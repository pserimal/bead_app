#!/usr/bin/env python3
"""Evaluate board-trained CRNN on zip baseline + board held-out + val sets.

Runs the production runtime path (letterbox 48×48, constrained decode over
each eval set's own code vocabulary) for every checkpoint given, and prints
a comparison table.  Also breaks the held-out set down per source board.
"""
from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent  # training/scripts/ → repo root
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import os
os.chdir(_REPO_ROOT)

import cv2
import numpy as np
import torch

from ocr_core.bead_ocr_crnn import constrained_decode, load_checkpoint
from training.scripts.eval_cell_baseline import (
    BLANK_PENALTY,
    MIN_CONF,
    evaluate,
    load_zip_cells,
    print_summary,
)

ROOT = _REPO_ROOT
ZIP_PATH = ROOT / "training" / "samples" / "stand" / "标注结果" / "1_标注结果_2026-07-26.zip"
HELDOUT_DIR = ROOT / "training" / "data" / "board_cells_train2" / "heldout"
VAL_DIR = ROOT / "training" / "data" / "board_cells_train2" / "val"
HELDOUT_BOARDS = ["09_23", "05_16", "08_22", "22_8"]


def load_manifest_dir(cells_dir: Path) -> tuple[list[np.ndarray], list[str], list[str]]:
    """(imgs_bgr, labels, source_board) from cells dir + manifest.csv.

    Uses the manifest when its 文件名 entries resolve to real files;
    otherwise falls back to parsing the code from the filename itself
    (build_train_set2 wrote `tr`/`va` files but `train`/`val` manifest
    names — filename fallback keeps both working).
    """
    from training.scripts.train_crnn import _parse_code_from_filename

    manifest = cells_dir / "manifest.csv"
    imgs, labels, boards = [], [], []
    if manifest.exists():
        with open(manifest, encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                fname = row["文件名"]
                p = Path(fname) if ("/" in fname or "\\" in fname) else cells_dir / fname
                if p.exists():
                    img = cv2.imdecode(np.fromfile(str(p), dtype=np.uint8),
                                       cv2.IMREAD_COLOR)
                    if img is not None:
                        imgs.append(img)
                        labels.append(row["编码"])
                        boards.append(row.get("来源", ""))
    # Fallback: any PNG not covered by a valid manifest row (or no manifest).
    if not imgs:
        for p in sorted(cells_dir.glob("*.png")):
            code = _parse_code_from_filename(p.name)
            if not code:
                continue
            img = cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                continue
            imgs.append(img)
            labels.append(code)
            boards.append("")
    return imgs, labels, boards


def per_code_table(r: dict, top_n: int = 8) -> list[str]:
    lines = []
    ranked = sorted(r["per_code"].items(),
                    key=lambda kv: (kv[1]["accuracy"], kv[1]["n"]))
    worst = ranked[:top_n]
    best = ranked[-top_n:]
    lines.append("  worst:")
    for code, d in worst:
        lines.append(f"    {code:6s} n={d['n']:6d} acc={d['accuracy']:.3f}")
    lines.append("  best:")
    for code, d in reversed(best):
        lines.append(f"    {code:6s} n={d['n']:6d} acc={d['accuracy']:.3f}")
    return lines


def main() -> int:
    ckpts = [Path(sys.argv[i]) for i in range(1, len(sys.argv))] or [
        ROOT / "training" / "checkpoints" / "crnn_board_m2.pt",
        ROOT / "training" / "checkpoints" / "crnn_real_m.pt",
    ]
    out_json: dict = {}

    zip_imgs, zip_labels = load_zip_cells(ZIP_PATH)
    ho_imgs, ho_labels, ho_boards = load_manifest_dir(HELDOUT_DIR)
    val_imgs, val_labels, _ = load_manifest_dir(VAL_DIR)
    print(f"[data] zip={len(zip_labels)} heldout={len(ho_labels)} val={len(val_labels)}")

    # Per-set code vocab (each eval set constrains decode with its own labels).
    zip_codes = sorted(set(zip_labels))
    ho_codes = sorted(set(ho_labels))
    val_codes = sorted(set(val_labels))

    for ck in ckpts:
        if not ck.exists():
            print(f"[skip] {ck} not found")
            continue
        model, chars = load_checkpoint(ck, device="cpu")
        print(f"\n===== {ck.name} (chars={len(chars)}) =====")
        r_zip = evaluate(model, chars, zip_imgs, zip_labels, zip_codes)
        r_ho = evaluate(model, chars, ho_imgs, ho_labels, ho_codes)
        r_val = evaluate(model, chars, val_imgs, val_labels, val_codes)
        print_summary("zip     ", ck.name, r_zip)
        print_summary("heldout ", ck.name, r_ho)
        print_summary("val     ", ck.name, r_val)

        # Held-out per-board breakdown.
        if ho_boards:
            by_board: dict[str, dict] = {}
            for b in sorted(set(ho_boards)):
                idx = [i for i, x in enumerate(ho_boards) if x == b]
                sub_imgs = [ho_imgs[i] for i in idx]
                sub_labels = [ho_labels[i] for i in idx]
                by_board[b] = evaluate(model, chars, sub_imgs, sub_labels, ho_codes)
            print("  heldout per-board exact_match:")
            for b, r in by_board.items():
                print(f"    {b:12s} n={r['n_cells']:7d} em={r['exact_match_rate']:.4f}")
            out_json.setdefault("heldout_per_board", {})[ck.name] = {
                b: r["exact_match_rate"] for b, r in by_board.items()
            }

        print("  zip per-code:")
        for line in per_code_table(r_zip):
            print(line)
        print("  heldout per-code:")
        for line in per_code_table(r_ho):
            print(line)

        out_json[ck.name] = {
            "num_classes": len(chars),
            "zip": r_zip,
            "heldout": r_ho,
            "val": r_val,
        }

    out = ROOT / "training" / "docs" / "eval-board-model.json"
    out.write_text(json.dumps(out_json, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
