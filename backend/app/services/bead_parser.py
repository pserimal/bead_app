"""Bead-pattern parser.

Pipeline:
  1. Detect the bead board grid using blue major grid lines as anchors.
  2. OCR the entire board in a single pass, map detections to (row, col).
  3. Look up each detected code in the Perler color library.

This is the high-level façade. The actual work is delegated to the
pluggable `pipeline` package: `Pipeline(GridDetector, CodeReader)`.
Concrete implementations live in `pipeline/blue_line_grid_detector.py`
(`BlueLineGridDetector`) and `pipeline/easy_ocr_code_reader.py`
(`EasyOcrCodeReader`).
"""
from __future__ import annotations

import json
from pathlib import Path

from app.services.pipeline.blue_line_grid_detector import BlueLineGridDetector
from app.services.pipeline.easy_ocr_code_reader import EasyOcrCodeReader
from app.services.pipeline.interfaces import PipelineResult


_LIBRARY_PATH = Path(__file__).parent.parent / "data" / "default_colors.json"


def _load_color_library() -> dict[str, dict]:
    with open(_LIBRARY_PATH) as f:
        entries = json.load(f)
    return {e["code"]: e for e in entries}


_COLOR_LIBRARY = _load_color_library()


def _hydrate_cell(bead_code: str | None, confidence: float, ocr_text: str | None) -> dict:
    """Build a legacy-shaped cell dict, joining the OCR code with color library metadata."""
    if bead_code is None:
        return {
            "row": 0,                # filled in by caller
            "col": 0,                # filled in by caller
            "bead_code": None,
            "pixel_color": None,
            "color_name": None,
            "confidence": confidence,
            "ocr_text": ocr_text,
        }
    entry = _COLOR_LIBRARY.get(bead_code)
    if entry is None:
        return {
            "row": 0,
            "col": 0,
            "bead_code": bead_code,
            "pixel_color": None,
            "color_name": None,
            "confidence": confidence,
            "ocr_text": ocr_text,
        }
    return {
        "row": 0,
        "col": 0,
        "bead_code": bead_code,
        "pixel_color": entry["color_hex"],
        "color_name": entry.get("color_name"),
        "confidence": confidence,
        "ocr_text": ocr_text,
    }


class BeadPatternParser:
    """Parse a Perler bead board image into a list of (row, col, code, color)."""

    def __init__(self):
        self.color_library = _COLOR_LIBRARY
        # Lazily built on first parse() so unit tests can construct a
        # BeadPatternParser without immediately wiring the live pipeline.
        self._pipeline = None

    def _get_pipeline(self):
        if self._pipeline is None:
            from app.services.pipeline import Pipeline

            self._pipeline = Pipeline(BlueLineGridDetector(), EasyOcrCodeReader())
        return self._pipeline

    def parse(self, image_path: str, **kwargs) -> dict:
        """Parse a bead board image.

        When ``user_bbox`` is provided (4-tuple ``(x, y, w, h)`` in image
        pixels), the grid-detection pipeline is bypassed entirely and the
        per-cell OCR path  (``ocr_cells_from_crop``) is used instead. This
        is the **preferred path for real-world images** — the user picks
        the board region and provides rows/cols explicitly.

        Returns the legacy dict shape that downstream code
        (`blueprint_service.save_parsed_cells`, integration tests) expects:

            {
                "grid_rows": int,
                "grid_cols": int,
                "cells": [{"row", "col", "bead_code", "pixel_color",
                           "color_name", "confidence", "ocr_text"}, ...],
                "detection_count": int,
                # On failure:
                "error": str,
            }
        """
        user_bbox = kwargs.pop("user_bbox", None)
        user_rows = kwargs.get("user_rows")
        user_cols = kwargs.get("user_cols")

        if user_bbox is not None:
            return self._parse_via_crop_cells(image_path, user_bbox, user_rows, user_cols)

        try:
            result = self._get_pipeline().parse(image_path, **kwargs)
        except FileNotFoundError:
            raise
        except RuntimeError as exc:
            return {"grid_rows": 0, "grid_cols": 0, "cells": [],
                    "detection_count": 0,
                    "error": str(exc) or "Grid detection failed"}

        return _pipeline_result_to_legacy_dict(result)

    def _parse_via_crop_cells(
        self,
        image_path: str,
        user_bbox: tuple[int, int, int, int],
        user_rows: int | None,
        user_cols: int | None,
    ) -> dict:
        """User-crop OCR path — bypasses grid detection entirely."""
        import cv2

        img = cv2.imread(image_path)
        if img is None:
            raise FileNotFoundError(f"Cannot read image: {image_path}")

        if not user_rows or not user_cols or user_rows < 1 or user_cols < 1:
            return {"grid_rows": 0, "grid_cols": 0, "cells": [],
                    "detection_count": 0,
                    "error": "user_rows and user_cols are required with user_bbox"}

        from app.services.bead_ocr import ocr_cells_from_crop

        merged = ocr_cells_from_crop(
            image_bgr=img,
            user_rows=int(user_rows),
            user_cols=int(user_cols),
            crop_bbox=user_bbox,
        )

        return _cells_crop_result_to_legacy_dict(
            merged, int(user_rows), int(user_cols),
        )


def _pipeline_result_to_legacy_dict(result: PipelineResult) -> dict:
    """Convert a PipelineResult into the legacy BeadPatternParser dict shape."""
    cells: list[dict] = []
    detection_count = 0
    for code_res in result.cells:
        cell = _hydrate_cell(code_res.code, code_res.confidence, code_res.raw_text)
        cell["row"] = code_res.row
        cell["col"] = code_res.col
        cells.append(cell)
        if code_res.code is not None:
            detection_count += 1

    return {
        "grid_rows": result.grid_rows,
        "grid_cols": result.grid_cols,
        "cells": cells,
        "detection_count": detection_count,
        "grid_source": result.grid_source,
    }


def _cells_crop_result_to_legacy_dict(
    merged: dict[tuple[int, int], tuple[str, float]],
    grid_rows: int,
    grid_cols: int,
) -> dict:
    """Convert the dict from ocr_cells_from_crop into the legacy format."""
    cells: list[dict] = []
    detection_count = 0
    for r in range(grid_rows):
        for c in range(grid_cols):
            det = merged.get((r, c))
            if det is None:
                cells.append({
                    "row": r, "col": c,
                    "bead_code": None,
                    "pixel_color": None,
                    "color_name": None,
                    "confidence": 0.0,
                    "ocr_text": None,
                })
            else:
                code, conf = det
                cell = _hydrate_cell(code, conf, code)
                cell["row"] = r
                cell["col"] = c
                cells.append(cell)
                detection_count += 1

    return {
        "grid_rows": grid_rows,
        "grid_cols": grid_cols,
        "cells": cells,
        "detection_count": detection_count,
        "grid_source": "user_crop",
    }


def parse(image_path: str) -> dict:
    """Convenience function: parse a single bead board image."""
    return BeadPatternParser().parse(image_path)