# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. The authoritative knowledge base is **AGENTS.md** — read it first; this file is the one-screen summary.

## What this is

AI拼豆助手 (ai_dou) — Perler bead pattern recognition app. Users upload a photo of a bead board, crop the grid region, set rows/cols; the system OCRs the alphanumeric bead codes printed in each cell, looks them up in a bead color library, and produces a read-only bead blueprint.

**2026-08-15: the Kotlin cloud backend (`server/` Spring Boot + `image_service/` Python FastAPI) was removed. The runtime is now a single Rust binary.**

Top-level parts:

- **`local_server/`** — Rust single-binary runtime: axum API + SQLite + ONNX Runtime OCR + serves the React frontend **from disk** (`release/dist/` — replacing files takes effect immediately, no recompile). LAN deployment via `build-release.bat` → `release/` → `start-local.bat` (auto-opens browser) / `stop-local.bat`
- **`frontend/`** — React/Vite SPA; talks to `/api/v1` same-origin (dev: Vite proxy → `:8080`)
- **`training/`** — Python CRNN training + annotation + model publishing (dev-time only)
- **`ocr_core/`** — Python OCR core shared by training/export (charset, CRNN arch, inference reference). Rust runtime does its own inference via ONNX.
- **`artifacts/`** — model artifacts (`model.pt` + `model.onnx` dual outputs) + color library snapshot

## Architecture (one-screen mental model)

```
[ Browser (本机/局域网) ]  http://<IP>:8080
        ▼
[ bead-local-server.exe ]
        ├─ axum /api/v1/* ──▶ SQLite (data/bead-local.db, WAL)
        ├─ static assets    ──▶ disk dist/ (frontend/dist → release/dist, hot-swap, no recompile)
        └─ OCR worker       ──▶ ONNX Runtime (model.onnx), in-process thread
```

**Recognition flow**: upload → `POST /api/v1/jobs` (multipart) → job created (PENDING, JOB_STARTED) → in-process OCR worker decodes cells → per-cell `CELL_PROCESSED` events through the same idempotent `apply_event` path as the (kept) `/internal/jobs/{id}/events` endpoint → `JOB_SUCCEEDED` atomically creates the Blueprint. Frontend polls via React Query (2s).

**Event policy**: events are in-flight tracking data — capped at 200 while running, deleted entirely at terminal state (blueprint holds results). Compact (`VACUUM + wal_checkpoint(TRUNCATE)`) runs after jobs finish to keep the db file small.

## Key contracts

- `/api/v1` DTOs mirror `frontend/src/types/api.ts` (007: camelCase, PageResponse/ApiError/JobDetail/BlueprintDetail). Keep `local_server/src/models.rs` and the frontend types aligned.
- Crop math contract (10% inset) exists in two implementations: `local_server/src/export.rs` (crop_rect) and the frontend CellThumb preview — see `docs/crop-math.md`.
- Model acceptance gate: `training/scripts/eval_acceptance.py` (fixed benchmark, 0.005 tolerance; accepts .pt or .onnx) + Rust-side `local_server/src/bin/bench_acceptance.rs` (hardcoded reference values).
- Color library: runtime seed `data/default_colors.json` (mard 291, `#` stripped) + OCR vocabulary `artifacts/colors/library.json`.

## Commands (quick)

```bash
# Rust runtime
cd local_server && ORT_DYLIB_PATH=<onnxruntime.dll> cargo run        # :8080
ORT_DYLIB_PATH=<...> cargo test                                      # 21 tests
ORT_DYLIB_PATH=<...> cargo run --release --bin bench_acceptance      # gate

# Release pack (frontend build + exe + DLL + data + models → zip)
# NOTE: frontend is NOT embedded — served from disk; hot-swap = copy frontend/dist over release/dist
cd frontend && npm run build
cd local_server && cmd /c build-release.bat                          # → bead-local-server-v0.1.0.zip

# Dev frontend
cd frontend && npm run dev                                           # :5173 → :8080 proxy

# Training (conda env bead-train, repo root)
python -m training.scripts.train_crnn ...
python -m training.scripts.export_onnx --checkpoint <pt> --out-dir <artifact> --verify
python -m training.scripts.eval_acceptance --candidate <pt|onnx> --production <current>
```

## Pitfalls (top 5)

1. MinGW `link` shadows MSVC linker — `.cargo/config.toml` pins linker + LIB (Windows SDK 26100)
2. ort uses `load-dynamic` + `api-23`; set `ORT_DYLIB_PATH` to the 1.23.2 DLL (same core as Python reference); ship DLL next to exe
3. Numerical parity rules: batch 128, uint8-quantized input (round→u8→/255), INTER_AREA = weighted area average
4. `.bat` files must be CRLF; `"%OUT%\data\"` trailing backslash breaks copy; `taskkill //PID` in Git Bash
5. SQLite deletes don't shrink files — always `compact()` (VACUUM + checkpoint) after pruning

Full details, env pitfalls, and the history of architecture decisions: **AGENTS.md** + `.scratch/spring-kotlin-python-rewrite/` (wayfinder tracker, incl. the 2026-08-15 Kotlin removal decision).
