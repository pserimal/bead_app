# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

拼豆助手 (ai_dou) — Perler bead pattern recognition app. Users upload a photo of a bead board; the app detects the grid, OCRs the alphanumeric bead codes printed in each cell, looks each code up in a Perler color library, and produces an editable bead blueprint.

The repo is organized into three top-level parts:

- **`frontend/`** — React/Vite SPA (`:5173`), talks to backend via `/api/*`
- **`backend/`** — FastAPI inference service (`:8000`), PostgreSQL-backed; loads trained CRNN weights at runtime
- **`training/`** — model training + data annotation; trains the CRNN consumed by `backend/`, manages real bead images and ground-truth labels

## Architecture (one-screen mental model)

```
[ Browser (React/Vite, :5173) ]
        │  /api/*  (Vite proxy → :8000)
        ▼
[ FastAPI app (uvicorn, :8000) ]                        [ training/ — offline ]
        ├─ routers   app/api/{blueprints,colors}.py           ├─ models/        (CRNN arch, synth_generator, bead_ocr_vlm)
        ├─ models    app/models/  (SQLAlchemy async,           ├─ scripts/       (train_crnn, eval_stand, crop_examples, ...)
        │             2 parent-child pairs)                    ├─ data/real/     (raw bead images, ground-truth JSONs)
        ├─ schemas   app/schemas/ (Pydantic v2)                ├─ data/annotations/ (label tool, manifest, GT zips)
        └─ services  app/services/                             ├─ crops/         (per-cell crops from real images)
              ├─ bead_parser.py       ← orchestrator           ├─ checkpoints/   (trained .pt files)
              │     ├─ pipeline/     ← pluggable grid+OCR       └─ docs/PLAN.md   (training rationale)
              │     │     ├─ interfaces.py
              │     │     ├─ blue_line_grid_detector.py
              │     │     └─ easy_ocr_code_reader.py
              │     └─ bead_ocr.py    ← OCR dispatcher (OCR_ENGINE)
              │           ├─ bead_ocr_easy.py      (EasyOCR, default)
              │           ├─ bead_ocr_template.py  (glyph template matching)
              │           ├─ bead_ocr_deepseek.py  (DeepSeek-OCR via Ollama)
              │           └─ bead_ocr_crnn_inference.py   (trained CRNN, loads from training/checkpoints/)
              ├─ bead_grid_detector.py / bead_ocr_preprocess.py / code_match.py
              ├─ blueprint_service.py / color_library_service.py  (CRUD)
              ├─ debug_io.py          (debug image dumps, controlled by DEBUG_DUMP)
              └─ storage.py           (local FS, module-level singleton)
        │
        ▼
[ PostgreSQL (asyncpg) ]   uploads/  ← raw images (runtime, gitignored)
```

Pipeline is **OCR-based**, not color-pixel matching. Cells contain *printed text codes* (e.g. `H7`, `E11`), not the actual bead color — see the docstring in `backend/app/services/bead_parser.py`. The previous CV pipeline (YOLO + CIEDE2000) was removed in commit `8a69fc7`.

**Two OCR paths**: (1) Auto grid detection via `pipeline/` package (blue-line FFT + OCR), or (2) user-provided bbox bypasses grid detection and OCRs cells directly from a crop region (preferred for real-world images).

`backend/app/services/AGENTS.md` has a more detailed map of the services tree.

## Commands

### Backend
```bash
conda activate bead-app                                  # env defined in backend/environment.yml
cd backend && uvicorn app.main:app --reload --port 8000  # API + Swagger at /docs

cd backend && pytest -v                                  # full suite
cd backend && pytest tests/test_foo.py -v                # single file
cd backend && pytest tests/test_foo.py::test_bar -v      # single test
cd backend && pytest -k "grid" -v                        # name-substring filter

# OCR engine benchmarking (A/B comparison on real images)
cd backend && python -m tests.benchmark_real <image> <gt_json> <rows> <cols>

cd backend && alembic upgrade head
cd backend && alembic revision --autogenerate -m "msg"

docker-compose up -d   # postgres + backend, no frontend service
```

### Training
```bash
# Train a CRNN model (writes to training/checkpoints/crnn_v1.pt by default)
cd training && python -m training.scripts.train_crnn --synth-n 50000 --epochs 30

# Benchmark a trained CRNN against real-image ground truth
cd training && python -m training.scripts.eval_stand

# Crop a raw bead image into a grid-only stand crop
cd training && python -m training.scripts.crop_examples

# Build a semi-automatic GT JSON for a real image
cd training && python -m training.scripts.build_gt_from_ocr
```

### Frontend
```bash
cd frontend && npm install
cd frontend && npm run dev      # dev server :5173, proxies /api → :8000
cd frontend && npm run build    # tsc -b && vite build
cd frontend && npm run lint
cd frontend && npm test         # vitest run --passWithNoTests
cd frontend && npx vitest run src/test/foo.test.tsx      # single test file
```

## Project-specific gotchas

- **No `pyproject.toml`** — neither `backend/` nor `training/` is pip-installable. Run backend via `uvicorn app.main:app` from `backend/`. Run training scripts via `python -m training.scripts.X` from the repo root (so `training.*` imports resolve). CORS in `main.py` is hardcoded to `http://localhost:5173` (no env override).
- **Conda env name is `bead-app`** — Python 3.10, deps pinned in `backend/environment.yml`. A `backend/requirements.txt` also exists (used by the docker backend service); keep them in sync. Training scripts additionally need `torch` + `torchvision` (install separately; not in environment.yml yet).
- **Postgres credentials are `admin:123456`** (hardcoded in `docker-compose.yml` and `.env.example`). Local-only.
- **Image upload limits**: 20 MB max, JPEG/PNG only — enforced in the blueprints router.
- **`BeadPatternParser` loads `default_colors.json` at import time** (module-level). Tests that mutate this file need to clear/reload the module.
- **Training scripts import the runtime backend** (`bead_ocr_crnn_inference.py`, `default_colors.json`) — they add `repo-root` to `sys.path` so `backend.*` and `training.*` both resolve. The `CRNN_MODEL_PATH` setting (in `backend/app/config.py`) defaults to `../training/checkpoints/crnn_v2.pt`, relative to `backend/app/`.
- **EasyOCR is initialized lazily behind a module-level lock** (`_get_reader()` in `bead_ocr_easy.py`) — the first OCR call in a process pays the model-load cost.
- **Frontend proxies `/api` to `http://localhost:8000`** via `vite.config.ts`. Do not hardcode `localhost:8000` in axios calls — use the `apiClient` from `frontend/src/api/client.ts` (baseURL `/api`, 30s timeout, error interceptor).
- **No global state library** — server state goes through TanStack React Query (`hooks/useBlueprints.ts`, `hooks/useColorLibrary.ts`); only one React Context (`ToastContext`). Everything else is prop drilling.
- **Tailwind v4 CSS-based config** — config lives in `frontend/src/index.css`, not `tailwind.config.*`. Don't introduce a `tailwind.config.js`.
- **ESLint flat config** (`frontend/eslint.config.js`, v10+ format). No Prettier.
- **Tests use mixed sync/async patterns** — `TestClient` vs `httpx.AsyncClient` are used inconsistently across the 15 backend test files. Some test files call `asyncio.run(_init_db())` at import time. Match the surrounding style when adding tests.
- **`PaginatedResponse[T]` is duplicated** in `backend/app/schemas/common.py` and `frontend/src/types/api.ts`. Keep the generic parameter aligned on both sides.

## Where things live (quick lookup)

| Looking for… | File |
|---|---|
| Pipeline entrypoint | `backend/app/services/bead_parser.py` (`BeadPatternParser.parse`) |
| Pipeline protocols | `backend/app/services/pipeline/interfaces.py` (`GridDetector`, `CodeReader`) |
| Grid detection | `backend/app/services/pipeline/blue_line_grid_detector.py` |
| OCR dispatcher | `backend/app/services/bead_ocr.py` (selects engine by `OCR_ENGINE`) |
| Runtime OCR engines | `backend/app/services/bead_ocr_easy.py`, `bead_ocr_template.py`, `bead_ocr_deepseek.py`, `bead_ocr_crnn_inference.py` |
| CRNN model architecture | `training/models/bead_ocr_crnn.py` (CRNN class + checkpoint I/O) |
| Synthetic data generator | `training/models/synth_generator.py` (CHARS/CODES constants + `generate_dataset`) |
| Training script | `training/scripts/train_crnn.py` |
| Eval against real stand crops | `training/scripts/eval_stand.py` |
| Real bead images (input data) | `training/data/real/{raw,stand}/` |
| Annotation tool + GT JSONs | `training/data/annotations/` |
| Per-cell crops | `training/crops/cells/`, `training/crops/cut/` |
| Trained checkpoints | `training/checkpoints/crnn_v2.pt` (default `CRNN_MODEL_PATH`) |
| Training plan / rationale | `training/docs/PLAN.md` |
| API routers | `backend/app/api/blueprints.py`, `backend/app/api/colors.py` |
| DB session | `backend/app/db.py` (`get_db` dependency) |
| Settings / .env | `backend/app/config.py` |
| Color library seed | `backend/app/data/default_colors.json` + `app/seed.py` |
| Debug image dumps | `backend/app/services/debug_io.py` (controlled by `DEBUG_DUMP` env) |
| Synthetic test fixtures | `backend/tests/fixtures/` (perler template generator + labels, commit `e6d0db3`) |
| A/B benchmark (real) | `backend/tests/benchmark_real.py` (EasyOCR vs PaddleOCR on real images) |
| Bead board canvas | `frontend/src/components/BeadBoard.tsx` (Canvas 2D, pan/zoom/rotate + cell select) |
| Cropping UI (complexity hotspot, 1017 LOC) | `frontend/src/components/CropBox.tsx` |
| React Query hooks | `frontend/src/hooks/useBlueprints.ts`, `useColorLibrary.ts` |
| Toast notifications | `frontend/src/components/ToastContext.tsx` (`useToast()`) |

## Agent skills

### Issue tracker

Issues live as GitHub issues in `pserimal/bead_app`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Detailed subdirectory docs

Per-subdirectory `AGENTS.md` files contain exhaustive structure/conventions/anti-patterns notes that this file deliberately does not duplicate:

- `AGENTS.md` — project-wide overview, command reference, three-part layout summary
- `training/README.md` — training-part quickstart, data layout, checkpoint workflow
- `backend/AGENTS.md` — backend structure, model/service conventions, anti-patterns
- `frontend/AGENTS.md` — frontend structure, component conventions, anti-patterns
- `frontend/src/components/AGENTS.md`, `frontend/src/pages/AGENTS.md`
- `backend/tests/AGENTS.md`
- `backend/app/services/AGENTS.md`

Read those when working in the corresponding subtree; they are kept up to date with each refactor.