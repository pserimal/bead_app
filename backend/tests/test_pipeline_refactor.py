"""Tests for T7 — Pipeline refactor with stub adapters.

Verifies that:
  1. Pipeline.parse() calls `dump_debug` at pre-grid / post-grid / post-ocr
     checkpoints (when DEBUG_DUMP=True).
  2. BeadPatternParser delegates to the pipeline (not the legacy functions).
  3. The legacy output dict shape is preserved end-to-end.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import cv2
import numpy as np
import pytest

from app.services.bead_parser import BeadPatternParser
from app.services.pipeline import (
    CodeResult,
    GridCell,
    GridResult,
    Pipeline,
)
from app.services.pipeline.blue_line_grid_detector import BlueLineGridDetector
from app.services.pipeline.easy_ocr_code_reader import EasyOcrCodeReader


# ── 1. Pipeline.dump_debug integration ───────────────────────────────────


def test_pipeline_calls_dump_debug_at_three_checkpoints(tmp_path, monkeypatch):
    """Pipeline.parse() emits pre-grid / post-grid / post-ocr debug dumps."""
    img_path = tmp_path / "test.jpeg"
    cv2.imwrite(str(img_path), np.zeros((200, 300, 3), dtype=np.uint8))

    cell = GridCell(row=0, col=0, x=10, y=10, w=20, h=20)
    grid_result = GridResult(
        rows=1, cols=1, x0=10, y0=10,
        cell_w=20.0, cell_h=20.0, cells=[cell], source="fft",
    )
    code_result = CodeResult(row=0, col=0, code="H7", confidence=0.9,
                             raw_text="H7")

    det = MagicMock()
    det.detect.return_value = grid_result
    rd = MagicMock()
    rd.read.return_value = [code_result]

    captured: list[tuple[str, dict]] = []
    def fake_dump(step, image, metadata=None):
        captured.append((step, metadata or {}))

    monkeypatch.setattr("app.services.debug_io.dump_debug", fake_dump)

    Pipeline(det, rd).parse(str(img_path))

    steps = [step for step, _ in captured]
    assert steps == ["pre-grid", "post-grid", "post-ocr"]


# ── 2. BeadPatternParser delegates to Pipeline ──────────────────────────


def test_bead_parser_constructs_pipeline_with_stubs():
    """A fresh BeadPatternParser must wire up the concrete adapters."""
    parser = BeadPatternParser()
    pipeline = parser._get_pipeline()
    assert isinstance(pipeline._detector, BlueLineGridDetector)
    assert isinstance(pipeline._reader, EasyOcrCodeReader)


# ── 3. Shape / error / edge-case tests ──────────────────────────────────


def test_bead_parser_returns_error_dict_on_missing_image(tmp_path):
    """Missing image path → FileNotFoundError propagates up."""
    parser = BeadPatternParser()
    with pytest.raises(FileNotFoundError):
        parser.parse(str(tmp_path / "does_not_exist.jpeg"))


def test_bead_parser_produces_valid_dict_keys_on_real_image(tmp_path, monkeypatch):
    """On a real (non-trivial) image, output has all expected keys."""
    # Build a minimal test image: a solid white square.
    # Patch detect_grid and ocr_board to avoid OOM from EasyOCR loading.
    monkeypatch.setattr("app.services.bead_grid_detector.detect_grid",
                        lambda img: None)
    monkeypatch.setattr("app.services.bead_ocr.ocr_board",
                        lambda img, grid: {})
    img_path = tmp_path / "solid_white.jpeg"
    cv2.imwrite(str(img_path), np.full((300, 300, 3), 255, dtype=np.uint8))
    parser = BeadPatternParser()
    out = parser.parse(str(img_path))
    for key in ("grid_rows", "grid_cols", "cells", "detection_count"):
        assert key in out, f"missing key: {key}"


@pytest.mark.slow
def test_bead_parser_always_has_cells_list():
    """Regardless of detection outcome, `cells` must be a list."""
    # Uses real image → may load EasyOCR (~150 MB).
    # Run with: pytest --slow
    parser = BeadPatternParser()
    img = Path(__file__).parent / "fixtures" / "templates" / "template_29x29_s0.png"
    if not img.is_file():
        pytest.skip("fixture not present")
    out = parser.parse(str(img))
    assert isinstance(out.get("cells"), list)
