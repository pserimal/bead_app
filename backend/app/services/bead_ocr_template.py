"""Plan B: Template-matching per-cell code reader.

Renders each valid bead code with every available known font, normalizes
each glyph to a fixed binary canvas, and recognizes cells by normalized
cross-correlation (Pearson) against the template bank. **No training data
required** — the closed code vocabulary *is* the model.

This is the cheap, zero-dependency baseline. On synthetic fixtures (DejaVu
Sans, solid fills, no noise) it should hit ~100% per-cell accuracy, which
proves the machinery; real photos are a separate domain-gap question
(Plan A / active learning is the long-term answer there).

Matching is fully vectorized: every template is flattened into one matrix
and a whole board's cells are correlated against it in a single BLAS gemm,
so a full board takes well under a second rather than minutes.

Selected via ``OCR_ENGINE="template"``.
"""
from __future__ import annotations

import concurrent.futures
import json
import threading
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.services.code_match import fuzzy_correct


_LIBRARY_PATH = Path(__file__).parent.parent / "data" / "default_colors.json"

# Fonts tried, in priority order. Multi-font coverage makes the matcher
# robust to whatever font the real bead template uses. All are common on
# Debian/Ubuntu; missing entries are skipped silently.
_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
]

# Canonical glyph canvas: every template and every normalized cell is
# letterboxed into this fixed shape so NCC is element-wise.
_CANVAS_W = 48
_CANVAS_H = 32

# Render font size for templates. Picked to fill a good fraction of the
# canvas while leaving room for letterboxing.
_TEMPLATE_FONT_SIZE = 20

# Confidence multiplier applied to a detection recovered via dictionary
# fuzzy correction rather than a clean template match.
_FUZZY_CONF_PENALTY = 0.9


def _load_library_codes() -> list[str]:
    with open(_LIBRARY_PATH) as f:
        return [e["code"] for e in json.load(f)]


def _available_fonts() -> list[str]:
    return [p for p in _FONT_CANDIDATES if Path(p).exists()]


# ── Glyph rendering & normalization ───────────────────────────────────


def _render_binary(code: str, font_path: str, size: int = _TEMPLATE_FONT_SIZE):
    """Render ``code`` as white-on-black text, cropped to the ink bbox.

    Returns a uint8 array (ink=255) or ``None`` if nothing was drawn.
    """
    img = Image.new("L", (96, 96), 0)
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(font_path, size)
    except OSError:
        return None
    draw.text((48, 48), code, fill=255, font=font, anchor="mm")
    arr = np.array(img)
    ys, xs = np.where(arr > 0)
    if len(xs) == 0:
        return None
    return arr[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def _to_canvas(binary: np.ndarray) -> np.ndarray | None:
    """Letterbox a binary ink crop into the canonical canvas (ink=255).

    Scales to fit *within* the canvas box (preserving aspect ratio) so
    wide glyphs (3-char codes, noisy ink blobs) never overflow the width.
    """
    if binary is None or binary.size == 0:
        return None
    h, w = binary.shape
    scale = min(_CANVAS_H / float(h), _CANVAS_W / float(w)) * 0.9
    new_h = max(1, int(round(h * scale)))
    new_w = max(1, int(round(w * scale)))
    resized = cv2.resize(binary, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.zeros((_CANVAS_H, _CANVAS_W), dtype=np.uint8)
    yoff = (_CANVAS_H - new_h) // 2
    xoff = (_CANVAS_W - new_w) // 2
    canvas[yoff:yoff + new_h, xoff:xoff + new_w] = resized
    return canvas


def _normalize_cell(cell_bgr: np.ndarray) -> np.ndarray | None:
    """Binarize a cell crop to a clean glyph, force ink=255, fit to canvas.

    Uses a **global OTSU** threshold rather than ``preprocess_cell``'s
    adaptive variants: on the solid-color cells of a bead board, adaptive
    thresholding produces salt-and-pepper speckle (each pixel is compared
    to its near-identical local neighborhood), which destroys the glyph.
    Global OTSU cleanly separates the two-tone (background + text) cell.

    Uneven-lighting real photos are the known weakness here — that domain
    gap is what Plan A / active learning addresses; this baseline targets
    clean boards. Returns ``None`` for empty / degenerate cells.
    """
    if cell_bgr is None or cell_bgr.size == 0:
        return None
    gray = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2GRAY)
    # Upscale tiny cells so the glyph has enough pixels for a clean crop.
    side = max(1, min(gray.shape))
    if side < 40:
        factor = max(2, 64 // side)
        gray = cv2.resize(
            gray, None, fx=factor, fy=factor, interpolation=cv2.INTER_LANCZOS4
        )
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Force the minority polarity to be "ink" (255): on a bead cell the
    # background always dominates the pixel count, text is the minority.
    white = int((binary > 127).sum())
    if white > binary.size - white:
        binary = 255 - binary
    ink = int((binary > 127).sum())
    ratio = ink / float(binary.size)
    if ratio < 0.01 or ratio > 0.8:
        return None  # empty cell or degenerate binarization
    ys, xs = np.where(binary > 127)
    if len(xs) == 0:
        return None
    crop = binary[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return _to_canvas(crop)


# ── Template bank (lazy, vectorized) ─────────────────────────────────

_bank_lock = threading.Lock()
_bank_ready = False
_bank_codes: list[str] = []               # bead code for each matrix row
_bank_centered: np.ndarray | None = None  # (N, D) float32, row-centered
_bank_tstd: np.ndarray | None = None      # (N,) per-template std
_bank_D = 0


def _build_bank(codes: list[str], fonts: list[str]) -> dict[str, list[np.ndarray]]:
    bank: dict[str, list[np.ndarray]] = {}
    for code in codes:
        variants: list[np.ndarray] = []
        for fp in fonts:
            canvas = _to_canvas(_render_binary(code, fp))
            if canvas is not None:
                variants.append(canvas.astype(np.float32))
        if variants:
            bank[code] = variants
    return bank


def _finalize_bank(bank: dict[str, list[np.ndarray]]) -> None:
    """Flatten every (code, font-variant) canvas into one stacked matrix."""
    global _bank_ready, _bank_codes, _bank_centered, _bank_tstd, _bank_D
    codes: list[str] = []
    rows: list[np.ndarray] = []
    for code, variants in bank.items():
        for v in variants:
            codes.append(code)
            rows.append(v.astype(np.float32).ravel())
    if not rows:
        raise RuntimeError("Template bank is empty")
    mat = np.stack(rows)                        # (N, D)
    _bank_D = int(mat.shape[1])
    means = mat.mean(axis=1, keepdims=True)     # (N, 1)
    _bank_tstd = mat.std(axis=1)                # (N,)
    _bank_centered = (mat - means).astype(np.float32)  # (N, D)
    _bank_codes = codes
    _bank_ready = True


def _get_bank() -> None:
    global _bank_ready
    if not _bank_ready:
        with _bank_lock:
            if not _bank_ready:
                fonts = _available_fonts()
                if not fonts:
                    raise RuntimeError(
                        "No fonts available for template matching; install "
                        "fonts-dejavu / fonts-liberation / fonts-freefont"
                    )
                _finalize_bank(_build_bank(_load_library_codes(), fonts))


# ── Matching (vectorized batch NCC) ──────────────────────────────────


def _match_batch(
    canvases: list[np.ndarray | None],
) -> list[tuple[str, float] | None]:
    """NCC-match a list of canvases against the bank in one gemm.

    Returns a list aligned with ``canvases``: each entry is
    ``(code, score)`` or ``None`` (empty / flat cell).
    """
    _get_bank()
    out: list[tuple[str, float] | None] = [None] * len(canvases)
    idxs = [i for i, c in enumerate(canvases) if c is not None]
    if not idxs:
        return out
    C = np.stack([canvases[i].astype(np.float32).ravel() for i in idxs])  # (M, D)
    cmean = C.mean(axis=1, keepdims=True)   # (M, 1)
    cstd = C.std(axis=1)                    # (M,)
    Cc = C - cmean                          # (M, D)
    num = Cc @ _bank_centered.T             # (M, N)
    denom = _bank_D * cstd[:, None] * _bank_tstd[None, :]
    ncc = num / np.maximum(denom, 1e-6)     # (M, N)
    best = ncc.argmax(axis=1)               # (M,)
    best_score = ncc[np.arange(len(idxs)), best]
    for k, i in enumerate(idxs):
        if cstd[k] < 1e-3:
            continue
        out[i] = (_bank_codes[int(best[k])], float(best_score[k]))
    return out


def _clamp(val: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, val))


def _ocr_one_cell(
    cell_bgr: np.ndarray,
    valid_codes: set[str],
    min_conf: float,
) -> tuple[str, float] | None:
    """Recognize one cell crop → ``(code, confidence)`` or ``None``."""
    canvas = _normalize_cell(cell_bgr)
    m = _match_batch([canvas])[0]
    if m is None:
        return None
    code, score = m
    if score < min_conf:
        return None
    if code not in valid_codes:
        corrected = fuzzy_correct(code, valid_codes)
        if corrected is None:
            return None
        code = corrected
        score *= _FUZZY_CONF_PENALTY
    return (code, score)


def ocr_cells_from_crop_template(
    image_bgr: np.ndarray,
    user_rows: int,
    user_cols: int,
    crop_bbox: tuple[int, int, int, int],
    valid_codes: set[str] | None = None,
    min_conf: float = 0.5,
    max_workers: int = 8,
) -> dict[tuple[int, int], tuple[str, float]]:
    """Recognize every cell of a user-cropped board by template matching.

    Mirrors the EasyOCR variant's API/return shape so it is a drop-in for
    the ``OCR_ENGINE`` switch in ``bead_ocr.ocr_cells_from_crop``.

    All cell crops are normalized (the cv2-heavy step, parallelized), then
    correlated against the template bank in a single vectorized pass.
    """
    h, w = image_bgr.shape[:2]
    x, y, cw, ch = crop_bbox
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(w, x + cw)
    y1 = min(h, y + ch)
    if x0 >= x1 or y0 >= y1:
        return {}

    cell_w = (x1 - x0) / user_cols
    cell_h = (y1 - y0) / user_rows

    if valid_codes is None:
        valid_codes = set(_load_library_codes())

    # Inset each cell by ~10% to avoid sampling the blue grid lines, which
    # would otherwise dominate the binary ink and corrupt the glyph match.
    inset_frac = 0.10

    rects: list[tuple[int, int, int, int, int, int]] = []
    for r in range(user_rows):
        for c in range(user_cols):
            cy0 = _clamp(int(round(y0 + r * cell_h)), 0, h)
            cx0 = _clamp(int(round(x0 + c * cell_w)), 0, w)
            cy1 = _clamp(int(round(y0 + (r + 1) * cell_h)), 0, h)
            cx1 = _clamp(int(round(x0 + (c + 1) * cell_w)), 0, w)
            iy = max(1, int(round((cy1 - cy0) * inset_frac)))
            ix = max(1, int(round((cx1 - cx0) * inset_frac)))
            cy0 += iy
            cy1 -= iy
            cx0 += ix
            cx1 -= ix
            if cy0 >= cy1 or cx0 >= cx1:
                continue
            rects.append((r, c, cy0, cx0, cy1, cx1))

    if not rects:
        return {}

    def _norm(rect):
        _r, _c, cy0, cx0, cy1, cx1 = rect
        crop = image_bgr[cy0:cy1, cx0:cx1]
        if crop.size == 0:
            return None
        return _normalize_cell(crop)

    canvases: list[np.ndarray | None] = [None] * len(rects)
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(max_workers, len(rects))
    ) as ex:
        futs = {ex.submit(_norm, rect): i for i, rect in enumerate(rects)}
        for fut in concurrent.futures.as_completed(futs):
            canvases[futs[fut]] = fut.result()

    merged: dict[tuple[int, int], tuple[str, float]] = {}
    matches = _match_batch(canvases)
    for i, m in enumerate(matches):
        if m is None:
            continue
        code, score = m
        if score < min_conf:
            continue
        if code not in valid_codes:
            corrected = fuzzy_correct(code, valid_codes)
            if corrected is None:
                continue
            code = corrected
            score *= _FUZZY_CONF_PENALTY
        r, c = rects[i][0], rects[i][1]
        key = (r, c)
        prev = merged.get(key)
        if prev is None or score > prev[1]:
            merged[key] = (code, score)
    return merged
