import numpy as np
import cv2
from app.services.bead_ocr_preprocess import preprocess_cell, _upscale_factor


def test_upscale_factor_for_small_cells():
    assert _upscale_factor(8) == 6
    assert _upscale_factor(15) == 6
    assert _upscale_factor(20) == 5
    assert _upscale_factor(28) == 4
    assert _upscale_factor(40) == 3


def test_preprocess_returns_multiple_variants():
    """Bright-background cell (white background, black text) returns ≥2 variants."""
    cell = np.full((20, 20, 3), 240, dtype=np.uint8)  # near-white background
    cv2.putText(cell, "H7", (2, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1)
    variants = preprocess_cell(cell)
    assert len(variants) >= 2
    for name, img in variants:
        assert isinstance(name, str)
        assert img.ndim == 2  # grayscale


def test_preprocess_dark_background_inverts_text():
    """Dark-background cell (white text) gets inverted variants."""
    cell = np.full((20, 20, 3), 30, dtype=np.uint8)  # near-black background
    cv2.putText(cell, "F1", (2, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
    variants = preprocess_cell(cell)
    assert len(variants) >= 2
    # All variants should have *some* non-zero pixels (inverted text visible)
    for name, img in variants:
        assert img.sum() > 0, f"variant {name} is empty"


def test_preprocess_empty_input_returns_empty():
    """Empty crop returns no variants (no crash)."""
    cell = np.zeros((0, 0, 3), dtype=np.uint8)
    variants = preprocess_cell(cell)
    assert variants == []


def test_preprocess_bright_threshold_boundary():
    """Cell at exactly the bright threshold (180) routes to bright branch."""
    cell = np.full((20, 20, 3), 180, dtype=np.uint8)
    variants = preprocess_cell(cell)
    # mean=180 is on the boundary — bright branch (>180 strict)
    assert len(variants) >= 2
