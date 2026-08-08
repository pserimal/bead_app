#!/usr/bin/env python3
"""Generate per-color training cells for the FULL mard palette.

The board-graph pipeline (generate_board) only covers colors that appear in
the source photo, so models never see ~237 of mard's 291 codes. This script
renders a cell for EVERY mard color: background = the bead's color_hex,
text = the code itself, so the model learns the color→code mapping directly.

Style follows the crop of a rendered board (board_generator + crop_board):
solid colored background, centered text, light grid-line residue, plus
diversity jitter (font, size, rotation, brightness/saturation).

Usage (repo root):
    python -m training.scripts.build_mard_dataset \
        --per-color 40 --out training/data/mard_full
"""
from __future__ import annotations

import argparse
import csv
import random
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont, ImageFilter  # noqa: E402

from ocr_core.code_library import load_library  # noqa: E402
from training.models.synth_generator import available_fonts  # noqa: E402


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _contrast_text_color(hex_color: str) -> tuple[int, int, int]:
    """Same rule as board_generator._contrast_text_color (reference)."""
    r, g, b = _hex_to_rgb(hex_color)
    luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    return (0, 0, 0) if luma > 0.5 else (255, 255, 255)


def render_cell(rng: random.Random, code: str, hex_color: str,
                fonts: list[str], cell_size: int = 48) -> np.ndarray:
    """Render one cell: colored background + centered code text (96→48).

    Text is always BLACK and large (like the annotation tool's marked
    style), regardless of background brightness — real marked cells draw
    black text over the bead color.  This differs from the diagram style
    (board_generator._contrast_text_color) which switches to white on
    dark backgrounds.
    """
    bg = _hex_to_rgb(hex_color)
    # Annotation-tool style: heavy text whose color contrasts the bead
    # background (black on light beads, white on dark beads) — matches
    # how real marked cells look (dark beads get white text, e.g. H7).
    text_rgb = _contrast_text_color(hex_color)

    SZ = 96  # render 2x then downscale
    img = Image.new("RGB", (SZ, SZ), bg)
    draw = ImageDraw.Draw(img)

    # Font / size / position jitter (mirror real diagram variance).
    # Larger text (marked style covers 40-60 % of the cell).
    font_size = rng.randint(40, 62)
    font = ImageFont.truetype(rng.choice(fonts), font_size)
    bbox = draw.textbbox((0, 0), code, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    jx = rng.randint(-10, 10)
    jy = rng.randint(-10, 10)
    cx = (SZ - tw) / 2 - bbox[0] + jx
    cy = (SZ - th) / 2 - bbox[1] + jy
    # Bold stroke thickness varies (marking tools differ) — 0..3 px.
    stroke = rng.randint(0, 3)
    draw.text((cx, cy), code, fill=text_rgb, font=font, stroke_width=stroke,
              stroke_fill=text_rgb)

    # Light grid-line residue on the left/top edge (like crop_board output).
    if rng.random() < 0.5:
        edge = rng.choice(["top", "left"])
        if edge == "top":
            draw.line([(0, 0), (SZ, 0)], fill="#DDDDDD", width=1)
        else:
            draw.line([(0, 0), (0, SZ)], fill="#DDDDDD", width=1)

    # Rotation ±5° (production crops are near axis-aligned but photos
    # can be slightly tilted).
    angle = rng.uniform(-5, 5)
    if abs(angle) > 0.3:
        img = img.rotate(angle, resample=Image.BILINEAR,
                         fillcolor=bg)

    # Affine warp (perspective/camera skew) — subtle ±0.02 shear.
    if rng.random() < 0.4:
        import cv2
        arr_w = np.array(img)
        M = np.float32([[1, rng.uniform(-0.02, 0.02), 0],
                        [rng.uniform(-0.02, 0.02), 1, 0]])
        arr_w = cv2.warpAffine(arr_w, M, (SZ, SZ),
                               flags=cv2.INTER_LINEAR,
                               borderMode=cv2.BORDER_REPLICATE)
        img = Image.fromarray(arr_w)

    # Downscale + LANCZOS (same as synth pipeline).
    img = img.resize((cell_size, cell_size), Image.LANCZOS)
    arr = np.array(img)

    # Brightness jitter ±12 %.
    if rng.random() < 0.5:
        delta = rng.randint(-30, 30)
        arr = np.clip(arr.astype(np.int16) + delta, 0, 255).astype(np.uint8)

    # Saturation jitter (keep color hue, vary intensity like camera WB).
    if rng.random() < 0.5:
        import cv2
        hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV).astype(np.int16)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * rng.uniform(0.7, 1.3), 0, 255)
        hsv[:, :, 2] = np.clip(hsv[:, :, 2] * rng.uniform(0.85, 1.15), 0, 255)
        arr = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB)

    # Mild Gaussian blur (camera softness).
    if rng.random() < 0.5:
        radius = rng.uniform(0.2, 1.2)
        arr = np.array(Image.fromarray(arr).filter(
            ImageFilter.GaussianBlur(radius=radius)))

    # JPEG artefacts.
    if rng.random() < 0.3:
        import io
        buf = io.BytesIO()
        Image.fromarray(arr).save(buf, format="JPEG",
                                  quality=rng.randint(60, 90))
        buf.seek(0)
        arr = np.array(Image.open(buf).convert("RGB"))

    return arr


def build(per_color: int, out_root: Path, seed: int = 0,
          cell_size: int = 48, brand: str = "mard") -> dict:
    lib = load_library()
    entries = [e for e in lib if e.get("brand") == brand]
    if not entries:
        raise ValueError(f"no {brand} entries in color library")
    # render_code: strip brand-conflict prefix (MARD- → ''), like boards.
    prefix = "MARD-" if brand == "mard" else ""
    fonts = available_fonts()
    if not fonts:
        raise RuntimeError("no fonts available (see synth_generator)")

    rng = random.Random(seed)
    cells_dir = out_root / "cells"
    cells_dir.mkdir(parents=True, exist_ok=True)

    rows: list[dict] = []
    total = 0
    for e in entries:
        code = e["code"]
        if prefix and code.startswith(prefix):
            code = code[len(prefix):]
        hexc = e["color_hex"]
        for i in range(per_color):
            arr = render_cell(rng, code, hexc, fonts, cell_size=cell_size)
            name = f"{code}_{i:04d}_mard.png"
            Image.fromarray(arr).save(cells_dir / name)
            rows.append({"编码": code, "文件名": name, "行": "",
                         "列": "", "色相": hexc, "亮度": ""})
            total += 1

    manifest = out_root / "manifest.csv"
    with open(manifest, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["编码", "文件名", "行", "列", "色相", "亮度"])
        writer.writeheader()
        writer.writerows(rows)

    codes = sorted({r["编码"] for r in rows})
    print(f"[done] {out_root}: {total} cells, {len(codes)} codes "
          f"(per-color={per_color}, brand={brand})")
    return {"cells": total, "codes": len(codes)}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--per-color", type=int, default=40,
                   help="cells per mard color (default 40)")
    p.add_argument("--out", type=Path,
                   default=_REPO_ROOT / "training" / "data" / "mard_full")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--cell-size", type=int, default=48)
    p.add_argument("--brand", default="mard")
    args = p.parse_args()
    build(args.per_color, args.out, seed=args.seed,
          cell_size=args.cell_size, brand=args.brand)


if __name__ == "__main__":
    main()
