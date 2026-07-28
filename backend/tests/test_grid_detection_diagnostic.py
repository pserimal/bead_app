"""Quick diagnosis of grid detection on synthetic fixtures.

Runs ``BlueLineGridDetector.detect()`` on each fixture, records what
strategy won (user / fft / projection / clamp / None), what dimensions
it predicted, and time taken. This isolates the grid-detection bug
without paying the ~5GB EasyOCR memory cost.

Run:
    pytest tests/test_grid_detection_diagnostic.py -v -s
"""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "templates"


def _all_fixtures() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("template_*.png"))


def _expected_dims(png: Path) -> tuple[int, int]:
    stem = png.stem  # template_{rows}x{cols}_s{seed}
    parts = stem.split("_")
    size_part = parts[1]  # rowsxcols
    r, c = (int(x) for x in size_part.split("x"))
    return r, c


def _has_blue_lines(png: Path) -> bool:
    seed = int(png.stem.rsplit("_s", 1)[1])
    return seed in (0, 2, 4)


def test_grid_detection_results():
    """Report what the grid detector does on every fixture, in <1s each."""
    import cv2
    from app.services.pipeline.blue_line_grid_detector import BlueLineGridDetector

    detector = BlueLineGridDetector()
    fixtures = _all_fixtures()

    by_source: dict[str, list[tuple[str, int, int, int, int]]] = {}
    failures: list[str] = []

    for png in fixtures:
        gt_rows, gt_cols = _expected_dims(png)
        img = cv2.imread(str(png))
        t0 = time.time()
        try:
            result = detector.detect(img)
        except Exception as e:
            result = None
            failures.append(f"{png.name}: exception {e!r}")
            continue
        dt = time.time() - t0

        if result is None:
            entry = (png.name, gt_rows, gt_cols, 0, 0)
            by_source.setdefault("None", []).append(entry)
            print(f"  {png.name}: None  (expected {gt_rows}x{gt_cols})  [{dt:.2f}s]")
        else:
            entry = (png.name, gt_rows, gt_cols, result.rows, result.cols)
            by_source.setdefault(result.source, []).append(entry)
            ok = "✓" if (result.rows == gt_rows and result.cols == gt_cols) else "✗"
            print(
                f"  {png.name}: source={result.source:10s} "
                f"pred={result.rows}x{result.cols}  exp={gt_rows}x{gt_cols} {ok}  [{dt:.2f}s]"
            )

    print()
    print("Summary by source:")
    for src, entries in sorted(by_source.items()):
        correct = sum(1 for e in entries if e[1] == e[3] and e[2] == e[4])
        print(f"  {src:10s}: {len(entries)} fixtures, {correct} dimensionally correct")

    if failures:
        print()
        print("Exceptions:")
        for f in failures:
            print(f"  {f}")

    # Test passes if it runs without crashing — we only care about the
    # printed report for diagnostic purposes.
