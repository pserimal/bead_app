# Project Context — ai_dou (拼豆助手)

> Domain glossary. Implementation details live elsewhere (AGENTS.md, training/docs/PLAN.md).
> This file only defines **terms** and **ubiquitous language** that the team uses.

## Core Terms

**bead code**: a 2-3 character alphanumeric identifier printed inside a bead diagram cell (e.g. `H01`, `F2`, `C21`, `MARD-A10`). Each code maps to a color in the bead color library.

**cell**: one square region of a bead board diagram, containing zero or one bead code. Cropped from a board image after grid detection.

**board** *(aka "bead board diagram")*: the full digitally-generated image of a Perler bead pattern. Always synthetic (never a photograph). Pixel-aligned grid of cells.

**manifest.csv**: the metadata table shipped with a directory of labeled cell images. Columns: `编码` (code), `文件名` (filename), `行`/`列` (board coords, optional), `色相` (hue, optional), `亮度` (brightness, optional).

**board.json**: the metadata file shipped next to a generated board PNG (from `board_generator.py`). Header (source image, brand, rows/cols, cell_size, merge params, generator + attribution) + `cells[]` with 1-based `row`/`col`, `code`, `color_hex`. Unlike manifest.csv it is board-level, not cell-image-directory-level.

**render_code** *(aka native code)*: the bead code as printed inside a diagram cell — the brand code with any library-wide conflict prefix stripped (`H07`, not `COCO-H07`). The library keeps prefixed codes for uniqueness (DB PK); the diagram always prints the render_code (`-` is outside the OCR charset).

**marked image** *(aka "labeled cell image")*: a 48×48 PNG of a single cell that has been preprocessed (background normalized, polarity handled) so that the bead code text is the dominant readable feature. Filename pattern: `<CODE>_<SEQ>_marked[_h<v>].png`.

## Vocabulary Reality (vs initial assumptions)

The bead color library (`artifacts/colors/library.json` + server `default_colors.json`, 017) now holds **1950 official codes across 15 brands** (Hama, Perler, Nabbi, Artkal A/C/M/R/S, Yant, Diamond Dotz, Mard), sourced from [maxcleme/beadcolors](https://github.com/maxcleme/beadcolors). Each entry carries a `brand` field; cross-brand code conflicts are disambiguated with brand prefixes (e.g. `MARD-A10`). The old 65-code custom snapshot (3 prefixes H/F/G) was replaced — do not assume codes are limited to H/F/G.

**ADR 0005 addition (training-side only)**: `artifacts/colors/library.json` was merged with the Zippland 291-color mapping → **3113 codes, 17 brands** (+COCO/漫漫/盼盼/咪小窝). The server `default_colors.json` was NOT synced (still 1950) — the merge exists for synthetic-board generation; see `docs/adr/0005-synthetic-board-generation.md`.

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
| Colors     | True RGB with library hex                  | Mixed: ~56 % color (deep bg + white text), ~44 % grayscale; varies by code (A/C/E/F/M codes fully colored, H codes mostly grayscale) |
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
