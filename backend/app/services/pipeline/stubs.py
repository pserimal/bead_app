"""Compatibility shim — imports and re-exports the concrete implementations.

Classes were renamed in T14:
  StubGridDetector   → BlueLineGridDetector (in blue_line_grid_detector.py)
  StubCodeReader    → EasyOcrCodeReader  (in easy_ocr_code_reader.py)

Tests and bead_parser.py still import from here; this shim re-exports
the new class names under the old names for backwards compatibility.
This file can be deleted once all imports are updated.
"""
from __future__ import annotations

from app.services.pipeline.blue_line_grid_detector import (
    BlueLineGridDetector as StubGridDetector,
    _clamp_to_standard,
)
from app.services.pipeline.easy_ocr_code_reader import EasyOcrCodeReader as StubCodeReader

__all__ = ["StubGridDetector", "StubCodeReader", "_clamp_to_standard"]
