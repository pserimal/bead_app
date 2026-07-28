"""Recognition benchmark harness (T4).

Compares pipeline output against the synthetic Perler templates under
`backend/tests/fixtures/templates/`. Each fixture ships as a paired
PNG (the image) and JSON (the ground-truth cell map). The ground-truth
JSON schema is `{code: [[r, c], ...]}` — see plan §"Verified discrepancies".

Three metrics are reported:

- cell_recall       = (# ground-truth cells hit with correct code)
                      / (# ground-truth cells)
- code_precision    = (# returned cells whose code matches ground truth)
                      / (# returned cells with non-null code)
- dimension_accuracy = 1.0 if (predicted rows/cols match ground truth) else 0.0

Usage from CLI:

    python backend/tests/benchmark.py [fixtures_dir]

When invoked with no arguments, runs against the committed synthetic suite
using the live `BeadPatternParser`. To avoid loading the ~150 MB EasyOCR
model, tests inject a stub parser via the `parser` kwarg of `run()`.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

# Acceptance thresholds from .sisyphus/plans/recognition-accuracy.md TL;DR.
# T15's `test_benchmark_meets_thresholds` asserts these on the synthetic suite.
THRESHOLDS: dict[str, float] = {
    "cell_recall": 0.95,
    "code_precision": 0.90,
    "dimension_accuracy": 0.95,
}

# Fixture filename pattern: template_<rows>x<cols>_s<seed>.{png,json}
_FIXTURE_RE = re.compile(r"^template_(\d+)x(\d+)_s\d+$")


def _fixture_pairs(fixtures_dir: str | Path) -> list[tuple[Path, Path, int, int]]:
    """Return [(png_path, json_path, rows, cols), ...] for every committed fixture.

    A fixture pair is valid only when both the PNG and the JSON exist; pairs
    missing either side are skipped silently (should never happen in CI).
    """
    root = Path(fixtures_dir)
    if not root.is_dir():
        return []
    pairs: list[tuple[Path, Path, int, int]] = []
    for png_path in sorted(root.glob("template_*.png")):
        m = _FIXTURE_RE.match(png_path.stem)
        if m is None:
            continue
        rows, cols = int(m.group(1)), int(m.group(2))
        json_path = png_path.with_suffix(".json")
        if not json_path.is_file():
            continue
        pairs.append((png_path, json_path, rows, cols))
    return pairs


def evaluate(result: dict[str, Any], ground_truth: dict[str, list]) -> dict[str, float]:
    """Score one pipeline result against one ground-truth map.

    Args:
        result: Pipeline output dict with keys
            `grid_rows`, `grid_cols`, `_gt_rows`, `_gt_cols`, `cells`
            where each cell has `row`, `col`, `bead_code`.
        ground_truth: Map `{code: [[r, c], ...]}` (the JSON schema).
            `evaluate` inverts it internally — callers may pass it as-is.

    Returns:
        Dict with `cell_recall`, `code_precision`, `dimension_accuracy`.
    """
    # Invert ground truth: {(r, c): code}
    inv: dict[tuple[int, int], str] = {}
    for code, positions in ground_truth.items():
        for pos in positions:
            r, c = int(pos[0]), int(pos[1])
            inv[(r, c)] = code

    cells = result.get("cells") or []
    correct = 0
    recalled = 0
    for cell in cells:
        code = cell.get("bead_code")
        if code is None:
            continue
        recalled += 1
        key = (int(cell["row"]), int(cell["col"]))
        if inv.get(key) == code:
            correct += 1

    gt_total = len(inv)
    cell_recall = correct / gt_total if gt_total else 0.0
    code_precision = correct / recalled if recalled else 0.0
    dimension_accuracy = 1.0 if (
        result.get("grid_rows") == result.get("_gt_rows")
        and result.get("grid_cols") == result.get("_gt_cols")
    ) else 0.0

    return {
        "cell_recall": cell_recall,
        "code_precision": code_precision,
        "dimension_accuracy": dimension_accuracy,
    }


def run(
    fixtures_dir: str | Path = "backend/tests/fixtures/templates",
    parser: Any | None = None,
) -> dict[str, Any]:
    """Aggregate `evaluate()` across every committed fixture.

    Args:
        fixtures_dir: Path to the templates directory.
        parser: Optional parser object exposing `parse(path, **kwargs) -> dict`.
            Defaults to `BeadPatternParser()` from the live pipeline. Tests
            inject a stub to avoid loading the EasyOCR model.

    Returns:
        Summary dict with:
            - `fixture_count`: number of fixtures scored
            - `cell_recall`, `code_precision`, `dimension_accuracy`: aggregates
            - `per_fixture`: list of `{fixture, result, metrics}` records
              (each `result` includes `_gt_rows`/`_gt_cols` for downstream
              callers; metrics scored from that single fixture's ground truth)
    """
    if parser is None:
        # Imported lazily so unit tests that pass their own parser don't
        # trigger the ~150 MB EasyOCR model download.
        from app.services.bead_parser import BeadPatternParser

        parser = BeadPatternParser()

    pairs = _fixture_pairs(fixtures_dir)
    per_fixture: list[dict[str, Any]] = []

    sum_recall = 0.0
    sum_precision = 0.0
    sum_dim = 0.0

    for png_path, json_path, gt_rows, gt_cols in pairs:
        with json_path.open() as f:
            ground_truth = json.load(f)

        try:
            result = parser.parse(str(png_path))
        except Exception as exc:  # noqa: BLE001 — we want to record any failure
            # A pipeline crash counts as 0 on every metric for this fixture
            # but is preserved in the record so QA can inspect it.
            per_fixture.append({
                "fixture": png_path.name,
                "result": {"grid_rows": 0, "grid_cols": 0, "cells": [],
                           "_gt_rows": gt_rows, "_gt_cols": gt_cols,
                           "error": str(exc)},
                "metrics": {"cell_recall": 0.0, "code_precision": 0.0,
                            "dimension_accuracy": 0.0},
            })
            continue

        # Annotate the result with ground-truth dimensions so `evaluate()` can
        # score dimension_accuracy without the caller having to thread them.
        result = dict(result)
        result["_gt_rows"] = gt_rows
        result["_gt_cols"] = gt_cols

        metrics = evaluate(result, ground_truth)
        sum_recall += metrics["cell_recall"]
        sum_precision += metrics["code_precision"]
        sum_dim += metrics["dimension_accuracy"]

        per_fixture.append({
            "fixture": png_path.name,
            "result": result,
            "metrics": metrics,
        })

    n = len(pairs)
    return {
        "fixture_count": n,
        "cell_recall": sum_recall / n if n else 0.0,
        "code_precision": sum_precision / n if n else 0.0,
        "dimension_accuracy": sum_dim / n if n else 0.0,
        "per_fixture": per_fixture,
    }


def _cli(argv: list[str]) -> int:
    """Print a one-line aggregate summary to stdout. Exits non-zero on threshold breach."""
    fixtures_dir = argv[1] if len(argv) > 1 else "backend/tests/fixtures/templates"
    summary = run(fixtures_dir=fixtures_dir)
    print(json.dumps({
        "fixture_count": summary["fixture_count"],
        "cell_recall": round(summary["cell_recall"], 4),
        "code_precision": round(summary["code_precision"], 4),
        "dimension_accuracy": round(summary["dimension_accuracy"], 4),
        "thresholds": THRESHOLDS,
    }, indent=2, ensure_ascii=False))

    fails = []
    for key, threshold in THRESHOLDS.items():
        if summary[key] < threshold:
            fails.append(f"{key}={summary[key]:.4f} < {threshold}")
    if fails:
        print("\nTHRESHOLD FAILURES:", file=sys.stderr)
        for f in fails:
            print(f"  - {f}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv))