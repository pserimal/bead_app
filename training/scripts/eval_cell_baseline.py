"""Cell-level recognition baseline for the CRNN user-crop path.

Establishes the reproducible "不得退化" baseline measured before the old
FastAPI backend is deleted. Mirrors the runtime inference contract from
``backend/app/services/bead_ocr_crnn_inference.py`` (letterbox to 48x48,
constrained decode over the CODES vocabulary, blank_penalty=2.0, min_conf
filter, confidence = exp(score / len(code))), but decodes with the
checkpoint's OWN charset (never the global 37-token synth_generator table)
— the same behavior the future ``ocr_core`` service will implement.

Eval sets (cell-level only; grid positions are unavailable in current GT):
  1. ``examples/stand/标注结果/1_标注结果_2026-07-26.zip``  — 7631 annotated
     cell crops + manifest.csv; label = 编码 column.
  2. ``examples/stand/cells/`` — code-in-filename samples (sample_000_H15.png).

The constrained-decode trie is built over the **eval set's code vocabulary**
(distinct 编码 labels ∩ checkpoint charset) — the checkpoint was trained on
exactly these 23 codes (A/B/C/E/F/G/H/M + digits), while the color-library
``CODES`` constant (65 codes, H/F/G only) is *not* the model's support set.
A trie over the color-library CODES would make every out-of-library label
(A4, A6, B23, C13, ...) unreachable — use ``--codes-source=colorlib`` to
reproduce that behavior for comparison.

Usage:
    cd <repo-root>
    /path/to/python.exe training/scripts/eval_cell_baseline.py \
        --checkpoint training/checkpoints/crnn_real_m.pt

Sweep all checkpoints (used to pick the baseline artifact):
    /path/to/python.exe training/scripts/eval_cell_baseline.py \
        --checkpoint training/checkpoints --sweep
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

# Bootstrap: ensure repo root is importable (scripts run from anywhere).
ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2
import numpy as np
import torch

from ocr_core.bead_ocr_crnn import (
    build_code_trie,
    constrained_decode,
    load_checkpoint,
    CheckpointFormatError,
)
from ocr_core.charset import charset_hash
from training.models.synth_generator import CODES

ZIP_PATH = ROOT / "training" / "samples" / "stand" / "标注结果" / "1_标注结果_2026-07-26.zip"
CELLS_DIR = ROOT / "training" / "samples" / "stand" / "cells"
MIN_CONF = 0.5
BLANK_PENALTY = 0.0
BATCH_SIZE = 128
CELL_RE = re.compile(r"sample_\d+_([A-Z]\d{1,3})\.png$")


# ── Letterbox crop, identical to the runtime ``_crop_cell`` ─────────


def _load_legacy(path: Path) -> tuple[object, list[str]]:
    """Migrate a legacy 3-key checkpoint in memory (010 R2 验收对比用).

    正式加载路径（ocr_core.bead_ocr_crnn.load_checkpoint）拒绝旧格式；
    这里仅为对比 011 基线数字而临时构造元数据。
    """
    import torch

    from ocr_core.bead_ocr_crnn import CRNN

    ckpt = torch.load(path, map_location="cpu", weights_only=False)
    chars = ckpt["chars"]
    model = CRNN(num_classes=ckpt["num_classes"])
    model.load_state_dict(ckpt["state_dict"])
    model.eval()
    print(f"[legacy] migrated {path.name} in memory ({len(chars)} chars, charset_hash={charset_hash()[:12]}...)")
    return model, chars


def _prep_cell(cell_bgr: np.ndarray, color: bool = False) -> np.ndarray:
    """Convert a BGR cell to the model input space.

    Grayscale (48, 48) for the 1-channel CRNN; RGB (48, 48, 3) for the
    RGB CRNN (BGR→RGB so channel order matches training).
    """
    if color:
        rgb = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        scale = min(48 / h, 48 / w) if h > 0 and w > 0 else 1.0
        new_h = max(1, int(round(h * scale)))
        new_w = max(1, int(round(w * scale)))
        resized = cv2.resize(rgb, (new_w, new_h), interpolation=cv2.INTER_AREA)
        canvas = np.full((48, 48, 3), 255, dtype=np.uint8)
        yoff = (48 - new_h) // 2
        xoff = (48 - new_w) // 2
        canvas[yoff : yoff + new_h, xoff : xoff + new_w] = resized
        return canvas
    gray = cv2.cvtColor(cell_bgr, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    scale = min(48 / h, 48 / w) if h > 0 and w > 0 else 1.0
    new_h = max(1, int(round(h * scale)))
    new_w = max(1, int(round(w * scale)))
    resized = cv2.resize(gray, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.full((48, 48), 255, dtype=np.uint8)
    yoff = (48 - new_h) // 2
    xoff = (48 - new_w) // 2
    canvas[yoff : yoff + new_h, xoff : xoff + new_w] = resized
    return canvas


# ── Eval-set loading ────────────────────────────────────────────────


def load_zip_cells(zip_path: Path) -> tuple[list[np.ndarray], list[str]]:
    """Return (cell_imgs_bgr, labels) from the annotation zip + manifest.csv."""
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if n.endswith(".png")]
        manifest = z.read("manifest.csv").decode("utf-8-sig", errors="replace")
    labels_by_name: dict[str, str] = {}
    for row in csv.DictReader(io.StringIO(manifest)):
        code = (row.get("编码") or "").strip().upper()
        fname = (row.get("文件名") or "").strip()
        if code and fname:
            labels_by_name[fname] = code
    imgs: list[np.ndarray] = []
    labels: list[str] = []
    with zipfile.ZipFile(zip_path) as z:
        for n in names:
            label = labels_by_name.get(n)
            if not label:
                continue
            data = np.frombuffer(z.read(n), dtype=np.uint8)
            img = cv2.imdecode(data, cv2.IMREAD_COLOR)
            if img is None:
                continue
            imgs.append(img)
            labels.append(label)
    return imgs, labels


def load_dir_cells(cells_dir: Path) -> tuple[list[np.ndarray], list[str]]:
    """Return (cell_imgs_bgr, labels) from code-in-filename sample crops."""
    imgs: list[np.ndarray] = []
    labels: list[str] = []
    if not cells_dir.exists():
        return imgs, labels
    for p in sorted(cells_dir.glob("sample_*.png")):
        m = CELL_RE.match(p.name)
        if not m:
            continue
        img = cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            continue
        imgs.append(img)
        labels.append(m.group(1))
    return imgs, labels


# ── Evaluation ──────────────────────────────────────────────────────


def evaluate(
    model: torch.nn.Module,
    chars: list[str],
    cell_imgs: list[np.ndarray],
    labels: list[str],
    valid_codes: list[str],
) -> dict:
    """Run batched inference + constrained decode; returns metrics dict.

    Reports two views:
      - ``exact_match_rate``: constrained-decode top-1 on ALL cells (no
        confidence rejection) — the decode-quality number the acceptance
        rule should be written against (mirrors training val_em semantics).
      - ``unknown_rate`` / ``accepted``: the runtime view with the
        ``min_conf`` filter applied (rejected cells = UNKNOWN). The current
        confidence formula ``exp(score/len(code))`` is miscalibrated for the
        T=11 model (correct cells score ~0.002), so the runtime filter
        rejects essentially everything — documented as a finding.
    """
    char_to_idx = {ch: i for i, ch in enumerate(chars)}
    trie = build_code_trie(valid_codes)
    codes_set = set(valid_codes)
    color = getattr(model, "input_channels", 1) == 3

    prepped = [_prep_cell(c, color=color) for c in cell_imgs]
    raw_preds: list[str] = []          # constrained decode, never rejected
    runtime_preds: list[str | None] = []  # None when min_conf/codeset rejects
    confs: list[float] = []

    t0 = time.perf_counter()
    with torch.no_grad():
        for i in range(0, len(prepped), BATCH_SIZE):
            batch = np.stack(prepped[i : i + BATCH_SIZE])
            if color:
                tensor = torch.from_numpy(batch).float().permute(0, 3, 1, 2) / 255.0
            else:
                tensor = torch.from_numpy(batch).float().unsqueeze(1) / 255.0
            logits = model(tensor)
            decoded = constrained_decode(logits, trie, char_to_idx, blank=0, blank_penalty=BLANK_PENALTY)
            for code, score in decoded:
                norm_conf = float(np.exp(score / max(1, len(code))))
                raw_preds.append(code)
                if code not in codes_set or norm_conf < MIN_CONF:
                    runtime_preds.append(None)
                else:
                    runtime_preds.append(code)
                confs.append(norm_conf)
    elapsed = time.perf_counter() - t0
    ms_per_cell = elapsed * 1000.0 / max(1, len(labels))

    n = len(labels)
    # View 1: raw constrained-decode top-1 on every cell (no conf rejection).
    correct_all = sum(
        1 for p, l in zip(raw_preds, labels) if p == l
    )
    # View 2: runtime view with min_conf rejection.
    rejected = sum(1 for p in runtime_preds if p is None)
    accepted = n - rejected
    accepted_correct = sum(
        1 for p, l in zip(runtime_preds, labels) if p is not None and p == l
    )
    accepted_confs = [c for p, c in zip(runtime_preds, confs) if p is not None]

    per_code: dict[str, dict] = {}
    for l in sorted(set(labels)):
        idxs = [i for i, lab in enumerate(labels) if lab == l]
        corr = sum(1 for i in idxs if raw_preds[i] == l)
        per_code[l] = {"n": len(idxs), "correct": corr,
                       "accuracy": corr / len(idxs)}

    return {
        "n_cells": n,
        "exact_match_rate": correct_all / max(1, n),   # raw constrained top-1
        "correct": correct_all,
        "accepted": accepted,
        "accepted_accuracy": (accepted_correct / max(1, accepted)) if accepted else None,
        "unknown_rate": rejected / max(1, n),          # runtime min_conf rejection
        "mean_conf": float(np.mean(confs)) if confs else None,
        "median_conf": float(np.median(confs)) if confs else None,
        "p10_conf": float(np.percentile(confs, 10)) if confs else None,
        "p90_conf": float(np.percentile(confs, 90)) if confs else None,
        "ms_per_cell": ms_per_cell,
        "per_code": per_code,
    }


def print_summary(tag: str, ckpt_name: str, r: dict) -> None:
    acc = r["exact_match_rate"]
    print(
        f"[{tag}] {ckpt_name}: n={r['n_cells']} "
        f"exact_match(raw)={acc:.4f} ({r['correct']}/{r['n_cells']}) "
        f"accepted@min_conf={r['accepted']} acc@accepted={r['accepted_accuracy'] if r['accepted_accuracy'] is not None else float('nan'):.4f} "
        f"UNKNOWN(runtime)={r['unknown_rate']:.4f} "
        f"conf(mean/p10/p90)={r['mean_conf'] if r['mean_conf'] is not None else float('nan'):.4f}/"
        f"{r['p10_conf'] if r['p10_conf'] is not None else float('nan'):.4f}/"
        f"{r['p90_conf'] if r['p90_conf'] is not None else float('nan'):.4f} "
        f"ms/cell={r['ms_per_cell']:.3f}"
    )


def main() -> None:
    global MIN_CONF
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--checkpoint", type=str, required=True,
                    help="path to a .pt checkpoint, or a directory with --sweep")
    ap.add_argument("--sweep", action="store_true",
                    help="treat --checkpoint as a dir; eval every *.pt")
    ap.add_argument("--legacy", action="store_true",
                    help="migrate legacy 3-key checkpoints in memory (010 R2 验收对比用；"
                         "正式加载应拒绝旧格式)")
    ap.add_argument("--min-conf", type=float, default=MIN_CONF)
    ap.add_argument("--codes-source", type=str, default="eval",
                    choices=["eval", "colorlib"],
                    help="trie vocab: 'eval' (distinct eval labels; default) "
                         "or 'colorlib' (CODES constant)")
    ap.add_argument("--json", type=str, default=None,
                    help="optional path to write full metrics JSON")
    args = ap.parse_args()

    MIN_CONF = args.min_conf

    zip_imgs, zip_labels = load_zip_cells(ZIP_PATH)
    dir_imgs, dir_labels = load_dir_cells(CELLS_DIR)
    print(f"[data] zip cells: {len(zip_labels)}; dir cells: {len(dir_labels)}")

    # Per-set code vocabulary: each eval set constrains decode with its OWN
    # distinct labels (merging the out-of-distribution dir codes into the zip
    # trie would pollute the zip's constrained decode).
    def eval_codes(labels: list[str]) -> list[str]:
        if args.codes_source == "colorlib":
            return CODES
        return sorted(set(labels))

    zip_codes = eval_codes(zip_labels)
    dir_codes = eval_codes(dir_labels)

    if args.sweep:
        ckpt_paths = sorted(Path(args.checkpoint).glob("*.pt"))
    else:
        ckpt_paths = [Path(args.checkpoint)]

    results: dict[str, dict] = {}
    for ck in ckpt_paths:
        try:
            model, chars = load_checkpoint(ck, device="cpu")
        except CheckpointFormatError:
            if not args.legacy:
                raise
            model, chars = _load_legacy(ck)
        print(f"[model] {ck.name}: num_classes={len(chars)} chars={chars}")
        r_zip = evaluate(model, chars, zip_imgs, zip_labels, zip_codes)
        r_dir = evaluate(model, chars, dir_imgs, dir_labels, dir_codes)
        print_summary("zip", ck.name, r_zip)
        print_summary("dir", ck.name, r_dir)
        results[ck.name] = {
            "checkpoint": str(ck),
            "num_classes": len(chars),
            "chars": chars,
            "valid_codes": {"zip": zip_codes, "dir": dir_codes},
            "zip": r_zip,
            "dir": r_dir,
            "reproduce": (
                f"python training/scripts/eval_cell_baseline.py --checkpoint {ck}"
            ),
        }
        print("---")

    if args.json:
        Path(args.json).write_text(
            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    if args.sweep:
        # Rank by zip exact-match rate to surface the best checkpoint.
        ranked = sorted(
            results.items(), key=lambda kv: -kv[1]["zip"]["exact_match_rate"]
        )
        print("RANKING by zip exact_match_rate:")
        for name, r in ranked:
            print(f"  {name}: {r['zip']['exact_match_rate']:.4f}")


if __name__ == "__main__":
    main()
