# Model Training Strategy Specification

> 2026-08-15 重写：反映当前生产状态（bean-mard-v12，Rust local_server 运行时）。
> 历史版本对应 crnn_color_v6（Kotlin server 时代）已归档在 git 历史。

## Problem Statement

The recognition model must identify mard bead-board cells from user-uploaded color diagrams, including colors and codes that are absent from the manually annotated set. A real-only model fits the known annotated cells well but fails on unseen mard colors and codes. A cell-only synthetic generator covers the palette but does not reproduce the context of a real diagram: neighboring cells, page-wide watermarks, periodic blue separator grids, and crop-box alignment errors.

The training strategy therefore needs to preserve two properties at the same time:

- high accuracy on real labeled bead cells;
- broad generalization across all 291 mard colors and their printed codes in realistic diagram context.

Two additional problems surfaced in production measurements (2026-08-15):

- **Real blur generalization is far below the synthetic-only numbers.** Real blurred-diagram cells (user-corrected annotations) recognize at ~43–71% exact-match while clear real cells are ~91%. Synthetic Gaussian+JPEG blur does not transfer to real blurred photos.
- **The acceptance gate was measuring memorization, not generalization.** The four eval benchmark directories were being fed into the training set, so high gate scores were inflated by the model having seen the answers.

## Solution

Use a color-aware RGB CRNN trained on a mixed dataset with real labeled cells as the domain anchor and mard synthetic diagram crops as the coverage expansion.

The synthetic path is diagram-level rather than cell-level:

1. Render a large pool of mard-coded colored cells.
2. Randomly arrange those cells into complete diagrams.
3. Apply full-page translucent watermarks using randomized light-gray or white text, size, spacing, and content.
4. Add blue separator grid lines every few cells across the complete diagram.
5. Re-cut the diagram using a simulated user crop-box offset: normally ±2 px, occasionally up to ±8 px.
6. Apply whole-board upload degradation (blur + JPEG re-compression) **before** cropping so every cropped cell inherits it: 55% clear, 30% slight defocus, 13% moderate, 2% heavy.
7. Use the resulting crops as labeled training cells, preserving each cell's mard code from diagram metadata.

The training corpus combines synthetic diagram cells with every manual annotation directory under `training/samples/标注数据` — except the eval benchmark directories, which are excluded so the gate measures unseen generalization (data hygiene, see Implementation Decisions).

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
10. As a bead-board user, I want genuinely blurred photo cells to be recognized, so that phone photos of bead boards do not produce garbage output (current weak point: ~43–71%).
11. As a training operator, I want every mard code to have synthetic coverage, so that new palette entries do not require immediate manual annotation before they can be recognized.
12. As a training operator, I want each mard code to appear repeatedly in each generated corpus, so that a code is not represented by a single font, position, or rendering artifact.
13. As a training operator, I want synthetic cells to be generated from the authoritative mard color hex values, so that the color-to-code relationship is deterministic and auditable.
14. As a training operator, I want the printed code to match the exact color metadata used to render its cell, so that synthetic labels cannot drift from their image content.
15. As a training operator, I want several fonts, font sizes, stroke widths, rotations, affine shears, brightness levels, saturation levels, blur levels, and JPEG qualities, so that the model learns glyph identity rather than one renderer's fingerprint.
16. As a training operator, I want full-page watermark variation, so that the model does not overfit one watermark phrase, size, opacity, or tile spacing.
17. As a training operator, I want blue grid intervals and line widths to vary, so that the model does not memorize one fixed separator pattern.
18. As a training operator, I want crop offsets to be deterministic from a seed, so that a dataset can be reproduced exactly for debugging and evaluation.
19. As a training operator, I want the cropper to avoid independent per-cell label corruption, so that crop simulation represents a misaligned crop box rather than intentionally wrong ground truth.
20. As a training operator, I want real labeled cells to remain the dominant appearance anchor, so that synthetic expansion does not destroy production-domain accuracy.
21. As a training operator, I want class balancing choices to be explicit, so that rare synthetic codes do not silently dilute high-value real-domain examples. (The balance sampler is **disabled**: it does not converge on this dataset.)
22. As a training operator, I want validation to be stratified by code, so that a validation score is not dominated by the most frequent code.
23. As a training operator, I want a heldout set generated with a different seed and diagram instances, so that the reported score measures generalization to new diagrams rather than memorization.
24. As a training operator, I want eval benchmark directories kept out of training, so that gate scores measure genuine generalization rather than memorization of the answer set.
25. As a training operator, I want real annotation BLANKs (watermark-residue blanks) never discarded by the blank cap, so that the most valuable real evidence is preserved.
26. As a training operator, I want every dataset build to record its synth:real ratio, per-source counts, and blur-level statistics, so that training runs are auditable.
27. As a deployment operator, I want the active model artifact to be selected through the `artifacts/models/current` pointer, so that replacing the model does not require changing OCR code.
28. As a deployment operator, I want job metadata to record the active model snapshot, so that a recognition result can be traced to the model that produced it.
29. As a deployment operator, I want restarting the server to preserve historical jobs, events, blueprints, and color data, so that operational restarts do not destroy user history.
30. As a developer, I want the RGB model to remain checkpoint-compatible with the older grayscale model family, so that existing artifacts can still be evaluated or rolled back.
31. As a developer, I want the same RGB channel ordering and letterbox behavior in training, evaluation, and production inference, so that model scores correspond to deployed behavior.
32. As a developer, I want model naming to be uniform `bean-mard-v<N>` and auto-incremented, so that artifacts and checkpoints cannot collide or be misaddressed.
33. As a developer, I want checkpoint metadata to hard-check format_version / arch / num_classes / input size / charset hash, so that a stale or mismatched artifact fails fast.
34. As a reviewer, I want the generation pipeline to preserve attribution and licensing metadata, so that derivative mard palette and diagram data remain traceable.

## Implementation Decisions

### Model architecture

- The model family is an RGB-input CRNN variant with three input channels. The older grayscale CRNN remains loadable for comparison and rollback.
- Input preprocessing: cells resized to height 48 with letterboxing, uint8 quantization (round → u8 → /255), batch size 128 for numerical parity with the Python reference.
- Decoding: CTC with blank at index 0, constrained over the mard code dictionary + BLANK via a trie. Truncated prefixes (`BLA`, `BLAN`) are dropped.
- Char set single source of truth: `ocr_core/charset.py`; Rust runtime reads `charset.json` from the artifact.
- ONNX export (opset 17) is the production runtime artifact; the Rust local_server runs it in-process via onnxruntime (ort, load-dynamic, API 23, DLL 1.23.2).

### Synthetic generation (diagram-level)

- The authoritative palette scope for synthetic expansion is the mard brand: 291 codes and their corresponding color values. Other brands are out of this strategy's synthetic scope.
- The synthetic diagram generator creates random code layouts rather than mapping a source photograph. This guarantees coverage of every mard code in every sufficiently large diagram corpus.
- Each generated diagram contains 32×40 cells by default. Each diagram's code pool is constructed so all 291 mard codes appear before additional random repetitions fill the grid.
- 5–15% of cells per board are BLANK (empty bead positions): near-white bead background with watermark/grid residue, **not** pure white — the blank cell label is a real special label, not the CTC blank token.
- The rendered cell is produced at double resolution and downsampled to the production cell size. Font family, font size, text position, stroke width, rotation, affine shear, brightness, saturation, blur, and JPEG compression are randomized.
- Text color uses a contrast rule: dark bead backgrounds use light text and light bead backgrounds use dark text.
- Watermarks are applied after cell composition, at the full-diagram level, with random text, size, tile spacing, light-gray/white color, and low opacity.
- Blue separator grids are applied after cell composition and before cropping; interval randomized between 4 and 10 cells, small set of blue colors, 1–2 px line widths.
- Crop simulation applies one global offset to the selected diagram crop (±2 px normally, up to ±8 px occasionally). Independent per-cell offsets stay disabled (they would create label corruption).
- Whole-board upload degradation is applied before cropping (55% clear / 30% slight / 13% moderate / 2% heavy Gaussian+JPEG). Each board's `board.json` records its `blur_level` for audit.

### Dataset assembly (build_color_dataset_v2)

- Training corpus = synthetic diagram cells + all manual annotation directories under `training/samples/标注数据`.
- **Data hygiene (2026-08-15)**: the five eval benchmark directories are excluded from training by default: `code_main` (1_标注结果_2026-07-29), `blank_clean` (5_标注结果_2026-08-08), `blank_polluted` (corrections-fdaa77a1), `blank_polluted_ref` (4_标注结果_2026-08-08), `blur_real` (corrections-b48348f1-2026-08-15-模糊图纸). The gate therefore measures unseen real cells.
- **BLANK cap (default 4000) applies to synthetic-board BLANKs only.** Real annotation BLANKs are never dropped — they are the valuable watermark-residue evidence. Keeps the label distribution sane (target ~8% BLANK) without throwing away real data.
- Every build writes `dataset.json` with built_at, excluded dirs, blank cap + dropped count, synth/real cell counts, synth:real ratio, per-source counts, and blur-level stats.
- Training recipe (current, v12/v47): `--no-balance-classes --color --augment --lr 1e-3 --batch-size 64 --epochs 30` (~20 min / 30 epochs).
- The training vocabulary is derived from the complete supported code character set; labels remain constrained by the mard code dictionary during evaluation and production decoding.

### Naming & artifacts

- **All models are `bean-mard-v<N>`** numbered by event-time order (2026-08-15 unification; mapping table in `.scratch/rename_artifacts.json`).
- `training/scripts/model_naming.py` enforces the format and auto-increments: `train_crnn --out` omitted → next `bean-mard-v<N>.pt` in `training/checkpoints/`; `publish_checkpoint --name` omitted → next `bean-mard-v<N>` under `artifacts/models/`; non-`bean-mard-vN` names are rejected.
- Each artifact dir is immutable: `artifacts/models/bean-mard-v<N>-<version>/` containing `model.pt` (training), `model.onnx` (runtime), `charset.json`, `manifest.json`.
- Runtime model selection: `artifacts/models/current` pointer (Windows `mklink /D`). Rust hardcoded paths must be grepped and updated on every deployment (`api.rs` snapshot, `main.rs` default path, `parity.rs`).
- ONNX is **not** in git and **not** in the release zip; end users download the model per README and place it under the app `models\` dir. Missing model → server runs in no-model mode, create-job returns 503 MODEL_NOT_INSTALLED.
- Database (SQLite, WAL) starts in preservation mode; ordinary restarts never destroy user data. The Kotlin-era `BEAD_DB_RECREATE_ON_START` destructive switch no longer exists in the Rust runtime.

## Testing Decisions

- Tests verify externally observable behavior of the training pipeline, not private rendering implementation details.
- The highest-value integration test is a small deterministic diagram fixture: generate a diagram, assert all expected metadata codes exist, crop it with a fixed seed, and assert the output manifest count and labels match the metadata.
- The fixture should verify that the generated diagram contains RGB content, at least one blue separator, and watermark pixels that span more than one local cell region.
- A crop-offset test should use two seeds and assert that at least one output crop differs in dimensions or pixels while retaining the same metadata label and total cell count.
- A palette coverage test should assert that a generated corpus includes all 291 mard codes and that each code has at least the configured minimum count.
- A training smoke test should load a small generated corpus with the RGB model, run one optimization step, save a format-versioned checkpoint, and reload it through the production checkpoint loader.
- A production-shape inference test should pass an RGB crop through the same letterbox and channel-order path used by the runtime, confirming the model receives three channels and produces a valid constrained code.
- **Acceptance gate (eval_acceptance.py)**: fixed benchmark, candidate must not be more than 0.005 (absolute fraction) worse than production on any metric. Benchmarks: 5 real sets (`code_main`, `blank_clean`, `blank_polluted`, `blank_polluted_ref`, `blur_real`) + `synthetic_heldout` (independently seeded diagram corpus, never in training). Gate FAIL requires a human decision recording the trade-off — the gate may not be weakened to pass.
- **Rust-side gate (bench_acceptance.rs)**: 4 real-set reference values hardcoded; must be run after the Python gate.
- **Data hygiene rule**: the five eval benchmark dirs must stay out of training (enforced by `DEFAULT_EXCLUDES` in build_color_dataset_v2; matches `REAL_SETS` in eval_acceptance). When a new annotated dir is added, decide explicitly: benchmark (excluded from training, added to gate) vs training-only.
- Prior art includes the existing board metadata/crop verification gate, stratified validation in the CRNN training script, checkpoint compatibility checks, and Rust contract tests.

## Out of Scope

- Synthetic training data for Hama, Perler, Artkal, or other non-mard brands.
- Automatic resolution of ambiguous or incorrect historical annotations such as visually similar code confusions (annotation quality is the training-quality ceiling; fixes are manual).
- Changes to the frontend crop interaction or blueprint rendering UI.
- Automatic color calibration of arbitrary camera white balance beyond the existing augmentation strategy.
- Replacing the CRNN architecture with a transformer, vision-language model, or multi-stage detector.
- Changing the public job API or database schema for training metadata.
- Deleting, rewriting, or migrating historical recognition jobs during model deployment.
- Making the training corpus or model weights part of the normal source-control history; large generated datasets and weights remain local/artifact outputs according to repository policy.

## Further Notes

### Current state (2026-08-15)

- Production: **bean-mard-v12** (trained on color_v10d, label-noise-corrected; deployed, local_server :8080 loads it). NOTE: v12 was trained with the eval sets included (pre-hygiene), so its gate numbers are inflated by memorization — it is still the deployed production model pending a decision.
- Honest generalization baseline: **bean-mard-v47** (trained on color_v11 with eval sets excluded): code_main 0.9149, blur_real 0.4275, blank_polluted blank 0.42 — the real capability level, far below the old memorized numbers.
- Real blur is the weakest area: ~43–71% exact-match on blurred real cells vs ~91% on clear real cells. Synthetic blur does not transfer to real photos.

### Gotchas (注意事项)

- **Balance sampler is unusable**: `--balance-classes` does not converge on this all-SampleLike dataset (v1b stuck at val_em 0.002). Must use `--no-balance-classes`.
- **BLANK ratio >21% breaks code recognition**: `build_color_dataset_v2 --blank-cap 4000` (default) keeps it ~8%. Cap now applies to synthetic BLANKs only.
- **Annotation noise = training-quality ceiling**: 46 H18↔H12 mislabels from 1_标注结果_07-29 were learned by the model; fixing them (retrain → v12) gained +0.84pp code_main and +13.2pp blank_polluted_ref. Fix the labels, not the model.
- **Gate same-source leakage**: eval dirs in training inflate the gate (v12 code_main 0.9981 was memorization). Keep them excluded; when gate FAILs on the new honest baseline, that is the real number, not a bug.
- **Synthetic blur ≠ real blur**: Gaussian+JPEG on synthetic boards does not reproduce real blurred photos (blur_real 0.43–0.71). Collect real blurred annotations; the recent `corrections-b48348f1-...-模糊图纸` dir is a start.
- **Naming is enforced**: publish/checkpoint names must match `bean-mard-v<N>`; Rust hardcoded paths (api.rs snapshot / main.rs default / parity.rs) and start-local.bat `BEAD_ARTIFACT_DIR` must be grepped and updated on every deploy.
- **Numerical parity laws**: batch 128, uint8 quantization (round→u8→/255), cv2 INTER_AREA = weighted area average. Violating any of these breaks parity between Python reference and Rust runtime.
- **current pointer**: create with Windows `mklink /D` (WSL `ln` creates a directory and fails).
- **No destructive DB reset in Rust runtime**: SQLite history is preserved on restart; there is no recreate-on-start switch anymore.
- **onnx is deploy-time only**: not in git, not in the release zip; end users download models to app `models\` per README. Missing model degrades to no-model mode (503).
