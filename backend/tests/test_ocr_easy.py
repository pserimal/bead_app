"""Integration test: EasyOCR-enhanced crop OCR against a real image."""
from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.services.bead_ocr_easy import ocr_cells_from_crop_easy


REAL_IMAGE = "training/data/real/stand/拼豆日记54📔骑派大星（附图纸）_3_08e-_来自小红书网页版.jpg"
EXPECTED_ROWS = 72
EXPECTED_COLS = 56


@pytest.mark.slow
def test_easy_ocr_runs_on_real_image_and_returns_grid():
    """EasyOCR variant processes the real fixture without crashing."""
    img = cv2.imread(REAL_IMAGE)
    assert img is not None, f"missing fixture: {REAL_IMAGE}"
    h, w = img.shape[:2]

    result = ocr_cells_from_crop_easy(
        image_bgr=img,
        user_rows=EXPECTED_ROWS,
        user_cols=EXPECTED_COLS,
        crop_bbox=(0, 0, w, h),
    )

    assert isinstance(result, dict)
    assert len(result) <= EXPECTED_ROWS * EXPECTED_COLS
    for key, val in result.items():
        assert isinstance(key, tuple) and len(key) == 2
        assert 0 <= key[0] < EXPECTED_ROWS
        assert 0 <= key[1] < EXPECTED_COLS
        code, conf = val
        assert isinstance(code, str)
        assert isinstance(conf, float)
        assert 0.0 <= conf <= 1.0
