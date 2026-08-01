# 0004 — Real-only CRNN beats mixed real+synth on in-distribution val

**Status**: accepted  ·  **Date**: 2026-07-29

## Context

Trained 3 variants of the CRNN on the 8644-cell labeled set:

| Run | Source | Best val_em | val_valid | Synth generalizes? |
|-----|--------|-------------|-----------|---------------------|
| 1 | Real only | **0.990** (epoch 14) | 0.999 | ❌ 0% on 200 synth samples (model collapses) |
| 2 | Real + 30k synth marked, weight=1.0 | 0.936 | 0.987 | (lower priority, not tested) |
| 3 | Real + 30k synth marked, weight=0.2 | 0.981 | 0.999 | ✅ 32.5% on 200 synth samples |
| 4 | Synth only | 0.985 on real val | 0.227 | n/a |

## Decision

**Use the real-only model (`crnn_real_v1.pt`) for the 23 labeled codes.**

- Highest in-distribution accuracy (99.0%)
- Per-code accuracy: 21/23 codes at 100%, worst is H14 at 75% (8 samples, 6 confused with H12)
- Errors concentrated in H12 ↔ H18 ↔ H14 (digit 2/4/8 confusion) and H3 ↔ C (letter confusion)

**Caveat**: The real-only model is overfit to the 3 source boards in `../../training/samples/stand/`. It will likely degrade on new boards that use:
- Different fonts
- Different colors
- Codes outside the 23 seen

## Consequences

**Positive**:
- 99% accuracy on the labeled validation set is good enough for production
- Simple, single-source training (no synthetic data needed)
- 30 epoch training takes ~90s on GPU

**Negative**:
- Model knows only 23 of 65 codes from the Perler color library
- The 42 unseen codes (e.g. F1, F2-F8, G1-G5, H30-H52) will be misclassified as one of the 23 known codes
- Adding a new bead color to the library requires collecting ~50 labeled samples and retraining

## When to use synth

The synth generator remains valuable for:
- Covering codes not in the labeled set (F1-F8, G1-G5, H30-H52)
- Generalizing across fonts / color shades (when source diversity becomes a problem)
- Pretraining when starting from a new domain

The "synth hurts in-distribution accuracy" result is expected: synth teaches the model broader features at the cost of fit to the specific labeled style. This is a real trade-off, not a bug.

## Open questions

1. Does the real-only model work on board 2.jpg and 3.jpg (the other boards in `../../training/samples/stand/`)? The labeled data came from these 3 boards but the split is per-cell, not per-board. If yes, 99% is the real number. If no, the model has overfit even more than we thought.

2. Should we collect more labeled data covering the 42 missing codes? Each new code needs ~20-30 samples for the model to learn it well.

3. What is the inference-time preprocessing? If the production pipeline produces images that look like "marked" style, the model is fine. If not, accuracy will drop on the real beads.