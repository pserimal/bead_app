# BACKEND TESTS

**Updated:** 2026-07-12

## OVERVIEW

15 pytest files (~1422 lines) with mixed sync/async patterns. Uses `conftest.py` for session-scoped fixtures with SQLite in-memory DB. Some files do module-level DB init via `asyncio.run()` — anti-pattern. No `pytest.ini`; config via env vars.

## STRUCTURE

```
tests/
├── conftest.py                 # Session-scoped fixtures, sqlite+aiosqlite://, creates tables + seeds colors
├── __init__.py                 # Package marker
├── test_api_upload.py          # Upload endpoint tests, module-level init, TestClient (139 lines)
├── test_api_blueprints.py      # Blueprint CRUD tests, module-level init, in-memory DB (84 lines)
├── test_api_colors.py          # Color endpoint tests, pytest-asyncio, AsyncClient (103 lines)
├── test_app.py                 # Health check, TestClient (9 lines)
├── test_color_card_detector.py # OpenCV synthetic images, /tmp/ paths (154 lines)
├── test_color_extractor.py     # PIL synthetic images, tempfile, sys.path hack (122 lines)
├── test_color_matcher.py       # Pure unit tests, CIEDE2000 color matching (139 lines)
├── test_db.py                  # DB connection test
├── test_models.py              # Model creation/query tests
├── test_parser.py              # BlueprintParser pipeline test
├── test_seed.py                # Seed function test
├── test_storage.py             # FileStorage save/delete test
└── test_ws.py                  # WebSocket test
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Add test fixture | `conftest.py` | Session-scoped, sets `DATABASE_URL` env var, creates all tables |
| Test new API endpoint | `test_api_*.py` | Match existing router: follow `Depends(get_db)` pattern |
| Test image processing | `test_color_*.py` | Uses synthetic images (PIL/OpenCV), not real files |
| Test DB models | `test_models.py` | Tests CRUD operations on all 4 models |
| Test pipeline | `test_parser.py` | End-to-end BlueprintParser test with image fixture |

## CONVENTIONS

- **No `pytest.ini`** — config via `DATABASE_URL` env var set in `conftest.py`
- **SQLite for tests** — `sqlite+aiosqlite://` in-memory or temp file, not PostgreSQL
- **Session-scoped fixtures** — DB tables created once per session, shared across test files
- **Seed on session start** — `conftest.py` seeds `default_colors.json` into color library
- **Synthetic test images** — generated via PIL (`Image.new`) or OpenCV (`np.zeros`), no real files
- **`/tmp/` for temp files** — color card detector tests write to `/tmp/`

## ANTI-PATTERNS

- **Mixed async clients** — some files use `httpx.AsyncClient` (pytest-asyncio), others use `TestClient` (sync)
- **Module-level DB init** — `asyncio.run(_init_db())` at import time in `test_api_upload.py`, `test_api_blueprints.py`
- **Module-level teardown** — manual `atexit.register(cleanup)` instead of pytest fixtures
- **Hardcoded image paths** — some tests reference `dou_tu_example.jpg` not in repo
- **No error detail assertion** — tests check status codes but not error message structure
- **`sys.path` manipulation** — `test_color_extractor.py` modifies `sys.path` to import app modules

## COMMANDS

```bash
# Run all tests
cd backend && pytest -v

# Run specific test file
cd backend && pytest tests/test_api_upload.py -v

# Run with coverage (if pytest-cov installed)
cd backend && pytest --cov=app --cov-report=term-missing

# Run async-only tests
cd backend && pytest -v -k "async"
```

## NOTES

- DB tables created via `Base.metadata.create_all` in conftest, not Alembic migrations
- `conftest.py` sets `os.environ["DATABASE_URL"]` before any imports of `app.db`
- Color seeder runs on every test session start (idempotent)
- Temp file DB deleted in `atexit` handler for files using module-level init
- `test_ws.py` exists but WebSocket endpoint may not be fully implemented
