"""Synthetic bead-board generator for CRNN training (whole-board pipeline).

Renders a full bead diagram (拼豆图纸) from a real photograph by mapping the
image onto a bead-brand palette, then emits per-cell ground-truth metadata —
so downstream cell cropping yields labeled training data with zero manual
annotation.

Pipeline (reference: liangdabiao/perler-beads-ai, Apache-2.0; original
algorithm & palette data: Zippland/perler-beads, AGPL-3.0):

1. **Grid sizing**: the caller picks the number of columns ``N`` (random
   30–300 by default); rows ``M = round(N * H / W)`` so every cell maps to a
   square region of the source image (same rule as the reference's
   ``page.tsx``).
2. **Dominant color extraction**: for each cell region, RGB values are
   quantized into buckets (>>4 per channel) and the most frequent bucket's
   mean color is used.  (Improvement over the reference's exact-RGB mode
   counting, which degenerates to a random pixel on photographic noise.)
3. **Palette mapping**: nearest color by RGB Euclidean distance (same metric
   as the reference so merge thresholds stay comparable).
4. **Global frequency merge** (verbatim reference strategy): colors are
   sorted by usage frequency; for every (high-freq, low-freq) pair whose RGB
   distance < ``merge_threshold`` (default 30), all low-freq cells are
   replaced with the high-freq color.  Metadata is generated AFTER merging so
   cell labels always match the rendered color.
5. **Rendering**: cells are drawn at ``cell_size`` px; each cell is filled
   with its palette color and stamped with its bead code (adaptive font,
   contrast-aware text color — logic reused from ``synth_generator``).  A
   light per-cell border plus darker separation lines every ``grid_interval``
   (random 5–20) cells mimic real printed diagrams; the separation-line color
   is picked at random from the palette.  ~30 % of boards get a random
   semi-transparent CJK watermark spanning many cells (real shared diagrams
   often carry one).

Output contract (``generate_board`` returns a ``Board``):

- ``Board.image``: (M*cell, N*cell, 3) uint8 RGB rendered diagram.
- ``Board.cells``: list of ``CellMeta`` — 1-based ``row``/``col``, ``code``,
  ``color_hex`` (matches the color library entry used for that cell).
- ``Board.meta``: header dict (source image, board geometry, generator
  version + attribution) — serialized as ``board.json`` next to the PNG.

Attribution: palette data for the 4 Chinese brands (COCO/漫漫/盼盼/咪小窝)
comes from ``colorSystemMapping.json``, byte-identical in both reference
projects — copyright Zippland/perler-beads (AGPL-3.0), reference via
liangdabiao/perler-beads-ai.  ai_dou is AGPL-3.0; see
``docs/adr/0005-synthetic-board-generation.md``.

Usage::

    from training.models.board_generator import generate_board
    board = generate_board(image_rgb, brand="mard", seed=7)
    board.image     # rendered diagram
    board.cells[0]  # CellMeta(row=1, col=1, code="H01", color_hex="#FFFFFF")
"""

from __future__ import annotations

import json
import random
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# Our rendered boards can exceed PIL's default decompression-bomb limit
# (e.g. 300 cols x tall portrait source -> > 178 MP).  We own the output,
# so the guard is counterproductive here.
Image.MAX_IMAGE_PIXELS = None

from ocr_core.code_library import load_library

# Reuse font discovery from the cell-level generator.
from training.models.synth_generator import (
    _get_wm_font,
    available_fonts,
)

# ═══════════════════════════════════════════════════════════════════════
# Constants
# ═══════════════════════════════════════════════════════════════════════

DEFAULT_CELL_SIZE = 48          # rendered px per cell
COLS_RANGE = (30, 300)          # random column count range
GRID_INTERVAL_RANGE = (5, 20)   # separation lines every N cells
MERGE_THRESHOLD = 30.0          # RGB euclidean (reference default)
WATERMARK_PROB = 0.40           # fraction of boards with a watermark

# CJK characters for random watermarks (kept short: shared-diagram style).
_WM_CHARS = "小红书成品图图纸分享拼豆图案创意制作教程手工DIY爱好者收藏关注点赞评论转发打卡日常记录分享生活"

TOOL_REF = (
    "liangdabiao/perler-beads-ai (Apache-2.0); "
    "algorithm & palette data: Zippland/perler-beads (AGPL-3.0)"
)


# ═══════════════════════════════════════════════════════════════════════
# Data types
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class CellMeta:
    row: int        # 1-based
    col: int        # 1-based
    code: str
    color_hex: str


@dataclass
class Board:
    image: np.ndarray                    # (H, W, 3) uint8 RGB
    rows: int
    cols: int
    brand: str
    cells: list[CellMeta] = field(default_factory=list)
    meta: dict = field(default_factory=dict)


# ═══════════════════════════════════════════════════════════════════════
# Color helpers
# ═══════════════════════════════════════════════════════════════════════


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _rgb_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return np.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def load_brand_palette(brand: str) -> list[dict]:
    """Return color-library entries for one brand (hex normalized, sorted).

    Each entry gains ``_rgb`` and ``render_code`` — the code actually printed
    on the diagram, i.e. the library code with the brand-conflict prefix
    stripped (real diagrams print `H07`, not `COCO-H07`; the prefix only
    exists for library-wide uniqueness and contains `-`, which is outside
    the OCR charset).
    """
    lib = load_library()
    entries = [e for e in lib if e.get("brand") == brand]
    if not entries:
        raise ValueError(
            f"unknown brand {brand!r}; available: "
            + ", ".join(sorted({e['brand'] for e in lib}))
        )
    prefix = _BRAND_PREFIX.get(brand)
    for e in entries:
        e["_rgb"] = _hex_to_rgb(e["color_hex"])
        code = e["code"]
        if prefix and code.startswith(prefix):
            code = code[len(prefix):]
        e["render_code"] = code
    return sorted(entries, key=lambda e: e["code"])


# Brand-conflict prefixes used by build_color_library.py /
# import_zippland_palette.py — stripped from codes before printing.
_BRAND_PREFIX: dict[str, str] = {
    "hama": "HAMA-", "hama_maxi": "HMAX-", "hama_mini": "HMIN-",
    "perler": "PERLER-", "perler_caps": "PCAP-", "perler_mini": "PMIN-",
    "nabbi": "NABBI-",
    "artkal_a": "ARKA-", "artkal_c": "ARKC-", "artkal_m": "ARKM-",
    "artkal_r": "ARKR-", "artkal_s": "ARKS-",
    "yant": "YANT-", "diamondDotz": "DDOTZ-", "mard": "MARD-",
    "coco": "COCO-", "manman": "MM-", "panpan": "PP-",
    "mixiaowo": "MXW-",
}


# ═══════════════════════════════════════════════════════════════════════
# Steps 1–4: grid, dominant color, mapping, merge
# ═══════════════════════════════════════════════════════════════════════


def compute_grid_size(img_h: int, img_w: int, cols: int | None,
                      rng: random.Random) -> tuple[int, int]:
    """(rows, cols) with square source cells: M = round(N * H / W)."""
    n = cols if cols is not None else rng.randint(*COLS_RANGE)
    n = max(1, int(n))
    m = max(1, round(n * img_h / img_w))
    return m, n


def _dominant_color(region: np.ndarray) -> tuple[int, int, int]:
    """Most frequent quantized color (mean of the winning bucket).

    ``region``: (h, w, 3) uint8 RGB.  Quantize to 16 levels/channel so
    photographic noise doesn't defeat the mode (reference counts exact RGB
    values, which degenerates on noisy photos).
    """
    px = region.reshape(-1, 3).astype(np.int32)
    q = px >> 4  # 16 levels per channel
    keys = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
    counts = np.bincount(keys, minlength=4096)
    best = int(np.argmax(counts))
    mask = keys == best
    mean = px[mask].mean(axis=0)
    return tuple(int(round(v)) for v in mean)


def _extract_dominant_grid(img: np.ndarray, rows: int, cols: int) -> np.ndarray:
    """Per-cell dominant color → (rows, cols, 3) float64 RGB."""
    h, w = img.shape[:2]
    grid = np.zeros((rows, cols, 3), dtype=np.float64)
    for r in range(rows):
        y0, y1 = r * h // rows, (r + 1) * h // rows
        for c in range(cols):
            x0, x1 = c * w // cols, (c + 1) * w // cols
            grid[r, c] = _dominant_color(img[y0:y1, x0:x1])
    return grid


def _map_to_palette(grid: np.ndarray, palette: list[dict],
                    rgb_arr: np.ndarray) -> np.ndarray:
    """Nearest palette color per cell (RGB euclidean, reference metric).

    Returns (rows, cols) array of palette indices.
    """
    rows, cols = grid.shape[:2]
    flat = grid.reshape(-1, 3)
    d2 = ((flat[:, None, :] - rgb_arr[None, :, :]) ** 2).sum(axis=2)
    idx = d2.argmin(axis=1)
    return idx.reshape(rows, cols)


def _global_frequency_merge(
    grid_idx: np.ndarray, palette: list[dict],
    threshold: float,
) -> np.ndarray:
    """Reference merge strategy: frequency-ordered global color replace.

    For each (high-freq, low-freq) pair with RGB distance < threshold, every
    low-freq cell becomes the high-freq color.  Verbatim port of the
    reference's merge loop (page.tsx) — NOT a connected-region merge.
    """
    freq = Counter(grid_idx.ravel())
    order = [k for k, _ in freq.most_common()]
    rgb = np.array([palette[i]["_rgb"] for i in order], dtype=np.float64)
    replaced: set[int] = set()
    for i, hi in enumerate(order):
        if hi in replaced:
            continue
        hi_rgb = rgb[i]
        for j in range(i + 1, len(order)):
            lo = order[j]
            if lo in replaced:
                continue
            d = np.sqrt(((hi_rgb - rgb[j]) ** 2).sum())
            if d < threshold:
                grid_idx[grid_idx == lo] = hi
                replaced.add(lo)
    return grid_idx


# ═══════════════════════════════════════════════════════════════════════
# Step 5: rendering
# ═══════════════════════════════════════════════════════════════════════


def _code_font_size(draw: ImageDraw.ImageDraw, code: str, cell: int,
                    font_path: str) -> ImageFont.FreeTypeFont:
    """Reference font size: max(8, floor(cell * 0.4)) px, bold sans-serif.

    Same rule as the reference export (imageDownloader.ts).  With crop
    jitter being a WHOLE-GRID offset (never per-cell), the text stays fully
    inside its cell: 19 px text centered in a 48 px cell leaves ~14 px
    margins, and a ±10 px grid shift reaches at most 58 px — the neighbour's
    text starts at 64 px.
    """
    size = max(8, int(cell * 0.4))
    font = ImageFont.truetype(font_path, size)
    bbox = draw.textbbox((0, 0), code, font=font)
    if (bbox[2] - bbox[0]) <= cell * 0.95 and (bbox[3] - bbox[1]) <= cell * 0.9:
        return font
    # Overflow fallback: shrink until it fits (rare, long codes only).
    for s in range(size - 1, max(6, int(cell * 0.2)) - 1, -1):
        f = ImageFont.truetype(font_path, s)
        b = draw.textbbox((0, 0), code, font=f)
        if (b[2] - b[0]) <= cell * 0.95 and (b[3] - b[1]) <= cell * 0.9:
            return f
    return ImageFont.truetype(font_path, max(6, int(cell * 0.2)))


def _distort_board(arr: np.ndarray, rng: random.Random) -> np.ndarray:
    """Apply font-renderer-like distortion to the whole rendered board.

    Different tools/diagrams use different typefaces and stroke weights.
    Deliberately SUBTLE — a 42 % pixel change made codes unrecognizable
    (val dropped to ~70 %).  Current bounds: stretch ±1.5 %, shear ±0.004,
    stroke morph 20 % probability, kernel 1 px.
    """
    import cv2
    import numpy as _np

    h, w = arr.shape[:2]
    sx = 1.0 + rng.uniform(-0.015, 0.015)
    sy = 1.0 + rng.uniform(-0.008, 0.008)
    shear = rng.uniform(-0.004, 0.004)
    new_w = max(w - 2, int(round(w * sx)))
    new_h = max(h - 2, int(round(h * sy)))

    # Affine: scale + shear around the image center, in one warp.
    cx, cy = w / 2.0, h / 2.0
    M = _np.array([[sx, shear * sy, 0.0], [0.0, sy, 0.0]], dtype=float)
    # Compose: translate center → origin, apply M, translate back.
    T1 = _np.array([[1, 0, -cx], [0, 1, -cy], [0, 0, 1]])
    M3 = _np.array([[M[0, 0], M[0, 1], 0], [M[1, 0], M[1, 1], 0], [0, 0, 1]])
    T2 = _np.array([[1, 0, cx], [0, 1, cy], [0, 0, 1]])
    full = T2 @ M3 @ T1
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    warped = cv2.warpAffine(bgr, full[:2], (w, h),
                            flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_REPLICATE)

    # Stroke weight: erode/dilate the text via the luminance channel.
    if rng.random() < 0.2:
        op = rng.choice(["erode", "dilate"])
        k = 1
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
        gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
        gray = cv2.erode(gray, kernel, iterations=1) if op == "erode" \
            else cv2.dilate(gray, kernel, iterations=1)
        warped[:, :, 0] = gray
        warped[:, :, 1] = gray
        warped[:, :, 2] = gray

    return cv2.cvtColor(warped, cv2.COLOR_BGR2RGB)


def _contrast_text_color(hex_color: str) -> tuple[int, int, int]:
    """Reference contrast rule: luma > 0.5 → black text, else white
    (getContrastColor, imageDownloader.ts)."""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    return (0, 0, 0) if luma > 0.5 else (255, 255, 255)


def _render_board(
    grid_idx: np.ndarray,
    palette: list[dict],
    cell_size: int,
    grid_interval: int,
    grid_color: tuple[int, int, int],
    watermark: bool,
    rng: random.Random,
    font_paths: list[str],
    cell_fonts: bool = True,
) -> np.ndarray:
    rows, cols = grid_idx.shape
    W, H = cols * cell_size, rows * cell_size
    img = Image.new("RGB", (W, H))
    draw = ImageDraw.Draw(img)

    # Precompute per-cell text color (reference contrast rule).
    text_colors = [_contrast_text_color(palette[i]["color_hex"])
                   for i in range(len(palette))]

    # Font per cell: pick randomly per CELL when cell_fonts=True (max
    # diversity — the model learns glyph shapes, not one typeface), else
    # one font for the whole board.
    font_cache: dict[str, ImageFont.FreeTypeFont] = {}

    def _font_for(code: str) -> ImageFont.FreeTypeFont:
        if cell_fonts:
            fp = rng.choice(font_paths)
            return _code_font_size(draw, code, cell_size, fp)
        font = font_cache.get(code)
        if font is None:
            font = _code_font_size(draw, code, cell_size, font_paths[0])
            font_cache[code] = font
        return font

    for r in range(rows):
        for c in range(cols):
            idx = int(grid_idx[r, c])
            entry = palette[idx]
            x0, y0 = c * cell_size, r * cell_size
            draw.rectangle([x0, y0, x0 + cell_size - 1, y0 + cell_size - 1],
                           fill=entry["color_hex"])

    # Codes on top of colors (drawn in a second pass so cell text never gets
    # overdrawn by later cells' fills).
    for r in range(rows):
        for c in range(cols):
            idx = int(grid_idx[r, c])
            entry = palette[idx]
            code = entry["render_code"]
            font = _font_for(code)
            bbox = draw.textbbox((0, 0), code, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            cx = c * cell_size + (cell_size - tw) / 2 - bbox[0]
            cy = r * cell_size + (cell_size - th) / 2 - bbox[1]
            # Centered exactly like the reference export — no jitter.
            draw.text((cx, cy), code, fill=text_colors[idx], font=font)

    # ── Grid lines (reference style: light per-cell border + dark separators)
    # Per-cell border.
    for r in range(rows + 1):
        y = r * cell_size
        draw.line([(0, y), (W, y)], fill="#DDDDDD", width=1)
    for c in range(cols + 1):
        x = c * cell_size
        draw.line([(x, 0), (x, H)], fill="#DDDDDD", width=1)
    # Separation lines every grid_interval cells (drawn BETWEEN cells,
    # exactly like the reference: lineX = i * cellSize).
    for i in range(grid_interval, cols, grid_interval):
        x = i * cell_size
        draw.line([(x, 0), (x, H)], fill=grid_color, width=2)
    for j in range(grid_interval, rows, grid_interval):
        y = j * cell_size
        draw.line([(0, y), (W, y)], fill=grid_color, width=2)

    # ── Watermark (semi-transparent white CJK text, tiled across the board)
    if watermark:
        wm_font_path = None
        wm_font = _get_wm_font()
        if wm_font is not None:
            wm_font_path = wm_font.path
        if wm_font_path:
            n_chars = rng.randint(2, 6)
            text = "".join(rng.choice(_WM_CHARS) for _ in range(n_chars))
            # Watermark size is relative to the BOARD, not the cell — a
            # 144-288 px glyph on a 24k-px board is invisible.  Use 8-15 %
            # of the short side so the mark is clearly visible at any size.
            short_side = min(W, H)
            font_size = int(short_side * rng.uniform(0.08, 0.15))
            big_font = ImageFont.truetype(wm_font_path, font_size)
            bbox = draw.textbbox((0, 0), text, font=big_font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            # Tile the watermark across the ENTIRE board (center included):
            # a grid with step = text size * 1.3-1.8 (~40 % area coverage),
            # shifted by a random global offset.  The grid is extended one
            # step beyond every edge so no region — especially the center —
            # is left without a watermark instance.
            step_x = int(tw * rng.uniform(1.3, 1.8))
            step_y = int(th * rng.uniform(1.3, 1.8))
            off_x = rng.randint(-step_x // 2, step_x // 2)
            off_y = rng.randint(-step_y // 2, step_y // 2)
            alpha = rng.randint(28, 55)
            # Watermark is near-white — matches real shared diagrams where
            # the watermark is light on top of the colored cells.
            rgba = (255, 255, 255, alpha)
            overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            od = ImageDraw.Draw(overlay)
            for j in range(-1, H // step_y + 2):
                y = j * step_y + off_y
                for i in range(-1, W // step_x + 2):
                    x = i * step_x + off_x
                    od.text((x - bbox[0], y - bbox[1]), text, fill=rgba,
                            font=big_font)
            img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

    return np.array(img)


# ═══════════════════════════════════════════════════════════════════════
# Public API
# ═══════════════════════════════════════════════════════════════════════


def generate_board(
    image: np.ndarray,
    brand: str,
    cols: int | None = None,
    cell_size: int = DEFAULT_CELL_SIZE,
    merge_threshold: float = MERGE_THRESHOLD,
    grid_interval: int | None = None,
    watermark_prob: float = WATERMARK_PROB,
    seed: int = 0,
    source_path: str | None = None,
    font_path: str | None = None,
    distort: bool = True,
) -> Board:
    """Generate a synthetic bead board from a real image.

    Args:
        image: (H, W, 3) uint8 RGB source photograph.
        brand: bead brand id from the color library (e.g. ``hama``, ``coco``).
        cols: column count; None → random in [30, 300].
        cell_size: rendered px per cell (default 48 = production crop size).
        merge_threshold: RGB-euclidean merge distance (reference default 30).
        grid_interval: separation line every N cells; None → random 5–20.
        watermark_prob: probability of adding a semi-transparent watermark.
        seed: RNG seed for reproducible generation.
        source_path: original image path recorded in metadata (optional).
        font_path: force a specific font for code text (default: random pick
            from all available fonts — font diversity makes the model
            font-agnostic; see experiment 002).
        distort: apply per-board stroke/geometry distortion (horizontal
            stretch ±4 %, stroke erode/dilate) to mimic different renderers.
    """
    rng = random.Random(seed)
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("image must be (H, W, 3) uint8 RGB")
    h, w = image.shape[:2]

    palette = load_brand_palette(brand)
    rgb_arr = np.array([e["_rgb"] for e in palette], dtype=np.float64)

    rows, cols_n = compute_grid_size(h, w, cols, rng)
    dom = _extract_dominant_grid(image, rows, cols_n)
    grid_idx = _map_to_palette(dom, palette, rgb_arr)
    grid_idx = _global_frequency_merge(grid_idx, palette, merge_threshold)

    interval = grid_interval if grid_interval is not None else \
        rng.randint(*GRID_INTERVAL_RANGE)
    grid_color = _hex_to_rgb(rng.choice(palette)["color_hex"])
    watermark = rng.random() < watermark_prob

    fonts = available_fonts()
    if not fonts:
        raise RuntimeError("no fonts available for rendering (see synth_generator)")
    if font_path is None:
        # Cell-level font diversity (default): every cell picks a random
        # font — the model learns glyph shapes instead of one typeface, which
        # is what makes it generalise to unseen boards.  A fixed font_path
        # forces one face for the whole board (testing/ablation).
        font_list = fonts
    else:
        font_list = [font_path]
    rendered = _render_board(
        grid_idx, palette, cell_size, interval, grid_color,
        watermark, rng, font_list, cell_fonts=(font_path is None),
    )
    if distort:
        rendered = _distort_board(rendered, rng)

    cells = [
        CellMeta(
            row=int(r) + 1, col=int(c) + 1,
            code=palette[int(grid_idx[r, c])]["render_code"],
            color_hex=palette[int(grid_idx[r, c])]["color_hex"],
        )
        for r in range(rows) for c in range(cols_n)
    ]

    meta = {
        "format_version": 1,
        "source": {
            "image": source_path,
            "width": w,
            "height": h,
        },
        "board": {
            "brand": brand,
            "rows": rows,
            "cols": cols_n,
            "cell_size_px": cell_size,
            "grid_interval": interval,
            "grid_color": f"#{grid_color[0]:02X}{grid_color[1]:02X}{grid_color[2]:02X}",
            "merge_threshold": merge_threshold,
            "watermark": watermark,
            "font_path": font_path or "cell-random",
            "distort": distort,
            "seed": seed,
        },
        "generator": {
            "tool": "training.models.board_generator",
            "ref": TOOL_REF,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }

    return Board(image=rendered, rows=rows, cols=cols_n, brand=brand,
                 cells=cells, meta=meta)


def save_board(board: Board, out_dir: str | Path) -> dict:
    """Persist board.png + board.json (meta + per-cell metadata) to out_dir."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(board.image).save(out_dir / "board.png")
    doc = {
        **board.meta,
        "cells": [
            {"row": c.row, "col": c.col, "code": c.code,
             "color_hex": c.color_hex}
            for c in board.cells
        ],
    }
    with open(out_dir / "board.json", "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
    # Preview: downscale so it's cheap to eyeball.
    preview = Image.fromarray(board.image)
    preview.thumbnail((800, 800))
    preview.save(out_dir / "board_preview.png")
    return {"png": out_dir / "board.png",
            "json": out_dir / "board.json",
            "preview": out_dir / "board_preview.png"}
