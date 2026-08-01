# 0001 — CRNN output classes derived from labeled set, not the color library

**Status**: accepted  ·  **Date**: 2026-07-29

## Context

The CRNN model (`training/models/bead_ocr_crnn.py`) has historically used `num_classes = 37` covering the full alphabet (`A–Z`) plus digits (`0–9`) plus CTC blank. This was set so that "any new code can be added to the dictionary without retraining".

But the labeled training data (`training/samples/1_标注结果_2026-07-29/manifest.csv`) covers only **7 letters**: A, B, C, E, F, H, M — and 23 specific codes total. Training a 37-class head on data that contains 7 letters **wastes capacity** and creates a misleading prior (the model believes A/E/I/J etc. may appear as legitimate code prefixes, when they never do in real data).

## Decision

Define `CHARS`/`num_classes` from the **actual labeled set** at dataset-load time, not hardcoded:

- Base set: `{<blank>} + {A, B, C, E, F, H, M} + {0–9}` = **18 classes** for the current 8644-cell set
- When the color library requires a code outside this letter set (e.g. a new `Z12` bead), add the letter and retrain (or fine-tune)
- The vocabulary is **closed** in the sense that adding a code never requires labeling ALL letter variants — just the new prefix letter and its first few codes

## Consequences

**Positive**: smaller head (18 vs 37), simpler learning, less spillover between similar-looking letters.

**Negative**:
- The model will never emit `D`, `G`, `I` etc. If we suddenly want `G5`, we'd need to retrain.
- The "just-add-to-dictionary" idea dies; we must retrain when adding letters.

**Trade-off accepted**: in this domain, the letter set is essentially a controlled inventory (Perler bead manufacturers release codes with stable prefixes). Retraining on a few hundred cells when a new letter enters is cheap; the cost of having a noisy 37-class head on a 7-letter dataset is forever-pessim.

## Implementation

- `training/scripts/train_crnn.py` should derive CHARS from `set(manifest['encoding'])` and pass to CRNN
- The model's `synth_generator.CHARS` constant becomes a default that the dataset loader can override
- Removed: hardcoded `len(CHARS)` checks that assume the 37-class default
