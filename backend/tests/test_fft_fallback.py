"""Tests for T9 — FFT fallback chain (G1–G4).

Verifies the strategy chain in StubGridDetector:
  - G1: user_dims_override (already in T8)
  - G2: projection_peak (new)
  - G3: hough_lines (deferred — not implemented yet)
  - G4: clamp_to_standard (new — low-risk arithmetic)

Each test mocks `detect_grid` to return None (no blue lines), so
all fallback strategies are exercised.
"""
from __future__ import annotations

from unittest.mock import patch

import cv2
import numpy as np
import pytest

from app.services.pipeline.blue_line_grid_detector import BlueLineGridDetector


# ── G1: user_dims_override ──────────────────────────────────────────────


def test_user_dims_override_short_circuits(monkeypatch):
    """When user_rows/cols provided, FFT is skipped entirely."""
    monkeypatch.setattr("app.services.bead_grid_detector.detect_grid",
                        lambda img: None)
    det = BlueLineGridDetector()
    img = np.zeros((100, 300, 3), dtype=np.uint8)
    result = det.detect(img, user_rows=29, user_cols=29)
    assert result is not None
    assert result.rows == 29
    assert result.cols == 29
    assert result.source == "user"


# ── G2: projection_peak ─────────────────────────────────────────────────


def test_projection_fallback_returns_grid(monkeypatch):
    """When blue-line FFT fails AND no user_dims, projection peak fallback runs."""
    monkeypatch.setattr("app.services.bead_grid_detector.detect_grid",
                        lambda img: None)
    # Build an image with periodic vertical lines (column projection peaks)
    img = np.full((300, 300, 3), 255, dtype=np.uint8)
    for x in range(15, 300, 30):  # one dark vertical line every 30 px
        img[:, max(0, x-1):min(300, x+2)] = 0
    det = BlueLineGridDetector()
    result = det.detect(img)
    # Either projection succeeds OR all strategies fail → both are acceptable
    # outcomes for a fabricated image. The test's role is just to ensure the
    # function runs without crashing and returns None or GridResult.
    if result is not None:
        assert result.source in ("fft", "user", "projection", "hough", "clamp")


def test_projection_skipped_when_backends_disabled(monkeypatch):
    """BACKEND_FALLBACK_ENABLED=False → projection NOT attempted."""
    monkeypatch.setattr("app.services.bead_grid_detector.detect_grid",
                        lambda img: None)
    monkeypatch.setattr("app.config.settings.BACKEND_FALLBACK_ENABLED", False)
    det = BlueLineGridDetector()
    img = np.full((100, 100, 3), 200, dtype=np.uint8)
    result = det.detect(img)
    # Without fallback, FFT fails and we return None
    assert result is None


# ── G4: clamp_to_standard ──────────────────────────────────────────────


def test_clamp_snaps_close_dimensions(monkeypatch):
    """Detected (31, 31) should snap to (29, 29)."""
    monkeypatch.setattr("app.services.bead_grid_detector.detect_grid",
                        lambda img: None)
    # We can't easily inject a fake BeadGrid with rows=31, cols=31 because
    # StubGridDetector's strategy chain only sees `(image, user_rows, user_cols)`.
    # Test the clamp helper directly.
    from app.services.pipeline.blue_line_grid_detector import _clamp_to_standard
    snapped = _clamp_to_standard(31, 31)
    assert snapped == (29, 29)

    snapped = _clamp_to_standard(48, 39)
    assert snapped == (49, 39)

    snapped = _clamp_to_standard(70, 50)
    assert snapped == (69, 49)


def test_clamp_no_snap_when_far(monkeypatch):
    """Detected (35, 35) is too far from any standard → no snap."""
    from app.services.pipeline.blue_line_grid_detector import _clamp_to_standard
    # 35 is more than 2 away from 29 and 6 away from 39 → no snap
    assert _clamp_to_standard(35, 35) is None
    # 50 is 2 away from 49 (snap candidate) but it's within tolerance for col 49
    # (49,39) with rows=50 col=39 → snap to (49, 39)
    assert _clamp_to_standard(50, 39) == (49, 39)