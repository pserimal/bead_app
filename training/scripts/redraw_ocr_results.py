"""Run OCR on all 3 real images and redraw results.

Reads manifest.json, runs ocr_cells_from_crop_easy on each image,
maps bead_code to color via default_colors.json, redraws the grid
with colored cells + text codes, and saves to /tmp/ocr-redraw/.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

MANIFEST = ROOT / "training" / "data" / "annotations" / "stand_manifest.json"
LIBRARY = ROOT / "backend" / "app" / "data" / "default_colors.json"
OUT_DIR = Path("/tmp/ocr-redraw")


def load_color_lib() -> dict[str, tuple[int, int, int]]:
    """Load bead codes → RGB colors."""
    with open(LIBRARY) as f:
        entries = json.load(f)
    lib: dict[str, tuple[int, int, int]] = {}
    for e in entries:
        code = e["code"]
        hex_color = e.get("color_hex", "")
        if hex_color and hex_color.startswith("#") and len(hex_color) == 7:
            r = int(hex_color[1:3], 16)
            g = int(hex_color[3:5], 16)
            b = int(hex_color[5:7], 16)
            lib[code] = (r, g, b)
    return lib


def redraw_image(
    ocr_result: dict[tuple[int, int], tuple[str, float]],
    color_lib: dict[str, tuple[int, int, int]],
    rows: int,
    cols: int,
    cell_size: int = 16,
    font_size: int = 10,
) -> Image.Image:
    """Redraw the grid from OCR results with colored cells + text codes."""
    img_w = cols * cell_size
    img_h = rows * cell_size
    img = Image.new("RGB", (img_w, img_h), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Try to load a font
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", font_size)
    except (OSError, IOError):
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", font_size)
        except (OSError, IOError):
            font = ImageFont.load_default()

    recognized = 0
    missed = 0
    for r in range(rows):
        for c in range(cols):
            x0 = c * cell_size
            y0 = r * cell_size
            x1 = x0 + cell_size
            y1 = y0 + cell_size

            det = ocr_result.get((r, c))
            if det is not None:
                code, conf = det
                color = color_lib.get(code)
                if color:
                    draw.rectangle([x0, y0, x1, y1], fill=color, outline=(200, 200, 200))
                    # Pick text color based on background brightness
                    lum = 0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]
                    text_color = (255, 255, 255) if lum < 128 else (0, 0, 0)
                    draw.text((x0 + 1, y0 + 1), code, fill=text_color, font=font)
                else:
                    # Code recognized but not in color lib
                    draw.rectangle([x0, y0, x1, y1], fill=(230, 230, 230), outline=(200, 200, 200))
                    draw.text((x0 + 1, y0 + 1), code, fill=(0, 0, 255), font=font)
                recognized += 1
            else:
                # Not recognized
                draw.rectangle([x0, y0, x1, y1], fill=(255, 240, 240), outline=(220, 200, 200))
                missed += 1

    return img, recognized, missed


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    with open(MANIFEST) as f:
        manifest = json.load(f)

    color_lib = load_color_lib()
    print(f"Color library: {len(color_lib)} codes loaded\n")

    for crop_info in manifest["crops"]:
        fname = crop_info["file"]
        rows = crop_info["rows"]
        cols = crop_info["cols"]
        img_path = ROOT / "examples" / "stand" / fname

        print(f"{'='*60}")
        print(f"Image: {fname}")
        print(f"Grid: {rows} rows × {cols} cols = {rows*cols} cells")
        print(f"{'='*60}")

        # Load image
        img_bgr = cv2.imread(str(img_path))
        if img_bgr is None:
            print(f"  ✗ Cannot read: {img_path}")
            continue
        h, w = img_bgr.shape[:2]
        print(f"  Image size: {w}×{h}")

        # Run OCR
        from app.services.bead_ocr_easy import ocr_cells_from_crop_easy
        result = ocr_cells_from_crop_easy(
            image_bgr=img_bgr,
            user_rows=rows,
            user_cols=cols,
            crop_bbox=(0, 0, w, h),
            min_conf=0.0,
        )
        print(f"  Cells recognized: {len(result)}/{rows*cols} ({len(result)/(rows*cols)*100:.1f}%)")

        # Count unique codes
        unique_codes = set(code for code, _ in result.values())
        print(f"  Unique codes found: {len(unique_codes)}")
        print(f"  Sample codes: {sorted(unique_codes)[:10]}")

        # Redraw
        redrawn, recognized, missed = redraw_image(result, color_lib, rows, cols)
        out_path = OUT_DIR / f"{fname.rsplit('.', 1)[0]}_redraw.png"
        redrawn.save(str(out_path))
        print(f"  Redrawn saved: {out_path}")
        print(f"  Recognized: {recognized}, Missed: {missed}")
        print()

    print(f"\nAll redrawn images saved to: {OUT_DIR}")
    print(f"Files: {list(OUT_DIR.glob('*.png'))}")


if __name__ == "__main__":
    main()
