# Project Context — ai_dou (拼豆助手)

> Domain glossary. Implementation details live elsewhere (AGENTS.md, training/docs/PLAN.md).
> This file only defines **terms** and **ubiquitous language** that the team uses.

## Core Terms

**bead code**: a 2-3 character alphanumeric identifier printed inside a Perler bead diagram cell (e.g. `H7`, `F1`, `C21`). Each code maps to a color in the Perler color library.

**cell**: one square region of a bead board diagram, containing zero or one bead code. Cropped from a board image after grid detection.

**board** *(aka "bead board diagram")*: the full digitally-generated image of a Perler bead pattern. Always synthetic (never a photograph). Pixel-aligned grid of cells.

**manifest.csv**: the metadata table shipped with a directory of labeled cell images. Columns: `编码` (code), `文件名` (filename), `行`/`列` (board coords, optional), `色相` (hue, optional), `亮度` (brightness, optional).

**marked image** *(aka "labeled cell image")*: a 48×48 PNG of a single cell that has been preprocessed (background normalized, polarity handled) so that the bead code text is the dominant readable feature. Filename pattern: `<CODE>_<SEQ>_marked[_h<v>].png`.

## Vocabulary Reality (vs initial assumptions)

The original Perler color library (`artifacts/colors/library.json`, snapshot of the retired `backend/app/data/default_colors.json`) has **65 codes with only 3 letter prefixes** (H, F, G).

But the **labeled training set** (8644 cells, 23 unique codes) covers **7 letter prefixes**: A, B, C, E, F, H, M. Treat A/B/C/E/M as first-class — do not assume any letter is "rare" or "only in library".

## CRNN Output Dimensions

`num_classes` MUST be derived from the **labeled set, not the library**.

- Closed-set of 7 letters (A, B, C, E, F, H, M) + 10 digits + CTC blank = **18 classes**
- For full library coverage, expand to all 26 letters + 10 digits + blank = **37 classes** (current default)

Choosing the wrong output size is silent: the model still trains, just never emits the wrong-class outputs.

## Training-Data Preprocessing Reality

Synthesized cells and "marked" labeled cells are **NOT the same input space**:

| Property | Synthetic (`synth_generator.generate_one`) | Marked real cell (labeling tool output) |
|----------|-------------------------------------------|------------------------------------------|
| Resolution | 96×96 rendered → 48×48 downsampled | Already 48×48 (or 48×49) |
| Polarity   | Adaptive per background brightness        | Often inverted: white text on black, OR dark text on white |
| Background| Solid color from color library             | Normalized: either pure-black or near-white background |
| Colors     | True RGB with library hex                  | Effectively grayscale (R=G=B everywhere) |
| Text content| A-Z arbitrary (2860 combinations)         | Only the actual codes seen on real boards |

Implication: training CRNN directly on synthetic-vs-real creates a domain gap that is much smaller than originally imagined, because the labeled data is itself a **preprocessed** input format. Mixing synth + real cells requires matching this preprocessing on the synth side.

## Class Imbalance

Distribution across the 8644-cell set is **highly imbalanced**:

- Top-3 codes (`H7` 41%, `H12` 16%, `C21` 9%) = 66% of all cells
- Bottom-7 codes have < 20 samples each
- Code `A4` has only 2 examples — borderline untrainable

A naive train/val split that ignores code distribution will leave validation dominated by `H7`/`H12` only. **Always use stratified splits per code.**

## Decisions Logged

See `docs/adr/` for hard-to-reverse decisions.
