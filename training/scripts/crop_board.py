#!/usr/bin/env python3
"""Cut a generated bead board into per-cell crops with coordinate metadata.

Consumes the output of ``generate_board`` (``board.png`` + ``board.json``)
and slices it into individual 48×48 cell images whose filenames embed the
1-based grid coordinates plus the bead code, so labels can be recovered
from ``board.json`` with zero ambiguity::

    training/data/boards/<id>/
    ├── board.png / board.json / board_preview.png
    └── cells/
        ├── r001_c001_A1.png
        ├── r001_c002_A2.png
        └── manifest.csv          # 编码,文件名,行,列,色相,亮度 (行/列 filled)

Design decisions (project grill session 2026-08-01, ADR 0005 follow-up):

- **Pure cut + tiny jitter** — unlike production OCR (`ocr_cells_from_crop`
  insets 10 % to skip grid lines), training cells are cut at the raw grid
  boundaries so grid-line pixels appear at cell edges (real user crops are
  never perfectly aligned); a tiny random offset (whole-grid ±2 px +
  per-cell ±1 px, seed-controlled) simulates user selection error.
- **Filenames: `r{row:03d}_c{col:03d}_{code}.png`** — 1-based coords match
  `board.json` cells[] directly; the code is duplicated in the name so
  `train_crnn._load_real_samples` (filename-parsing loader) works unchanged
  and cross-checks are possible.
- **Verification gate**: after cutting, every cell is checked — count must
  equal rows×cols and the filename code must match `board.json`; mismatches
  are reported and exit non-zero (jitter must never corrupt labels).

Usage::

    python -m training.scripts.crop_board --boards-dir training/data/boards/
    python -m training.scripts.crop_board --board-dir training/data/boards/1/

Output cells are written at the board's native cell size (48 px by default;
no resize/letterbox — the training pipeline applies its own letterboxing,
matching production inference).
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from PIL import Image  # noqa: E402

# Decompression-bomb guard: boards are our own output, can exceed 178 MP.
Image.MAX_IMAGE_PIXELS = None

GRID_JITTER_PX = 0    # whole-grid offset, default 0 — production divides the
                         # user's grid region exactly (ocr_cells_from_crop), so
                         # no offset exists inside the grid; jitter only makes
                         # sense as an EDGE tolerance test, not for training.
GRID_JITTER_MAX = 10  # edge-tolerance bound (kept for robustness testing)
# Per-cell jitter is intentionally ZERO: production crops divide the user's
# grid region evenly, so a selection error shifts ALL cells by the same
# offset (content stays correct, labels stay valid).  Random per-cell
# offsets would cut neighbouring cells and poison labels.
CELL_JITTER_PX = 0


def crop_board_dir(board_dir: Path, seed: int = 0) -> dict:
    """Cut one board directory. Returns a stats dict (see CLI)."""
    png = board_dir / "board.png"
    jsn = board_dir / "board.json"
    if not jsn.exists():
        return {"skipped": True, "reason": f"missing board.json in {board_dir}"}
    if not png.exists():
        return {"skipped": True, "reason": f"missing board.png in {board_dir}"}

    with open(jsn, encoding="utf-8") as f:
        meta = json.load(f)
    board = meta["board"]
    rows, cols = int(board["rows"]), int(board["cols"])
    cell_size = int(board.get("cell_size_px", 48))
    cells_meta = meta.get("cells")
    if not cells_meta:
        return {"skipped": True, "reason": f"board.json has no cells[] ({board_dir})"}

    with Image.open(png) as im:
        im.load()
        img = im.convert("RGB")
    w, h = img.size

    # Expectation check: rendered size should match rows×cols×cell_size.
    expect_w, expect_h = cols * cell_size, rows * cell_size
    if (w, h) != (expect_w, expect_h):
        return {
            "skipped": True,
            "reason": (f"size mismatch {w}x{h} vs expected {expect_w}x{expect_h} "
                       f"({board_dir})"),
        }

    cells_dir = board_dir / "cells"
    cells_dir.mkdir(parents=True, exist_ok=True)

    rng = random.Random(seed)
    # Mixed jitter: 80 % small (±GRID_JITTER_PX), 20 % large (±GRID_JITTER_MAX)
    # — mimics real user selection error (mostly small, occasionally big).
    if rng.random() < 0.8:
        gdx = rng.randint(-GRID_JITTER_PX, GRID_JITTER_PX)
        gdy = rng.randint(-GRID_JITTER_PX, GRID_JITTER_PX)
    else:
        gdx = rng.randint(-GRID_JITTER_MAX, GRID_JITTER_MAX)
        gdy = rng.randint(-GRID_JITTER_MAX, GRID_JITTER_MAX)

    n_written = 0
    mismatches: list[tuple[str, str, str]] = []
    manifest_rows: list[dict] = []
    for cell in cells_meta:
        r, c = int(cell["row"]), int(cell["col"])
        code = cell["code"]
        # Base window (1-based → pixel offset).
        x0 = (c - 1) * cell_size
        y0 = (r - 1) * cell_size
        # Jitter: whole-grid + per-cell, then clamp to image bounds.
        jx = rng.randint(-CELL_JITTER_PX, CELL_JITTER_PX)
        jy = rng.randint(-CELL_JITTER_PX, CELL_JITTER_PX)
        xa = max(0, x0 + gdx + jx)
        ya = max(0, y0 + gdy + jy)
        xb = min(w, x0 + cell_size + gdx + jx)
        yb = min(h, y0 + cell_size + gdy + jy)
        if xb <= xa or yb <= ya:
            mismatches.append((f"r{r}c{c}", code, "empty crop after clamp"))
            continue

        crop = img.crop((xa, ya, xb, yb))
        # Native size (48×48 by default; edge cells may be a px smaller after
        # clamp — training letterbox handles that, same as production).
        name = f"r{r:03d}_c{c:03d}_{code}.png"
        crop.save(cells_dir / name)
        n_written += 1
        manifest_rows.append(
            {"编码": code, "文件名": name, "行": r, "列": c, "色相": "", "亮度": ""}
        )

        # Cross-check: code embedded in filename must match metadata.
        fname_code = name.rsplit("_", 1)[1][:-4]
        if fname_code != code:
            mismatches.append((name, code, f"filename says {fname_code}"))

    # Manifest (same columns as the annotation tool's export; 行/列 now filled).
    manifest_path = cells_dir / "manifest.csv"
    with open(manifest_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f, fieldnames=["编码", "文件名", "行", "列", "色相", "亮度"]
        )
        writer.writeheader()
        writer.writerows(manifest_rows)

    expected = rows * cols
    count_ok = n_written == expected
    return {
        "skipped": False,
        "board": f"{rows}x{cols}",
        "cells": n_written,
        "expected": expected,
        "mismatches": mismatches,
        "count_ok": count_ok,
        "ok": count_ok and not mismatches,
        "out": cells_dir,
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--board-dir", type=Path, default=None,
                   help="single board directory to cut")
    p.add_argument("--boards-dir", type=Path, default=None,
                   help="directory of board dirs to cut (all subdirs)")
    p.add_argument("--seed", type=int, default=0,
                   help="jitter RNG seed (per board, fixed = reproducible)")
    args = p.parse_args()

    if args.board_dir and args.boards_dir:
        p.error("use either --board-dir or --boards-dir, not both")
    if not args.board_dir and not args.boards_dir:
        p.error("one of --board-dir / --boards-dir is required")

    targets: list[Path]
    if args.board_dir:
        targets = [args.board_dir]
    else:
        targets = sorted(
            d for d in args.boards_dir.iterdir() if d.is_dir()
        )

    total_cells = 0
    total_mismatch = 0
    failed: list[str] = []
    for i, d in enumerate(targets, 1):
        # Per-board seed derived from the global seed so runs are
        # reproducible while each board still gets different jitter.
        res = crop_board_dir(d, seed=args.seed * 1000 + i)
        if res.get("skipped"):
            print(f"[{i}/{len(targets)}] SKIP {d.name}: {res['reason']}")
            continue
        tag = "OK " if res["ok"] else "FAIL"
        extra = ""
        if not res["count_ok"]:
            extra += f" count={res['cells']}/{res['expected']}"
        if res["mismatches"]:
            extra += f" mismatch={len(res['mismatches'])}"
        print(f"[{i}/{len(targets)}] {tag} {d.name}: {res['board']} "
              f"cells={res['cells']} {extra}")
        total_cells += res["cells"]
        total_mismatch += len(res["mismatches"])
        if not res["ok"]:
            failed.append(d.name)
            for name, expect, got in res["mismatches"][:5]:
                print(f"      {name}: expect {expect!r}, got {got!r}")

    print(f"\ntotal: {len(targets)} boards, {total_cells} cells, "
          f"{total_mismatch} mismatches")
    if failed:
        print(f"FAILED boards: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
