"""Precise bead-board grid detection using blue major gridlines and FFT."""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from scipy.signal import find_peaks


@dataclass
class BeadGrid:
    x0: int
    y0: int
    rows: int
    cols: int
    cell_w: float
    cell_h: float

    @property
    def width(self) -> int:
        return int(round(self.cols * self.cell_w))

    @property
    def height(self) -> int:
        return int(round(self.rows * self.cell_h))

    def cell_rect(self, row: int, col: int) -> tuple[int, int, int, int]:
        x = int(round(self.x0 + col * self.cell_w))
        y = int(round(self.y0 + row * self.cell_h))
        w = max(1, int(round(self.cell_w)))
        h = max(1, int(round(self.cell_h)))
        return x, y, w, h


def _find_blue_lines(image_bgr: np.ndarray, axis: str) -> np.ndarray:
    """Find positions of pure-blue 1-px guide lines.

    Returns sorted array of x-coords (axis='v') or y-coords (axis='h').

    Tighter HSV mask than the original: we look for the *saturated* blue
    used by 1-px grid lines (H≈120, S≥200, V≥200) and explicitly exclude
    dark/medium-saturated palette colours that were triggering false
    positives on the synthetic fixtures (which paint cell text using
    full-saturation palette colours).
    """
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    # Tight blue: only the bright, fully-saturated blue used for guide lines.
    blue_mask = cv2.inRange(hsv, (118, 200, 200), (122, 256, 256))
    # Optional: also catch deep blue (H≈120) that's slightly desaturated
    # (e.g. anti-aliased 1-px lines).  Still tight on H to avoid palette.
    blue_mask |= cv2.inRange(hsv, (115, 150, 150), (125, 256, 256))
    # Sum mask along the appropriate axis to get a 1D profile.
    if axis == 'v':
        proj = blue_mask.sum(axis=0)  # 1 px → small, grid line → very tall
    else:
        proj = blue_mask.sum(axis=1)
    # Relative threshold: real 1-px lines produce tall peaks, noise is short.
    # At least 50% of the strongest peak counts as a real line.
    if proj.max() < 5:
        return np.array([], dtype=int)
    threshold = max(5, int(proj.max() * 0.5))
    # distance must be < cell size; we don't know cell size yet, use 5px.
    # ``wlen`` constrains peak search so a slow drift doesn't merge peaks
    # at the edges — the *first and last* valid grid lines (col 0 and col W-1)
    # sit exactly on the image border, which is a real local maximum but
    # ``find_peaks`` misses it by default.  Pad the projection with one
    # zero on each side so the border peaks become "interior" and get
    # detected.  The returned indices are then shifted back by 1.
    peaks, _ = find_peaks(proj, height=threshold, distance=5, wlen=5)
    # Try harder: look for peaks that are also strong (relative to neighbors).
    # Add the image border as a synthetic peak if it itself is strong.
    pad = np.concatenate(([0], proj, [0]))
    border_peaks, _ = find_peaks(pad, height=threshold, distance=5)
    # shift back
    border_peaks = border_peaks[(border_peaks > 0) & (border_peaks < len(pad) - 1)] - 1
    if proj[0] >= threshold:
        border_peaks = np.concatenate(([0], border_peaks))
    if proj[-1] >= threshold:
        border_peaks = np.concatenate((border_peaks, [len(proj) - 1]))
    peaks = np.unique(np.concatenate((peaks, border_peaks)))
    return np.sort(peaks)


def _detect_cell_period(image_bgr: np.ndarray, axis: str,
                        section_lines: np.ndarray) -> float | None:
    """Estimate cell period (in pixels) within one section using FFT."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    lo, hi = section_lines[0], section_lines[1]
    if axis == 'v':
        strip = gray[:, lo:hi]
        proj = np.mean(strip, axis=0)
    else:
        strip = gray[lo:hi, :]
        proj = np.mean(strip, axis=1)

    if len(proj) < 16:
        return None

    centered = proj - proj.mean()
    fft = np.fft.rfft(centered)
    freqs = np.fft.rfftfreq(len(proj))
    power = np.abs(fft)
    power[0] = 0

    section_freq = 1.0 / max(1, len(proj))
    section_freq_idx = int(np.argmin(np.abs(freqs - section_freq)))
    power[max(0, section_freq_idx - 1):section_freq_idx + 2] = 0

    peak_idx = int(np.argmax(power))
    dom_freq = float(freqs[peak_idx])
    if dom_freq <= 0:
        return None
    return 1.0 / dom_freq


def _fit_cells_per_section(image_bgr: np.ndarray, axis: str,
                            section_lines: np.ndarray) -> tuple[float, int] | None:
    """Try every reasonable (cells_per_section) and pick the one whose period
    most strongly correlates with the actual gray profile. Prefer more cells
    per section when scores are close (smaller cells = higher resolution)."""
    section_size = section_lines[1] - section_lines[0]
    candidates = []
    for n in (3, 4, 5, 6, 7, 8, 10, 12, 14):
        if section_size / n < 6:
            continue
        candidates.append(n)

    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    if axis == 'v':
        proj = np.mean(gray[:, section_lines[0]:section_lines[1]], axis=0)
    else:
        proj = np.mean(gray[section_lines[0]:section_lines[1], :], axis=1)

    scored = []
    for n in candidates:
        cell_period = section_size / n
        score = _score_period(proj, cell_period, n)
        scored.append((score, n, cell_period))
    scored.sort(key=lambda x: (-x[0], -x[1]))
    if not scored or scored[0][0] <= 0:
        return None
    return (scored[0][2], scored[0][1])


def _score_period(proj: np.ndarray, period: float, n: int) -> float:
    """Score by counting how many expected grid-line positions fall on actual
    dark dips in the projection. Higher = more lines correctly aligned."""
    L = len(proj)
    expected_positions = [int(round(i * period)) for i in range(1, n)]
    window = max(1, int(period * 0.2))
    if not expected_positions:
        return 0.0
    bg = float(np.median(proj))
    threshold = bg - 15
    hits = 0
    for p in expected_positions:
        lo = max(0, p - window)
        hi = min(L, p + window + 1)
        if lo >= hi:
            continue
        if proj[lo:hi].min() < threshold:
            hits += 1
    return hits / len(expected_positions)


def detect_grid(image_bgr: np.ndarray) -> BeadGrid | None:
    """Detect the bead-board grid from blue 1-px guide lines.

    Two supported layouts:
      1. **Per-cell lines** (synthetic fixtures): blue lines are drawn at
         every cell boundary, so ``len(lines) - 1 == num_cells`` and
         cell_w = median spacing.
      2. **Section lines** (older templates): blue lines bracket groups
         of cells, so we still fall back to the period-scoring
         heuristic.

    The per-cell path is preferred whenever the line count is compatible
    with a Perler-board dimension (≤ ~100), since it requires no FFT.
    """
    h, w = image_bgr.shape[:2]
    v_lines = _find_blue_lines(image_bgr, 'v')
    h_lines = _find_blue_lines(image_bgr, 'h')
    if len(v_lines) < 3 or len(h_lines) < 3:
        return None

    # ── Path 1: per-cell blue lines (lines = cell boundaries) ──
    # For a 29×29 board drawn at the edges there are 30 line positions
    # (0, 32, …, 928).  The image border line at col == w-1 may sit one
    # pixel past the image and not be detected.  Infer cell count from
    # the *span between the first and last detected line* divided by the
    # median line spacing — this is robust to one missing border line.
    if len(v_lines) >= 2 and len(h_lines) >= 2:
        v_span = float(v_lines[-1] - v_lines[0])
        h_span = float(h_lines[-1] - h_lines[0])
        v_step = float(np.median(np.diff(v_lines)))
        h_step = float(np.median(np.diff(h_lines)))
        if v_step > 0 and h_step > 0 and 5 < v_step < 200 and 5 < h_step < 200:
            cols_per = max(1, int(round(v_span / v_step)) + 1)
            rows_per = max(1, int(round(h_span / h_step)) + 1)
            if 5 < cols_per < 200 and 5 < rows_per < 200:
                return BeadGrid(
                    x0=int(v_lines[0]), y0=int(h_lines[0]),
                    rows=rows_per, cols=cols_per,
                    cell_w=v_step, cell_h=h_step,
                )

    # ── Path 2: section blue lines (FFT period) ──
    v_fit = _fit_cells_per_section(image_bgr, 'v', v_lines)
    h_fit = _fit_cells_per_section(image_bgr, 'h', h_lines)
    if v_fit is None or h_fit is None:
        return None
    cell_w, cps_v = v_fit
    cell_h, cps_h = h_fit

    v_med = float(np.median(np.diff(v_lines)))
    h_med = float(np.median(np.diff(h_lines)))

    total_span_v = v_lines[-1] - v_lines[0]
    total_span_h = h_lines[-1] - h_lines[0]
    cols = int(round(total_span_v / cell_w)) + cps_v
    rows = int(round(total_span_h / cell_h)) + cps_h

    x0 = int(round(v_lines[0] + cell_w / 2))
    y0 = int(round(h_lines[0] + cell_h / 2))
    if x0 + int(round(cols * cell_w)) > w:
        cols = int((w - x0) // cell_w)
    if y0 + int(round(rows * cell_h)) > h:
        rows = int((h - y0) // cell_h)
    if cols <= 0 or rows <= 0:
        return None

    return BeadGrid(x0=x0, y0=y0, rows=rows, cols=cols,
                    cell_w=cell_w, cell_h=cell_h)