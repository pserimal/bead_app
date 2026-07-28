"""Tests for app.services.debug_io."""
import json
from pathlib import Path

import numpy as np

import app.config
from app.services.debug_io import debug_enabled, dump_debug


def test_dump_debug_noop_when_disabled(tmp_path: Path) -> None:
    """No file written when DEBUG_DUMP is False."""
    app.config.settings.DEBUG_DUMP = False
    app.config.settings.DEBUG_DUMP_DIR = str(tmp_path)

    dump_debug("test_step", np.zeros((10, 10, 3), dtype=np.uint8), {"x": 1})

    assert list(tmp_path.iterdir()) == []


def test_dump_debug_writes_png_and_json(tmp_path: Path) -> None:
    """Writes both PNG and JSON when DEBUG_DUMP=True."""
    app.config.settings.DEBUG_DUMP = True
    app.config.settings.DEBUG_DUMP_DIR = str(tmp_path)

    img = np.full((20, 30, 3), 100, dtype=np.uint8)
    dump_debug("grid-detection", img, {"rows": 29, "cols": 29})

    ts_dirs = list(tmp_path.iterdir())
    assert len(ts_dirs) == 1
    td = ts_dirs[0]

    png_path = td / "grid-detection.png"
    assert png_path.exists()
    # Verify it's a valid PNG (starts with PNG header)
    assert png_path.read_bytes()[:4] == b"\x89PNG"

    json_path = td / "grid-detection.json"
    assert json_path.exists()
    with open(json_path) as f:
        meta = json.load(f)
    assert meta == {"rows": 29, "cols": 29}


def test_dump_debug_writes_png_only_when_no_metadata(tmp_path: Path) -> None:
    """Only PNG is written when metadata is None."""
    app.config.settings.DEBUG_DUMP = True
    app.config.settings.DEBUG_DUMP_DIR = str(tmp_path)

    dump_debug("no-meta", np.zeros((5, 5, 3), dtype=np.uint8))

    ts_dirs = list(tmp_path.iterdir())
    assert len(ts_dirs) == 1
    td = ts_dirs[0]
    assert (td / "no-meta.png").exists()
    assert not (td / "no-meta.json").exists()


def test_debug_enabled_returns_false_by_default() -> None:
    app.config.settings.DEBUG_DUMP = False
    assert debug_enabled() is False


def test_debug_enabled_returns_true_when_enabled() -> None:
    app.config.settings.DEBUG_DUMP = True
    assert debug_enabled() is True
