#!/usr/bin/env python3
"""Build mard training cells through a full diagram -> crop pipeline.

Unlike the old per-cell generator, this script:

1. renders many mard-labelled source cells;
2. randomly lays them out into large diagrams;
3. overlays full-page watermarks and periodic blue grid separators;
4. crops the diagrams again with a simulated user crop-box offset;
5. writes the cropped cells and a manifest.

This keeps neighboring cells, watermarks, grid lines and crop errors in the
same image context as production OCR.
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from ocr_core.code_library import load_library  # noqa: E402
from training.models.board_generator import _WM_CHARS, _get_wm_font  # noqa: E402
from training.models.synth_generator import available_fonts  # noqa: E402
from training.scripts.build_mard_dataset import render_cell  # noqa: E402
from training.scripts.crop_board import crop_board_dir  # noqa: E402


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _luma(hex_color: str) -> float:
    r, g, b = _hex_to_rgb(hex_color)
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255


def _render_blank_cell(rng: random.Random, base: tuple[int, int, int],
                       fonts: list[str]) -> Image.Image:
    """Render a blank cell: near-white background + watermark residue +
    grid/edge noise, matching real empty bead cells.

    Real blank cells are NOT transparent white: they carry a light bead
    background (~220-245), faint watermark stroke fragments, occasional
    grid lines, and sensor noise.
    """
    SZ = 96
    img = Image.new("RGB", (SZ, SZ), base)
    draw = ImageDraw.Draw(img)

    # Faint watermark glyph fragments. Real blank cells carry DARK gray
    # residue of a faded watermark/text stroke over the light bead
    # background (the 4_标注 set shows dark 0.24 foreground). White marks
    # would be invisible on a light background.
    if rng.random() < 0.95:
        wm_font = _get_wm_font()
        if wm_font is not None:
            fs = rng.randint(44, 96)
            font = ImageFont.truetype(wm_font.path, fs)
            text = rng.choice([_WM_CHARS[_] for _ in rng.sample(range(len(_WM_CHARS)),
                                                                rng.randint(1, 4))])
            alpha = rng.randint(60, 110)
            color = rng.choice([(90, 90, 90), (120, 120, 120), (70, 70, 80),
                                (130, 120, 110), (150, 140, 130)])
            ox = rng.randint(-SZ // 2, SZ // 2)
            oy = rng.randint(-SZ // 2, SZ // 2)
            ov = Image.new("RGBA", (SZ, SZ), (0, 0, 0, 0))
            ImageDraw.Draw(ov).text((ox, oy), text, font=font, fill=(*color, alpha))
            img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
            draw = ImageDraw.Draw(img)

    # Per-cell grid residue — real blank cells almost always have at least
    # one border line visible (the 5_标注 set shows a left column line).
    if rng.random() < 0.95:
        n_edges = rng.choice([1, 1, 1, 2])
        edges = rng.sample(["top", "left", "bottom", "right"], n_edges)
        lw = rng.choice([1, 1, 2, 2])
        gcol = rng.choice([(150, 150, 150), (170, 170, 170), (185, 185, 190),
                           (140, 145, 155)])
        for edge in edges:
            if edge == "top":
                draw.line([(0, 0), (SZ, 0)], fill=gcol, width=lw)
            elif edge == "bottom":
                draw.line([(0, SZ - 1), (SZ, SZ - 1)], fill=gcol, width=lw)
            elif edge == "left":
                draw.line([(0, 0), (0, SZ)], fill=gcol, width=lw)
            else:
                draw.line([(SZ - 1, 0), (SZ - 1, SZ)], fill=gcol, width=lw)

    img = img.resize((CELL_SIZE, CELL_SIZE), Image.LANCZOS)
    arr = np.array(img)

    # Mild noise + brightness jitter (sensor noise, photo compression).
    if rng.random() < 0.9:
        sigma = rng.uniform(2.0, 6.0)
        arr = np.clip(arr.astype(np.float32) + np.random.normal(0, sigma, arr.shape),
                      0, 255).astype(np.uint8)
    if rng.random() < 0.7:
        delta = rng.randint(-22, 10)
        arr = np.clip(arr.astype(np.int16) + delta, 0, 255).astype(np.uint8)

    return Image.fromarray(arr)

CELL_SIZE = 48


def _mard_entries() -> list[dict]:
    entries = [e for e in load_library() if e.get("brand") == "mard"]
    if len(entries) != 291:
        raise RuntimeError(f"expected 291 mard entries, got {len(entries)}")
    return sorted(entries, key=lambda e: e["code"])


def _watermark(board: Image.Image, rng: random.Random) -> Image.Image:
    """Tile random near-white/light-gray watermark text across the whole page."""
    wm_font = _get_wm_font()
    if wm_font is None:
        return board
    W, H = board.size
    short_side = min(W, H)
    font_size = max(24, int(short_side * rng.uniform(0.045, 0.11)))
    font = ImageFont.truetype(wm_font.path, font_size)
    text = "".join(rng.choice(_WM_CHARS) for _ in range(rng.randint(2, 8)))
    bbox = font.getbbox(text)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    step_x = max(tw + 1, int(tw * rng.uniform(1.25, 1.75)))
    step_y = max(th + 1, int(th * rng.uniform(1.25, 1.75)))
    ox = rng.randint(-step_x, step_x)
    oy = rng.randint(-step_y, step_y)
    # Real diagrams vary between translucent white and pale gray marks.
    base = rng.choice([(255, 255, 255), (235, 235, 235), (215, 215, 215)])
    alpha = rng.randint(22, 62)

    overlay = Image.new("RGBA", board.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for y in range(-step_y, H + step_y, step_y):
        for x in range(-step_x, W + step_x, step_x):
            draw.text((x + ox - bbox[0], y + oy - bbox[1]), text,
                      font=font, fill=(*base, alpha))
    return Image.alpha_composite(board.convert("RGBA"), overlay).convert("RGB")


def _blue_grid(board: Image.Image, rows: int, cols: int,
               rng: random.Random) -> Image.Image:
    """Draw blue separator lines every few cells, as on shared diagrams."""
    draw = ImageDraw.Draw(board)
    interval = rng.randint(4, 10)
    blue = rng.choice([
        (55, 145, 220), (58, 155, 210), (70, 130, 205),
    ])
    width = rng.choice([1, 2, 2])
    W, H = board.size
    for col in range(interval, cols, interval):
        x = col * CELL_SIZE
        draw.line([(x, 0), (x, H)], fill=blue, width=width)
    for row in range(interval, rows, interval):
        y = row * CELL_SIZE
        draw.line([(0, y), (W, y)], fill=blue, width=width)
    return board


def _build_pool(codes: list[str], count: int, rng: random.Random) -> list[str]:
    """Ensure every code appears in each sufficiently large diagram."""
    pool = (codes * ((count + len(codes) - 1) // len(codes)))[:count]
    rng.shuffle(pool)
    return pool


def build(out_root: Path, boards: int = 24, rows: int = 32,
          cols: int = 40, per_board_seed: int = 0,
          watermark_prob: float = 1.0) -> dict:
    entries = _mard_entries()
    by_code = {e["code"]: e for e in entries}
    codes = sorted(by_code)
    fonts = available_fonts()
    if not fonts:
        raise RuntimeError("no fonts available")

    if out_root.exists():
        shutil.rmtree(out_root)
    board_root = out_root / "boards"
    cells_root = out_root / "cells"
    board_root.mkdir(parents=True)
    cells_root.mkdir(parents=True)
    all_rows: list[dict] = []
    rng = random.Random(per_board_seed)
    total_expected = rows * cols * boards

    for board_no in range(boards):
        board_rng = random.Random(rng.randint(0, 2**31 - 1))
        code_pool = _build_pool(codes, rows * cols, board_rng)
        # Randomly replace a fraction of cells with BLANK (real diagrams have
        # empty bead positions; they are not transparent white but carry the
        # same bead background + watermark/grid residue as neighboring cells).
        blank_frac = board_rng.uniform(0.05, 0.15)
        blank_positions = set(board_rng.sample(range(len(code_pool)),
                                               int(len(code_pool) * blank_frac)))
        board = Image.new("RGB", (cols * CELL_SIZE, rows * CELL_SIZE), "white")
        cells_meta = []
        for idx, code in enumerate(code_pool):
            r, c = divmod(idx, cols)
            if idx in blank_positions:
                # Blank cell: near-white bead background (real empty beads are
                # light gray/cream, not pure white), no printed code. It will
                # inherit the page watermark + grid lines drawn afterwards.
                light = board_rng.choice([e for e in entries
                                          if _luma(e["color_hex"]) > 0.8
                                          and abs(_hex_to_rgb(e["color_hex"])[0]
                                                  - _hex_to_rgb(e["color_hex"])[1]) < 25
                                          and abs(_hex_to_rgb(e["color_hex"])[1]
                                                  - _hex_to_rgb(e["color_hex"])[2]) < 25])
                base = _hex_to_rgb(light["color_hex"])
                tile_img = _render_blank_cell(board_rng, base, fonts)
                code_label = "BLANK"
                color_hex = light["color_hex"]
            else:
                entry = by_code[code]
                tile = render_cell(board_rng, code, entry["color_hex"], fonts,
                                   cell_size=CELL_SIZE)
                tile_img = Image.fromarray(tile)
                code_label = code
                color_hex = entry["color_hex"]
            board.paste(tile_img, (c * CELL_SIZE, r * CELL_SIZE))
            cells_meta.append({
                "row": r + 1, "col": c + 1, "code": code_label,
                "color_hex": color_hex,
            })

        board = _blue_grid(board, rows, cols, board_rng)
        if board_rng.random() <= watermark_prob:
            board = _watermark(board, board_rng)

        bdir = board_root / f"board_{board_no:03d}"
        bdir.mkdir()
        board.save(bdir / "board.png")
        (bdir / "board.json").write_text(json.dumps({
            "format_version": 1,
            "board": {
                "brand": "mard", "rows": rows, "cols": cols,
                "cell_size_px": CELL_SIZE,
                "watermark": watermark_prob > 0,
                "grid_interval": "random-4-10",
                "seed": board_no + per_board_seed,
            },
            "cells": cells_meta,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        result = crop_board_dir(bdir, seed=board_no + per_board_seed)
        if not result.get("ok"):
            raise RuntimeError(f"crop failed for {bdir}: {result}")
        cropped_dir = bdir / "cells"
        with open(cropped_dir / "manifest.csv", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                src = cropped_dir / row["文件名"]
                # Prefix board id so filenames remain unique in aggregate set.
                name = f"b{board_no:03d}_{row['文件名']}"
                shutil.copy(src, cells_root / name)
                row["文件名"] = name
                all_rows.append(row)
        print(f"[board {board_no + 1}/{boards}] {result['cells']} cropped cells")

    with open(out_root / "manifest.csv", "w", encoding="utf-8-sig",
              newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["编码", "文件名", "行", "列", "色相", "亮度"])
        writer.writeheader()
        writer.writerows(all_rows)

    print(f"[done] {out_root}: {len(all_rows)}/{total_expected} cells, "
          f"{len(set(r['编码'] for r in all_rows))} mard codes")
    return {"cells": len(all_rows), "codes": len(set(r["编码"] for r in all_rows))}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path,
                   default=_REPO_ROOT / "training" / "data" / "mard_board")
    p.add_argument("--boards", type=int, default=24)
    p.add_argument("--rows", type=int, default=32)
    p.add_argument("--cols", type=int, default=40)
    p.add_argument("--seed", type=int, default=20260808)
    p.add_argument("--watermark-prob", type=float, default=1.0)
    args = p.parse_args()
    build(args.out, args.boards, args.rows, args.cols, args.seed,
          args.watermark_prob)


if __name__ == "__main__":
    main()
