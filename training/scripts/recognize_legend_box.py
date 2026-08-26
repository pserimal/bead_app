#!/usr/bin/env python3
"""Single legend-box recognition baseline (user-selected rect).

Usage (bead-train env)::

    conda run -n bead-train python -m training.scripts.recognize_legend_box \
        path/to/board.jpg --bbox 1200,3500,420,150 --json out.json --debug-dir .scratch/box

The script does not modify ``training/scripts/extract_mard_legend.py``; it
uses the shared ``ocr_core.legend_box`` parsing core and EasyOCR as an
offline baseline.  At deploy time the Rust runtime will implement the same
contract without a Python dependency.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2
import numpy as np

from ocr_core.legend_box import (
    BoxWord,
    LegendBoxBbox,
    expand_bbox,
    load_mard_codes,
    parse_legend_box,
    validate_bbox,
)


def load_image(path: Path) -> np.ndarray:
    im = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if im is None:
        raise ValueError(f"cannot read image: {path}")
    return im


def read_words_in_box(
    image: np.ndarray,
    expanded: LegendBoxBbox,
    min_confidence: float = 0.20,
) -> list[BoxWord]:
    try:
        import easyocr
    except ImportError as exc:
        raise RuntimeError("EasyOCR is required (bead-train env)") from exc

    x0, y0 = int(round(expanded.x)), int(round(expanded.y))
    x1, y1 = int(round(expanded.x + expanded.width)), int(round(expanded.y + expanded.height))
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        return []

    # Upscale tiny boxes for OCR robustness (spec: tiny boxes still handled)
    # Keep aspect, target short side >= 96px
    h, w = crop.shape[:2]
    min_side = min(h, w)
    if min_side < 96 and min_side > 0:
        scale = 96 / min_side
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    raw = reader.readtext(crop, detail=1, paragraph=False, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()", batch_size=4)

    words: list[BoxWord] = []
    for bbox, text, conf in raw:
        pts = np.asarray(bbox, dtype=float)
        bx0, by0 = pts.min(axis=0)
        bx1, by1 = pts.max(axis=0)
        # Map crop coords back to original image coords (accounting for resize)
        if min_side < 96 and min_side > 0:
            bx0, by0, bx1, by1 = bx0 / scale, by0 / scale, bx1 / scale, by1 / scale
        words.append(
            BoxWord(
                text=text.strip().upper(),
                confidence=float(conf),
                x0=float(bx0 + x0),
                y0=float(by0 + y0),
                x1=float(bx1 + x0),
                y1=float(by1 + y0),
            )
        )
    # Filter by confidence but keep at least the best word for diagnostics
    filtered = [w for w in words if w.confidence >= min_confidence]
    return filtered if filtered else words


def _parse_bbox_arg(s: str) -> dict:
    parts = [p.strip() for p in s.replace(";", ",").split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("bbox must be x,y,width,height (e.g. 1200,3500,420,150)")
    try:
        x, y, w, h = map(float, parts)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"bbox numbers invalid: {e}")
    return {"x": x, "y": y, "width": w, "height": h}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("image", type=Path, help="board image path")
    p.add_argument("--bbox", required=True, type=_parse_bbox_arg, help="user box x,y,width,height in original pixels")
    p.add_argument("--brand", default="mard", choices=["mard"], help="colour brand context")
    p.add_argument("--json", type=Path, help="write JSON result")
    p.add_argument("--debug-dir", type=Path, help="write debug overlay + crop")
    p.add_argument("--min-confidence", type=float, default=0.20)
    args = p.parse_args()

    if not args.image.is_file():
        p.error(f"image not found: {args.image}")

    image = load_image(args.image)
    h, w = image.shape[:2]
    err, bbox = validate_bbox(args.bbox, w, h)
    if err is not None:
        print(json.dumps({"status": "invalid", "code": err, "message": "bbox validation failed", "bbox": args.bbox}, ensure_ascii=False, indent=2))
        return 2

    assert bbox is not None
    expanded = expand_bbox(bbox, w, h)
    mard_codes = load_mard_codes()

    try:
        words = read_words_in_box(image, expanded, min_confidence=args.min_confidence)
    except RuntimeError as e:
        print(json.dumps({"status": "model_unavailable", "diagnostics": str(e)}, ensure_ascii=False, indent=2))
        return 3

    result = parse_legend_box(words, mard_codes, bbox=bbox, expanded_bbox=expanded)
    out = result.to_dict()

    print(json.dumps(out, ensure_ascii=False, indent=2))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.debug_dir:
        args.debug_dir.mkdir(parents=True, exist_ok=True)
        # Save expanded crop
        ex = expanded
        crop = image[int(round(ex.y)) : int(round(ex.y + ex.height)), int(round(ex.x)) : int(round(ex.x + ex.width))]
        ok, enc = cv2.imencode(".png", crop)
        if ok:
            (args.debug_dir / "crop.png").write_bytes(enc.tobytes())
        # Overlay
        overlay = image.copy()
        cv2.rectangle(overlay, (int(bbox.x), int(bbox.y)), (int(bbox.x + bbox.width), int(bbox.y + bbox.height)), (0, 220, 0), 3)
        cv2.rectangle(overlay, (int(ex.x), int(ex.y)), (int(ex.x + ex.width), int(ex.y + ex.height)), (255, 180, 0), 2)
        for w_ in words:
            cv2.rectangle(overlay, (int(w_.x0), int(w_.y0)), (int(w_.x1), int(w_.y1)), (0, 120, 255), 2)
            cv2.putText(overlay, f"{w_.text} {w_.confidence:.2f}", (int(w_.x0), max(12, int(w_.y0) - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 120, 255), 1, cv2.LINE_AA)
        ok, enc = cv2.imencode(".png", overlay)
        if ok:
            (args.debug_dir / "overlay.png").write_bytes(enc.tobytes())

    # Exit code: 0 accepted/needs_confirmation, 2 invalid/recognition_failed
    if result.status in ("invalid", "recognition_failed"):
        return 2
    if result.status == "model_unavailable":
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
