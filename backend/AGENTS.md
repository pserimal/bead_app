# BACKEND

**Updated:** 2026-07-26

## OVERVIEW

FastAPI async backend with SQLAlchemy ORM, OpenCV image processing, and Alembic migrations. Runs via `uvicorn app.main:app` (no package install). This is **PART 3 of the three-part repo layout** (`frontend/` / `training/` / `backend/`) — see root `AGENTS.md` for the full structure.

The backend loads trained model weights from `training/checkpoints/` at runtime (CRNN engine only); the model architecture itself lives in `training/models/bead_ocr_crnn.py`.

## STRUCTURE

```
backend/
├── app/
│   ├── main.py             # FastAPI app + lifespan (create tables, seed colors, teardown)
│   ├── config.py           # pydantic_settings Settings, .env file support; CRNN_MODEL_PATH default
│   ├── db.py               # Async engine + async_sessionmaker + get_db() dependency
│   ├── seed.py             # seed_default_colors() — idempotent color library seeding
│   ├── api/
│   │   ├── blueprints.py   # /api/blueprints (upload, list, detail, cells, delete) — 176 lines
│   │   └── colors.py       # /api/color-libraries (list, create, update, delete entries) — 59 lines
│   ├── models/
│   │   ├── base.py         # DeclarativeBase + TimestampMixin (created_at, updated_at)
│   │   ├── blueprint.py    # Blueprint (parent, has image_path, grid_rows/cols)
│   │   ├── blueprint_cell.py # BlueprintCell (child, row/col/color_code, FK→Blueprint)
│   │   ├── color_library.py # ColorLibrary (1:many with ColorEntry)
│   │   └── color_entry.py  # ColorEntry (code, hex, name, brand, FK→ColorLibrary)
│   ├── schemas/
│   │   ├── common.py       # PaginatedResponse[T], ErrorResponse
│   │   ├── blueprint.py    # BlueprintCreate/Detail/ListItem/CellUpdate/BatchUpdate
│   │   └── color.py        # ColorEntryCreate/Update/Response
│   ├── data/
│   │   ├── default_colors.json  # Seed data for Perler bead color library (single source of truth — also read by training/models/synth_generator.py and training/models/bead_ocr_vlm.py)
│   │   └── image_colors.json    # Image-derived pixel→code mapping (sparse)
│   └── services/
│       ├── bead_parser.py         # BeadPatternParser — OCR-based pipeline (current)
│       ├── bead_grid_detector.py  # Low-level grid detection (HSV + FFT); used by pipeline/
│       ├── bead_ocr.py            # OCR dispatcher (selects engine by OCR_ENGINE)
│       ├── bead_ocr_easy.py       # EasyOCR — default engine
│       ├── bead_ocr_template.py   # Glyph template matching (NCC)
│       ├── bead_ocr_deepseek.py   # DeepSeek-OCR via Ollama
│       ├── bead_ocr_crnn_inference.py  # Trained CRNN — loads from training/checkpoints/
│       ├── bead_ocr_preprocess.py # Adaptive per-cell preprocessing (binarize, invert, etc.)
│       ├── code_match.py          # Fuzzy code correction (used by all engines)
│       ├── pipeline/              # Pluggable grid+OCR pipeline (Protocols + adapters)
│       ├── blueprint_service.py   # CRUD: get_blueprints, create_blueprint, save_parsed_cells
│       ├── color_library_service.py # CRUD for color libraries + entries
│       ├── debug_io.py            # Debug image dumps (controlled by DEBUG_DUMP env)
│       └── storage.py             # FileStorage — save/delete, module-level singleton
├── tests/                # Pytest (sync/async mixed, module-level init patterns)
├── migrations/           # Alembic schema migrations
├── uploads/              # Runtime uploaded images (gitignored)
├── environment.yml       # Conda env definition (Python 3.10, deps for inference runtime)
├── requirements.txt      # pip mirror of environment.yml for Docker
├── Dockerfile
├── alembic.ini
└── bead_app.db           # SQLite dev DB — should be gitignored (anti-pattern)
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Add new API endpoint | `app/api/blueprints.py` or `app/api/colors.py` | Follow `Depends(get_db)` pattern |
| Add new DB model | `app/models/` | Use `Base`, `TimestampMixin`, `Mapped`/`mapped_column` |
| Add new schema | `app/schemas/` | Pydantic v2 `BaseModel`, `ConfigDict(from_attributes=True)` |
| Modify image pipeline | `app/services/bead_parser.py` + `app/services/pipeline/` | OCR-based: `BlueLineGridDetector` → `EasyOcrCodeReader` (or other engine via `OCR_ENGINE`) → color lookup |
| Switch OCR engine | `app/services/bead_ocr.py` | Set `OCR_ENGINE` env var: `easy` / `template` / `deepseek` / `crnn` |
| Train a new CRNN | `training/scripts/train_crnn.py` | Writes `.pt` to `training/checkpoints/`; backend picks it up via `CRNN_MODEL_PATH` |
| Debug grid detection | `app/services/bead_grid_detector.py` or `app/services/pipeline/blue_line_grid_detector.py` | Pipeline wrapper calls into low-level |
| Debug per-cell OCR | `app/services/bead_ocr_*.py` (one per engine) | Each engine has its own module |
| Add migration | `migrations/versions/` | `alembic revision --autogenerate -m "desc"` |
| Debug/test endpoint | `tests/` | 15 pytest files; conftest.py with session fixtures, sqlite+aiosqlite test DB |

## CONVENTIONS

- **Models**: PascalCase classes, snake_case table names (plural)
- **Schemas**: PascalCase with suffix (`ColorEntryCreate`, `BlueprintDetailResponse`)
- **Services**: snake_case files, async functions, imported as `import app.services.X as svc`
- **API routes**: `APIRouter` with `prefix` and `tags`, response_model in decorator
- **DB dependency**: `Depends(get_db)` in all route handlers
- **Error handling**: `HTTPException` with status codes (400/404/409/413/500)
- **OCR engines are pluggable** — each `bead_ocr_<engine>.py` exposes a `ocr_cells_from_crop_<engine>(...)` function with the same signature, dispatched by `bead_ocr.py` based on `OCR_ENGINE` setting
- **Pipeline is pluggable** — `pipeline/interfaces.py` defines `GridDetector` and `CodeReader` Protocols; `pipeline/{blue_line_grid_detector,easy_ocr_code_reader}.py` are reference implementations

## ANTI-PATTERNS

- **No `__main__.py`** — can't run via `python -m app`
- **Mixed sync/async tests** — `httpx.AsyncClient` vs `TestClient` inconsistency across files
- **Module-level DB init** in tests — `asyncio.run(_init_db())` at import time in `test_api_upload.py`, `test_api_blueprints.py`
- **Hardcoded test image paths** — `tests/test_ocr_easy.py` references `training/data/real/stand/拼豆日记...jpg` (a specific real image; tests will fail if you don't have it locally)
- **Silent fallback** — `except Exception: db.rollback()` in `blueprints.py` upload handler swallows error details
- **DB file committed** — `bead_app.db` should be in `.gitignore` (currently tracked)
- **No centralized error codes** — ad-hoc `HTTPException` status codes, no error enum
- **`bead_ocr_crnn_inference.py` is the only engine that loads trained weights** — others are heuristic. If you swap `OCR_ENGINE=crnn`, the checkpoint at `CRNN_MODEL_PATH` must exist or you'll get `FileNotFoundError` at first OCR call

## COMMANDS

```bash
# Start backend
conda activate bead-app
cd backend && uvicorn app.main:app --reload --port 8000

# Run tests
cd backend && pytest -v

# Migrations
cd backend && alembic upgrade head
cd backend && alembic revision --autogenerate -m "description"

# Docker (postgres + backend; frontend NOT included)
docker-compose up -d backend
```

## NOTES

- DB URL defaults to `postgresql+asyncpg://admin:123456@localhost:5432/bead_app`
- `seed_default_colors()` runs in lifespan — idempotent
- Upload dir: `backend/uploads/`, max 20MB, JPEG/PNG only
- Alembic `env.py` uses `render_as_batch=True` (SQLite-compatible)
- `data/default_colors.json` is the **single source of truth** for the Perler palette — read by both `app/services/seed.py` (runtime seed) and `training/models/synth_generator.py` + `training/models/bead_ocr_vlm.py` (training/vocab generation). Both training-side readers resolve the path relative to the repo root (`Path(__file__).resolve().parent.parent.parent / "backend" / "app" / "data" / "default_colors.json"`).
- 2 parent-child model pairs: Blueprint→BlueprintCell, ColorLibrary→ColorEntry
- `CRNN_MODEL_PATH` default: `"../training/checkpoints/crnn_v2.pt"` (relative to `backend/app/`)