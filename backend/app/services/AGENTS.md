# BACKEND SERVICES

**Updated:** 2026-07-26

## OVERVIEW

The backend has two distinct service groupings:

1. **OCR inference pipeline** (`bead_parser.py` orchestrator + `pipeline/` pluggable adapters + `bead_ocr_*.py` engines + `bead_grid_detector.py` / `bead_ocr_preprocess.py` / `code_match.py`)
2. **CRUD + persistence** (`blueprint_service.py`, `color_library_service.py`, `storage.py`)

**Training-related files do NOT live here.** The CRNN model architecture, the synthetic dataset generator, and training/eval scripts live in `training/` (see `training/README.md`). The backend only consumes the trained `.pt` file via `CRNN_MODEL_PATH`.

This file deliberately does not duplicate `backend/AGENTS.md` — read both.

## STRUCTURE

```
backend/app/services/
├── bead_parser.py                # BeadPatternParser — orchestrator (~218 lines)
├── bead_grid_detector.py         # Low-level grid detection: HSV blue-line mask → FFT period → cell sampling (~233 lines)
├── bead_ocr.py                   # OCR dispatcher (selects engine by OCR_ENGINE setting)
├── bead_ocr_easy.py              # EasyOCR — default engine (~200 lines)
├── bead_ocr_template.py          # Glyph template matching (NCC, zero-training baseline) (~357 lines)
├── bead_ocr_deepseek.py          # DeepSeek-OCR via Ollama VLM (~343 lines)
├── bead_ocr_crnn_inference.py    # Trained CRNN — loads from training/checkpoints/ (~132 lines)
├── bead_ocr_preprocess.py        # Adaptive per-cell preprocessing (binarize, invert) (~105 lines)
├── code_match.py                 # Fuzzy code correction against valid_codes set (~145 lines)
├── pipeline/                     # Pluggable grid+OCR pipeline
│   ├── __init__.py               # Pipeline orchestrator + re-exports
│   ├── interfaces.py             # GridDetector, CodeReader, GridCell, CodeResult Protocols
│   ├── blue_line_grid_detector.py  # Reference GridDetector impl (wraps bead_grid_detector)
│   ├── easy_ocr_code_reader.py   # Reference CodeReader impl (wraps bead_ocr_easy)
│   └── stubs.py                  # Test/benchmark stubs
├── blueprint_service.py          # CRUD: get_blueprints, create_blueprint, save_parsed_cells (~150 lines)
├── color_library_service.py      # CRUD for color libraries + entries (~72 lines)
├── debug_io.py                   # Debug image dumps (DEBUG_DUMP env flag) (~31 lines)
└── storage.py                    # FileStorage — save/delete, module-level singleton (~61 lines)
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Change pipeline orchestration | `bead_parser.py` | `BeadPatternParser.parse(image)` — chains GridDetector + CodeReader |
| Add new pipeline stage | `pipeline/interfaces.py` | Define new Protocol; add adapter in `pipeline/` |
| Swap grid detection | `pipeline/blue_line_grid_detector.py` | Or implement your own `GridDetector` |
| Swap OCR engine (production) | `bead_ocr.py` + new `bead_ocr_<engine>.py` | Engine must expose `ocr_cells_from_crop_<engine>(image_bgr, rows, cols, bbox, ...)` |
| Change OCR pre-processing | `bead_ocr_preprocess.py` | Shared by all engines |
| Train a new CRNN | `training/scripts/train_crnn.py` (NOT here) | Writes `.pt` to `training/checkpoints/` |
| Debug fuzzy code correction | `code_match.py` | Used by `bead_ocr_easy/template/deepseek` |
| Add CRUD method | `blueprint_service.py` / `color_library_service.py` | Async, `AsyncSession` param |
| File upload/delete | `storage.py` | `FileStorage().save()` / `.delete()`; local FS singleton |

## CONVENTIONS

- **Async everywhere** — all service functions are `async def`, accept `AsyncSession` where DB access is needed
- **Stateless services** — no instance state, all config from `app/config.py` or class ctor
- **Service namespace import** — `from app.services import X as svc_X` (no direct `from X import` at module top-level — lazy imports avoid circular deps)
- **Pipelines use Protocols, not base classes** — `pipeline/interfaces.py` defines `GridDetector`/`CodeReader`; new implementations just satisfy the shape
- **OCR engines are dispatched, not registered** — `bead_ocr.py` has an explicit if/elif for each engine. Adding one means editing that file.
- **No Pydantic in services** — return raw dicts/tuples/dataclasses; schemas live in `app/schemas/`

## ANTI-PATTERNS

- **`bead_grid_detector.py` is "internal" to the pipeline** — it's the low-level impl that `pipeline/blue_line_grid_detector.py` wraps. Don't call `detect_grid()` directly from new code; route through `pipeline/`.
- **Mixed sync/async lazy imports** — `bead_ocr.py` uses lazy `from app.services.bead_ocr_X import ...` inside functions to break circular import chains. Don't move them to module top.
- **`bead_ocr_crnn_inference.py` imports from `training.models.*`** — yes, cross-part import is intentional (training owns the model architecture; runtime needs to instantiate it). Resolved via `sys.path` manipulation in training scripts and `CRNN_MODEL_PATH` setting for the checkpoint.
- **No type hints on some returns** — `bead_grid_detector.detect_grid()` returns `BeadGrid` (dataclass) but a few helpers still return raw tuples without inner-type annotations
- **Magic numbers** — `bead_ocr_preprocess.py` has hardcoded binarization thresholds; `code_match.py` has hardcoded edit-distance thresholds. No central config.

## UNIQUE STYLES

- **OCR-first, not color-first** — cells contain *printed text codes* (e.g. `H7`, `E11`), not the actual bead color. The original color-matching pipeline (YOLO + CIEDE2000 + Lab-space) was removed entirely.
- **Two OCR paths** — (1) Auto grid detection via `pipeline/` (blue-line FFT + OCR), or (2) user-provided bbox bypasses grid detection and OCRs cells directly from a crop region (preferred for real-world images).
- **Pluggable pipeline** — `pipeline/` is a clean Protocol-based extension point; you can swap in a custom `GridDetector` or `CodeReader` without touching `bead_parser.py`.
- **EasyOCR is initialized lazily** behind a module-level lock (`_get_reader()` in `bead_ocr_easy.py`) — first OCR call pays the model-load cost.
- **Code vocabulary is closed** — recognized codes are constrained to the closed set from `default_colors.json` (e.g. `A1`, `H7`, `Z99`). CTC decoding uses a trie-based constrained beam for the CRNN engine.

## NOTES

- The previous CV pipeline (YOLO + CIEDE2000) was removed in commit `8a69fc7`. None of `parser.py`, `yolo_detector.py`, `color_matcher.py`, `color_card_extractor.py`, `color_extractor.py`, `region_processor.py` exist in the current tree.
- `pipeline/` package was added in commit (see git log) to make the grid+OCR chain pluggable; the orchestrator `bead_parser.py` calls into it.
- Default colors JSON: 65 Perler-brand codes with hex + names (`backend/app/data/default_colors.json`); also read by `training/models/synth_generator.py` and `training/models/bead_ocr_vlm.py` for vocab generation.