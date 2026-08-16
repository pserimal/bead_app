# Project Context — ai_dou (AI拼豆助手)

> Domain glossary. Implementation details live elsewhere (AGENTS.md, training/docs/PLAN.md).
> This file only defines **terms** and **ubiquitous language** that the team uses.

## Recognition Workflow

**job**:
A single recognition task: from one uploaded board photo (cropped grid region + rows/cols) to a finished blueprint. Lifecycle: Pending → Processing → Succeeded / SucceededWithWarnings / Failed; may retry (attempts). Progress is expressed through events.
_Avoid_: task, request, upload (upload is the HTTP action, not the workflow entity)

**blueprint**:
The read-only recognition result of a job: a rows×cols table of cells, each carrying a recognized code (or BLANK), status, color, and confidence. Created atomically when the job succeeds. Corrections are recorded on cells — recognition output itself is never edited.
_Avoid_: pattern, result (pattern is the user's intended artwork; result is too generic)

**event**:
A timestamped fact in a job's lifecycle, delivered in sequence order (base = attempt × 10000). Types: JobStarted, CellProcessed, CellFailed, Heartbeat, RetryScheduled, JobSucceeded, JobFailed. Events are intermediate data — they are deleted once the job reaches a terminal state.

**correction**:
A manual override of one cell's recognized code in a blueprint (low-confidence fix on the correction page). Setting a new code remaps the cell; `null` reverts to the original recognition; the BLANK code marks the cell as empty.
_Avoid_: edit, fix (edit implies changing the recognition itself; fix is too generic)

**blank cell**:
A cell that contains no bead — an empty hole in the board. Recognized as the special BLANK code; carries no color. Distinct from an *unmapped* cell (recognized, but code unknown to the runtime seed).

## Beads, Cells & Patterns

**bead code**:
A 2-3 character alphanumeric identifier printed inside a diagram cell (e.g. `H01`, `F2`, `C21`). In the library, codes that collide across brands carry a brand prefix (`MARD-A10`); the diagram always prints the unprefixed form. Each code maps to a color in the color library.
_Avoid_: assuming codes are limited to any prefix set (the library spans 16+ brands)

**render_code** *(aka native code)*:
The bead code as printed inside a diagram cell — the library code with any brand-prefix stripped (`H07`, not `COCO-H07`). The library keeps prefixed codes for uniqueness (DB PK); `-` is outside the OCR charset.

**cell**:
One square region of a board grid, containing zero or one bead code, corresponding to one bead position on a pegboard. After OCR, a cell carries one of three statuses: **Mapped** (code recognized and found in the runtime seed), **Unmapped** (recognized, not in the seed), **Blank** (no bead).

**board** *(aka 拼豆图纸, bead board diagram)*:
The bead pattern the user uploads — a grid of cells, each printing a bead code. May be a digitally-generated image or a photo of a printed pattern. Training-side *synthetic boards* are the digital form of this. **Not** a pegboard (实物拼豆板) — see *pegboard*.
_Avoid_: conflating board with pegboard (拼豆板): in craft jargon 拼豆板 is the plastic pegboard, in this project board is the pattern image.

**pattern** *(aka 图纸, fuse-bead pattern)*:
The pixel-grid pattern of a bead project — every cell corresponds to one bead position. In craft jargon a pattern is the printable per-bead grid (usually with color codes); in this app the blueprint canvas is a pattern. Training-side it is always synthetic (never a photograph); user uploads are photos of printed patterns or digital images.

## Craft Vocabulary (拼豆手工领域, user-side language)

**bead** *(豆)*:
A single plastic cylinder (5mm Midi or 2.6mm Mini) placed on a pegboard peg and fused by ironing. One bead occupies exactly one cell on a pattern — the cell is the bead's position.
_Avoid_: using "bead" for a pattern cell (that is a *cell*); the OCR recognizes cells, not beads.

**pegboard** *(拼豆板 / 底板)*:
The plastic board with regularly spaced pegs on which beads are placed before ironing; 29×29 squares can be joined into larger boards. In craft jargon this is "拼豆板" — do **not** use it to mean this project's *board* (the pattern image).

**color card** *(色卡)*:
A brand's official bead color table (brand + code + color value). The color library is a machine-readable snapshot of color cards.
_Avoid_: color card (the brand's published table) vs color library (our data) — different things.

**bead list** *(材料清单 / 用豆清单)*:
Per-code bead count for a pattern (e.g. H7 × 5,240 beads) — what a maker buys and prepares. A blueprint's cells carry exactly the data to derive one.

**fusing** *(熨烫 / 烫豆)*:
The step that fuses arranged beads into a finished piece: cover with baking paper, iron, cool, peel off the pegboard. The craft as a whole is fuse-bead art (拼豆); this project only handles the pattern, not the physical beads.

## Color Library

**color library** *(aka library.json, full snapshot)*:
The multi-brand bead color reference, committed at `artifacts/colors/library.json`. Entries: `brand`, `code`, `color_name`, `color_hex`, `sort_order`. Cross-brand code conflicts are disambiguated with brand prefixes.

**runtime seed** *(aka default colors)*:
The subset of the library the runtime loads into SQLite at startup (`data/default_colors.json`, mard-only, 291 codes). The OCR vocabulary at inference time is closed to this seed — a cell whose code is not in the seed is **Unmapped** even when the full library knows that code.
_Avoid_: confusing the seed with the library — library = full multi-brand reference; seed = what the running service actually recognizes.

## Training Data

**marked image** *(aka "labeled cell image")*:
A 48×48 PNG of a single cell that has been preprocessed (background normalized, polarity handled) so that the bead code text is the dominant readable feature. Filename pattern: `<CODE>_<SEQ>_marked[_h<v>].png`.

**manifest.csv**:
The metadata table shipped with a directory of labeled cell images. Columns: `编码` (code), `文件名` (filename), `行`/`列` (board coords, optional), `色相` (hue, optional), `亮度` (brightness, optional).

**board.json**:
The metadata file shipped next to a generated pattern PNG (from `board_generator.py`). Header (source image, brand, rows/cols, cell_size, merge params, generator + attribution) + `cells[]` with 1-based `row`/`col`, `code`, `color_hex`. Board-level metadata, unlike manifest.csv which is cell-image-directory-level.

## Decisions Logged

See `docs/adr/` for hard-to-reverse decisions.
