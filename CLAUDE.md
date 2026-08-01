# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

拼豆助手 (ai_dou) — Perler bead pattern recognition app. Users upload a photo of a bead board, crop the grid region, set rows/cols; the backend OCRs the alphanumeric bead codes printed in each cell, looks each code up in a Perler color library, and produces a read-only bead blueprint.

The repo is organized into four top-level parts:

- **`frontend/`** — React/Vite SPA (`:5173`), talks to the Spring API via `/api/*` (Vite proxy → `:8080`)
- **`server/`** — Spring Boot + Kotlin API service (`:8080`), PostgreSQL-backed; the only external HTTP service
- **`image_service/`** — internal Python FastAPI CRNN service (`:8001`, internal network only); does the actual OCR
- **`ocr_core/`** — shared OCR core package (charset, code library, CRNN arch + inference); consumed by both `image_service/` and `training/`
- **`training/`** — model training + data annotation; produces versioned model artifacts consumed by `image_service/`

## Architecture (one-screen mental model)

```
[ Browser (React/Vite, :5173) ]
        │  /api/v1/*  (Vite proxy → :8080, CORS allowed)
        ▼
[ Spring Boot + Kotlin (server/, :8080) ]            [ PostgreSQL 192.168.5.88:5432 (or compose db) ]
        ├─ api/      JobController, BlueprintController, ColorController, InternalEventController
        ├─ service/  JobService (008: idempotent events, atomic blueprint, recovery sweep)
        │            PythonTaskDispatcher (009: multipart dispatch → image_service)
        ├─ model/    JPA entities (recognition_job, blueprint, color_library …)
        └─ config/   Flyway migrations, ColorSeedRunner, RecoveryScheduler, CORS
        │
        │  POST /v1/tasks (multipart: image + cropBox + rows/cols)
        ▼
[ Python image_service (:8001, internal) ]   ←── [ ocr_core/ (shared) ]
        ├─ worker: decode cells → callback events
        └─ POST /internal/jobs/{id}/events (per-cell, heartbeat, terminal)
```

**Recognition flow**: upload → `POST /api/v1/jobs` → Spring saves image + creates job (PENDING) → dispatcher submits to Python → Python runs CRNN (ocr_core) → per-cell `CELL_PROCESSED` callbacks → Spring applies idempotently → `JOB_SUCCEEDED` atomically creates Blueprint. The frontend polls the job via React Query (2s) and renders the blueprint read-only.

Protocol details (events, sequences, retries, recovery) are defined in the wayfinder tracker: `.scratch/spring-kotlin-python-rewrite/` (14 closed decision tickets + `IMPLEMENTATION-NOTES.md`).

## Commands

### Backend (server)
```bash
# Build/test (JDK 21 + Gradle 8.10; conda env bead-java on Windows, or gradlew)
cd server && gradle test --no-daemon            # 9 contract tests (MockMvc + jsonPath)
cd server && gradle bootJar --no-daemon         # build runnable jar
java -jar server/build/libs/bead-server-0.1.0.jar   # :8080, Swagger at /swagger-ui
```

### Image service (Python)
```bash
# From repo root (ocr_core must resolve); conda env bead-train (torch + cv2 + fastapi)
MODEL_ARTIFACT_DIR=artifacts/models/current \
  python -m uvicorn image_service.app.main:app --host 127.0.0.1 --port 8001
# /health → {"model_ready": true}; /v1/tasks is the only job endpoint
```

### Training
```bash
# Train a CRNN model (writes format_version=1 checkpoint with metadata)
python -m training.scripts.train_crnn --synth-n 50000 --epochs 30

# Publish a checkpoint as an immutable artifact (010 R3)
python -m training.scripts.publish_checkpoint \
    --checkpoint training/checkpoints/crnn_real_m.pt --name crnn_real_m --version <v>

# Baseline / acceptance eval (011)
python -m training.scripts.eval_cell_baseline --checkpoint <ckpt> --legacy

# Eval against real stand crops (grid-level; needs positioned GT)
python -m training.scripts.eval_stand
```

### Frontend
```bash
cd frontend && npm install
cd frontend && npm run dev      # dev server :5173, proxies /api → :8080
cd frontend && npm run build    # tsc -b && vite build
cd frontend && npm test         # vitest run --passWithNoTests (138 tests)
```

### Compose (013)
```bash
cp .env.example .env && docker compose up -d --build        # postgres + spring + python
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build  # dev ports
```

## Project-specific gotchas

- **No `pyproject.toml`** — `image_service/` runs via `uvicorn image_service.app.main:app` from repo root (so `ocr_core` resolves). Training scripts run via `python -m training.scripts.X` from repo root.
- **Conda envs**: `bead-app` (old backend, retired — no longer needed), `bead-train` (torch/cv2/fastapi for training + image_service), `bead-java` (JDK 21 + Gradle + PostgreSQL tools). Windows-side envs; WSL has no network.
- **Postgres**: dev uses remote `192.168.5.88:5432` (admin/123456, databases `bead_app` + `bead_app_test`); compose provides its own db service. Credentials are injected via env, not hardcoded (except `.env.example` template).
- **Image upload limits**: 20 MB max, JPEG/PNG only — enforced in JobController.
- **Model artifact contract (010 R3)**: `artifacts/models/<name>-<version>/{model.pt, charset.json, manifest.json}`; `artifacts/models/current` points to the active one; `image_service` loads via `MODEL_ARTIFACT_DIR`. Legacy 3-key checkpoints are **rejected** by `ocr_core.load_checkpoint` (must migrate via `publish_checkpoint.py`).
- **Checkpoint metadata hard-checks (010 R2)**: `format_version`, `model_arch`, `num_classes`, `input_size`, `charset_hash` mismatch → `CheckpointFormatError` at load.
- **Confidence fix (011 F1)**: `ocr_core.inference` normalizes confidence as `exp(score/T)` (per-step log-prob), not `exp(score/len(code))` — the old formula rejected everything at min_conf=0.5.
- **Frontend proxies `/api` → `http://localhost:8080`** via `vite.config.ts`. Use `apiClient` from `frontend/src/api/client.ts` (baseURL `/api/v1`, 30s timeout, error interceptor mapping `{code, message, details, traceId}`).
- **Tailwind v4 CSS-based config** — config lives in `frontend/src/index.css`. **ESLint flat config** (`frontend/eslint.config.js`). No Prettier.
- **No global state library** — React Query (`hooks/useJobs.ts`, `useBlueprints.ts`, `useColorLibrary.ts`); only one React Context (`ToastContext`).
- **Kotlin + Spring**: classes used as beans are plain classes (internal thread pool in `PythonTaskDispatcher` — `@Async` on final Kotlin classes silently fails; don't reintroduce it).
- **Event idempotency (008)**: `(job_id, attempt, sequence)` unique; JOB_STARTED uses sequence=0 so Python's sequence 1..N never collides; internal events use `appendInternalEvent` (next free sequence in current attempt).

## Where things live (quick lookup)

| Looking for… | File |
|---|---|
| /api/v1 contract (DTOs, errors, pagination) | `server/src/main/kotlin/com/beadapp/server/schema/Dtos.kt` |
| Job lifecycle + idempotent events + recovery | `server/.../service/JobService.kt` |
| Spring → Python dispatch | `server/.../service/PythonTaskDispatcher.kt` |
| Python callback endpoint | `server/.../api/InternalEventController.kt` |
| Flyway schema (008) | `server/src/main/resources/db/migration/V1__initial_schema.sql` |
| Python image-service entry | `image_service/app/main.py` (+ `worker.py`, `event_sender.py`) |
| Shared OCR core | `ocr_core/` (`bead_ocr_crnn.py`, `inference.py`, `charset.py`, `code_library.py`) |
| Checkpoint publish | `training/scripts/publish_checkpoint.py` |
| Baseline + acceptance (011) | `training/scripts/eval_cell_baseline.py`, `training/docs/baseline-2026-07-31.md` |
| CRNN training | `training/scripts/train_crnn.py` |
| Real bead images (input data) | `examples/` (stand crops + annotation zips) |
| Trained checkpoints | `training/checkpoints/*.pt` (gitignored); artifacts in `artifacts/models/` |
| Compose topology | `docker-compose.yml` (+ `docker-compose.dev.yml`) |
| Wayfinder tracker (decisions) | `.scratch/spring-kotlin-python-rewrite/` |
| Bead board canvas | `frontend/src/components/BeadBoard.tsx` |
| Cropping UI (complexity hotspot) | `frontend/src/pages/UploadPage.tsx` (single-region crop + 8 handles + numeric input) |
| Job trace view | `frontend/src/pages/JobDetailPage.tsx` |

## Agent skills

### Issue tracker

Issues live as GitHub issues in `pserimal/bead_app`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Detailed subdirectory docs

Per-subdirectory `AGENTS.md` files contain exhaustive structure/conventions/anti-patterns notes that this file deliberately does not duplicate:

- `AGENTS.md` — project-wide overview, command reference, layout summary
- `training/README.md` — training-part quickstart, data layout, checkpoint workflow
- `frontend/AGENTS.md` — frontend structure, component conventions, anti-patterns
- `frontend/src/components/AGENTS.md`, `frontend/src/pages/AGENTS.md`

The old `backend/` FastAPI service was retired in the Spring rewrite (commit `77d564d`); its `AGENTS.md` files no longer exist.
