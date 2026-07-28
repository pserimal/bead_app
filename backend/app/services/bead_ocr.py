"""OCR-based bead-code extraction for Perler bead board cells.

Each cell of a Perler bead board contains a short alphanumeric code (like
"H7", "F1", "E11") printed on a colored or white background. The code
identifies the bead color.

This module delegates to either:
- Plan A (EasyOCR + adaptive preprocessing) via bead_ocr_easy.py
- Plan B (PaddleOCR + same preprocessing) via bead_ocr_paddle.py
- DeepSeek-OCR (VLM via Ollama) via bead_ocr_deepseek.py

Selected by OCR_ENGINE setting (default: "easy").
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Optional


# ── Data-driven code pattern (discovers valid prefixes from library) ───

_LIBRARY_PATH = Path(__file__).parent.parent / "data" / "default_colors.json"


def _load_library_codes() -> list[str]:
    with open(_LIBRARY_PATH) as f:
        entries = json.load(f)
    return [e["code"] for e in entries]


def _parse_code(text: str) -> Optional[str]:
    """Parse a code using the allowlist and pattern. Kept for backward compatibility."""
    if not text:
        return None
    # Lazy-import to avoid circular deps at module load
    from app.services.beader_ocr_easy import _parse_code as _easy_parse
    return _easy_parse(text)


def _get_ocr_min_conf() -> float:
    """Read OCR_MIN_CONF from settings. Lazy import avoids circular dep at module load."""
    try:
        from app.config import settings
        return settings.OCR_MIN_CONF
    except Exception:  # noqa: BLE001
        return 0.5


def _load_valid_codes() -> list[str]:
    return _load_library_codes()


def _get_ocr_engine() -> str:
    """Read OCR_ENGINE from settings. Defaults to 'easy'."""
    try:
        from app.config import settings
        return settings.OCR_ENGINE
    except Exception:  # noqa: BLE001
        return "easy"


# ── Per-cell grid OCR (user-crop path, bypassing grid detection) ────────


def ocr_cells_from_crop(
    image_bgr,
    user_rows: int,
    user_cols: int,
    crop_bbox: tuple[int, int, int, int],  # (x, y, w, h) in image pixels
    valid_codes: set[str] | None = None,
    min_conf: float | None = None,
    max_workers: int = 20,
) -> dict[tuple[int, int], tuple[str, float]]:
    """OCR every cell in a user-cropped region of the bead board.

    Delegates to Plan A (EasyOCR) or Plan B (PaddleOCR) based on
    the OCR_ENGINE setting in config. Both variants use adaptive
    per-cell preprocessing for improved accuracy.

    Returns:
        ``{(row, col): (bead_code, confidence)}``  — one entry per cell
        for which the OCR parser returned a valid Perler bead code
        (filtered by ``valid_codes`` if provided).
    """
    if min_conf is None:
        min_conf = _get_ocr_min_conf()

    engine = _get_ocr_engine()
    if engine == "paddle":
        from app.services.bead_ocr_paddle import ocr_cells_from_crop_paddle
        return ocr_cells_from_crop_paddle(
            image_bgr, user_rows, user_cols, crop_bbox,
            valid_codes=valid_codes, min_conf=min_conf,
            max_workers=max_workers,
        )
    if engine == "template":
        # Plan B: zero-training glyph template matching (NCC). Cheapest
        # baseline; good on synthetic fixtures, brittle on real photos.
        from app.services.bead_ocr_template import ocr_cells_from_crop_template
        return ocr_cells_from_crop_template(
            image_bgr, user_rows, user_cols, crop_bbox,
            valid_codes=valid_codes, min_conf=min_conf,
            max_workers=max_workers,
        )
    if engine == "deepseek":
        from app.services.bead_ocr_deepseek import ocr_cells_from_crop_deepseek
        return ocr_cells_from_crop_deepseek(
            image_bgr, user_rows, user_cols, crop_bbox,
            valid_codes=valid_codes, min_conf=min_conf,
        )
    if engine == "crnn":
        from app.services.bead_ocr_crnn_inference import ocr_cells_from_crop_crnn
        return ocr_cells_from_crop_crnn(
            image_bgr, user_rows, user_cols, crop_bbox,
            valid_codes=valid_codes, min_conf=min_conf,
        )
    # Default: EasyOCR (Plan A)
    from app.services.bead_ocr_easy import ocr_cells_from_crop_easy
    return ocr_cells_from_crop_easy(
        image_bgr, user_rows, user_cols, crop_bbox,
        valid_codes=valid_codes, min_conf=min_conf,
        max_workers=max_workers,
    )
