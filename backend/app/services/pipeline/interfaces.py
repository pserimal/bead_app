"""Pipeline interfaces for bead-board recognition.

Defines the data contracts (dataclasses) and behaviour contracts (Protocols)
for the grid detection → code reading pipeline.

No concrete implementations live here (see tasks T7+).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

import numpy as np


# ── Data contracts ──────────────────────────────────────────────────────────


@dataclass
class GridCell:
    """A single cell within the detected bead-board grid.

    Attributes:
        row: Zero-based row index.
        col: Zero-based column index.
        x: Pixel x-coordinate of the top-left corner.
        y: Pixel y-coordinate of the top-left corner.
        w: Width of the cell in pixels.
        h: Height of the cell in pixels.
    """
    row: int
    col: int
    x: int
    y: int
    w: int
    h: int


@dataclass
class GridResult:
    """Result of grid detection on a bead-board image.

    Attributes:
        rows: Number of grid rows.
        cols: Number of grid columns.
        x0: Pixel x-coordinate of the grid origin (top-left corner).
        y0: Pixel y-coordinate of the grid origin (top-left corner).
        cell_w: Average cell width in pixels.
        cell_h: Average cell height in pixels.
        cells: List of individual :class:`GridCell` instances.
        source: Detection method label — one of ``"user"``, ``"fft"``,
            ``"projection"``, ``"hough"``, ``"clamp"``.
    """
    rows: int
    cols: int
    x0: int
    y0: int
    cell_w: float
    cell_h: float
    cells: list[GridCell]
    source: str


@dataclass
class CodeResult:
    """OCR result for a single grid cell.

    **This is an internal Python object, not an API output schema.**
    The :attr:`code` field carries the raw parsed bead code;
    public-facing output uses ``bead_code`` via :meth:`PipelineResult.as_dict`.

    Attributes:
        row: Zero-based row index.
        col: Zero-based column index.
        code: Parsed bead code string (e.g. ``"E11"``), or ``None`` when
            no code could be read.
        confidence: OCR confidence score in ``[0, 1]``.
        raw_text: Raw OCR output text before parsing, or ``None``.
    """
    row: int
    col: int
    code: str | None
    confidence: float
    raw_text: str | None


@dataclass
class PipelineResult:
    """Final output of the full detection + OCR pipeline.

    Attributes:
        grid_rows: Number of grid rows detected.
        grid_cols: Number of grid columns detected.
        cells: Code-result per cell.
        grid_source: Method label for grid detection (see :attr:`GridResult.source`).
    """
    grid_rows: int
    grid_cols: int
    cells: list[CodeResult]
    grid_source: str

    def as_dict(self) -> dict:
        """Convert to the outer API-friendly dictionary format.

        The cell dictionaries use the **outer** field name ``bead_code``
        (not the internal ``code``) for compatibility with
        :meth:`blueprint_service.save_parsed_cells` and the existing
        :class:`BeadPatternParser` output shape.
        """
        return {
            "grid_rows": self.grid_rows,
            "grid_cols": self.grid_cols,
            "cells": [
                {
                    "row": cell.row,
                    "col": cell.col,
                    "bead_code": cell.code,
                    "pixel_color": None,
                    "color_name": None,
                    "confidence": cell.confidence,
                    "ocr_text": cell.raw_text,
                }
                for cell in self.cells
            ],
        }


# ── Behaviour contracts (Protocols) ────────────────────────────────────────


@runtime_checkable
class GridDetector(Protocol):
    """Protocol for bead-board grid detection.

    Implementations locate the grid of cells on a Perler bead board image
    and return the layout metadata together with per-cell bounding boxes.
    """

    def detect(
        self,
        image: np.ndarray,
        *,
        user_rows: int | None = None,
        user_cols: int | None = None,
        user_bbox: tuple | None = None,
    ) -> GridResult | None:
        """Run grid detection.

        Args:
            image: BGR (or grayscale) image loaded via OpenCV.
            user_rows: Optional hint — expected number of rows.
            user_cols: Optional hint — expected number of columns.
            user_bbox: Optional hint — bounding box ``(x, y, w, h)``
                circumscribing the bead board.

        Returns:
            Detected grid, or ``None`` if detection failed.
        """
        ...


@runtime_checkable
class CodeReader(Protocol):
    """Protocol for reading bead codes from grid cells.

    Implementations run OCR on each cell (or the whole board in one pass)
    and return a ``CodeResult`` per input cell.
    """

    def read(
        self,
        cells: list[GridCell],
        image: np.ndarray,
    ) -> list[CodeResult]:
        """Read bead codes from the detected grid cells.

        Args:
            cells: Grid cells from a :class:`GridResult`.
            image: Original BGR image loaded via OpenCV.

        Returns:
            One :class:`CodeResult` per input cell (same order).
        """
        ...


# ── Orchestrator ────────────────────────────────────────────────────────────


class Pipeline:
    """Orchestrator: grid detection → code reading.

    Both stages are injected as protocols, keeping the orchestrator
    decoupled from concrete implementations.
    """

    def __init__(self, detector: GridDetector, reader: CodeReader) -> None:
        self._detector = detector
        self._reader = reader

    def parse(self, image_path: str, **kwargs) -> PipelineResult:
        """Run the full recognition pipeline on a bead-board image.

        Args:
            image_path: Path to the image file on disk.
            **kwargs: Forwarded to ``self._detector.detect()``.

        Returns:
            A :class:`PipelineResult` with grid metadata and per-cell codes.

        Raises:
            FileNotFoundError: If the image cannot be read.
            RuntimeError: If grid detection returns ``None``.
        """
        import cv2

        # Imported lazily so tests can patch / disable dump_debug without
        # touching this module's import graph.
        from app.services.debug_io import dump_debug

        img = cv2.imread(image_path)
        if img is None:
            raise FileNotFoundError(f"Cannot read image: {image_path}")

        dump_debug("pre-grid", img, {"path": image_path, "kwargs": kwargs})

        grid = self._detector.detect(img, **kwargs)
        if grid is None:
            raise RuntimeError("Grid detection failed")

        dump_debug("post-grid", img, {
            "rows": grid.rows,
            "cols": grid.cols,
            "source": grid.source,
        })

        codes = self._reader.read(grid.cells, img)

        dump_debug("post-ocr", img, {
            "detection_count": sum(1 for c in codes if c.code is not None),
            "grid_rows": grid.rows,
            "grid_cols": grid.cols,
        })

        return PipelineResult(
            grid_rows=grid.rows,
            grid_cols=grid.cols,
            cells=codes,
            grid_source=grid.source,
        )
