#!/usr/bin/env python3
"""CLI for generating a synthetic bead board from a real image.

Wraps ``training.models.board_generator.generate_board``: renders a full
拼豆图纸 (colored cells + bead codes + grid lines + optional watermark) from
a photograph, and writes ``board.png`` + ``board.json`` (per-cell brand/code/
1-based coordinates metadata) into ``training/data/boards/<board_id>/``.

Example::

    python -m training.scripts.generate_board \\
        --image path/to/photo.jpg --brand hama --cols 90 --seed 7

Rendered size: ``cols x round(cols * H / W)`` cells at ``--cell-size`` px.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from training.models.board_generator import (  # noqa: E402
    generate_board,
    save_board,
)
from training.models.synth_generator import available_fonts  # noqa: E402

from ocr_core.code_library import load_library  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--image", required=False, help="source photograph (JPG/PNG)")
    p.add_argument("--brand", default="mard",
                   help="bead brand id from the color library (default: mard)")
    p.add_argument("--cols", type=int, default=None,
                   help="number of grid columns (default: random in [30, 300])")
    p.add_argument("--cell-size", type=int, default=48,
                   help="rendered px per cell (default: 48)")
    p.add_argument("--merge-threshold", type=float, default=30.0,
                   help="RGB-euclidean merge distance (reference default: 30)")
    p.add_argument("--grid-interval", type=int, default=None,
                   help="separation line every N cells (default: random 5-20)")
    p.add_argument("--watermark-prob", type=float, default=0.40,
                   help="probability of adding a watermark (default: 0.40)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=Path, default=None,
                   help="output directory (default: training/data/boards/<stem>)")
    p.add_argument("--list-brands", action="store_true",
                   help="print available brands and exit")
    args = p.parse_args()

    if args.list_brands:
        brands: dict[str, int] = {}
        for e in load_library():
            brands[e["brand"]] = brands.get(e["brand"], 0) + 1
        for b, n in sorted(brands.items()):
            print(f"{b:16s} {n}")
        return 0

    if not args.image:
        p.error("--image is required unless --list-brands is used")
        return 2

    from PIL import Image
    import numpy as np

    src = Path(args.image)
    if not src.exists():
        print(f"image not found: {src}", file=sys.stderr)
        return 1
    with Image.open(src) as im:
        im.load()
        image = np.array(im.convert("RGB"))

    if not available_fonts():
        print("no rendering fonts available (see synth_generator.available_fonts)",
              file=sys.stderr)
        return 1

    board = generate_board(
        image,
        brand=args.brand,
        cols=args.cols,
        cell_size=args.cell_size,
        merge_threshold=args.merge_threshold,
        grid_interval=args.grid_interval,
        watermark_prob=args.watermark_prob,
        seed=args.seed,
        source_path=str(src),
    )

    out = args.out or (_REPO_ROOT / "training" / "data" / "boards" / src.stem)
    saved = save_board(board, out)
    print(f"board: {board.rows} x {board.cols} cells, brand={board.brand}")
    print(f"grid interval: {board.meta['board']['grid_interval']}, "
          f"watermark: {board.meta['board']['watermark']}")
    print(f"cells: {len(board.cells)} (first: "
          f"row={board.cells[0].row} col={board.cells[0].col} "
          f"code={board.cells[0].code} hex={board.cells[0].color_hex})")
    print(f"saved: {saved['png']}")
    print(f"       {saved['json']}")
    print(f"       {saved['preview']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
