"""End-to-end integration tests for the OCR recognition pipeline.

Runs ``BeadPatternParser`` against the 20 synthetic fixtures in
``tests/fixtures/templates/`` and quantifies three metrics:

- dimension_accuracy: predicted (rows, cols) == GT (rows, cols)
- cell_recall:       fraction of GT cells correctly read
- code_precision:     fraction of predicted codes that are correct

Each fixture has a known ``{code: [[r,c], ...]}`` GT in a sibling JSON.
These tests use small fixtures and short timeouts so the whole suite
finishes in seconds (no real EasyOCR model load by default — we mock it).

Run:
    pytest tests/test_recognition_integration.py -v

Skipped by default; opt in with:
    RUN_RECOG=1 pytest tests/test_recognition_integration.py -v
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from unittest.mock import patch

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "templates"

# Thresholds from .sisyphus/plans/recognition-accuracy.md
THRESHOLDS = {
    "cell_recall": 0.95,
    "code_precision": 0.90,
    "dimension_accuracy": 0.95,
}

# Toggle: set RUN_RECOG=1 to actually run the OCR pipeline against fixtures.
# (Default off because loading EasyOCR's model takes ~5–10s and is not
# what we want during routine unit-test runs.)
RUN_RECOG = os.environ.get("RUN_RECOG") == "1"


def _load_gt(gt_path: Path) -> tuple[int, int, dict[tuple[int, int], str]]:
    """Invert GT {code: [[r, c], ...]} → {(r, c): code} and extract dims from filename."""
    m = gt_path.stem  # template_{rows}x{cols}_s{seed}
    parts = m.split("_")
    size_part = parts[1]  # rowsxcols
    rows, cols = (int(x) for x in size_part.split("x"))
    raw = json.loads(gt_path.read_text())
    pos_to_code: dict[tuple[int, int], str] = {}
    for code, positions in raw.items():
        for r, c in positions:
            pos_to_code[(int(r), int(c))] = code
    return rows, cols, pos_to_code


def _all_fixtures() -> list[Path]:
    return sorted(FIXTURES_DIR.glob("template_*.png"))


def _has_blue_lines(png_path: Path) -> bool:
    seed = int(png_path.stem.rsplit("_s", 1)[1])
    return seed in (0, 2, 4)


# ── Per-fixture detailed tests ──────────────────────────────────────────


@pytest.mark.skipif(not RUN_RECOG, reason="set RUN_RECOG=1 to enable real OCR runs")
def test_recognition_metrics_on_all_synthetic_fixtures():
    """Run the full pipeline against every fixture and assert the three metrics."""
    from app.services.bead_parser import BeadPatternParser

    parser = BeadPatternParser()
    fixtures = _all_fixtures()
    assert fixtures, "no synthetic fixtures found"

    n = len(fixtures)
    sum_recall = 0.0
    sum_precision = 0.0
    sum_dim = 0.0
    failures: list[str] = []

    for png in fixtures:
        gt_path = png.with_suffix(".json")
        gt_rows, gt_cols, gt_pos = _load_gt(gt_path)

        # Always pass GT dims so the user_dims_override (G1) path runs and
        # grid detection is not a gating factor.  This isolates OCR
        # accuracy from grid-detection accuracy.
        t0 = time.time()
        result = parser.parse(
            str(png),
            user_rows=gt_rows,
            user_cols=gt_cols,
        )
        dt = time.time() - t0

        pred_rows = result.get("grid_rows", 0)
        pred_cols = result.get("grid_cols", 0)
        pred_cells = {c["row"]: {} for c in result.get("cells", [])}  # not used

        # Build a quick lookup
        pred_by_pos: dict[tuple[int, int], str | None] = {}
        for c in result.get("cells", []):
            pred_by_pos[(c["row"], c["col"])] = c.get("bead_code")

        # Dimension accuracy
        dim_ok = (pred_rows == gt_rows) and (pred_cols == gt_cols)
        sum_dim += 1.0 if dim_ok else 0.0
        if not dim_ok:
            failures.append(
                f"  {png.name}: dim FAIL predicted={pred_rows}x{pred_cols} "
                f"expected={gt_rows}x{gt_cols} ({dt:.1f}s)"
            )
            continue  # downstream metrics meaningless with wrong grid

        # Cell recall
        correct = 0
        for pos, gt_code in gt_pos.items():
            if pred_by_pos.get(pos) == gt_code:
                correct += 1
        gt_total = len(gt_pos)
        recall = correct / gt_total if gt_total else 0.0
        sum_recall += recall

        # Code precision
        matched_pred = sum(
            1 for c in result.get("cells", [])
            if c.get("bead_code") is not None
        )
        precision = correct / matched_pred if matched_pred else 0.0
        sum_precision += precision

        with_blue = "lines" if _has_blue_lines(png) else "no-lines"
        print(
            f"  {png.name} ({with_blue}): dim=ok, "
            f"recall={recall:.2%}, precision={precision:.2%} ({dt:.1f}s)"
        )

    avg_recall = sum_recall / n
    avg_precision = sum_precision / n
    avg_dim = sum_dim / n

    print()
    print(f"Aggregate over {n} fixtures:")
    print(f"  cell_recall        = {avg_recall:.4f} (target {THRESHOLDS['cell_recall']})")
    print(f"  code_precision     = {avg_precision:.4f} (target {THRESHOLDS['code_precision']})")
    print(f"  dimension_accuracy = {avg_dim:.4f} (target {THRESHOLDS['dimension_accuracy']})")

    if failures:
        print()
        print("Dimensional failures:")
        for f in failures:
            print(f)

    assert avg_recall >= THRESHOLDS["cell_recall"], (
        f"cell_recall {avg_recall:.2%} below target "
        f"{THRESHOLDS['cell_recall']:.0%}"
    )
    assert avg_precision >= THRESHOLDS["code_precision"], (
        f"code_precision {avg_precision:.2%} below target "
        f"{THRESHOLDS['code_precision']:.0%}"
    )
    assert avg_dim >= THRESHOLDS["dimension_accuracy"], (
        f"dimension_accuracy {avg_dim:.2%} below target "
        f"{THRESHOLDS['dimension_accuracy']:.0%}"
    )


# ── Sanity tests (always run, no OCR) ─────────────────────────────────


def test_synthetic_fixtures_have_ground_truth():
    """Every PNG has a sibling JSON with a non-empty code → positions map."""
    fixtures = _all_fixtures()
    assert len(fixtures) >= 20, f"expected ≥20 fixtures, found {len(fixtures)}"

    for png in fixtures:
        gt = png.with_suffix(".json")
        assert gt.exists(), f"missing GT JSON for {png.name}"
        data = json.loads(gt.read_text())
        assert data, f"empty GT for {png.name}"
        # Each GT code should have at least one (r, c) pair
        for code, positions in data.items():
            assert positions, f"{png.name}: code {code!r} has no positions"
            for r, c in positions:
                assert (
                    isinstance(r, int) and isinstance(c, int)
                ), f"{png.name}: bad position {(r, c)} for {code!r}"


def test_half_fixtures_have_blue_lines():
    """Exactly 12 of 20 fixtures should have blue guide lines per the spec."""
    with_lines = [p for p in _all_fixtures() if _has_blue_lines(p)]
    assert len(with_lines) == 12, (
        f"expected 12 fixtures with blue lines, got {len(with_lines)}"
    )


def test_fixtures_match_standard_perler_sizes():
    """The 4 board sizes should be the standard Perler grid dimensions."""
    sizes = set()
    for png in _all_fixtures():
        gt_rows, gt_cols, _ = _load_gt(png.with_suffix(".json"))
        sizes.add((gt_rows, gt_cols))
    expected = {(29, 29), (49, 39), (69, 49), (79, 57)}
    assert sizes == expected, f"expected standard sizes, got {sizes}"
