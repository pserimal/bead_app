"""Tests for the pipeline interfaces (GridDetector, CodeReader, Pipeline).

These are pure DI sanity tests — no concrete implementations exist yet.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import numpy as np

from app.services.pipeline import (
    CodeReader,
    CodeResult,
    GridCell,
    GridDetector,
    GridResult,
    Pipeline,
    PipelineResult,
)


def test_module_imports():
    """All public symbols are importable."""
    assert Pipeline is not None
    assert GridDetector is not None
    assert CodeReader is not None
    assert GridResult is not None
    assert CodeResult is not None
    assert PipelineResult is not None
    assert GridCell is not None


def test_pipeline_parse_returns_pipeline_result(tmp_path):
    """Pipeline.parse returns a PipelineResult when both stages succeed."""
    # Build a dummy image
    img_path = tmp_path / "test_board.jpeg"
    dummy_img = np.zeros((200, 300, 3), dtype=np.uint8)
    import cv2
    cv2.imwrite(str(img_path), dummy_img)

    # Mock detector that returns a valid GridResult
    cell = GridCell(row=0, col=0, x=10, y=10, w=20, h=20)
    grid_result = GridResult(
        rows=1, cols=1, x0=10, y0=10,
        cell_w=20.0, cell_h=20.0,
        cells=[cell],
        source="fft",
    )
    mock_detector = MagicMock(spec=GridDetector)
    mock_detector.detect.return_value = grid_result

    # Mock reader that returns one CodeResult
    code_result = CodeResult(row=0, col=0, code="E11", confidence=0.95,
                             raw_text="E11")
    mock_reader = MagicMock(spec=CodeReader)
    mock_reader.read.return_value = [code_result]

    pipeline = Pipeline(mock_detector, mock_reader)
    result = pipeline.parse(str(img_path))

    assert isinstance(result, PipelineResult)
    assert result.grid_rows == 1
    assert result.grid_cols == 1
    assert len(result.cells) == 1
    assert result.cells[0].code == "E11"
    assert result.grid_source == "fft"


def test_pipeline_calls_detect_once(tmp_path):
    """Pipeline.parse calls detector.detect exactly once."""
    img_path = tmp_path / "test_board.jpeg"
    dummy_img = np.zeros((200, 300, 3), dtype=np.uint8)
    import cv2
    cv2.imwrite(str(img_path), dummy_img)

    cell = GridCell(row=0, col=0, x=10, y=10, w=20, h=20)
    grid_result = GridResult(
        rows=1, cols=1, x0=10, y0=10, cell_w=20.0, cell_h=20.0,
        cells=[cell], source="fft",
    )
    mock_detector = MagicMock(spec=GridDetector)
    mock_detector.detect.return_value = grid_result

    mock_reader = MagicMock(spec=CodeReader)
    mock_reader.read.return_value = [
        CodeResult(row=0, col=0, code="E11", confidence=0.95, raw_text="E11"),
    ]

    pipeline = Pipeline(mock_detector, mock_reader)
    pipeline.parse(str(img_path))

    mock_detector.detect.assert_called_once()
    # Verify the image passed is a numpy array
    args, _ = mock_detector.detect.call_args
    assert isinstance(args[0], np.ndarray)


def test_pipeline_calls_read_with_detected_cells(tmp_path):
    """Pipeline.parse calls reader.read exactly once with the cells from detect."""
    img_path = tmp_path / "test_board.jpeg"
    dummy_img = np.zeros((200, 300, 3), dtype=np.uint8)
    import cv2
    cv2.imwrite(str(img_path), dummy_img)

    cells = [
        GridCell(row=0, col=0, x=10, y=10, w=20, h=20),
        GridCell(row=0, col=1, x=30, y=10, w=20, h=20),
    ]
    grid_result = GridResult(
        rows=1, cols=2, x0=10, y0=10, cell_w=20.0, cell_h=20.0,
        cells=cells, source="fft",
    )
    mock_detector = MagicMock(spec=GridDetector)
    mock_detector.detect.return_value = grid_result

    mock_reader = MagicMock(spec=CodeReader)
    mock_reader.read.return_value = [
        CodeResult(row=0, col=0, code="E11", confidence=0.95, raw_text="E11"),
        CodeResult(row=0, col=1, code="H7", confidence=0.90, raw_text="H7"),
    ]

    pipeline = Pipeline(mock_detector, mock_reader)
    pipeline.parse(str(img_path))

    mock_reader.read.assert_called_once()
    args, _ = mock_reader.read.call_args
    # The first positional arg should be the cells list
    passed_cells = args[0]
    assert len(passed_cells) == 2
    assert passed_cells[0].row == 0
    assert passed_cells[0].col == 0
    assert passed_cells[1].row == 0
    assert passed_cells[1].col == 1


def test_pipeline_result_as_dict_uses_bead_code_field():
    """PipelineResult.as_dict() uses 'bead_code' (not 'code') in cell dicts."""
    result = PipelineResult(
        grid_rows=1,
        grid_cols=2,
        cells=[
            CodeResult(row=0, col=0, code="E11", confidence=0.95,
                       raw_text="E11"),
            CodeResult(row=0, col=1, code=None, confidence=0.0,
                       raw_text=None),
        ],
        grid_source="fft",
    )

    d = result.as_dict()
    assert d["grid_rows"] == 1
    assert d["grid_cols"] == 2
    assert len(d["cells"]) == 2

    # Must use 'bead_code', NOT 'code'
    cell0 = d["cells"][0]
    assert "bead_code" in cell0
    assert "code" not in cell0
    assert cell0["bead_code"] == "E11"
    assert cell0["confidence"] == 0.95
    assert cell0["ocr_text"] == "E11"
    assert cell0["pixel_color"] is None
    assert cell0["color_name"] is None

    # Second cell with no code
    cell1 = d["cells"][1]
    assert cell1["bead_code"] is None
    assert cell1["ocr_text"] is None
    assert cell1["confidence"] == 0.0
