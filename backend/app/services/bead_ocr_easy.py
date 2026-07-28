"""Plan A: EasyOCR-enhanced per-cell OCR.

Variant of ocr_cells_from_crop that uses the adaptive preprocessing
pipeline (preprocess_cell) to generate multiple binarization variants
per cell, then picks the highest-confidence EasyOCR detection.
"""
from __future__ import annotations

import concurrent.futures
import json
import re
import threading
from pathlib import Path

import cv2
import numpy as np

from app.services.bead_ocr_preprocess import preprocess_cell
from app.services.code_match import build_valid_letters, clean_token, fuzzy_correct


# ── Library / pattern (mirrors bead_ocr.py) ──────────────────────────

_LIBRARY_PATH = Path(__file__).parent.parent / "data" / "default_colors.json"


def _load_library_codes() -> list[str]:
    with open(_LIBRARY_PATH) as f:
        entries = json.load(f)
    return [e["code"] for e in entries]


def _build_allowlist(codes: list[str]) -> str:
    """Character allowlist fed to EasyOCR's reader.

    Only legal prefix letters + digits are admitted, so the engine is less
    likely to hallucinate stray glyphs. OCR confusion between letters and
    digits (I/1, O/0, S/5) is recovered downstream by ``clean_token`` +
    ``fuzzy_correct`` rather than by widening this allowlist.
    """
    letters = sorted({c[0] for c in codes})
    digits = sorted({ch for c in codes for ch in c[1:] if ch.isdigit()})
    return "".join(letters) + "".join(digits)


def _build_code_pattern(codes: list[str]) -> re.Pattern:
    letters = sorted({c[0] for c in codes})
    max_digits = max(len(c) - 1 for c in codes)
    return re.compile(rf"^[{''.join(letters)}][0-9]{{1,{max_digits}}}")


_LIB_CODES = _load_library_codes()
_ALLOWLIST = _build_allowlist(_LIB_CODES)
_VALID_CODE_PATTERN = _build_code_pattern(_LIB_CODES)
_VALID_LETTERS = build_valid_letters(_LIB_CODES)

# Confidence multiplier applied to a detection whose code was recovered via
# Levenshtein fuzzy correction rather than an exact match. Keeps fuzzy
# results from outranking a clean exact match in the per-cell merge.
_FUZZY_CONF_PENALTY = 0.85


def _parse_code(text: str) -> str | None:
    """Clean raw OCR text to a ``<letter><digits>`` candidate (no fuzzy).

    Confusable letter forms (I/L/O/S/...) are normalized to their digit
    twins before the regex, so ``"HI"`` → ``"H1"`` instead of being
    dropped by the allowlist filter. Dictionary fuzzy correction is applied
    separately in ``_ocr_cell`` so it can discount the confidence.
    """
    if not text:
        return None
    token = clean_token(text, _VALID_LETTERS)
    if token is None:
        return None
    m = _VALID_CODE_PATTERN.match(token)
    return m.group() if m else None


# ── EasyOCR reader (lazy, locked) ────────────────────────────────────

_lock = threading.Lock()
_reader = None


def _get_easy_reader():
    global _reader
    if _reader is None:
        with _lock:
            if _reader is None:
                import easyocr
                _reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _reader


def _read_variant(reader, img: np.ndarray) -> list[tuple[str, float]]:
    """Run EasyOCR on one preprocessed variant."""
    return [
        (det[1], float(det[2]))
        for det in reader.readtext(
            img, detail=1, paragraph=False,
            allowlist=_ALLOWLIST, text_threshold=0.2,
            low_text=0.1, link_threshold=0.2,
        )
    ]


def _ocr_cell(cell_bgr: np.ndarray, reader, valid_codes: set[str], min_conf: float):
    """OCR one cell — returns (code, conf) or None."""
    variants = preprocess_cell(cell_bgr)
    best: tuple[str, float] | None = None
    for _name, variant in variants:
        try:
            results = _read_variant(reader, variant)
        except (OverflowError, ZeroDivisionError):
            # EasyOCR can produce inf/zero-div on certain preprocessed images
            continue
        for raw_text, conf in results:
            if conf < min_conf:
                continue
            code = _parse_code(raw_text)
            if code is None:
                continue
            fuzzy = False
            if code not in valid_codes:
                corrected = fuzzy_correct(code, valid_codes)
                if corrected is None:
                    continue
                code = corrected
                fuzzy = True
            eff_conf = conf * (_FUZZY_CONF_PENALTY if fuzzy else 1.0)
            if eff_conf < min_conf:
                continue
            if best is None or eff_conf > best[1]:
                best = (code, eff_conf)
    return best


def _clamp(val: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, val))


def ocr_cells_from_crop_easy(
    image_bgr: np.ndarray,
    user_rows: int,
    user_cols: int,
    crop_bbox: tuple[int, int, int, int],
    valid_codes: set[str] | None = None,
    min_conf: float = 0.5,
    max_workers: int = 20,
) -> dict[tuple[int, int], tuple[str, float]]:
    """OCR every cell of a user-cropped bead board using EasyOCR + adaptive preprocessing."""
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
        valid_codes = set(_LIB_CODES)

    reader = _get_easy_reader()

    tasks = []
    for r in range(user_rows):
        for c in range(user_cols):
            cy0 = _clamp(int(round(y0 + r * cell_h)), 0, h)
            cx0 = _clamp(int(round(x0 + c * cell_w)), 0, w)
            cy1 = _clamp(int(round(y0 + (r + 1) * cell_h)), 0, h)
            cx1 = _clamp(int(round(x0 + (c + 1) * cell_w)), 0, w)
            tasks.append((r, c, cy0, cx0, cy1, cx1))

    def _one(args):
        r, c, cy0, cx0, cy1, cx1 = args
        crop = image_bgr[cy0:cy1, cx0:cx1]
        if crop.size == 0:
            return None
        result = _ocr_cell(crop, reader, valid_codes, min_conf)
        if result is None:
            return None
        return (r, c, result[0], result[1])

    merged: dict[tuple[int, int], tuple[str, float]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers, len(tasks) or 1)) as ex:
        for fut in concurrent.futures.as_completed(ex.submit(_one, t) for t in tasks):
            res = fut.result()
            if res is None:
                continue
            r, c, code, conf = res
            key = (r, c)
            prev = merged.get(key)
            if prev is None or conf > prev[1]:
                merged[key] = (code, conf)
    return merged
