"""Tests for T11 — round + clamp in cell mapping.

The core improvement is clamping (cells at the grid edge are no longer
silently dropped by `continue`). `round()` gives more balanced rounding
than `int()` truncation, but the clamp is the primary safety net.
"""
from __future__ import annotations

import numpy as np
import pytest

from app.services.bead_grid_detector import BeadGrid
from app.services.bead_ocr import _run_pass


# ── Direct unit test of the mapping logic ────────────────────────────────


def test_clamp_retains_edge_cells(monkeypatch):
    """Detections slightly outside the grid should be clamped, not dropped."""
    grid = BeadGrid(x0=0, y0=0, rows=3, cols=3, cell_w=32.0, cell_h=32.0)

    mock_results = [
        _make_bbox(-1.0, 16.0),      # slightly before col 0 → clamp to col 0
        _make_bbox(96.1, 16.0),      # slightly past col 2 → clamp to col 2
        _make_bbox(16.0, -1.0),      # slightly before row 0 → clamp to row 0
        _make_bbox(16.0, 96.1),      # slightly past row 2 → clamp to row 2
    ]
    mock_reader = _make_mock_reader(mock_results)
    monkeypatch.setattr("app.services.bead_ocr._get_reader", lambda: mock_reader)
    monkeypatch.setattr("app.services.bead_ocr._parse_code", lambda t: "H1")

    scale, x0, y0 = 1.0, 0, 0
    cells = _run_pass(np.zeros((200, 200, 3), dtype=np.uint8), scale, grid, x0, y0)

    assert cells.get((0, 0)) is not None, "slightly-left should clamp to col 0"
    assert cells.get((0, 2)) is not None, "slightly-right should clamp to col 2"
    assert cells.get((0, 0)) is not None, "slightly-above should clamp to row 0"
    assert cells.get((2, 0)) is not None, "slightly-below should clamp to row 2"


def test_clamp_handles_wide_off_grid(monkeypatch):
    """Wildly off detections must still be clamped, never dropped."""
    grid = BeadGrid(x0=0, y0=0, rows=2, cols=2, cell_w=32.0, cell_h=32.0)
    mock_results = [
        _make_bbox(-5000, 16.0),    # far left → clamp to col 0
        _make_bbox(50000, 48.0),    # far right → clamp to col 1
    ]
    mock_reader = _make_mock_reader(mock_results)
    monkeypatch.setattr("app.services.bead_ocr._get_reader", lambda: mock_reader)
    monkeypatch.setattr("app.services.bead_ocr._parse_code", lambda t: "H1")

    scale, x0, y0 = 1.0, 0, 0
    cells = _run_pass(np.zeros((200, 200, 3), dtype=np.uint8), scale, grid, x0, y0)
    assert cells.get((0, 0)) is not None, "far-left should clamp to col 0"
    assert cells.get((1, 1)) is not None, "far-right should clamp to col 1"


def test_introduced_round_vs_int_different_at_half_boundary(monkeypatch):
    """round() and int() differ only on fractional values ≥0.5.

    At a cell boundary where the fractional position is 0.5+,
    round() maps to the next integer and int() truncates.
    With clamp, both are accepted — the key is no cell is dropped.
    """
    grid = BeadGrid(x0=0, y0=0, rows=3, cols=3, cell_w=32.0, cell_h=32.0)

    # cx at position where (cx-x0)/cell_w = 1.5 exactly — the boundary
    # between round(1.5)=2 and int(1.5)=1
    CX_BOUNDARY = 1.5 * 32.0  # 48.0 → col 1.5 → round=2, int=1

    mock_results = [
        _make_bbox(CX_BOUNDARY, 16.0),
    ]
    mock_reader = _make_mock_reader(mock_results)
    monkeypatch.setattr("app.services.bead_ocr._get_reader", lambda: mock_reader)
    monkeypatch.setattr("app.services.bead_ocr._parse_code", lambda t: "H1")

    scale, x0, y0 = 1.0, 0, 0
    cells = _run_pass(np.zeros((200, 200, 3), dtype=np.uint8), scale, grid, x0, y0)

    # With clamp, this detection is never dropped regardless of
    # whether it maps to col 1 (int) or col 2 (round).
    assert len(cells) == 1, "the detection at boundary must survive"
    # It should be in a valid column
    col = list(cells.keys())[0][1]
    assert 0 <= col < 3, f"clamp must keep col in [0, 2], got {col}"


# ── Helpers ──────────────────────────────────────────────────────────────


def _make_bbox(cx: float, cy: float) -> tuple:
    """Create an EasyOCR-style bbox centred on (cx, cy)."""
    return (
        [[cx - 5, cy - 5], [cx + 5, cy - 5],
         [cx + 5, cy + 5], [cx - 5, cy + 5]],
        "H1",
        0.95,
    )


class _MockReader:
    def readtext(self, image, detail, paragraph, allowlist,
                 text_threshold, low_text, link_threshold):
        return self._results

    def __init__(self, results):
        self._results = results


def _make_mock_reader(results):
    return _MockReader(results)