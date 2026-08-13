#!/usr/bin/env python3
"""Acceptance gate for CRNN checkpoints — fixed benchmark, old-vs-new.

This is the project's model acceptance mechanism (see docs/acceptance.md).

Design principles
-----------------
1. The benchmark sets are FIXED and versioned in this file. They are
   shared by every session so results are comparable over time.
2. Evaluation uses the PRODUCTION inference path (letterbox 48x48, RGB
   channel order, constrained decode over the full library + BLANK, and
   the free-path confidence formula) — the numbers reported here are what
   a deployed image_service would produce.
3. A candidate checkpoint must be >= the current production model on every
   key metric within a small tolerance, otherwise the gate FAILS and the
   candidate must NOT be deployed. "Better on unseen colors" is a goal,
   but it never justifies regressing real-labeled blanks or codes.

Usage (repo root)::

    python -m training.scripts.eval_acceptance \
        --candidate <ckpt.pt> --production <ckpt.pt> \
        [--json training/docs/acceptance-<name>.json] [--skip-holdout]

Exit code 0 = PASS, 1 = FAIL, 2 = error.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import os
os.chdir(_REPO_ROOT)

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

from ocr_core.bead_ocr_crnn import (  # noqa: E402
    build_code_trie,
    constrained_decode,
    load_checkpoint,
)
from ocr_core.code_library import load_codes  # noqa: E402
from training.scripts.eval_cell_baseline import _prep_cell  # noqa: E402


def load_eval_backend(model_path: Path) -> tuple[callable, list[str], bool]:
    """Load a ``.pt`` checkpoint or an ONNX export for evaluation.

    Returns ``(forward, chars, color)`` where ``forward(tensor) -> logits``
    (T, B, C) and ``color`` mirrors ``model.input_channels == 3``.  The ONNX
    path reads ``manifest.json``/``charset.json`` next to ``model.onnx``
    (written by ``export_onnx.py``), so the exact same fixed benchmark can
    run against either runtime — this is how conversion parity is gated.
    """
    if model_path.is_dir():
        model_path = model_path / "model.onnx"
    if model_path.suffix == ".onnx":
        import onnxruntime as ort

        manifest = {}
        mf = model_path.parent / "manifest.json"
        if mf.exists():
            manifest = json.loads(mf.read_text(encoding="utf-8"))
        session = ort.InferenceSession(str(model_path),
                                       providers=["CPUExecutionProvider"])
        in_name = manifest.get("input_name", "images")
        out_name = manifest.get("output_name", "logits")
        color = bool(manifest.get("input_channels", 1) == 3)
        chars = json.loads(
            (model_path.parent / "charset.json").read_text(encoding="utf-8")
        )["chars"]

        def forward(tensor: torch.Tensor) -> torch.Tensor:
            out = session.run([out_name], {in_name: tensor.numpy()})[0]
            return torch.from_numpy(out)

        return forward, chars, color
    model, chars = load_checkpoint(model_path, device="cpu")
    return model, chars, getattr(model, "input_channels", 1) == 3

# ── Fixed benchmark sets (version 1) ──────────────────────────────────
# Real-labeled sets are the production-truth proxy (they are also used in
# training, but they are the only ground truth we have for real boards; the
# synthetic heldout below tests genuinely unseen generalization).
REAL_SETS: dict[str, Path] = {
    "code_main": _REPO_ROOT / "training" / "samples" / "标注数据" / "1_标注结果_2026-07-29",
    "blank_clean": _REPO_ROOT / "training" / "samples" / "标注数据" / "5_标注结果_2026-08-08",
    "blank_polluted": _REPO_ROOT / "training" / "samples" / "标注数据" / "corrections-fdaa77a1-2026-08-09",
    "blank_polluted_ref": _REPO_ROOT / "training" / "samples" / "标注数据" / "4_标注结果_2026-08-08",
}
# Synthetic heldout: generated with an independent seed, never used in
# training for v6/v7/v8. Re-generate with a fixed seed if the dir is missing.
# Points at the cells/ subdir whose manifest.csv has been copied in by the
# generation step (load_manifest_dir expects manifest next to the PNGs).
HOLDOUT_DIR = _REPO_ROOT / "training" / "data" / "mard_board_heldout_v2" / "cells"

# Per-metric tolerance: candidate may be at most this much worse than
# production before the gate fails (absolute fraction).
TOLERANCE = 0.005


def label_of(name: str) -> str | None:
    """Code from a filename across all annotation naming conventions."""
    stem = name.rsplit(".", 1)[0]
    if stem.lower().startswith(("blank_", "empty_")) or name.startswith("BLANK_"):
        return "BLANK"
    parts = stem.split("_")
    if len(parts) >= 5 and parts[1].startswith("r") and parts[2].startswith("c"):
        return parts[0].upper()  # corrections: CODE_r.._c.._h.._v..
    if len(parts) >= 3 and parts[0].startswith("r") and parts[1].startswith("c"):
        return parts[2].upper()
    cand = parts[0].upper() if parts and parts[0][0].isalpha() else None
    return cand


def load_dir(cells_dir: Path) -> tuple[list[np.ndarray], list[str]]:
    """(imgs_bgr, labels) for every PNG in a directory."""
    imgs: list[np.ndarray] = []
    labels: list[str] = []
    for f in sorted(cells_dir.glob("*.png")):
        lab = label_of(f.name)
        if not lab:
            continue
        data = np.fromfile(str(f), dtype=np.uint8)
        img = cv2.imdecode(data, cv2.IMREAD_COLOR)
        if img is None:
            continue
        imgs.append(img)
        labels.append(lab)
    return imgs, labels


def load_heldout(cells_dir: Path) -> tuple[list[np.ndarray], list[str]]:
    """Cells from a diagram->crop heldout dir (manifest-based)."""
    from training.scripts.eval_board_model import load_manifest_dir
    imgs, labels, _ = load_manifest_dir(cells_dir)
    return imgs, labels


def eval_set(forward: callable, chars: list[str], color: bool, imgs, labels,
             full_trie: dict) -> tuple[float, float, float, float, float]:
    """(blank_acc, code_acc, overall, blank_conf_mean, code_conf_mean).

    Uses the same input prep as production and the same confidence formula
    (free-path CTC collapse). trie is the full library + BLANK, matching
    image_service's valid_codes=None path.  ``forward`` is either a loaded
    ``torch.nn.Module`` or an ONNX session wrapper — identical math on both.
    """
    c2i = {c: i for i, c in enumerate(chars)}
    blank_preds: list[float] = []
    code_preds: list[float] = []
    blank_ok = code_ok = n_blank = n_code = 0
    with torch.no_grad():
        for i in range(0, len(imgs), 128):
            batch_imgs = [_prep_cell(x, color=color) for x in imgs[i:i + 128]]
            batch = np.stack(batch_imgs)
            if color:
                tensor = torch.from_numpy(batch).float().permute(0, 3, 1, 2) / 255.0
            else:
                tensor = torch.from_numpy(batch).float().unsqueeze(1) / 255.0
            logits = forward(tensor)
            log_probs = torch.log_softmax(logits, dim=2)
            decoded = constrained_decode(logits, full_trie, c2i, blank=0)
            # Free-path confidence (same as ocr_core.inference._greedy_conf).
            preds = logits.argmax(dim=2).transpose(0, 1).cpu().numpy()
            for j, (code, _score) in enumerate(decoded):
                gt = labels[i + j]
                steps = []
                prev = -1
                for t in range(log_probs.shape[0]):
                    idx = int(preds[j, t])
                    if idx == 0:
                        prev = -1
                        continue
                    if idx != prev:
                        steps.append(float(log_probs[t, j, idx]))
                    prev = idx
                conf = float(np.exp(np.mean(steps))) if steps else 0.0
                if gt == "BLANK":
                    n_blank += 1
                    if code == "BLANK":
                        blank_ok += 1
                    blank_preds.append(conf)
                else:
                    n_code += 1
                    if code == gt:
                        code_ok += 1
                    code_preds.append(conf)
    blank_acc = blank_ok / max(1, n_blank)
    code_acc = code_ok / max(1, n_code)
    overall = (blank_ok + code_ok) / max(1, len(labels))
    bconf = float(np.mean(blank_preds)) if blank_preds else float("nan")
    cconf = float(np.mean(code_preds)) if code_preds else float("nan")
    return blank_acc, code_acc, overall, bconf, cconf


def build_full_trie(chars: list[str]) -> dict:
    codes = sorted(set(load_codes()) | {"BLANK"})
    return build_code_trie(codes)


def gate(candidate: Path, production: Path, out_json: Path | None,
         skip_holdout: bool = False) -> int:
    results: dict = {"version": 1, "candidate": str(candidate),
                     "production": str(production), "sets": {}}
    prod_forward, prod_chars, prod_color = load_eval_backend(production)
    cand_forward, cand_chars, cand_color = load_eval_backend(candidate)
    prod_runtime = "onnx" if production.suffix == ".onnx" else "pytorch"
    cand_runtime = "onnx" if candidate.suffix == ".onnx" else "pytorch"
    print(f"production: {production.name} ({prod_runtime}, {len(prod_chars)} chars)")
    print(f"candidate : {candidate.name} ({cand_runtime}, {len(cand_chars)} chars)")
    prod_trie = build_full_trie(prod_chars)
    cand_trie = build_full_trie(cand_chars)

    failures: list[str] = []
    for name, path in REAL_SETS.items():
        imgs, labels = load_dir(path)
        if not labels:
            print(f"  [warn] {name}: no labels loaded from {path}")
            continue
        p = eval_set(prod_forward, prod_chars, prod_color, imgs, labels, prod_trie)
        c = eval_set(cand_forward, cand_chars, cand_color, imgs, labels, cand_trie)
        results["sets"][name] = {
            "n": len(labels),
            "production": {"blank_acc": p[0], "code_acc": p[1], "overall": p[2],
                           "blank_conf": p[3], "code_conf": p[4]},
            "candidate": {"blank_acc": c[0], "code_acc": c[1], "overall": c[2],
                          "blank_conf": c[3], "code_conf": c[4]},
            "delta": {"blank_acc": c[0] - p[0], "code_acc": c[1] - p[1],
                      "overall": c[2] - p[2]},
        }
        print(f"\n[{name}] n={len(labels)}")
        print(f"  prod: blank={p[0]:.4f} code={p[1]:.4f} overall={p[2]:.4f} "
              f"bconf={p[3]:.3f} cconf={p[4]:.3f}")
        print(f"  cand: blank={c[0]:.4f} code={c[1]:.4f} overall={c[2]:.4f} "
              f"bconf={c[3]:.3f} cconf={c[4]:.3f}")
        for metric, delta in [("blank_acc", c[0] - p[0]),
                              ("code_acc", c[1] - p[1]),
                              ("overall", c[2] - p[2])]:
            if delta < -TOLERANCE:
                failures.append(f"{name}.{metric}: {delta:+.4f}")

    if not skip_holdout:
        if HOLDOUT_DIR.exists():
            imgs, labels = load_heldout(HOLDOUT_DIR)
            if labels:
                p = eval_set(prod_forward, prod_chars, prod_color, imgs, labels, prod_trie)
                c = eval_set(cand_forward, cand_chars, cand_color, imgs, labels, cand_trie)
                results["sets"]["synthetic_heldout"] = {
                    "n": len(labels),
                    "production": {"blank_acc": p[0], "code_acc": p[1], "overall": p[2],
                                   "blank_conf": p[3], "code_conf": p[4]},
                    "candidate": {"blank_acc": c[0], "code_acc": c[1], "overall": c[2],
                                  "blank_conf": c[3], "code_conf": c[4]},
                    "delta": {"blank_acc": c[0] - p[0], "code_acc": c[1] - p[1],
                              "overall": c[2] - p[2]},
                }
                print(f"\n[synthetic_heldout] n={len(labels)}")
                print(f"  prod: blank={p[0]:.4f} code={p[1]:.4f} overall={p[2]:.4f}")
                print(f"  cand: blank={c[0]:.4f} code={c[1]:.4f} overall={c[2]:.4f}")
                for metric, delta in [("blank_acc", c[0] - p[0]),
                                      ("code_acc", c[1] - p[1]),
                                      ("overall", c[2] - p[2])]:
                    if delta < -TOLERANCE:
                        failures.append(f"synthetic_heldout.{metric}: {delta:+.4f}")
            else:
                print("  [warn] heldout has no labels; skipping")
        else:
            print(f"  [warn] heldout missing: {HOLDOUT_DIR}; "
                  f"regenerate with build_mard_board_dataset seed 13579")

    passed = len(failures) == 0
    results["gate"] = "PASS" if passed else "FAIL"
    results["failures"] = failures
    print(f"\nGATE: {results['gate']}")
    if failures:
        print("failures:")
        for f in failures:
            print(f"  - {f}")

    if out_json:
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps(results, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        print(f"\nwrote {out_json}")
    return 0 if passed else 1


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--candidate", type=Path, required=True)
    p.add_argument("--production", type=Path, required=True)
    p.add_argument("--json", type=Path, default=None)
    p.add_argument("--skip-holdout", action="store_true")
    args = p.parse_args()
    sys.exit(gate(args.candidate, args.production, args.json,
                  skip_holdout=args.skip_holdout))


if __name__ == "__main__":
    main()
