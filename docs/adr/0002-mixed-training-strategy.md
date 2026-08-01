# 0002 — Train CRNN on real + synthetic because labeled real data covers only 23 codes

**Status**: accepted  ·  **Date**: 2026-07-29  ·  **Updated**: 2026-08-01 (017: library grew 65 → 1950 official codes)

## Context

After analysis of `training/samples/1_标注结果_2026-07-29/manifest.csv`:

- 8644 labeled real cells cover only **23 unique codes** (out of 65 in the then-current Perler snapshot)
- 7 letter prefixes present (A, B, C, E, F, H, M); old library only had H, F, G

Since 017 the color library is the official multi-brand [maxcleme/beadcolors](https://github.com/maxcleme/beadcolors) data (**1950 codes, 15 brands**, incl. Hama/Perler/Artkal/Nabbi/Yant/Mard/Diamond Dotz). The gap between labeled real codes (23) and the library is now much larger — synthetic vocabulary coverage matters even more.

Without synthetic data:
- The CRNN cannot recognize codes like `H20`, `H30`, `F5` simply because they are not seen in the training labels.
- Test boards may use any subset of the library codes → unfixable vocabulary gap with real data alone.

## Decision

Use **two-stage training** (unchanged):

### Stage A — Synthetic pretraining
- Generate ~50k samples covering **all library codes** (now 1950 incl. brand-prefixed conflicts like `MARD-A10`) plus extensions for A/B/C/E/M
- Apply the same "marked-style" preprocessing that `label_tool.html` produces
  (background-normalized, polarity-handled, grayscale saved as RGB)
- Train CRNN from scratch for 30 epochs at lr=1e-3
- Output class set derived from the full library (charset is the single source of truth in `ocr_core/charset.py`)

### Stage B — Real-data fine-tuning
- Take the Stage A checkpoint
- Fine-tune on 8644 labeled cells for 10-15 epochs at lr=1e-4
- Use **class-weighted sampling** (`WeightedRandomSampler`) to handle class imbalance
  (top-3 codes = 66% of data; bottom-7 codes < 20 samples each)
- Validate with stratified split per code so the validation set reflects code distribution

### (Future) Stage C — Mixed training (if needed)
- Sample real and synthetic with proportional weights in each batch
- Only enter if Stage B cannot reach > 60% val exact-match

## Consequences

**Positive**:
- Full library vocabulary (now 1950 codes) is reachable; 017 brand prefixes (`MARD-A10`) are decodable only if the charset covers `-` — otherwise they remain UNMAPPED at the Spring layer
- Real data still drives appearance adaptation; synthetic drives vocabulary

**Negative**:
- Must write a "marked-style" synth preprocessor (the synth generator and label_tool output must agree)
- Validation cannot use random split: stratified per-code split is mandatory
- Two-stage training takes longer per iteration; need a clear stopping criterion per stage
- 017 library trie includes `-`-containing codes (e.g. `MARD-A10`); `constrained_decode` skips chars outside the charset, so those branches are unreachable at decode time (harmless but present)

## Open questions

1. Does the inference pipeline (`ocr_cells_from_crop_crnn`) apply the **same** "marked-style" preprocessing that the label_tool applies? If not, there is still a train/inference gap.
2. Should rare codes (`A4` with 2 samples) be augmented, removed, or accept blindly-failed?
3. Should synthetic at Stage A cover only the library codes, or extend into the letter-prefix space seen in real data?
