#!/usr/bin/env python3
"""Build the mard training dataset from all real annotations + synthetic boards.

One command rebuilds ``training/data/color_v<N>`` from:

1. Synthetic diagram-derived mard cells (board generator + crop, incl. BLANK
   blank cells with watermark/grid residue);
2. EVERY manual annotation directory under ``training/samples/标注数据``
   (auto-discovered — drop new annotation folders there and re-run; naming
   conventions: ``CODE_*.png``, ``blank_*.png``, ``EMPTY_*.png``,
   ``CODE_r.._c.._h.._v..png``, ``BLANK_r.._c.._h.._v..png``).

Usage (repo root)::

    python -m training.scripts.build_color_dataset_v2 \
        --name color_v9 --boards-dir training/data/mard_board_v2 \
        --out training/data/color_v9
"""
from __future__ import annotations

import argparse
import csv
import shutil
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


def _label(name: str) -> str | None:
    stem = name.rsplit(".", 1)[0]
    if stem.lower().startswith(("blank_", "empty_")) or name.startswith("BLANK_"):
        return "BLANK"
    parts = stem.split("_")
    if len(parts) >= 5 and parts[1].startswith("r") and parts[2].startswith("c"):
        return parts[0].upper()
    if len(parts) >= 3 and parts[0].startswith("r") and parts[1].startswith("c"):
        return parts[2].upper()
    cand = parts[0].upper() if parts and parts[0][0].isalpha() else None
    return cand


def _copy_real_annotations(ann_root: Path, cells_dir: Path, rows: list[dict],
                           prefix: str) -> None:
    """Copy every PNG in ann_root (non-recursive) with the given filename prefix."""
    if not ann_root.exists():
        return
    n = 0
    for f in sorted(ann_root.glob("*.png")):
        code = _label(f.name)
        if not code:
            continue
        name = f"{prefix}_{f.name}"
        shutil.copy(f, cells_dir / name)
        rows.append({"编码": code, "文件名": name, "行": "", "列": "",
                     "色相": "", "亮度": ""})
        n += 1
    print(f"  [{prefix}] {n} cells from {ann_root.name}")


def build(name: str, boards_dir: Path, out_root: Path,
          ann_root: Path | None = None, blank_cap: int | None = 4000) -> dict:
    """Build the training set.

    ``blank_cap`` caps how many BLANK cells are kept (randomly sampled) so
    heavy blank annotations (e.g. 6607 blanks in one corrections dir) don't
    dominate training and skew the model toward predicting BLANK everywhere.
    None = no cap.
    """
    import random as _rng
    if ann_root is None:
        ann_root = _REPO_ROOT / "training" / "samples" / "标注数据"
    dst = out_root / name
    if dst.exists():
        shutil.rmtree(dst)
    cells = dst / "cells"
    cells.mkdir(parents=True)
    rows: list[dict] = []

    # 1. Synthetic diagram cells (incl. BLANK).
    if boards_dir.exists():
        man = boards_dir / "manifest.csv"
        if man.exists():
            for r in csv.DictReader(open(man, encoding="utf-8-sig")):
                src = boards_dir / "cells" / r["文件名"]
                if src.exists():
                    shutil.copy(src, cells / r["文件名"])
                    rows.append(r)
            print(f"  [boards] {len(rows)} cells from {boards_dir.name}")
        else:
            print(f"  [warn] no manifest in {boards_dir}")
    else:
        print(f"  [warn] boards dir missing: {boards_dir}")

    # 2. All manual annotations (auto-discovered subdirs).
    for sub in sorted(ann_root.iterdir()):
        if sub.is_dir():
            _copy_real_annotations(sub, cells, rows, f"m_{sub.name[:1]}")

    # 3. Cap BLANK count to keep the label distribution sane.
    if blank_cap is not None:
        blank_idx = [i for i, r in enumerate(rows) if r["编码"] == "BLANK"]
        if len(blank_idx) > blank_cap:
            _rng.seed(0)
            _rng.shuffle(blank_idx)
            drop = set(blank_idx[blank_cap:])
            kept = [r for i, r in enumerate(rows) if i not in drop]
            for i in sorted(drop, reverse=True):
                (cells / rows[i]["文件名"]).unlink(missing_ok=True)
            print(f"  [cap] BLANK {len(blank_idx)} -> {blank_cap}")
            rows = kept

    with open(dst / "manifest.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["编码", "文件名", "行", "列", "色相", "亮度"])
        w.writeheader()
        w.writerows(rows)

    from collections import Counter
    cnt = Counter(r["编码"] for r in rows)
    print(f"[done] {dst}: {len(rows)} cells, {len(cnt)} codes, "
          f"BLANK={cnt.get('BLANK', 0)}")
    return {"cells": len(rows), "codes": len(cnt), "blank": cnt.get("BLANK", 0)}


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--name", default="color_v9")
    p.add_argument("--boards-dir", type=Path,
                   default=_REPO_ROOT / "training" / "data" / "mard_board_v2")
    p.add_argument("--out-root", type=Path,
                   default=_REPO_ROOT / "training" / "data")
    p.add_argument("--ann-root", type=Path,
                   default=_REPO_ROOT / "training" / "samples" / "标注数据")
    p.add_argument("--blank-cap", type=int, default=4000,
                   help="max BLANK cells kept (None = unlimited)")
    args = p.parse_args()
    build(args.name, args.boards_dir, args.out_root, args.ann_root,
          blank_cap=args.blank_cap)


if __name__ == "__main__":
    main()
