"""Train CRNN on synthetic cell data + fine-tune on real stand crops.

Usage:
    cd training && python -m training.scripts.train_crnn \\
        --synth-n 50000 --epochs 30 --out checkpoints/crnn_v1.pt

The training loop expects:
- torch installed (`pip install torch torchvision`)
- Synth samples are regenerated each run (no caching) to keep the script
  self-contained; if you need to scale up, point --synth-cache-dir at a
  directory to persist generated samples as PNGs.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Dataset

# Make the `training` package importable when this file is run as
# `python -m training.scripts.train_crnn` from the repo root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from training.models.bead_ocr_crnn import CRNN, ctc_greedy_decode, save_checkpoint  # noqa: E402
from training.models.synth_generator import (  # noqa: E402
    CHARS,
    CODES,
    Sample,
    generate_dataset,
)


# ── Dataset ──────────────────────────────────────────────────────────


def _to_gray(img: np.ndarray) -> np.ndarray:
    """Convert (H, W, 3) RGB uint8 → (H, W) grayscale uint8 (pass-through if already 2d)."""
    if img.ndim == 2:
        return img
    return (0.299 * img[:, :, 0] + 0.587 * img[:, :, 1] + 0.114 * img[:, :, 2]).astype(np.uint8)


class CellDataset(Dataset):
    """Wraps a list of Samples into a torch Dataset.

    Each item is (image_tensor, target_indices, target_length).
    """

    def __init__(self, samples: list[Sample]):
        self.samples = samples

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, idx: int):
        s = self.samples[idx]
        # Convert RGB → grayscale, then to (1, H, W) float32 in [0, 1].
        gray = _to_gray(s.image)
        img = torch.from_numpy(gray).float().unsqueeze(0) / 255.0
        target = torch.tensor(s.token_indices, dtype=torch.long)
        return img, target, len(s.token_indices)


def collate(batch):
    imgs, targets, lengths = zip(*batch)
    imgs = torch.stack(imgs)
    # Pad targets with -1 (CTCLoss ignore_index).
    max_len = max(lengths)
    padded = torch.full((len(targets), max_len), -1, dtype=torch.long)
    for i, t in enumerate(targets):
        padded[i, : t.size(0)] = t
    return imgs, padded, torch.tensor(lengths, dtype=torch.long)


# ── Training loop ───────────────────────────────────────────────────


def evaluate(model: CRNN, samples: list[Sample], device: str, codes: set[str]) -> tuple[float, float]:
    """Return (exact_match_rate, valid_code_rate) over the given samples."""
    model.eval()
    idx_to_char = {i: ch for i, ch in enumerate(CHARS)}
    correct = 0
    valid = 0
    with torch.no_grad():
        bs = 64
        for i in range(0, len(samples), bs):
            chunk = samples[i : i + bs]
            imgs = torch.from_numpy(np.stack([_to_gray(s.image) for s in chunk])).float().unsqueeze(1) / 255.0
            imgs = imgs.to(device)
            logits = model(imgs)  # (T, B, C)
            preds = ctc_greedy_decode(logits, idx_to_char)
            for j, pred in enumerate(preds):
                if pred in codes:
                    valid += 1
                if pred == chunk[j].code:
                    correct += 1
    n = max(1, len(samples))
    return correct / n, valid / n


def train(args):
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[train] device={device}")

    print(f"[train] generating {args.synth_n} synthetic samples...")
    samples = generate_dataset(args.synth_n, seed=args.seed)
    rng = random.Random(args.seed)
    rng.shuffle(samples)
    split = int(len(samples) * 0.9)
    train_samples = samples[:split]
    val_samples = samples[split:]
    print(f"[train] train={len(train_samples)} val={len(val_samples)}")

    train_loader = DataLoader(
        CellDataset(train_samples),
        batch_size=args.batch_size,
        shuffle=True,
        collate_fn=collate,
        num_workers=0,
    )

    model = CRNN(num_classes=len(CHARS)).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    ctc_loss = nn.CTCLoss(blank=0, zero_infinity=True)

    codes_set = set(CODES)
    best_val = 0.0
    for epoch in range(args.epochs):
        model.train()
        t0 = time.time()
        total = 0.0
        n = 0
        for imgs, targets, target_lengths in train_loader:
            imgs = imgs.to(device)
            targets = targets.to(device)
            target_lengths = target_lengths.to(device)
            logits = model(imgs)
            log_probs = nn.functional.log_softmax(logits, dim=2)
            T, B, C = log_probs.shape
            input_lengths = torch.full((B,), T, dtype=torch.long, device=device)
            # CTCLoss expects concatenated 1-D targets; we filter -1 first.
            mask = targets >= 0
            flat_targets = targets[mask]
            loss = ctc_loss(log_probs, flat_targets, input_lengths, target_lengths)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            total += float(loss.item()) * B
            n += B
        scheduler.step()
        em, vr = evaluate(model, val_samples, device, codes_set)
        dt = time.time() - t0
        print(f"[train] epoch {epoch+1:3d}/{args.epochs} loss={total/n:.4f} "
              f"val_em={em:.3f} val_valid={vr:.3f} ({dt:.1f}s)")
        if em > best_val:
            best_val = em
            out_path = Path(args.out)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            save_checkpoint(out_path, model, len(CHARS), CHARS)
            print(f"[train] saved checkpoint → {out_path} (val_em={em:.3f})")

    print(f"[train] done. best_val_em={best_val:.3f}")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--synth-n", type=int, default=20000,
                   help="Number of synthetic samples to generate for training.")
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", type=str, default="checkpoints/crnn_v1.pt")
    return p.parse_args()


if __name__ == "__main__":
    train(parse_args())