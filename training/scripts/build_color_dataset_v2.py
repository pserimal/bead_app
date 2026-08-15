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

    python -m training.scripts.build_color_dataset_v2 \\
        --name color_v11 --boards-dir training/data/mard_board_v3 \\
        --out training/data/color_v11 \\
        --exclude-dirs code_main,blank_clean,blank_polluted,blank_polluted_ref

Notes on data hygiene (2026-08-15):

- ``--exclude-dirs`` removes the eval_acceptance benchmark directories from
  the training set so the acceptance gate measures *unseen* real cells, not
  cells the model already memorized (was: same-source leakage).
- BLANK cells are capped per-source (``--blank-cap``): real annotation
  BLANKs are never discarded (they carry the valuable watermark-residue
  signal); only synthetic-board BLANKs beyond the cap are dropped, keeping
  the label distribution sane without throwing away real evidence.
- A ``dataset.json`` is written with the exact synth:real ratio, per-source
  counts, BLANK cap applied, and blur-level stats (from the boards
  ``board_*/board.json``), so every training run is auditable.
"""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from collections import Counter
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Default eval_acceptance benchmark dirs (training/samples/标注数据) — these
# must stay OUT of training so the gate measures generalization. Matches
# REAL_SETS keys in eval_acceptance.py.
DEFAULT_EXCLUDES = {
    "1_标注结果_2026-07-29": "code_main",
    "5_标注结果_2026-08-08": "blank_clean",
    "corrections-fdaa77a1-2026-08-09": "blank_polluted",
    "4_标注结果_2026-08-08": "blank_polluted_ref",
    "corrections-b48348f1-2026-08-15-模糊图纸": "blur_real",
}


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
                           prefix: str) -> dict:
    """Copy every PNG in ann_root (non-recursive) with the given filename prefix.

    Returns per-label counts for the dataset.json audit.
    """
    if not ann_root.exists():
        return {}
    cnt: Counter = Counter()
    n = 0
    for f in sorted(ann_root.glob("*.png")):
        code = _label(f.name)
        if not code:
            continue
        name = f"{prefix}_{f.name}"
        shutil.copy(f, cells_dir / name)
        rows.append({"编码": code, "文件名": name, "行": "", "列": "",
                     "色相": "", "亮度": ""})
        cnt[code] += 1
        n += 1
    print(f"  [{prefix}] {n} cells from {ann_root.name}")
    return dict(cnt)


def _blur_stats(boards_dir: Path) -> dict:
    """Count blur levels actually applied, from each board's board.json.

    board.json stores ``board.blur_level`` since 2026-08-15 (generator writes
    it). Older corpora without the field count as "unknown".
    """
    stats = {"clear": 0, "slight": 0, "moderate": 0, "heavy": 0, "unknown": 0}
    if not boards_dir.exists():
        return stats
    boards = sorted(boards_dir.glob("board_*/board.json"))
    for b in boards:
        try:
            meta = json.load(open(b, encoding="utf-8"))
            lvl = meta.get("board", {}).get("blur_level")
        except Exception:
            lvl = None
        if lvl in stats:
            stats[lvl] += 1
        else:
            stats["unknown"] += 1
    return stats


def build(name: str, boards_dir: Path, out_root: Path,
          ann_root: Path | None = None, blank_cap: int | None = 4000,
          exclude_dirs: list[str] | None = None) -> dict:
    """Build the training set.

    - ``blank_cap`` caps *synthetic-board* BLANK cells only (real-annotation
      BLANKs are always kept — they are the valuable watermark-residue
      evidence). None = no cap.
    - ``exclude_dirs``: benchmark directories to keep out of training.
    """
    import random as _rng
    if ann_root is None:
        ann_root = _REPO_ROOT / "training" / "samples" / "标注数据"
    if exclude_dirs is None:
        exclude_dirs = sorted(DEFAULT_EXCLUDES.keys())

    dst = out_root / name
    if dst.exists():
        shutil.rmtree(dst)
    cells = dst / "cells"
    cells.mkdir(parents=True)
    rows: list[dict] = []
    sources: dict = {}

    # 1. Synthetic diagram cells (incl. BLANK).
    synth_blanks = 0
    if boards_dir.exists():
        man = boards_dir / "manifest.csv"
        if man.exists():
            n = 0
            for r in csv.DictReader(open(man, encoding="utf-8-sig")):
                src = boards_dir / "cells" / r["文件名"]
                if src.exists():
                    shutil.copy(src, cells / r["文件名"])
                    rows.append(r)
                    n += 1
                    if r["编码"] == "BLANK":
                        synth_blanks += 1
            print(f"  [boards] {n} cells from {boards_dir.name}")
            sources["synth_boards"] = {"cells": n, "blank": synth_blanks,
                                       "blur": _blur_stats(boards_dir)}
        else:
            print(f"  [warn] no manifest in {boards_dir}")
    else:
        print(f"  [warn] boards dir missing: {boards_dir}")

    # 2. Manual annotations (auto-discovered subdirs), minus benchmark dirs.
    real_sources: dict = {}
    real_blanks = 0
    for sub in sorted(ann_root.iterdir()):
        if not sub.is_dir():
            continue
        if sub.name in exclude_dirs:
            print(f"  [exclude] {sub.name} (eval benchmark, kept out of training)")
            continue
        cnt = _copy_real_annotations(sub, cells, rows, f"m_{sub.name[:1]}")
        if cnt:
            real_sources[sub.name] = {"cells": sum(cnt.values()),
                                      "blank": cnt.get("BLANK", 0)}
            real_blanks += cnt.get("BLANK", 0)

    # 3. Cap synthetic-board BLANKs only (real annotation BLANKs are gold —
    #    watermark-residue evidence — never dropped).
    synth_total = sum(v["cells"] for k, v in sources.items())
    cap_dropped = 0
    if blank_cap is not None and synth_blanks > blank_cap:
        # Find indices of synthetic BLANK rows (they came first, before real).
        # Rows are appended in order: boards block then real blocks. The
        # first synth_total rows are synthetic.
        blank_idx = [i for i, r in enumerate(rows[:synth_total])
                     if r["编码"] == "BLANK"]
        if len(blank_idx) > blank_cap:
            _rng.seed(0)
            _rng.shuffle(blank_idx)
            drop = set(blank_idx[blank_cap:])
            cap_dropped = len(drop)
            kept = [r for i, r in enumerate(rows) if i not in drop]
            for i in sorted(drop, reverse=True):
                (cells / rows[i]["文件名"]).unlink(missing_ok=True)
            rows = kept
            print(f"  [cap] synthetic BLANK {len(blank_idx)} -> {blank_cap} "
                  f"(dropped {cap_dropped}; real-annotation BLANK {real_blanks} kept)")

    with open(dst / "manifest.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["编码", "文件名", "行", "列", "色相", "亮度"])
        w.writeheader()
        w.writerows(rows)

    # 4. Audit metadata (problem 3: synth:real ratio + blur stats).
    cnt = Counter(r["编码"] for r in rows)
    meta = {
        "name": name,
        "built_at": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc).isoformat(),
        "boards_dir": str(boards_dir),
        "excluded_dirs": exclude_dirs,
        "blank_cap": blank_cap,
        "blank_cap_dropped": cap_dropped,
        "synth_cells": synth_total if sources else 0,
        "real_cells": sum(v["cells"] for v in real_sources.values()),
        "synth_blank": synth_blanks - cap_dropped,
        "real_blank_kept": real_blanks,
        "total_cells": len(rows),
        "total_codes": len(cnt),
        "blank_total": cnt.get("BLANK", 0),
        "synth_real_ratio": round(
            (synth_total if sources else 0) /
            max(1, sum(v["cells"] for v in real_sources.values())), 3),
        "sources": {"synth_boards": sources.get("synth_boards", {}),
                    "real": real_sources},
    }
    (dst / "dataset.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                      encoding="utf-8")
    print(f"[done] {dst}: {len(rows)} cells, {len(cnt)} codes, "
          f"BLANK={cnt.get('BLANK', 0)} "
          f"(synth:real={meta['synth_cells']}:{meta['real_cells']})")
    print(f"  dataset.json written (ratio/blur/sources audit)")
    return meta


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
                   help="max synthetic-BLANK cells kept (real BLANKs always kept; None = unlimited)")
    p.add_argument("--exclude-dirs", type=str, default=None,
                   help="comma-separated benchmark dir names to keep out of "
                        "training (default: the eval_acceptance 4 sets)")
    args = p.parse_args()

    ex = None
    if args.exclude_dirs is not None:
        ex = [d.strip() for d in args.exclude_dirs.split(",") if d.strip()]
    build(args.name, args.boards_dir, args.out_root, args.ann_root,
          blank_cap=args.blank_cap, exclude_dirs=ex)


if __name__ == "__main__":
    main()
