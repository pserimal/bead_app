"""Synthetic single-cell generator for CRNN training.

Generates 48×48 RGB training cells that closely mimic real Perler bead diagram
cells after grid-based cropping.  Key design decisions driven by visual
inspection of ``training/crops/cut/1/`` (cells from a 7633×4338 px, 90×158
grid real-world bead pattern image):

- **Square cells**: real cells are ~48×48 px (from grid‑division of high‑res
  scans).  Output is 48×48.
- **Coloured backgrounds**: every cell has a solid background colour drawn from
  the 65‑entry Perler colour library (``default_colors.json``).  There are no
  pure‑white empty cells in the real diagrams.
- **Text colour**: white on dark backgrounds (luminance < 130), black on
  light backgrounds — exactly what you see in filled vs.  unfilled bead cells.
- **Large text**: font at 36‑50 px on a 96‑px render‑canvas, downscaled to
  48×48 via Lanczos.  Text fills 40‑55 % of cell width.
- **Neighbour‑bleed stripes** (60 %): a full‑edge stripe (4‑16 px) of a
  different colour on one side, simulating adjacent bead colour bleeding into
  the current cell.
- **Social‑media watermark** (30 %): large Chinese text (e.g.  "小红书",
  "成品图", "图纸分享") rendered on a 5× canvas, randomly cropped back to
  cell size, composited with alpha 25‑60.  May partially occlude the bead
  code — this is intentional and matches real‑world watermarks.
- **Gaussian blur**: always applied (radius 0.5‑1.5) — real cells are never
  razor‑sharp due to camera softness and JPEG compression in source images.
- **Additional augmentations**: Gaussian noise (40 %, σ 0‑4), JPEG
  re‑compression (30 %, q 60‑90), brightness jitter (20 %, ±10).

Character set: 26 uppercase letters (A‑Z) + 10 digits (0‑9) + CTC blank
= 37 classes.  Training covers the full letter+digit space so new codes can
be added to the dictionary without retraining.

Usage::

    from training.models.synth_generator import generate_dataset, CODES

    samples = generate_dataset(n=100_000, seed=42)
    # → list[Sample], each Sample.image is a (48, 48, 3) uint8 RGB ndarray
"""

from __future__ import annotations

import io
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ═══════════════════════════════════════════════════════════════════════
# Code vocabulary
# ═══════════════════════════════════════════════════════════════════════

# Color library lives in the backend service (single source of truth for the
# 65-entry Perler palette). Resolve relative to repo root regardless of cwd.
_LIB_PATH = Path(__file__).resolve().parent.parent.parent / "backend" / "app" / "data" / "default_colors.json"


def _load_library() -> list[dict]:
    with open(_LIB_PATH, encoding="utf-8") as f:
        return json.load(f)


_LIB: list[dict] = _load_library()

CODES: list[str] = [e["code"] for e in _LIB if e.get("code")]
_HEX_COLORS: list[str] = [e["color_hex"] for e in _LIB if e.get("color_hex")]

LETTERS: list[str] = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
DIGITS: list[str] = list("0123456789")
# <blank> at index 0 (CTC requirement), then A‑Z, then 0‑9.
CHARS: list[str] = ["<blank>"] + LETTERS + DIGITS
CHAR_TO_IDX: dict[str, int] = {ch: i for i, ch in enumerate(CHARS)}
IDX_TO_CHAR: dict[int, str] = {i: ch for i, ch in enumerate(CHARS)}


def _random_code(rng: random.Random) -> str:
    """Generate a random bead code: 1 uppercase letter + 1–2 digits.

    Covers the full A‑Z × (10 + 100) = 2860‑code space so the model sees
    every letter during training.
    """
    letter = rng.choice(LETTERS)
    n_digits = rng.choice([1, 2])
    digits = "".join(rng.choices(DIGITS, k=n_digits))
    return letter + digits


# ═══════════════════════════════════════════════════════════════════════
# Font discovery
# ═══════════════════════════════════════════════════════════════════════

_FONT_CANDIDATES: list[str] = [
    # Windows (priority: Calibri looks closest to real bead diagrams)
    "C:/Windows/Fonts/calibrib.ttf",
    "C:/Windows/Fonts/calibri.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "C:/Windows/Fonts/seguisb.ttf",
    "C:/Windows/Fonts/verdana.ttf",
    "C:/Windows/Fonts/verdanab.ttf",
    "C:/Windows/Fonts/consola.ttf",
    "C:/Windows/Fonts/consolab.ttf",
    "C:/Windows/Fonts/tahoma.ttf",
    "C:/Windows/Fonts/tahomabd.ttf",
    # Linux
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
]

# Chinese fonts for watermark rendering (optional — watermark is skipped if
# no CJK font is found).
_WM_FONT_PATHS: list[str] = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]

# ═══════════════════════════════════════════════════════════════════════
# Canvas
# ═══════════════════════════════════════════════════════════════════════

CELL_SIZE = 48           # target cell px (square)
RENDER_SIZE = CELL_SIZE * 2  # render at 2× for anti‑aliasing

# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _luminance(rgb: tuple[int, int, int]) -> float:
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def _luminance_bgr(bgr: tuple[int, int, int]) -> float:
    return 0.299 * bgr[2] + 0.587 * bgr[1] + 0.114 * bgr[0]


def _pick_text_color(bg_rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    """White on dark, near‑black on light (matching real bead cells)."""
    if _luminance(bg_rgb) < 130:
        return (255, 255, 255)
    else:
        return (10, 10, 10)


# ═══════════════════════════════════════════════════════════════════════
# Sample dataclass
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class Sample:
    image: np.ndarray     # (48, 48, 3) uint8 RGB
    code: str
    token_indices: list[int]


def code_to_token_indices(code: str) -> list[int]:
    return [CHAR_TO_IDX[ch] for ch in code]


# ═══════════════════════════════════════════════════════════════════════
# Font cache helpers
# ═══════════════════════════════════════════════════════════════════════

_available_fonts: list[str] | None = None
_wm_font: ImageFont.FreeTypeFont | None = None
_wm_font_checked: bool = False


def available_fonts() -> list[str]:
    global _available_fonts
    if _available_fonts is None:
        _available_fonts = [p for p in _FONT_CANDIDATES if Path(p).exists()]
    return _available_fonts


def _get_wm_font() -> ImageFont.FreeTypeFont | None:
    global _wm_font, _wm_font_checked
    if not _wm_font_checked:
        _wm_font_checked = True
        for p in _WM_FONT_PATHS:
            if Path(p).exists():
                _wm_font = ImageFont.truetype(p, 12)
                break
    return _wm_font


# ═══════════════════════════════════════════════════════════════════════
# Cell generation
# ═══════════════════════════════════════════════════════════════════════


def generate_one(rng: random.Random, fonts: list[str]) -> Sample:
    """Generate a single 48×48 synthetic cell matching real bead diagrams."""

    code = _random_code(rng)
    bg_hex = rng.choice(_HEX_COLORS)
    bg_rgb = _hex_to_rgb(bg_hex)
    text_rgb = _pick_text_color(bg_rgb)

    SZ = RENDER_SIZE  # 96
    pil_img = Image.new("RGB", (SZ, SZ), bg_rgb)
    draw = ImageDraw.Draw(pil_img)

    # ── 1. Full‑edge neighbour‑bleed stripe (60 %) ──
    if rng.random() < 0.6:
        other_rgb = _hex_to_rgb(rng.choice(_HEX_COLORS))
        edge = rng.randint(0, 3)
        margin = rng.randint(4, 16)
        if edge == 0:
            draw.rectangle([(0, 0), (SZ, margin)], fill=other_rgb)
        elif edge == 1:
            draw.rectangle([(0, SZ - margin), (SZ, SZ)], fill=other_rgb)
        elif edge == 2:
            draw.rectangle([(0, 0), (margin, SZ)], fill=other_rgb)
        else:
            draw.rectangle([(SZ - margin, 0), (SZ, SZ)], fill=other_rgb)

    # ── 2. Large social‑media watermark (30 %) ──
    wm_font = _get_wm_font()
    if rng.random() < 0.3 and wm_font is not None:
        wm_text = rng.choice(["小红书", "成品图", "图纸分享"])
        BIG = SZ * 5  # 480 — watermark spans many cells
        wm_canvas = Image.new("RGBA", (BIG, BIG), (0, 0, 0, 0))
        wm_draw = ImageDraw.Draw(wm_canvas)

        big_font_size = rng.randint(80, 140)
        try:
            # Use the same face as _wm_font but at a larger size
            big_font = ImageFont.truetype(wm_font.path, big_font_size)
        except Exception:
            big_font = ImageFont.load_default()

        alpha = rng.randint(25, 60)
        wm_rgba = (
            (255, 255, 255, alpha)
            if _luminance(bg_rgb) < 130
            else (0, 0, 0, alpha)
        )
        tx = rng.randint(-BIG // 2 + 20, BIG // 2 - 20)
        ty = rng.randint(-BIG // 2 + 20, BIG // 2 - 20)
        wm_draw.text((tx, ty), wm_text, fill=wm_rgba, font=big_font)

        crop_x = rng.randint(0, BIG - SZ)
        crop_y = rng.randint(0, BIG - SZ)
        wm_overlay = wm_canvas.crop(
            (crop_x, crop_y, crop_x + SZ, crop_y + SZ)
        )
        pil_img = Image.alpha_composite(
            pil_img.convert("RGBA"), wm_overlay
        ).convert("RGB")
        draw = ImageDraw.Draw(pil_img)

    # ── 3. Bead code text (centred, large) ──
    font_size = rng.randint(36, 50)
    font = ImageFont.truetype(rng.choice(fonts), font_size)
    bbox = draw.textbbox((0, 0), code, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    cx = (SZ - tw) / 2 - bbox[0] + rng.randint(-2, 2)
    cy = (SZ - th) / 2 - bbox[1] + rng.randint(-2, 2)
    draw.text((cx, cy), code, fill=text_rgb, font=font)

    # ── 4. Downscale to cell size ──
    pil_img = pil_img.resize((CELL_SIZE, CELL_SIZE), Image.LANCZOS)

    # ── 5. Gaussian blur (always) ──
    pil_img = pil_img.filter(
        ImageFilter.GaussianBlur(radius=rng.uniform(0.5, 1.5))
    )

    arr = np.array(pil_img)

    # Extra OpenCV blur occasionally (simulates camera softness)
    if rng.random() < 0.3:
        arr = cv2.GaussianBlur(arr, (3, 3), 0)

    # ── 6. Gaussian noise (40 %) ──
    if rng.random() < 0.4:
        sigma = rng.uniform(0, 4)
        arr = np.clip(
            arr.astype(np.float32) + np.random.normal(0, sigma, arr.shape),
            0, 255,
        ).astype(np.uint8)

    # ── 7. JPEG re‑compression artefacts (30 %) ──
    if rng.random() < 0.3:
        buf = io.BytesIO()
        Image.fromarray(arr).save(
            buf, format="JPEG", quality=rng.randint(60, 90)
        )
        buf.seek(0)
        arr = np.array(Image.open(buf).convert("RGB"))

    # ── 8. Brightness jitter (20 %) ──
    if rng.random() < 0.2:
        delta = rng.randint(-10, 10)
        arr = np.clip(arr.astype(np.int16) + delta, 0, 255).astype(np.uint8)

    return Sample(image=arr, code=code, token_indices=code_to_token_indices(code))


# ═══════════════════════════════════════════════════════════════════════
# Dataset helpers
# ═══════════════════════════════════════════════════════════════════════


def generate_dataset(n: int, seed: int = 0) -> list[Sample]:
    """Generate *n* synthetic training samples."""
    rng = random.Random(seed)
    np.random.seed(seed)
    fonts = available_fonts()
    if not fonts:
        raise RuntimeError(
            "No fonts found for synthesis. Install at least one of: "
            "fonts-dejavu, fonts-liberation, fonts-freefont (Linux) or "
            "ensure Windows system fonts are accessible."
        )
    return [generate_one(rng, fonts) for _ in range(n)]


def save_samples(samples: Iterable[Sample], out_dir: str | Path) -> int:
    """Save each sample as ``<out_dir>/<code>/<idx>.png``."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    for s in samples:
        code_dir = out_dir / s.code
        code_dir.mkdir(parents=True, exist_ok=True)
        idx = counts.get(s.code, 0)
        counts[s.code] = idx + 1
        Image.fromarray(s.image).save(code_dir / f"{idx:06d}.png")
    return sum(counts.values())


def samples_to_arrays(
    samples: list[Sample],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Stack samples into (N, H, W, C) uint8 + (N, max_len) labels.

    Returns ``(images, labels, target_lengths)``.
    """
    images = np.stack([s.image for s in samples])
    max_len = max(len(s.token_indices) for s in samples)
    labels = np.full((len(samples), max_len), -1, dtype=np.int64)
    target_lengths = np.zeros(len(samples), dtype=np.int64)
    for i, s in enumerate(samples):
        labels[i, : len(s.token_indices)] = s.token_indices
        target_lengths[i] = len(s.token_indices)
    return images, labels, target_lengths


# ═══════════════════════════════════════════════════════════════════════
# CLI — quick preview generation
# ═══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser()
    p.add_argument("--n", type=int, default=100)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=str, default="data/synth_preview")
    args = p.parse_args()
    samples = generate_dataset(args.n, args.seed)
    n = save_samples(samples, args.out)
    print(f"saved {n} samples to {args.out}")
