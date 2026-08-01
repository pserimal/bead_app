"""Benchmark the CRNN recognizer on the real stand crops.

Reads each ``training/data/real/stand/<image>`` + its ``.gt.json`` ground truth,
runs the CRNN over every cell, and reports per-image exact-match rate.
This is the headline number that decides whether the CRNN path is worth
scaling up vs. going back to the drawing board.

Usage:
    cd training && python -m training.scripts.eval_stand
    # or with a custom checkpoint:
    CRNN_MODEL_PATH=../training/checkpoints/crnn_v1.pt python -m training.scripts.eval_stand
    # (模型现在经 ocr_core 加载；artifact 通过 MODEL_ARTIFACT_DIR 指定)
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np


EXAMPLES_DIR = Path(__file__).resolve().parent.parent / "data" / "real" / "stand"
MANIFEST = EXAMPLES_DIR / "manifest.json"


def _load_gt(image_path: Path) -> dict:
    gt_path = image_path.with_suffix("").with_name(image_path.stem + ".gt.json")
    if not gt_path.exists():
        # Manifest names are sometimes the .gt.json already. Try sibling.
        for sibling in image_path.parent.iterdir():
            if sibling.stem.startswith(image_path.stem) and sibling.suffix == ".json":
                gt_path = sibling
                break
    if not gt_path.exists():
        raise FileNotFoundError(f"No GT for {image_path}")
    with open(gt_path, encoding="utf-8") as f:
        return json.load(f)


def _evaluate_one(image_path: Path, ocr_fn) -> dict:
    gt = _load_gt(image_path)
    rows = gt["rows"]
    cols = gt["cols"]
    gt_cells = {(c["row"], c["col"]): c.get("code") for c in gt["cells"]}

    img = cv2.imdecode(np.fromfile(str(image_path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(image_path)
    h, w = img.shape[:2]
    # Use the full image as the crop (stand crops are already aligned grids).
    crop_bbox = (0, 0, w, h)

    pred = ocr_fn(img, rows, cols, crop_bbox)

    # Build a dense prediction grid (cells with no detection get None).
    dense_pred: dict[tuple[int, int], str | None] = {}
    for r in range(rows):
        for c in range(cols):
            v = pred.get((r, c))
            dense_pred[(r, c)] = v[0] if v else None

    correct = 0
    invalid = 0  # cells with a non-null prediction that doesn't match GT
    missed = 0   # cells with no prediction but GT has a code
    total_non_empty_gt = 0
    for (r, c), gt_code in gt_cells.items():
        if gt_code is None:
            continue  # empty in GT → no contribution
        total_non_empty_gt += 1
        p = dense_pred.get((r, c))
        if p is None:
            missed += 1
        elif p == gt_code:
            correct += 1
        else:
            invalid += 1

    return {
        "image": image_path.name,
        "rows": rows,
        "cols": cols,
        "total_non_empty_gt": total_non_empty_gt,
        "correct": correct,
        "invalid": invalid,
        "missed": missed,
        "exact_match_rate": correct / max(1, total_non_empty_gt),
        "coverage": (correct + invalid) / max(1, total_non_empty_gt),
    }


def main():
    from ocr_core.inference import ocr_cells_from_crop as ocr_cells_from_crop_crnn

    if not MANIFEST.exists():
        raise SystemExit(f"Missing {MANIFEST}")
    with open(MANIFEST, encoding="utf-8") as f:
        manifest = json.load(f)

    rows = []
    print(f"{'image':<60} {'exact%':>8} {'cov%':>8} {'corr/gt':>10}")
    print("-" * 90)
    for crop in manifest["crops"]:
        image_path = EXAMPLES_DIR / crop["file"]
        try:
            r = _evaluate_one(image_path, ocr_cells_from_crop_crnn)
        except FileNotFoundError as e:
            print(f"[skip] {e}")
            continue
        rows.append(r)
        print(
            f"{r['image'][:58]:<60} "
            f"{r['exact_match_rate']*100:>7.2f}% "
            f"{r['coverage']*100:>7.2f}% "
            f"{r['correct']:>5}/{r['total_non_empty_gt']:<5}"
        )
    if rows:
        total_correct = sum(r["correct"] for r in rows)
        total_gt = sum(r["total_non_empty_gt"] for r in rows)
        print("-" * 90)
        print(f"OVERALL exact_match_rate = {total_correct / max(1, total_gt):.4f}  ({total_correct}/{total_gt})")


if __name__ == "__main__":
    main()