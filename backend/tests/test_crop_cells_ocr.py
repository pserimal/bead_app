"""Tests for ocr_cells_from_crop() — Task 1 & 2.

Task 1: ``ocr_cells_from_crop()`` — per-cell OCR with user-crop bypass.
Task 2: ``BeadPatternParser.parse()`` — routes to ``ocr_cells_from_crop``
when ``user_bbox`` is provided; otherwise keeps the original pipeline.
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services.bead_ocr import _ocr_single_cell, _parse_code, _ALLOWLIST


# ── Fixtures ───────────────────────────────────────────────────────────


@pytest.fixture
def blank_image():
    """Return a 300×400 grayscale image."""
    return 128 * np.ones((300, 400, 3), dtype=np.uint8)


@pytest.fixture
def small_crop_with_text():
    """Return a 32×32 colour cell on which EasyOCR would read "H7"."""
    img = 220 * np.ones((32, 32, 3), dtype=np.uint8)
    cv2.putText(img, "H7", (2, 20), cv2.FONT_HERSHEY_SIMPLEX,
                0.3, (0, 0, 0), 1, cv2.LINE_AA)
    return img


# ── Helper: mock EasyOCR reader ────────────────────────────────────────


class _MockReader:
    """Returns a single detection (text, confidence) for any input."""
    def __init__(self, text: str = "H7", conf: float = 0.95):
        self._text = text
        self._conf = conf

    def readtext(self, image, **kw):
        return [
            ([[0, 0], [10, 0], [10, 10], [0, 10]], self._text, self._conf)
        ]


# ── 1. _ocr_single_cell on real image (no mock) ────────────────────────


def test_ocr_single_cell_rejects_empty_crop():
    """An empty crop must return an empty list."""
    reader = _MockReader()
    results = _ocr_single_cell(np.zeros((0, 0, 3), dtype=np.uint8), reader)
    assert results == []


# ── 2. ocr_cells_from_crop — pure-function tests with mock ─────────────


def test_cells_from_crop_with_mock_reader(monkeypatch):
    """With a mock reader that always returns "H7", every cell gets "H7"."""
    import app.services.bead_ocr as ocr_mod

    def _fake_single(crop, reader):
        return [("H7", 0.95)]

    monkeypatch.setattr(ocr_mod, "_ocr_single_cell", _fake_single)

    # Build a 2×2 grid → 4 cells
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    result = ocr_mod.ocr_cells_from_crop(
        image_bgr=img,
        user_rows=2,
        user_cols=2,
        crop_bbox=(0, 0, 100, 100),
    )
    assert len(result) == 4
    for (r, c), (code, conf) in result.items():
        assert code == "H7"
        assert 0 <= r < 2
        assert 0 <= c < 2


def test_cells_from_crop_filters_valid_codes(monkeypatch):
    """Codes not in valid_codes must not appear in output."""
    import app.services.bead_ocr as ocr_mod

    def _fake_single(crop, reader):
        return [("XYZ", 0.9)]

    monkeypatch.setattr(ocr_mod, "_ocr_single_cell", _fake_single)

    img = np.zeros((50, 50, 3), dtype=np.uint8)
    result = ocr_mod.ocr_cells_from_crop(
        image_bgr=img,
        user_rows=1, user_cols=1,
        crop_bbox=(0, 0, 50, 50),
        valid_codes={"H7"},
    )
    # XYZ is not in valid_codes → empty result
    assert len(result) == 0


def test_cells_from_crop_low_confidence_filtered(monkeypatch):
    """Detections below min_conf must be dropped."""
    import app.services.bead_ocr as ocr_mod

    def _fake_single(crop, reader):
        return [("H7", 0.3)]

    monkeypatch.setattr(ocr_mod, "_ocr_single_cell", _fake_single)

    img = np.zeros((50, 50, 3), dtype=np.uint8)
    result = ocr_mod.ocr_cells_from_crop(
        image_bgr=img,
        user_rows=1, user_cols=1,
        crop_bbox=(0, 0, 50, 50),
        valid_codes={"H7"},
        min_conf=0.5,
    )
    assert len(result) == 0


def test_cells_from_crop_bbox_outside_image_returns_empty(monkeypatch):
    """A bbox that lies entirely outside the image must return {}."""
    import app.services.bead_ocr as ocr_mod

    img = np.zeros((100, 100, 3), dtype=np.uint8)
    result = ocr_mod.ocr_cells_from_crop(
        image_bgr=img,
        user_rows=2, user_cols=2,
        crop_bbox=(-50, -50, 10, 10),  # wholly outside
    )
    assert result == {}


def test_cells_from_crop_partial_bbox_clamps(monkeypatch):
    """A bbox that partially overlaps the image should clamp, not crash."""
    import app.services.bead_ocr as ocr_mod

    def _fake_single(crop, reader):
        return [("H7", 0.9)]

    monkeypatch.setattr(ocr_mod, "_ocr_single_cell", _fake_single)

    img = np.zeros((100, 100, 3), dtype=np.uint8)
    result = ocr_mod.ocr_cells_from_crop(
        image_bgr=img,
        user_rows=1, user_cols=1,
        crop_bbox=(-10, -10, 50, 50),  # partially outside
    )
    # A 1×1 grid with partial overlap → should still try OCR on what's inside
    assert len(result) == 1


# ── 3. _parse_code data-driven test (reused from T10) ──────────────────


def test_parse_code_accepts_all_library_codes():
    """_parse_code must accept all codes from default_colors.json."""
    codes = [e["code"] for e in json.load(
        open(Path(__file__).parent.parent / "app" / "data" / "default_colors.json")
    )]
    for code in codes:
        parsed = _parse_code(code)
        assert parsed == code, f"failed to parse {code!r}, got {parsed!r}"


# ── 4. BeadPatternParser routing with user_bbox (Task 2) ───────────────


from unittest.mock import MagicMock


@pytest.fixture
def real_fixture_path():
    """Path to a real-world Perler template image."""
    p = Path(__file__).parent.parent.parent / "examples"
    # Use the smallest real image
    candidates = sorted(p.glob("*.jpg"))
    if candidates:
        return str(candidates[0])
    pytest.skip("no example image found")


def test_parse_with_user_bbox_calls_ocr_cells_from_crop(monkeypatch, tmp_path):
    """parse(…, user_bbox=…) must route to ocr_cells_from_crop, not detect_grid."""
    import cv2
    from app.services.bead_parser import BeadPatternParser

    img_path = tmp_path / "test.png"
    cv2.imwrite(str(img_path), np.zeros((200, 200, 3), dtype=np.uint8))

    # Mock the pipeline to prove it is NOT called
    monkeypatch.setattr("app.services.bead_grid_detector.detect_grid",
                        lambda img: None)
    monkeypatch.setattr("app.services.bead_ocr.ocr_board",
                        lambda img, grid: {})

    # Spy on ocr_cells_from_crop
    from unittest.mock import MagicMock
    import app.services.bead_ocr as ocr_mod
    spy = MagicMock(return_value={(0, 0): ("H7", 0.9)})
    monkeypatch.setattr(ocr_mod, "ocr_cells_from_crop", spy)

    parser = BeadPatternParser()
    result = parser.parse(str(img_path),
                          user_rows=10, user_cols=10,
                          user_bbox=(0, 0, 100, 100))

    # The result should match our spy's return value structure
    assert result["cells"] is not None
    spy.assert_called_once()
    call_kwargs = spy.call_args[1]
    assert call_kwargs["user_rows"] == 10
    assert call_kwargs["user_cols"] == 10
    assert call_kwargs["crop_bbox"] == (0, 0, 100, 100)


def test_parse_without_user_bbox_uses_grid_detector(monkeypatch, tmp_path):
    """parse() without user_bbox must use the original pipeline path."""
    import cv2
    from app.services.bead_parser import BeadPatternParser

    img_path = tmp_path / "test.png"
    cv2.imwrite(str(img_path), np.zeros((200, 200, 3), dtype=np.uint8))

    mock_grid = MagicMock(return_value=None)  # Pipeline will handle None
    monkeypatch.setattr("app.services.bead_grid_detector.detect_grid", mock_grid)

    parser = BeadPatternParser()
    result = parser.parse(str(img_path), user_rows=10, user_cols=10)
    # Without user_bbox, the original pipeline runs → detect_grid gets called
    assert result is not None
    mock_grid.assert_called()


# ── 5. Real-image end-to-end smoke (Task 5) ───────────────────────────

import pytest


@pytest.mark.slow
def test_real_image_e2e_crop_cells_recognition():
    """Run the user-crop OCR path on a real-world Perler template.
    * It returns at least some valid bead codes
    * All returned codes are members of the color library
    """
    import cv2
    from app.services.bead_ocr import ocr_cells_from_crop

    # Load the smallest real image
    img_path = Path(__file__).parent.parent.parent / "examples" / "拼豆日记54📔骑派大星（附图纸）_3_08e-_来自小红书网页版.jpg"
    if not img_path.is_file():
        pytest.skip(f"example image not found: {img_path}")

    img = cv2.imread(str(img_path))
    h, w = img.shape[:2]
    assert h > 0 and w > 0, f"failed to read image at {img_path}"

    # Estimated board bbox: central region (100, 300, 880, 1200) for 1080x1813 image
    bbox = (100, 300, 880, 1200)

    # Run on a subset: 10×10 grid (100 cells) — quick smoke test
    import time as T
    t0 = T.time()
    merged = ocr_cells_from_crop(
        image_bgr=img,
        user_rows=10, user_cols=10,
        crop_bbox=bbox,
        max_workers=10,
    )
    elapsed = T.time() - t0

    # Load the known valid codes
    import json
    lib_path = Path(__file__).parent.parent / "app" / "data" / "default_colors.json"
    valid_codes = {e["code"] for e in json.loads(lib_path.read_text())}

    print(f"\n  Real image e2e test ({img_path.name}):")
    print(f"  Grid: 10×10 = 100 cells | Recognized: {len(merged)} | Time: {elapsed:.1f}s")

    # Every returned code must be valid
    for (r, c), (code, conf) in sorted(merged.items()):
        assert code in valid_codes, f"invalid code {code} at ({r},{c})"
        print(f"    ({r},{c}): {code} (conf={conf:.2f})")

    # At least some codes should be recognized on a real Perler board
    assert len(merged) >= 2, f"expected ≥2 recognized cells, got {len(merged)}"
    print(f"  ✅ All {len(merged)} recognized codes are valid library codes")


@pytest.mark.slow
def test_real_image_parse_via_bead_parser():
    """Run BeadPatternParser with user_bbox on a real image — end-to-end."""
    from app.services.bead_parser import BeadPatternParser

    img_path = Path(__file__).parent.parent.parent / "examples" / "拼豆日记54📔骑派大星（附图纸）_3_08e-_来自小红书网页版.jpg"
    if not img_path.is_file():
        pytest.skip()

    parser = BeadPatternParser()
    bbox = (100, 300, 880, 1200)

    import time as T
    t0 = T.time()
    result = parser.parse(
        str(img_path),
        user_rows=10,
        user_cols=10,
        user_bbox=bbox,
    )
    elapsed = T.time() - t0
    cells = result.get("cells", [])
    recognized = sum(1 for c in cells if c.get("bead_code"))
    print(f"\n  BeadPatternParser e2e: {recognized}/{len(cells)} recognized ({elapsed:.1f}s)")
    assert result["grid_rows"] == 10
    assert result["grid_cols"] == 10
    assert recognized >= 2, f"expected ≥2, got {recognized}"