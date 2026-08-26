#!/usr/bin/env python3
"""Grid legend recognition: big region -> rows*cols cells.

Takes a large legend region (user-selected big bbox), runs EasyOCR once
on that region, then assigns words to grid cells and parses each cell's
code+count via ocr_core.legend_box.

Usage:
    python -m training.scripts.recognize_legend_grid board.jpg --bbox 27,4672,7324,1196 --rows 8 --cols 8 --json out.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2
import numpy as np

from ocr_core.legend_box import BoxWord, LegendBoxBbox, load_mard_codes, parse_legend_box

def load_image(path: Path) -> np.ndarray:
    img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"cannot read image: {path}")
    return img

def read_words_in_region(image: np.ndarray, bbox: LegendBoxBbox, min_confidence: float = 0.15) -> list[BoxWord]:
    # Crop without additional safe margin (big region already tight)
    x0, y0 = int(round(bbox.x)), int(round(bbox.y))
    x1, y1 = int(round(bbox.x + bbox.width)), int(round(bbox.y + bbox.height))
    h,w = image.shape[:2]
    x0,y0 = max(0,x0), max(0,y0)
    x1,y1 = min(w,x1), min(h,y1)
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        return []
    # Upscale if small
    h_c,w_c = crop.shape[:2]
    min_side = min(h_c, w_c)
    scale = 1.0
    if min_side < 96 and min_side>0:
        scale = 96/min_side
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    import easyocr
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    raw = reader.readtext(crop, detail=1, paragraph=False, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()", batch_size=4)
    words=[]
    for bbox_pts, text, conf in raw:
        pts = np.asarray(bbox_pts, dtype=float)
        bx0,by0 = pts.min(axis=0)
        bx1,by1 = pts.max(axis=0)
        if scale != 1.0:
            bx0,by0,bx1,by1 = bx0/scale, by0/scale, bx1/scale, by1/scale
        words.append(BoxWord(text=text.strip().upper(), confidence=float(conf), x0=float(bx0+x0), y0=float(by0+y0), x1=float(bx1+x0), y1=float(by1+y0)))
    # filter by confidence but keep low conf digits if needed
    filtered=[w for w in words if w.confidence >= min_confidence]
    return filtered if filtered else words

def main()->int:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("image", type=Path)
    p.add_argument("--bbox", required=True, help="x,y,width,height")
    p.add_argument("--rows", type=int, required=True)
    p.add_argument("--cols", type=int, required=True)
    p.add_argument("--json", type=Path, help="output json")
    p.add_argument("--min-confidence", type=float, default=0.15)
    args=p.parse_args()
    if not args.image.is_file():
        p.error(f"image not found: {args.image}")
    if not (1 <= args.rows <= 20 and 1 <= args.cols <=20):
        p.error("rows/cols must be 1..20")
    try:
        x,y,w,h = map(float, args.bbox.replace(";",",").split(","))
    except Exception as e:
        p.error(f"bbox invalid: {e}")
    bbox=LegendBoxBbox(x=x,y=y,width=w,height=h)
    img=load_image(args.image)
    ih,iw = img.shape[:2]
    # validate bbox
    from ocr_core.legend_box import validate_bbox
    err, valid = validate_bbox({"x":x,"y":y,"width":w,"height":h}, iw, ih)
    if err:
        print(json.dumps({"code":err,"message":"bbox invalid"}, ensure_ascii=False))
        return 2
    mard=load_mard_codes()
    # read words once for big region (no extra expand)
    words = read_words_in_region(img, valid, min_confidence=args.min_confidence)
    # assign to grid
    cell_w = valid.width/args.cols
    cell_h = valid.height/args.rows
    grid_words=defaultdict(list)
    for w in words:
        col = int((w.x_center - valid.x)//cell_w)
        row = int((w.y_center - valid.y)//cell_h)
        col = max(0, min(args.cols-1, col))
        row = max(0, min(args.rows-1, row))
        grid_words[(row,col)].append(w)
    results=[]
    for r in range(args.rows):
        for c in range(args.cols):
            cell_bbox=LegendBoxBbox(x=valid.x + c*cell_w, y=valid.y + r*cell_h, width=cell_w, height=cell_h)
            ws = sorted(grid_words[(r,c)], key=lambda x: (x.y_center, x.x_center))
            res = parse_legend_box(ws, mard, bbox=cell_bbox, expanded_bbox=None)
            d=res.to_dict()
            d["row"]=r
            d["col"]=c
            d["bbox"]= {"x":int(round(cell_bbox.x)), "y":int(round(cell_bbox.y)), "width":int(round(cell_bbox.width)), "height":int(round(cell_bbox.height))}
            results.append(d)
    out={"rows":args.rows,"cols":args.cols,"bbox":{"x":int(valid.x),"y":int(valid.y),"width":int(valid.width),"height":int(valid.height)},"cells":results}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(out, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    # exit 0 even if some cells failed, to allow partial success
    return 0

if __name__=="__main__":
    raise SystemExit(main())
