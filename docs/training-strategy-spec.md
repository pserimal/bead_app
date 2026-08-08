# Current Training Strategy Specification

## Problem Statement

The recognition model must identify mard bead-board cells from user-uploaded color diagrams, including colors and codes that are absent from the manually annotated set. A real-only model fits the known annotated cells well but fails on unseen mard colors and codes. A cell-only synthetic generator covers the palette but does not reproduce the context of a real diagram: neighboring cells, page-wide watermarks, periodic blue separator grids, and crop-box alignment errors.

The training strategy therefore needs to preserve two properties at the same time:

- high accuracy on real labeled bead cells;
- broad generalization across all 291 mard colors and their printed codes in realistic diagram context.

## Solution

Use a color-aware RGB CRNN trained on a mixed dataset with real labeled cells as the domain anchor and mard synthetic diagram crops as the coverage expansion.

The synthetic path is diagram-level rather than cell-level:

1. Render a large pool of mard-coded colored cells.
2. Randomly arrange those cells into complete diagrams.
3. Apply full-page translucent watermarks using randomized light-gray or white text, size, spacing, and content.
4. Add blue separator grid lines every few cells across the complete diagram.
5. Re-cut the diagram using a simulated user crop-box offset: normally ±2 px, occasionally up to ±8 px.
6. Use the resulting crops as labeled training cells, preserving each cell's mard code from diagram metadata.

The current production candidate is `crnn_color_v6`, trained from 30,720 diagram-derived mard cells plus 18,228 real labeled cells. Its new-diagram heldout exact-match rate is 0.9888, while the real zip benchmark remains 0.9642.

## User Stories

1. As a bead-board user, I want the recognizer to understand all mard color codes, so that an unfamiliar bead color is not automatically mapped to a familiar but incorrect color.
2. As a bead-board user, I want recognition to use the color visible in my uploaded diagram, so that near-identical printed glyphs can be disambiguated by bead color when possible.
3. As a bead-board user, I want cells from diagrams with watermarks to remain recognizable, so that shared or downloaded diagrams are usable without manual cleanup.
4. As a bead-board user, I want cells crossed or bordered by periodic blue grid lines to remain recognizable, so that diagram separators do not cause systematic OCR errors.
5. As a bead-board user, I want small crop-box alignment errors to be tolerated, so that I do not need pixel-perfect grid selection before recognition.
6. As a bead-board user, I want larger crop-box errors to be represented occasionally during training, so that the model is robust to imperfect but usable selections.
7. As a bead-board user, I want neighboring cells and page context represented during training, so that the model sees the same visual interference that occurs in a real diagram.
8. As a bead-board user, I want recognition to work on color photographs and color-rendered diagrams, so that the production path does not discard useful RGB information.
9. As a bead-board user, I want the model to retain high accuracy on known real bead cells, so that expanding the code vocabulary does not regress common existing codes.
10. As a training operator, I want every mard code to have synthetic coverage, so that new palette entries do not require immediate manual annotation before they can be recognized.
11. As a training operator, I want each mard code to appear repeatedly in each generated corpus, so that a code is not represented by a single font, position, or rendering artifact.
12. As a training operator, I want synthetic cells to be generated from the authoritative mard color hex values, so that the color-to-code relationship is deterministic and auditable.
13. As a training operator, I want the printed code to match the exact color metadata used to render its cell, so that synthetic labels cannot drift from their image content.
14. As a training operator, I want several fonts, font sizes, stroke widths, rotations, affine shears, brightness levels, saturation levels, blur levels, and JPEG qualities, so that the model learns glyph identity rather than one renderer's fingerprint.
15. As a training operator, I want full-page watermark variation, so that the model does not overfit one watermark phrase, size, opacity, or tile spacing.
16. As a training operator, I want blue grid intervals and line widths to vary, so that the model does not memorize one fixed separator pattern.
17. As a training operator, I want crop offsets to be deterministic from a seed, so that a dataset can be reproduced exactly for debugging and evaluation.
18. As a training operator, I want the cropper to avoid independent per-cell label corruption, so that crop simulation represents a misaligned crop box rather than intentionally wrong ground truth.
19. As a training operator, I want real labeled cells to remain the dominant appearance anchor, so that synthetic expansion does not destroy production-domain accuracy.
20. As a training operator, I want class balancing choices to be explicit, so that rare synthetic codes do not silently dilute high-value real-domain examples.
21. As a training operator, I want validation to be stratified by code, so that a validation score is not dominated by the most frequent code.
22. As a training operator, I want a heldout set generated with a different seed and diagram instances, so that the reported score measures generalization to new diagrams rather than memorization.
23. As a training operator, I want separate real-cell and diagram-level metrics, so that a trade-off between real recognition and unseen-color generalization is visible.
24. As a deployment operator, I want the active model artifact to be selected through the current model pointer, so that replacing the model does not require changing OCR code.
25. As a deployment operator, I want job metadata to record the active model snapshot, so that a recognition result can be traced to the model that produced it.
26. As a deployment operator, I want restarting the server to preserve historical jobs, events, blueprints, and color data, so that operational restarts do not destroy user history.
27. As a developer, I want an explicit destructive database reset switch for development, so that a deliberate schema reset remains possible without making data loss the default.
28. As a developer, I want the RGB model to remain checkpoint-compatible with the older grayscale model family, so that existing artifacts can still be evaluated or rolled back.
29. As a developer, I want the same RGB channel ordering and letterbox behavior in training, evaluation, and production inference, so that model scores correspond to deployed behavior.
30. As a reviewer, I want the generation pipeline to preserve attribution and licensing metadata, so that derivative mard palette and diagram data remain traceable.

## Implementation Decisions

- The model family is an RGB-input CRNN variant with three input channels. The older grayscale CRNN remains loadable for comparison and rollback.
- The authoritative palette scope for synthetic expansion is the mard brand: 291 codes and their corresponding color values. Other brands are out of this strategy's synthetic scope.
- The synthetic diagram generator creates random code layouts rather than mapping a source photograph. This guarantees coverage of every mard code in every sufficiently large diagram corpus.
- Each generated diagram contains 32×40 cells by default. Each diagram's code pool is constructed so all 291 mard codes appear before additional random repetitions fill the grid.
- The rendered cell is produced at double resolution and downsampled to the production cell size. Font family, font size, text position, stroke width, rotation, affine shear, brightness, saturation, blur, and JPEG compression are randomized.
- Text color uses a contrast rule: dark bead backgrounds use light text and light bead backgrounds use dark text. This matches the existing diagram rendering convention and avoids invisible dark text on black beads.
- Watermarks are applied after cell composition, at the full-diagram level. The watermark uses random short text, size, tile spacing, light-gray/white color, and low opacity, and is tiled across the complete image rather than placed in one local region.
- Blue separator grids are applied after cell composition and before cropping. Their interval is randomized between four and ten cells, with a small set of blue colors and one- or two-pixel line widths.
- Crop simulation applies one global offset to the selected diagram crop. Most samples use ±2 px and a minority use ±8 px. Independent per-cell offsets remain disabled because they would create label corruption rather than realistic crop-box error.
- The training corpus combines 30,720 diagram-derived mard crops and 18,228 real labeled crops. The real set is retained as the appearance anchor; the synthetic set expands palette and diagram-context coverage.
- Training uses RGB input, light augmentation, 30 epochs, batch size 64, learning rate 1e-3, and no class-balancing sampler for the current v6 recipe. The no-balance decision prevents the large synthetic vocabulary from washing out real-domain frequency and appearance signals.
- The training vocabulary is derived from the complete supported code character set, while labels remain constrained by the mard code dictionary during evaluation and production decoding.
- The model artifact is immutable and versioned. The active artifact is selected through the `artifacts/models/current` pointer, and job snapshots record the active model name.
- Database startup defaults to preservation mode. Flyway migration still runs, but destructive clean/recreate only happens when `BEAD_DB_RECREATE_ON_START=true` is explicitly supplied.
- The existing highest-level seams are retained: diagram generation and crop output, the training CLI, and the production-shaped evaluation path. No separate low-level rendering test seam is required for the strategy itself.

## Testing Decisions

- Tests should verify externally observable behavior of the training pipeline, not private rendering implementation details.
- The highest-value integration test is a small deterministic diagram fixture: generate a diagram, assert all expected metadata codes exist, crop it with a fixed seed, and assert the output manifest count and labels match the metadata.
- The fixture should verify that the generated diagram contains RGB content, at least one blue separator, and watermark pixels that span more than one local cell region.
- A crop-offset test should use two seeds and assert that at least one output crop differs in dimensions or pixels while retaining the same metadata label and total cell count.
- A palette coverage test should assert that a generated corpus includes all 291 mard codes and that each code has at least the configured minimum count.
- A training smoke test should load a small generated corpus with the RGB model, run one optimization step, save a format-versioned checkpoint, and reload it through the production checkpoint loader.
- A production-shape inference test should pass an RGB crop through the same letterbox and channel-order path used by image_service, confirming the model receives three channels and produces a valid constrained code.
- The existing evaluation scripts remain the acceptance seam: report real zip exact-match separately from diagram-heldout exact-match. The v6 target is no regression against the real benchmark and a substantial improvement on independently seeded diagram-heldout data.
- The database preservation behavior should be tested at the application startup seam: with the default configuration, an existing job count remains unchanged after restart; with the explicit destructive flag, reset behavior remains available for development.
- Prior art includes the existing board metadata/crop verification gate, stratified validation in the CRNN training script, checkpoint compatibility checks, and Spring MockMvc contract tests for API behavior.

## Out of Scope

- Synthetic training data for Hama, Perler, Artkal, or other non-mard brands.
- Automatic resolution of ambiguous or incorrect historical annotations such as visually similar code confusions.
- Changes to the frontend crop interaction or blueprint rendering UI.
- Automatic color calibration of arbitrary camera white balance beyond the existing augmentation strategy.
- Replacing the CRNN architecture with a transformer, vision-language model, or multi-stage detector.
- Changing the public job API or database schema for training metadata.
- Deleting, rewriting, or migrating historical recognition jobs during model deployment.
- Making the training corpus or model weights part of the normal source-control history; large generated datasets and weights remain local/artifact outputs according to repository policy.

## Further Notes

- Current production candidate: `crnn_color_v6`, trained from the diagram-level mard pipeline plus real labeled cells.
- Measured v5 → v6 improvement on independently seeded diagram-heldout data: 0.9449 → 0.9888 exact-match, with real zip accuracy unchanged at 0.9642.
- The diagram-level generator is the preferred path for future mard synthetic expansion. The old isolated-cell generator may still be useful for quick ablations, but it is not representative enough to be the primary training source.
- Watermark, blue-grid, and crop-offset parameters should remain seed-controlled so future experiments can compare model changes rather than dataset drift.
- The project retains the ability to perform a destructive database reset only through explicit configuration; ordinary server restarts must preserve user history.
