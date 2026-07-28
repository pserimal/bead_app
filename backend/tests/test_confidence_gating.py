"""Tests for T12 — OTSU + Adaptive Gaussian + confidence gating.

Verifies:
  1. _preprocess_variants produces 6 variants (4 fixed + OTSU + Adaptive Gaussian)
  2. ocr_board respects OCR_MIN_CONF threshold
  3. OTSU variant handles uniform images (returns either 0 or 255 for all pixels)
"""
from __future__ import annotations

from unittest.mock import patch

import cv2
import numpy as np
import pytest

from app.services.bead_ocr import _preprocess_variants, ocr_board
from app.services.bead_grid_detector import BeadGrid


# ── 1. _preprocess_variants count ────────────────────────────────────────


def test_preprocess_variants_returns_six():
    gray = np.full((64, 64), 128, dtype=np.uint8)
    variants = _preprocess_variants(gray)
    assert len(variants) == 6


def test_preprocess_variants_includes_otsu():
    gray = np.full((64, 64), 128, dtype=np.uint8)
    names = [name for name, _ in _preprocess_variants(gray)]
    assert "otsu" in names
    assert "adaptive_gauss" in names


def test_preprocess_variants_returns_valid_arrays():
    gray = np.full((64, 64), 128, dtype=np.uint8)
    variants = _preprocess_variants(gray)
    for name, arr in variants:
        assert arr.shape == gray.shape, f"{name}: shape mismatch"
        # Binarized output must be 0 or 255
        unique = set(np.unique(arr).tolist())
        assert unique <= {0, 255}, f"{name}: non-binary output {unique}"


# ── 2. ocr_board respects OCR_MIN_CONF ──────────────────────────────────


class _FakeReader:
    """Returns a hard-coded detection set regardless of input."""
    def __init__(self, detections):
        self._detections = detections

    def readtext(self, image, detail, paragraph, allowlist,
                 text_threshold, low_text, link_threshold):
        return self._detections


def _detections_with_confidences(*confs: float):
    """Build (bbox, text, conf) tuples — one per conf value.

    Coordinates are in BIG (3× upscaled) image space. With cell_w=32 in
    board space, big-space cell width is 96. We centre each detection
    in the middle of a distinct cell column.
    """
    out = []
    for i, conf in enumerate(confs):
        # Cell centres in big space: 48 (col 0), 144 (col 1), 240 (col 2)
        cx = 48.0 + i * 96.0
        bbox = [[cx - 5, 48 - 5], [cx + 5, 48 - 5],
                [cx + 5, 48 + 5], [cx - 5, 48 + 5]]
        out.append((bbox, "H7", conf))
    return out


@pytest.fixture(autouse=True)
def _mock_easyocr(monkeypatch):
    """Replace EasyOCR reader with one that returns our controlled detections."""
    reader = _FakeReader(_detections_with_confidences(0.3, 0.6, 0.9))
    monkeypatch.setattr("app.services.bead_ocr._get_reader", lambda: reader)
    monkeypatch.setattr("app.services.bead_ocr._parse_code", lambda t: "H7")


def test_high_confidence_keeps_all_detections(monkeypatch):
    """With OCR_MIN_CONF=0.0, all detections survive."""
    monkeypatch.setattr("app.config.settings.OCR_MIN_CONF", 0.0)
    grid = BeadGrid(x0=0, y0=0, rows=1, cols=3, cell_w=32.0, cell_h=32.0)
    img = np.zeros((100, 200, 3), dtype=np.uint8)
    result = ocr_board(img, grid)
    assert len(result) == 3, f"all 3 detections should survive, got {len(result)}"


def test_low_confidence_filtered(monkeypatch):
    """With OCR_MIN_CONF=0.5, only conf ≥ 0.5 detections survive (i.e. 0.6 and 0.9)."""
    monkeypatch.setattr("app.config.settings.OCR_MIN_CONF", 0.5)
    grid = BeadGrid(x0=0, y0=0, rows=1, cols=3, cell_w=32.0, cell_h=32.0)
    img = np.zeros((100, 200, 3), dtype=np.uint8)
    result = ocr_board(img, grid)
    assert len(result) == 2, f"only conf ≥ 0.5 should survive, got {len(result)}"


def test_very_high_confidence_filters_almost_all(monkeypatch):
    """With OCR_MIN_CONF=0.99, only conf 0.9 detection fails (0.9 < 0.99)."""
    monkeypatch.setattr("app.config.settings.OCR_MIN_CONF", 0.99)
    grid = BeadGrid(x0=0, y0=0, rows=1, cols=3, cell_w=32.0, cell_h=32.0)
    img = np.zeros((100, 200, 3), dtype=np.uint8)
    result = ocr_board(img, grid)
    assert len(result) == 0, "no detections should survive threshold 0.99"


def test_default_confidence_is_0_5(monkeypatch):
    """Sanity check: the default config value is 0.5."""
    # We need to reload settings to get default — use a fresh import.
    import importlib
    import app.config as cfg_mod
    importlib.reload(cfg_mod)
    assert cfg_mod.settings.OCR_MIN_CONF == 0.5