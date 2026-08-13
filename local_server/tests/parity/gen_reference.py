#!/usr/bin/env python3
"""Generate parity reference fixtures for `tests/parity.rs` (Rust OCR core).

The fixtures are produced by the **production Python path** (`ocr_core`
functions + onnxruntime) so the Rust port can be diffed against a trusted
reference: per-cell letterboxed input, ONNX logits, and the final
constrained-decode (code, confidence).

Usage (repo root, bead-train env)::

    python local_server/tests/parity/gen_reference.py \
        --out .scratch/parity-fixtures \
        --model artifacts/models/crnn_color_mard_v8-2026-08-09T04-30-00Z/model.onnx \
        --sets training/samples/标注数据/1_标注结果_2026-07-29 \
               training/samples/标注数据/5_标注结果_2026-08-08 \
        --max-cells 128

Writes `cells/NNN.png` + `reference.json`; consumed by `cargo test` in
`local_server/` (BEAD_PARITY_FIXTURES env or the default path below).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
import torch  # noqa: E402

from ocr_core.bead_ocr_crnn import (  # noqa: E402
    build_code_trie,
    constrained_decode,
)
from ocr_core.code_library import load_library  # noqa: E402
from ocr_core.inference import _greedy_conf  # noqa: E402
from training.scripts.eval_cell_baseline import _prep_cell  # noqa: E402

DEFAULT_OUT = REPO_ROOT / ".scratch" / "parity-fixtures"


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", type=Path, default=DEFAULT_OUT)
    p.add_argument("--model", type=Path,
                   default=REPO_ROOT / "artifacts/models/crnn_color_mard_v8-2026-08-09T04-30-00Z/model.onnx")
    p.add_argument("--sets", type=Path, nargs="+",
                   default=[REPO_ROOT / "training/samples/标注数据/1_标注结果_2026-07-29",
                            REPO_ROOT / "training/samples/标注数据/5_标注结果_2026-08-08"])
    p.add_argument("--max-cells", type=int, default=128)
    args = p.parse_args()

    from training.scripts.eval_acceptance import load_dir

    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    art_dir = args.model.parent
    chars = json.loads((art_dir / "charset.json").read_text(encoding="utf-8"))["chars"]
    char_to_idx = {ch: i for i, ch in enumerate(chars)}

    # Closed vocabulary — same construction as ocr_core.inference.ocr_cells_from_crop.
    mard_codes = {e["code"] for e in load_library() if e.get("brand") == "mard"}
    codes_set = {c for c in mard_codes
                 if c[:1].isalpha() and c[1:].isdigit() and c[1:] != ""}
    codes_set.add("BLANK")
    trie = build_code_trie(sorted(codes_set))

    imgs, labels = [], []
    for s in args.sets:
        im, lb = load_dir(s)
        imgs += im
        labels += lb
    if len(imgs) < args.max_cells:
        print(f"[warn] only {len(imgs)} cells available, using all")
    n = min(args.max_cells, len(imgs))

    out_dir = args.out
    cells_dir = out_dir / "cells"
    cells_dir.mkdir(parents=True, exist_ok=True)

    # Preprocess ALL cells, then run a single batch-N inference — the same
    # execution shape as production (batch 128), so the Rust parity test
    # compares against identical onnxruntime numerics (batch-1 kernels take
    # a different numerical path; do not mix).
    preps: list[np.ndarray] = []
    metas: list[dict] = []
    for i in range(n):
        img_bgr, label = imgs[i], labels[i]
        prep = _prep_cell(img_bgr, color=True)  # (48, 48, 3) uint8
        preps.append(prep)
        cv2.imwrite(str(cells_dir / f"{i:03d}.png"), img_bgr)
        metas.append({"label": label})
    batch = np.stack(preps)  # (N, 48, 48, 3) uint8
    tensor = torch.from_numpy(batch).float().permute(0, 3, 1, 2) / 255.0
    logits_all = session.run(["logits"], {"images": tensor.numpy()})[0]  # (11, N, 35)
    log_probs_all = torch.log_softmax(torch.from_numpy(logits_all), dim=2)
    decoded_all = constrained_decode(log_probs_all, trie, char_to_idx, blank=0)
    greedy_codes_all, greedy_confs_all = _greedy_conf(log_probs_all, chars)

    reference: dict = {}
    for i in range(n):
        (code, score) = decoded_all[i]
        greedy_code = greedy_codes_all[i]
        if code not in codes_set and greedy_code in codes_set:
            code = greedy_code
        conf = greedy_confs_all[i] if greedy_code == code else float(np.exp(score / max(1, logits_all.shape[0])))
        reference[f"{i:03d}"] = {
            "label": metas[i]["label"],
            "code": code,
            "conf": round(float(conf), 6),
            "prep": [round(float(v), 4) for v in preps[i].reshape(-1)],
            "logits": [round(float(v), 6) for v in logits_all[:, i, :].reshape(-1)],
        }
    (out_dir / "reference.json").write_text(json.dumps(reference, indent=1), encoding="utf-8")
    print(f"[ok] {n} fixtures (batch-{n} inference) -> {out_dir}")


if __name__ == "__main__":
    main()
