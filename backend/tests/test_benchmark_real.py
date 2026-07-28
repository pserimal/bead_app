"""Unit tests for benchmark_real.py — no real OCR engines invoked."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import pytest


@pytest.fixture
def gt_file(tmp_path: Path) -> Path:
    """Write a small ground-truth JSON."""
    cells = []
    for r in range(2):
        for c in range(2):
            cells.append({
                "row": r, "col": c,
                "code": "H7" if (r, c) != (1, 1) else None,  # one needs_manual
                "confidence": 0.95,
                "source": "auto_high_conf",
            })
    gt_path = tmp_path / "tiny.gt.json"
    gt_path.write_text(json.dumps({"rows": 2, "cols": 2, "cells": cells}))
    return gt_path


@pytest.fixture
def tiny_image(tmp_path: Path) -> Path:
    """Write a tiny test image."""
    img_path = tmp_path / "tiny.png"
    cv2.imwrite(str(img_path), np.full((40, 40, 3), 255, dtype=np.uint8))
    return img_path


@patch("app.services.bead_ocr_paddle.ocr_cells_from_crop_paddle")
@patch("app.services.bead_ocr_easy.ocr_cells_from_crop_easy")
def test_easy_winner_when_higher_recall(mock_easy, mock_paddle, tiny_image, gt_file):
    """If EasyOCR has higher recall, winner='easy'."""
    from tests.benchmark_real import compare_engines  # noqa

    mock_easy.return_value = {(0, 0): ("H7", 0.95), (0, 1): ("H7", 0.95), (1, 0): ("H7", 0.95)}
    mock_paddle.return_value = {(0, 0): ("H7", 0.9), (1, 0): ("H7", 0.9)}

    result = compare_engines(str(tiny_image), str(gt_file), rows=2, cols=2)
    assert result["winner"] == "easy"
    assert result["easy"]["cell_recall"] == 1.0  # 3/3 correct
    assert result["paddle"]["cell_recall"] == pytest.approx(2/3)


@patch("app.services.bead_ocr_paddle.ocr_cells_from_crop_paddle")
@patch("app.services.bead_ocr_easy.ocr_cells_from_crop_easy")
def test_paddle_winner_when_higher_recall(mock_easy, mock_paddle, tiny_image, gt_file):
    """If PaddleOCR has higher recall, winner='paddle'."""
    from tests.benchmark_real import compare_engines  # noqa

    mock_easy.return_value = {(0, 0): ("H7", 0.95)}
    mock_paddle.return_value = {(0, 0): ("H7", 0.95), (0, 1): ("H7", 0.95), (1, 0): ("H7", 0.95)}

    result = compare_engines(str(tiny_image), str(gt_file), rows=2, cols=2)
    assert result["winner"] == "paddle"


@patch("app.services.bead_ocr_paddle.ocr_cells_from_crop_paddle")
@patch("app.services.bead_ocr_easy.ocr_cells_from_crop_easy")
def test_paddle_failure_falls_back_to_easy(mock_easy, mock_paddle, tiny_image, gt_file):
    """If PaddleOCR raises, winner still picks easy."""
    from tests.benchmark_real import compare_engines  # noqa

    mock_easy.return_value = {(0, 0): ("H7", 0.95)}
    mock_paddle.side_effect = RuntimeError("PaddleOCR API error")

    result = compare_engines(str(tiny_image), str(gt_file), rows=2, cols=2)
    assert result["winner"] == "easy"
    assert result["paddle"]["cell_recall"] == 0.0
