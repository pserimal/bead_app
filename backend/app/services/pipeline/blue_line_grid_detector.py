"""Stub GridDetector / CodeReader adapters (T7, T8, T9).

These adapters delegate to the existing functional pipeline:
  - BlueLineGridDetector  → bead_grid_detector.detect_grid
  - EasyOcrCodeReader    → bead_ocr.ocr_board

They adapt the legacy return shapes (`BeadGrid`, `dict[(r,c), (code,conf)]`)
to the `pipeline/interfaces.py` contracts (`GridResult`, `list[CodeResult]`).

T14 renames these classes to BlueLineGridDetector / EasyOcrCodeReader.
"""
from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks

from app.services import bead_grid_detector
from app.services.pipeline.interfaces import CodeReader, CodeResult, GridCell, GridDetector, GridResult


# ── Constants for the fallback chain ─────────────────────────────────────

STANDARD_BOARD_SIZES: list[tuple[int, int]] = [
    (29, 29), (49, 39), (69, 49), (79, 57),
]
SIZE_CLAMP_TOLERANCE: int = 2


# ── Helpers ──────────────────────────────────────────────────────────────


def _build_cells(x0: int, y0: int, rows: int, cols: int,
                 cell_w: float, cell_h: float) -> list[GridCell]:
    return [
        GridCell(
            row=r, col=c,
            x=int(round(x0 + c * cell_w)),
            y=int(round(y0 + r * cell_h)),
            w=max(1, int(round(cell_w))),
            h=max(1, int(round(cell_h))),
        )
        for r in range(rows)
        for c in range(cols)
    ]


def _clamp_to_standard(rows: int, cols: int) -> tuple[int, int] | None:
    """If (rows, cols) is within ±SIZE_CLAMP_TOLERANCE of a standard size, snap."""
    for s_rows, s_cols in STANDARD_BOARD_SIZES:
        if abs(rows - s_rows) <= SIZE_CLAMP_TOLERANCE \
                and abs(cols - s_cols) <= SIZE_CLAMP_TOLERANCE:
            return (s_rows, s_cols)
    return None


def _grid_from_image_size(image: np.ndarray, rows: int, cols: int) -> GridResult:
    """Build a GridResult from image dimensions and target rows/cols."""
    h, w = image.shape[:2]
    cell_w = w / cols
    cell_h = h / rows
    return GridResult(
        rows=rows, cols=cols,
        x0=0, y0=0,
        cell_w=cell_w, cell_h=cell_h,
        cells=_build_cells(0, 0, rows, cols, cell_w, cell_h),
        source="user",
    )


# ── BlueLineGridDetector ─────────────────────────────────────────────────────


class BlueLineGridDetector(GridDetector):
    """Strategy chain for grid detection.

    Strategies run in order; the first to return a non-None result wins:
      G1 user_dims_override   — when user_rows/cols are both provided
      G2 blue_line_fft        — primary path via bead_grid_detector.detect_grid
      G3 projection_peak      — grayscale row/col projection + peak finding
      G4 hough_lines          — cv2.HoughLinesP (deferred — not yet implemented)
      G5 clamp_to_standard    — snap detected dims to a known Perler board size

    Each strategy receives the image and the user's hint kwargs. G3–G5 only
    run when BACKEND_FALLBACK_ENABLED=True (env / config knob).
    """

    def detect(
        self,
        image: np.ndarray,
        *,
        user_rows: int | None = None,
        user_cols: int | None = None,
        user_bbox: tuple | None = None,
    ) -> GridResult | None:
        # ── G1: user_dims_override ────────────────────────────────────
        if user_rows is not None and user_cols is not None:
            return self._user_dims_override(image, user_rows, user_cols)

        # ── G2: blue_line_fft ─────────────────────────────────────────
        result = self._blue_line_fft(image)
        if result is not None:
            return result

        # ── Fallback chain (skipped when feature flag off) ────────────
        try:
            from app.config import settings
            fallback_enabled = bool(settings.BACKEND_FALLBACK_ENABLED)
        except Exception:  # noqa: BLE001
            fallback_enabled = True

        if not fallback_enabled:
            return None

        # ── G3: projection_peak ───────────────────────────────────────
        result = self._projection_peak(image)
        if result is not None:
            snapped = _clamp_to_standard(result.rows, result.cols)
            if snapped is not None:
                result = GridResult(
                    rows=snapped[0], cols=snapped[1],
                    x0=result.x0, y0=result.y0,
                    cell_w=result.cell_w, cell_h=result.cell_h,
                    cells=result.cells, source="clamp",
                )
            return result

        # ── G4: hough_lines (deferred) ────────────────────────────────
        # Not yet implemented. Future work.

        return None

    # ── G1 ─────────────────────────────────────────────────────────────
    def _user_dims_override(self, image: np.ndarray,
                             user_rows: int, user_cols: int) -> GridResult:
        """Use the user-supplied dimensions directly.

        Try to derive cell_w/cell_h from FFT first; if that fails, fall
        back to blue-line detection (without requiring FFT cell fitting).
        If both fail, divide the image by the user dimensions to get a
        rough cell size.
        """
        bead_grid = bead_grid_detector.detect_grid(image)
        if bead_grid is not None:
            cell_w, cell_h = float(bead_grid.cell_w), float(bead_grid.cell_h)
            return GridResult(
                rows=user_rows, cols=user_cols,
                x0=bead_grid.x0, y0=bead_grid.y0,
                cell_w=cell_w, cell_h=cell_h,
                cells=_build_cells(bead_grid.x0, bead_grid.y0,
                                    user_rows, user_cols, cell_w, cell_h),
                source="user",
            )
        # detect_grid() returned None — no usable blue-line signal.  Use
        # the user-supplied dimensions and a fallback cell size from image.
        h, w = image.shape[:2]
        cell_w = w / user_cols
        cell_h = h / user_rows
        return GridResult(
            rows=user_rows, cols=user_cols,
            x0=0, y0=0,
            cell_w=cell_w, cell_h=cell_h,
            cells=_build_cells(0, 0, user_rows, user_cols, cell_w, cell_h),
            source="user",
        )

    # ── G2 ─────────────────────────────────────────────────────────────
    def _blue_line_fft(self, image: np.ndarray) -> GridResult | None:
        bead_grid = bead_grid_detector.detect_grid(image)
        if bead_grid is None:
            return None
        cells = [
            GridCell(
                row=row, col=col,
                x=bead_grid.cell_rect(row, col)[0],
                y=bead_grid.cell_rect(row, col)[1],
                w=bead_grid.cell_rect(row, col)[2],
                h=bead_grid.cell_rect(row, col)[3],
            )
            for row in range(bead_grid.rows)
            for col in range(bead_grid.cols)
        ]
        return GridResult(
            rows=bead_grid.rows,
            cols=bead_grid.cols,
            x0=bead_grid.x0,
            y0=bead_grid.y0,
            cell_w=float(bead_grid.cell_w),
            cell_h=float(bead_grid.cell_h),
            cells=cells,
            source="fft",
        )

    # ── G3 ─────────────────────────────────────────────────────────────
    def _projection_peak(self, image: np.ndarray) -> GridResult | None:
        """Sobel-edge projection fallback for templates without blue lines.

        Strategy: cell content (text, colored backgrounds) creates
        high-density edge pixels.  Cell *boundaries* (1-px white strips
        between cells) are minima in the per-column edge-density profile.
        We invert the profile, then run ``_infer_count_from_projection``
        on the inverted signal.
        """
        import cv2
        gray = _to_gray(image)
        if gray is None:
            return None
        # Sobel gradient magnitude.  Use float to keep small values.
        sx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
        sy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
        # Per-column / per-row sum of |gradient| — high in cell interiors,
        # low on cell boundaries.
        v_density = np.abs(sx).sum(axis=0).astype(np.float64)
        h_density = np.abs(sy).sum(axis=1).astype(np.float64)
        # Invert so cell boundaries become peaks (as required by the
        # generic peak-finder in ``_infer_count_from_projection``).
        v_inv = v_density.max() - v_density
        h_inv = h_density.max() - h_density

        rows = _infer_count_from_projection(h_inv)
        cols = _infer_count_from_projection(v_inv)
        if rows is None or cols is None or rows < 3 or cols < 3:
            return None

        # The Sobel fallback is unreliable without a strong periodic
        # signal — only return if it lands on a known standard size.
        snapped = _clamp_to_standard(rows, cols)
        if snapped is None:
            return None
        rows, cols = snapped
        h, w = gray.shape
        cell_w = w / cols
        cell_h = h / rows
        return GridResult(
            rows=rows, cols=cols,
            x0=0, y0=0,
            cell_w=cell_w, cell_h=cell_h,
            cells=_build_cells(0, 0, rows, cols, cell_w, cell_h),
            source="clamp",
        )


def _to_gray(image: np.ndarray) -> np.ndarray | None:
    """Convert BGR image to grayscale. Returns None for empty input."""
    if image is None or image.size == 0:
        return None
    if image.ndim == 2:
        return image
    return cv2_rgb_to_gray(image)


def cv2_rgb_to_gray(image: np.ndarray) -> np.ndarray:
    """Convert BGR to grayscale using the standard luminance formula."""
    import cv2
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def _infer_count_from_projection(proj: np.ndarray) -> int | None:
    """Infer number of cells from a 1D projection profile.

    Counts peaks (cell lines) and uses the median spacing to compute
    the total count. Returns None if fewer than 3 peaks are found.
    """
    if proj.size < 6:
        return None
    peaks, _ = find_peaks(proj, height=max(2, proj.max() * 0.3), distance=3)
    if len(peaks) < 3:
        return None
    diffs = np.diff(peaks)
    median_spacing = float(np.median(diffs))
    if median_spacing <= 0:
        return None
    return max(3, int(round(proj.size / median_spacing)))