"""A/B benchmark: compare EasyOCR-enhanced vs PaddleOCR-enhanced on real images.

Hard constraint (per spec): ONLY real images from training/data/real/stand/ are
accepted as inputs. Synthetic fixtures are forbidden in integration tests.

Usage:
    cd backend && python -m tests.benchmark_real <image_path> <gt_path> <rows> <cols>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import cv2


THRESHOLDS = {
    "cell_recall": 0.95,
    "code_precision": 0.90,
}


def _load_gt(gt_path: Path) -> dict[tuple[int, int], str]:
    """Invert ground truth JSON into {(r, c): code} map (skipping nulls)."""
    with open(gt_path) as f:
        gt = json.load(f)
    inv: dict[tuple[int, int], str] = {}
    for cell in gt["cells"]:
        if cell.get("code") is None:
            continue
        inv[(int(cell["row"]), int(cell["col"]))] = cell["code"]
    return inv


def _evaluate(
    ocr_result: dict[tuple[int, int], tuple[str, float]],
    gt_map: dict[tuple[int, int], str],
    rows: int,
    cols: int,
) -> dict[str, float]:
    """Compute cell_recall and code_precision against ground truth."""
    correct = 0
    recalled = 0
    for key, gt_code in gt_map.items():
        det = ocr_result.get(key)
        if det is None:
            continue
        recalled += 1
        if det[0] == gt_code:
            correct += 1
    gt_total = len(gt_map)
    return {
        "cell_recall": correct / gt_total if gt_total else 0.0,
        "code_precision": correct / recalled if recalled else 0.0,
    }


def compare_engines(
    image_path: str | Path,
    gt_path: str | Path,
    rows: int,
    cols: int,
) -> dict[str, Any]:
    """Run both EasyOCR and PaddleOCR variants on a real image, compare metrics."""
    image_path = Path(image_path)
    gt_path = Path(gt_path)
    img = cv2.imread(str(image_path))
    if img is None:
        raise FileNotFoundError(f"cannot read: {image_path}")
    h, w = img.shape[:2]

    gt_map = _load_gt(gt_path)

    # Plan A: EasyOCR
    from app.services.bead_ocr_easy import ocr_cells_from_crop_easy
    easy_result = ocr_cells_from_crop_easy(
        image_bgr=img, user_rows=rows, user_cols=cols,
        crop_bbox=(0, 0, w, h), min_conf=0.0,
    )
    easy_metrics = _evaluate(easy_result, gt_map, rows, cols)

    # Plan B: PaddleOCR (may fail due to API issues)
    paddle_result = None
    paddle_metrics = {"cell_recall": 0.0, "code_precision": 0.0}
    try:
        from app.services.bead_ocr_paddle import ocr_cells_from_crop_paddle
        paddle_result = ocr_cells_from_crop_paddle(
            image_bgr=img, user_rows=rows, user_cols=cols,
            crop_bbox=(0, 0, w, h), min_conf=0.0,
        )
        paddle_metrics = _evaluate(paddle_result, gt_map, rows, cols)
    except Exception as e:
        print(f"⚠️  Plan B (PaddleOCR) failed: {e}", file=sys.stderr)

    # Decide winner by cell_recall (primary KPI)
    if easy_metrics["cell_recall"] >= paddle_metrics["cell_recall"]:
        winner = "easy"
    else:
        winner = "paddle"

    return {
        "image": str(image_path),
        "gt_path": str(gt_path),
        "gt_size": len(gt_map),
        "easy": {
            "cell_recall": easy_metrics["cell_recall"],
            "code_precision": easy_metrics["code_precision"],
            "predictions": len(easy_result),
        },
        "paddle": {
            "cell_recall": paddle_metrics["cell_recall"],
            "code_precision": paddle_metrics["code_precision"],
            "predictions": len(paddle_result) if paddle_result else 0,
        },
        "winner": winner,
        "thresholds": THRESHOLDS,
    }


def _format_table(result: dict) -> str:
    lines = [
        "",
        f"Image: {result['image']}",
        f"GT size (non-null cells): {result['gt_size']}",
        "",
        f"{'Engine':<20} {'cell_recall':<14} {'code_precision':<18} {'predictions':<12}",
        "-" * 64,
        f"{'Plan A (EasyOCR)':<20} "
        f"{result['easy']['cell_recall']:<14.4f} "
        f"{result['easy']['code_precision']:<18.4f} "
        f"{result['easy']['predictions']:<12}",
        f"{'Plan B (PaddleOCR)':<20} "
        f"{result['paddle']['cell_recall']:<14.4f} "
        f"{result['paddle']['code_precision']:<18.4f} "
        f"{result['paddle']['predictions']:<12}",
        "-" * 64,
        f"Winner: {result['winner'].upper()}",
        "",
        f"Thresholds: cell_recall >= {THRESHOLDS['cell_recall']}, "
        f"code_precision >= {THRESHOLDS['code_precision']}",
    ]
    return "\n".join(lines)


def _cli(argv: list[str]) -> int:
    if len(argv) < 5:
        print("Usage: benchmark_real.py <image_path> <gt_path> <rows> <cols>", file=sys.stderr)
        return 2

    image = argv[1]
    gt = argv[2]
    rows = int(argv[3])
    cols = int(argv[4])

    result = compare_engines(image, gt, rows, cols)
    print(_format_table(result))

    winner_metrics = result[result["winner"]]
    fails = []
    if winner_metrics["cell_recall"] < THRESHOLDS["cell_recall"]:
        fails.append(f"cell_recall={winner_metrics['cell_recall']:.4f} < {THRESHOLDS['cell_recall']}")
    if winner_metrics["code_precision"] < THRESHOLDS["code_precision"]:
        fails.append(f"code_precision={winner_metrics['code_precision']:.4f} < {THRESHOLDS['code_precision']}")
    if fails:
        print("\nTHRESHOLD FAILURES:", file=sys.stderr)
        for f in fails:
            print(f"  - {f}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv))
