# 0003 — Adjust synth_generator to produce "marked-style" output

**Status**: accepted  ·  **Date**: 2026-07-29  ·  **Revised**: 2026-07-29

## Context

Comparison of synthetic cell output (`training/models.synth_generator.generate_one`) against the 8644 labeled "marked" cells (`training/samples/1_标注结果_2026-07-29/`) reveals the synthetic data has features the real data does NOT have, and vice versa.

### What synth does that real doesn't

1. **Colored backgrounds** — synth outputs full RGB color (R-G diff up to 100+); real marked images are effectively grayscale (R=G=B everywhere)
2. **Neighbor-bleed solid stripes** (60% probability) — synth draws a 4-16 px solid colored bar on one edge; real marked cells have **no** stripes (the marking tool already trimmed them out via 10% inset or similar)
3. **Social-media watermarks** (30%) — synth overlays "小红书" / "成品图" / "图纸分享"; real marked cells have none
4. **Smooth text rendering** — synth keeps the anti-aliased gradient of PIL text; real marked images have sharper edges

### What real has that synth doesn't

1. **Wider positional jitter** — text position varies more between samples (different render algorithms of different tools used to make the source boards)
2. **Smaller, less text coverage** — text occupies 40-55% of cell width; synth text fills 60-70%
3. **Limited luminance palette** — real samples cluster in 3 buckets: dark<50 (37%), light>180 (39%), mid 100-180 (24%); synth spans 0-255 with everything in between

### What we previously thought real had but doesn't

- **Blue grid lines at top/bottom of marked cells** — verified absent (0/100 samples have blue tint at edges). The grid lines exist on the **full board** but the labeling tool's crop step already trimmed them. No need to add blue grid lines to synth.

### Earlier text-coverage analysis was wrong

First pass used a strict luminance threshold (`<30 OR >220`) to count "text pixels" and reported codes like `A4` having only 1% text. This was misleading — those cells do have text, but the text is in the mid-luminance range. Manual inspection confirms all labeled cells contain visible text.

## Decision

Add a `style="marked"` mode to `generate_one()` (default `"marked"` for new training; `"colored"` preserved for legacy). When `style="marked"`:

1. **Grayscale-only background** — pick from three luminance buckets (matching the observed distribution):
   - `dark` (~22, 37% probability) with white text
   - `light` (~215, 39% probability) with near-black text
   - `mid` (~145, 24% probability) with adaptive text color
2. **No neighbor-bleed stripes**
3. **No social-media watermarks**
4. **No blue grid lines** (real marked cells don't have them)
5. **Smaller text** — font size 24-38 px on 96 px canvas (down from 36-50)
6. **Wider positional jitter** — ±10 px in both axes (vs ±2)
7. **Sharper edges** — apply OTSU-style binarization on the rendered canvas before downsampling to 48×48
8. **No water-mark artifacts** — but keep mild gaussian noise (σ 0-2) to simulate the marking tool's natural smoothing

`train_crnn.py` will be updated to:
- Default to `style="marked"` when training alongside real data
- Document that `style="colored"` is only for backward-compat single-source training (rarely correct)

## Consequences

**Positive**:
- Synthetic and real distributions align → synthetic data contributes meaningfully
- Synth now covers the **full 65-code vocabulary** while looking like real marked cells
- Model gets both shape variety (synth) AND appearance (real) in the same input space

**Negative**:
- Synthetic no longer produces colorful "bead board" looking cells; loses visual variety
- `style="colored"` path remains for backward compatibility but is no longer the recommended default

## Verification

After change, re-run the diagnostic comparison:
- `REAL marked cells` and `SYNTH marked cells` should have R-G diff < 5 (true grayscale)
- Luminance distribution should cluster in the same 3 buckets
- ASCII rendering of `synth H7` should look nearly identical to `real H7`