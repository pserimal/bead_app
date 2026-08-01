# 0005 — Synthetic whole-board generation with per-cell metadata

**Status**: accepted  ·  **Date**: 2026-08-01

## Context

Training the cell-level CRNN currently depends on ~8.6k manually annotated
cells (`training/samples/1_标注结果_2026-07-29/`, 23 codes) plus
`synth_generator`'s per-cell synthetic renders. The bottleneck is manual
annotation. A cheaper path: real bead diagrams (拼豆图纸) are themselves
synthetic — generated from photographs by image→palette tools. If we run that
same generation pipeline ourselves and keep the mapping metadata
(brand, code, 1-based row/col), every cropped cell carries a free, exact
label. Downstream cell cropping (next step) then yields unlimited labeled
training data with zero annotation cost.

### Reference projects & licensing

- **liangdabiao/perler-beads-ai** (Apache-2.0) — the project we reference for
  the export format (codes + grid lines), pipeline structure
  (dominant color → merge → background removal) and the AI-prompt idea.
- **Zippland/perler-beads** (AGPL-3.0) — the original; its
  `colorSystemMapping.json` (291 standard colors → 5 Chinese brands:
  MARD/COCO/漫漫/盼盼/咪小窝) is **byte-identical** in both repos, so the
  data copyright belongs to Zippland. Both are credited.

**Decision: ai_dou is released under AGPL-3.0** (project-wide), so using
AGPL-derived data is compliant; all derivative files carry attribution.

## Decision

1. **Reference scope**: adopt the export format (colored cells + printed
   codes + grid lines), the pipeline structure and the palette data; skip
   the Jimeng AI API (external paid dependency) and the frontend UI.
2. **Palette**: merge the 291-color mapping into `artifacts/colors/library.json`
   (1950 → 3113 entries). New brands: `coco`/`manman`/`panpan`/`mixiaowo`.
   **MARD is skipped** — our library already has the identical 291 MARD
   palette (hex values match 100 %; only code format differs: ours `A1` vs
   theirs `A01` — if ever imported, normalize to our no-leading-zero format).
3. **Grid sizing** (verbatim reference rule): caller picks columns N
   (default random 30–300), rows M = round(N × H/W) so each cell is a square
   region of the source image.
4. **Pipeline**:
   - dominant color per cell = mode of quantized RGB buckets (16 levels/ch —
     fixes the reference's exact-RGB mode, which degenerates to a random
     pixel on photographic noise);
   - palette mapping by RGB Euclidean distance (same metric as reference);
   - **global frequency merge** (verbatim reference strategy, NOT the BFS
     connected-region described in its README): colors sorted by frequency;
     for every (high-freq, low-freq) pair with RGB distance < threshold
     (default 30), all low-freq cells are replaced by the high-freq color.
     Metadata is generated AFTER merging so labels match rendered colors.
   - background removal / color-remap: skipped (production crops the grid
     region, so external cells never reach inference).
5. **Rendering**: cell_size px per cell (default 48 = production crop size);
   code text adaptive font size + contrast color (reused from
   `synth_generator`); light per-cell border (#DDDDDD) + darker separation
   lines every grid_interval (random 5–20) cells, line color random from the
   brand palette; ~30 % of boards get a random semi-transparent CJK
   watermark spanning many cells (real shared diagrams carry them).
6. **Printed code = brand-native code**: the color library stores
   brand-conflict prefixes (`COCO-H07`, `MARD-A10`) for uniqueness, but
   diagrams print the native code (`H07`); `-` is outside the OCR charset.
   `load_brand_palette` strips the prefix into `render_code`.
7. **Metadata**: `board.json` next to `board.png` — header (source image,
   board geometry, merge params, generator + attribution) + `cells[]` with
   1-based `row`/`col`, `code`, `color_hex`. Attribution string embedded:
   `liangdabiao/perler-beads-ai (Apache-2.0); algorithm & palette data:
   Zippland/perler-beads (AGPL-3.0)`.
8. **Layout**: core `training/models/board_generator.py` +
   CLI `training/scripts/generate_board.py`; output under
   `training/data/boards/<id>/` (gitignored).

## Consequences

- Cell-crop training data can be generated at scale from any CC0 image set
  with exact labels (brand, code, coords) — the annotation step disappears.
- The generated boards also serve as a **figure-level** evaluation source
  once the crop step exists (board → cells → compare against metadata).
- Reference projects must keep being credited in every derivative file and
  this ADR; the AGPL-3.0 license file covers the merged palette data.
- Rendering quality (fonts, watermark, merge aggressiveness) may need tuning
  after visual inspection — grid_interval, merge_threshold, watermark_prob
  are all CLI-exposed.

## Files

- `training/models/board_generator.py` — core generator (`generate_board`,
  `save_board`)
- `training/scripts/generate_board.py` — CLI
- `training/scripts/import_zippland_palette.py` — palette merge (dry-run +
  validation)
- `artifacts/colors/library.json` — 3113 entries (1950 + 1163)
