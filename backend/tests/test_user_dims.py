"""Tests for T8 — Wire user-supplied grid dimensions through the API.

Verifies:
  1. BeadPatternParser.parse() accepts user_rows/user_cols kwargs.
  2. With user_rows+user_cols, grid dimensions match the supplied values.
  3. Providing only user_rows does not trigger the user-override shortcut.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from app.services.bead_parser import BeadPatternParser
from app.services.pipeline.blue_line_grid_detector import BlueLineGridDetector

FIXTURES = Path(__file__).parent / "fixtures" / "templates"
NO_BLUE_LINE = str(FIXTURES / "template_29x29_s2.png")


def test_parse_accepts_user_dims_kwarg():
    """parse() must accept user_rows/user_cols kwargs without TypeError."""
    # Mock at the module where the stub looks it up (avoids import binding issue).
    p = BeadPatternParser()
    p._pipeline = None  # force rebuild after patch
    with patch("app.services.bead_grid_detector.detect_grid", return_value=None):
        with patch("app.services.bead_ocr.ocr_board", return_value={}):
            result = p.parse(NO_BLUE_LINE, user_rows=29, user_cols=29)
    assert result["grid_rows"] == 29
    assert result["grid_cols"] == 29


def test_user_dims_override_source_is_user():
    """When user dims are provided, the GridResult source should be 'user'."""
    import numpy as np
    det = BlueLineGridDetector()
    img = np.zeros((300, 300, 3), dtype=np.uint8)
    result = det.detect(img, user_rows=29, user_cols=29)
    assert result is not None
    assert result.source == "user"
    assert result.rows == 29
    assert result.cols == 29


def test_user_dims_without_user_cols_runs_fft():
    """Providing only user_rows does NOT trigger the user_override shortcut.

    The detector falls through to FFT / fallback. Mock just to avoid OOM.
    """
    p = BeadPatternParser()
    p._pipeline = None
    with patch("app.services.bead_grid_detector.detect_grid", return_value=None):
        with patch("app.services.bead_ocr.ocr_board", return_value={}):
            result = p.parse(NO_BLUE_LINE, user_rows=29)
    assert isinstance(result, dict)
    assert "grid_rows" in result
    assert "grid_cols" in result
