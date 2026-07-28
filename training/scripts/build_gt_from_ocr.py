"""Generate a semi-automatic ground truth JSON for a real perler board image.

Runs the current EasyOCR-enhanced variant on a real image and produces
a ground-truth JSON in the format expected by benchmark_real.py:
    {rows, cols, cells: [{row, col, code, source}, ...]}

Cells where EasyOCR returned conf >= 0.9 are marked source="auto_high_conf".
All other cells are left with code=null and source="needs_manual" for
the user to fill in by hand.

Usage:
    cd backend && python scripts/build_gt_from_ocr.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from app.services.bead_ocr_easy import ocr_cells_from_crop_easy  # noqa: E402


AUTO_CONFIDENCE_THRESHOLD = 0.9


def build_gt(image_path: Path, rows: int, cols: int) -> dict:
    """Build semi-automatic ground truth for one real image."""
    img = cv2.imread(str(image_path))
    if img is None:
        raise FileNotFoundError(f"cannot read: {image_path}")
    h, w = img.shape[:2]

    ocr_result = ocr_cells_from_crop_easy(
        image_bgr=img,
        user_rows=rows,
        user_cols=cols,
        crop_bbox=(0, 0, w, h),
        min_conf=0.0,  # accept all detections; we filter by conf here
    )

    cells = []
    auto_count = 0
    manual_count = 0
    for r in range(rows):
        for c in range(cols):
            det = ocr_result.get((r, c))
            if det is not None and det[1] >= AUTO_CONFIDENCE_THRESHOLD:
                cells.append({
                    "row": r, "col": c,
                    "code": det[0],
                    "confidence": det[1],
                    "source": "auto_high_conf",
                })
                auto_count += 1
            else:
                cells.append({
                    "row": r, "col": c,
                    "code": None,
                    "confidence": 0.0,
                    "source": "needs_manual",
                })
                manual_count += 1

    return {
        "rows": rows,
        "cols": cols,
        "image": str(image_path.relative_to(ROOT)),
        "auto_threshold": AUTO_CONFIDENCE_THRESHOLD,
        "summary": {
            "total": rows * cols,
            "auto_high_conf": auto_count,
            "needs_manual": manual_count,
            "auto_coverage": auto_count / (rows * cols),
        },
        "cells": cells,
    }


def main() -> None:
    image_path = ROOT / "training" / "data" / "real" / "stand" / "拼豆日记54📔骑派大星（附图纸）_3_08e-_来自小红书网页版.jpg"
    out_path = image_path.with_suffix(".gt.json")

    gt = build_gt(image_path, rows=72, cols=56)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(gt, f, ensure_ascii=False, indent=2)

    print(f"✓ Wrote {out_path}")
    print(f"  Total cells: {gt['summary']['total']}")
    print(f"  Auto (conf ≥ {AUTO_CONFIDENCE_THRESHOLD}): {gt['summary']['auto_high_conf']} "
          f"({gt['summary']['auto_coverage']*100:.1f}%)")
    print(f"  Needs manual: {gt['summary']['needs_manual']}")
    print(f"\nNext: open {out_path} and fill in 'code' for needs_manual cells.")


if __name__ == "__main__":
    main()
