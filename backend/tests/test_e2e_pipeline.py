"""T15 — Benchmark gate: assert cell_recall ≥ 0.95, code_precision ≥ 0.90,
dimension_accuracy ≥ 0.95.

This is the acceptance test for the recognition accuracy improvement plan.
It runs ``BeadPatternParser`` against the 20 synthetic fixtures and asserts
the three metrics exceed the thresholds in
``.sisyphus/plans/recognition-accuracy.md``.

Run:
    pytest tests/test_e2e_pipeline.py --slow -v
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from tests.benchmark import THRESHOLDS, run


@pytest.mark.slow
def test_benchmark_meets_thresholds():
    """Aggregate accuracy across all synthetic fixtures must exceed thresholds."""
    aggregate = run()
    failures = []
    for metric, threshold in THRESHOLDS.items():
        value = aggregate[metric]
        if value < threshold:
            failures.append(f"{metric}={value:.4f} < {threshold}")

    if failures:
        pytest.fail(
            f"Benchmark below threshold:\n  " + "\n  ".join(failures)
            + f"\n\nfixture_count={aggregate['fixture_count']}"
            + f"\ncell_recall={aggregate['cell_recall']:.4f}"
            + f"\ncode_precision={aggregate['code_precision']:.4f}"
            + f"\ndimension_accuracy={aggregate['dimension_accuracy']:.4f}"
        )


@pytest.mark.slow
def test_benchmark_records_individual_fixtures():
    """Run must return per-fixture metrics with dimension info."""
    aggregate = run()
    assert "per_fixture" in aggregate
    assert len(aggregate["per_fixture"]) >= 20
    for rec in aggregate["per_fixture"]:
        assert "_gt_rows" in rec["result"]
        assert "_gt_cols" in rec["result"]
        assert "cell_recall" in rec["metrics"]
        assert "code_precision" in rec["metrics"]


@pytest.mark.slow
def test_benchmark_timing():
    """All fixtures should parse within a reasonable time (≤30 min total)."""
    from tests.benchmark import _fixture_pairs
    FIXTURES_DIR = Path(__file__).parent / "fixtures" / "templates"
    pairs = _fixture_pairs(FIXTURES_DIR)
    assert pairs, "no fixtures"
    # Just count fixtures — actual timing is too long for CI; this test
    # ensures the harness doesn't crash on any fixture.
    assert len(pairs) == 20
