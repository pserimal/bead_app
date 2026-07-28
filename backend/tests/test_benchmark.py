"""Unit tests for the benchmark harness (T4).

These tests exercise `evaluate()` on canned inputs and `run()` against the
synthetic fixtures committed in `backend/tests/fixtures/templates/`.
They run on the fast pytest path (no EasyOCR model load).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.benchmark import THRESHOLDS, evaluate, run


# ── evaluate() — pure-function tests ──────────────────────────────────────


def test_evaluate_perfect_prediction_scores_one():
    gt = {"H1": [[0, 0], [1, 1]]}
    result = {
        "grid_rows": 2,
        "grid_cols": 2,
        "_gt_rows": 2,
        "_gt_cols": 2,
        "cells": [
            {"row": 0, "col": 0, "bead_code": "H1"},
            {"row": 1, "col": 1, "bead_code": "H1"},
        ],
    }
    metrics = evaluate(result, gt)
    assert metrics["cell_recall"] == 1.0
    assert metrics["code_precision"] == 1.0
    assert metrics["dimension_accuracy"] == 1.0


def test_evaluate_empty_cells_zero_recall():
    gt = {"H1": [[0, 0]]}
    result = {
        "grid_rows": 1,
        "grid_cols": 1,
        "_gt_rows": 1,
        "_gt_cols": 1,
        "cells": [],
    }
    metrics = evaluate(result, gt)
    assert metrics["cell_recall"] == 0.0
    assert metrics["code_precision"] == 0.0


def test_evaluate_wrong_code_drops_precision_only():
    gt = {"H1": [[0, 0], [1, 1]]}
    result = {
        "grid_rows": 2,
        "grid_cols": 2,
        "_gt_rows": 2,
        "_gt_cols": 2,
        "cells": [
            {"row": 0, "col": 0, "bead_code": "H1"},     # correct
            {"row": 1, "col": 1, "bead_code": "H2"},     # wrong
        ],
    }
    metrics = evaluate(result, gt)
    assert metrics["cell_recall"] == 0.5        # 1 of 2 ground-truth cells hit
    assert metrics["code_precision"] == 0.5     # 1 of 2 returned codes was right


def test_evaluate_extra_cells_dont_inflate_precision():
    """Cells returned that aren't in ground truth count as wrong, not correct."""
    gt = {"H1": [[0, 0]]}
    result = {
        "grid_rows": 2,
        "grid_cols": 2,
        "_gt_rows": 1,
        "_gt_cols": 1,
        "cells": [
            {"row": 0, "col": 0, "bead_code": "H1"},
            {"row": 1, "col": 1, "bead_code": "H2"},  # spurious, ignored
        ],
    }
    metrics = evaluate(result, gt)
    assert metrics["cell_recall"] == 1.0          # the one gt cell is hit
    assert metrics["code_precision"] == 0.5       # 1 of 2 returned was right


def test_evaluate_dimension_mismatch_zeroes_dimension_accuracy():
    gt = {"H1": [[0, 0]]}
    result = {
        "grid_rows": 5,
        "grid_cols": 5,
        "_gt_rows": 1,
        "_gt_cols": 1,
        "cells": [{"row": 0, "col": 0, "bead_code": "H1"}],
    }
    metrics = evaluate(result, gt)
    assert metrics["dimension_accuracy"] == 0.0
    assert metrics["cell_recall"] == 1.0


def test_evaluate_handles_none_codes():
    """A cell with bead_code=None must count as 'not recalled', not wrong."""
    gt = {"H1": [[0, 0], [1, 1]]}
    result = {
        "grid_rows": 2,
        "grid_cols": 2,
        "_gt_rows": 2,
        "_gt_cols": 2,
        "cells": [
            {"row": 0, "col": 0, "bead_code": None},
            {"row": 1, "col": 1, "bead_code": "H1"},
        ],
    }
    metrics = evaluate(result, gt)
    assert metrics["cell_recall"] == 0.5        # 1 of 2 gt cells hit
    assert metrics["code_precision"] == 1.0     # the 1 returned code was right


# ── run() — integration with synthetic fixtures ──────────────────────────


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "templates"


class _AlwaysFailsParser:
    """Stub parser used by run() tests so we don't load the ~150 MB EasyOCR model.

    Raises on every parse so `run()` records errors instead of running real OCR.
    The benchmark harness must still record fixture_count, per_fixture rows,
    and the three aggregate metric keys regardless of parser outcome.
    """
    def parse(self, path, **kwargs):
        raise RuntimeError("stub parser fails by design")


def test_run_finds_synthetic_fixtures():
    """`run()` should discover at least the 20 committed templates."""
    summary = run(fixtures_dir=str(FIXTURES_DIR), parser=_AlwaysFailsParser())
    assert summary["fixture_count"] >= 20


def test_run_returns_all_three_metrics():
    summary = run(fixtures_dir=str(FIXTURES_DIR), parser=_AlwaysFailsParser())
    assert "cell_recall" in summary
    assert "code_precision" in summary
    assert "dimension_accuracy" in summary


def test_thresholds_match_plan_targets():
    """Thresholds come from `.sisyphus/plans/recognition-accuracy.md` TL;DR."""
    assert THRESHOLDS == {
        "cell_recall": 0.95,
        "code_precision": 0.90,
        "dimension_accuracy": 0.95,
    }


def test_run_records_baseline_dimensions():
    """The fixture filename encodes (rows, cols); `run()` should record them
    so `evaluate()` can score dimension_accuracy without re-parsing."""
    summary = run(fixtures_dir=str(FIXTURES_DIR), parser=_AlwaysFailsParser())
    # Each fixture record should carry its expected rows/cols
    for record in summary["per_fixture"]:
        assert "_gt_rows" in record["result"]
        assert "_gt_cols" in record["result"]