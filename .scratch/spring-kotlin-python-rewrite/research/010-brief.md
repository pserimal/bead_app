# Research Brief — Ticket 010: CRNN 训练推理共享核心与模型 artifact 边界

**Ticket:** `.scratch/spring-kotlin-python-rewrite/issues/010-crnn-runtime-artifact-boundary.md` (state: open, label: wayfinder:research)
**Scope:** Current-state investigation of the CRNN stack in this repo (no code changes made).
**Method:** Local codebase reading of every file in the training↔backend CRNN path. No web research needed — this is fully answerable from the repo.
**Alignment:** Answer feeds the map's "Not yet specified" item *训练/推理共享 OCR 核心模块的目录、checkpoint 元数据和模型 artifact 发布方式*, and must be consistent with closed decisions [002](https://placeholder/issues/002) (Python = internal CRNN-only service; training/inference share one standalone OCR core module; inference must not depend on old backend or training scripts) and [005](https://placeholder/issues/005) (Spring owns DB/files; color library + model delivered as snapshot/fixed artifact; first version Docker Compose; local dev may read-only mount checkpoint).

---

## Summary

The repo already has a single CRNN architecture module (`training/models/bead_ocr_crnn.py`) that is (a) imported lazily by the backend runtime, (b) imported by the training scripts, and (c) the only place the model class lives — there is **no duplication of the model architecture**, only duplication of the **charset/vocab constants** and of the **color-library loading**. But the cross-part import boundary is held together by ambient `sys.path` luck, the checkpoint format carries no version/compatibility metadata, and the runtime re-injects a *global* char→idx map (`synth_generator.CHAR_TO_IDX`, 37 tokens) over a checkpoint whose own `chars` field (≤14 tokens given the actual library codes) it never validates — a concrete latent crash/mis-decode hazard. The current `.pt` format is a bare dict `{state_dict, num_classes, chars}`. The default checkpoint `training/checkpoints/crnn_v2.pt` does **not exist in this worktree** (and `.gitignore` ignores all `training/checkpoints/*.pt` with no negation).

---

## Findings (evidence by file)

### 1. Checkpoint format & I/O — `training/models/bead_ocr_crnn.py`

- **Format:** `torch.save({"state_dict": model.state_dict(), "num_classes": int, "chars": list[str]}, path)` — exactly three keys, no version field, no arch id, no hyperparams, no charset hash, no code-dict version, no timestamp. (`save_checkpoint`, ~end of file)
- **Load:** `torch.load(path, map_location=device, weights_only=False)` → builds `CRNN(num_classes=ckpt["num_classes"])` with **hardcoded defaults** (`hidden=128`), `load_state_dict`, `.eval()`, then `set_char_index({ch: i for i, ch in enumerate(chars)})`. (`load_checkpoint`)
- **Architecture contract is implicit, not recorded:** input is hardcoded `(B, 1, 48, 48)`; the CNN stack collapses H 48→1 and W 48→6 (T=6 time steps); `blank=0` is hardcoded in both decoders. Any of these changing silently breaks loading or decoding; nothing in the checkpoint records them.
- **Global mutable state:** `_CHAR_TO_IDX: dict` is a module-level global mutated by `set_char_index()` — injected from *outside* the module (trainer sets it; inference entrypoint overrides it). `constrained_decode()` reads this global per-call.
- **Security note:** `weights_only=False` enables arbitrary pickle payloads (accepts legacy dict layout; flag as accepted risk or migrate to safetensors later).

### 2. Training / eval checkpoint usage — `training/scripts/train_crnn.py`, `training/scripts/eval_stand.py`

- `train_crnn.py` only **writes** checkpoints: `save_checkpoint(out_path, model, len(chars), chars)` on best validation EM. It never loads one → **no resume / fine-tune-from-checkpoint support today** despite the PLAN.md "fine-tune" roadmap.
- **Charset is NOT the synth CHARS table:** the vocab comes from `derive_vocab(real_codes + CODES)` = `["<blank>"] + sorted(letters) + sorted(digits)` (`train_crnn.py`). Because the actual library (`backend/app/data/default_colors.json`) only contains codes starting with **H, F, G** (65 entries: H1–H52, F1–F8, G1–G5 — verified), a checkpoint trained with current code has `num_classes = 1 + 3 + 10 = 14`, **not 37**. Synth samples whose letters aren't in the vocab are silently dropped (`kept X/Y synth ...`), so even `--synth-only` collapses to 14 classes unless real data adds letters.
- `eval_stand.py` does **not** load the checkpoint itself; it imports the backend runtime `from app.services.bead_ocr_crnn_inference import ocr_cells_from_crop_crnn` inside `main()` and relies on the `CRNN_MODEL_PATH` setting — i.e., the eval harness depends on the *old backend service* (the reverse of the intended boundary). It contains **no `sys.path` shim of its own**.
- `train_crnn.py` has the repo's only `sys.path` shim: inserts repo root so `training.*` resolves (lines ~30–34).

### 3. CHARS/CODES constants — `training/models/synth_generator.py`

- `CHARS = ["<blank>"] + "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "0123456789"` (37 tokens) and `CHAR_TO_IDX`/`IDX_TO_CHAR` are hardcoded here; **CODES is derived at import time** from `backend/app/data/default_colors.json` via `Path(__file__).resolve().parent.parent.parent / "backend" / "app" / "data" / "default_colors.json"`.
- **Duplication:** the same library JSON is independently loaded by at least 5 places: `synth_generator._load_library()`, `bead_ocr_vlm._load_library_codes()`, `bead_ocr._load_library_codes()`, `bead_parser._load_color_library()`, plus `derive_vocab` re-deriving the charset in `train_crnn.py`. The 37-token `CHARS` and the runtime-injected `CHAR_TO_IDX` only match checkpoints trained with the *old* 37-class flow — **they do not match checkpoints produced by the current `train_crnn.py`** (14-class, as shown above).
- `_random_code()` generates codes over full A–Z × 1–2 digits (docstring claims "training covers the full letter+digit space") — that claim is false under current `derive_vocab`, which filters to library letters.

### 4. Runtime wiring — `backend/app/services/bead_ocr_crnn_inference.py`, `bead_ocr.py`, `config.py`

- **Path resolution:** `Path(settings.CRNN_MODEL_PATH)` — resolved against **process CWD**, not the config file. Default `"../training/checkpoints/crnn_v2.pt"` only resolves correctly when uvicorn's CWD is `backend/` (per the documented `cd backend && uvicorn app.main:app`). From repo root it would resolve one level too high.
- **Lazy load:** module-global `_MODEL` cache; `_load_model()` raises `FileNotFoundError("CRNN checkpoint not found ...")` with a training hint if absent.
- **Charset/decoding wiring (the hazard):** per call it does `set_char_index(CHAR_TO_IDX)` (the **synth_generator 37-token map**) *after* `load_checkpoint` already set the checkpoint's own map, then `build_code_trie(CODES or valid_codes)` and `constrained_decode(logits, trie, blank=0)`. With a 14-class checkpoint, `logits[:, _CHAR_TO_IDX['H']=8]` etc. indexes out of range → `RuntimeError`/IndexError or, if sizes happen to align, mis-decode. **No validation anywhere that checkpoint charset == runtime charset.** This is the concrete compatibility gap the ticket asks about.
- **Per-call cost:** trie rebuilt on every invocation; cells processed in batches of 128; confidence = `exp(score / len(code))`; results filtered by `codes_set` and `min_conf`.
- **Dispatcher:** `bead_ocr.py` `ocr_cells_from_crop()` selects engine by `OCR_ENGINE` setting (easy/paddle/template/deepseek/crnn; default `easy`); `OCR_ENGINE=crnn` + `CRNN_MODEL_PATH` are env-configurable but **absent from `.env.example`** (only DATABASE_URL, UPLOAD_DIR).
- **Backend-module dependencies of the CRNN runtime (complete list):** `app.config.settings` (only backend module); `training.models.bead_ocr_crnn` (arch + I/O + decoders); `training.models.synth_generator` (CHAR_TO_IDX, CODES); third-party: torch, cv2, numpy. Nothing else.
- **Latent dead/broken branches found nearby (cleanup targets):** `bead_ocr.py::_parse_code` lazily imports `app.services.beader_ocr_easy` which **does not exist** (ENOENT verified; the real module is `bead_ocr_easy`); `OCR_ENGINE=="paddle"` branch imports `app.services.bead_ocr_paddle` which **does not exist** in the services tree. Both are `ImportError`-at-call-time bugs.

### 5. `training/checkpoints/` contents & gitignore

- Root `.gitignore` has `training/checkpoints/*.pt` with **no negation** (no `!training/checkpoints/crnn_v2.pt`), and there is no `training/checkpoints/.gitignore`. `training/README.md` claims "committed checkpoint is tracked / except crnn_v2.pt" — **contradicted by the ignore rules**.
- **`training/checkpoints/crnn_v2.pt` does not exist in this worktree** (ENOENT on direct read). No `README.md` in the dir either. Practical consequence: `OCR_ENGINE=crnn` in this checkout fails immediately with "CRNN checkpoint not found" until someone trains.
- File sizes are not verifiable without a shell (no CLI available in this environment).

### 6. Dependency manifests

- `backend/environment.yml` (conda env `bead-app`, python 3.10): **no torch/torchvision/easyocr** — comment says torch/torchvision are pip-installed separately. Includes fastapi, uvicorn, sqlalchemy, asyncpg, alembic, opencv, numpy, pillow, scipy, colour-science, pytest stack.
- `backend/requirements.txt` (docker backend): includes `onnxruntime`, `ultralytics`, `scikit-learn`, `easyocr` — **YOLO-era leftovers unrelated to the CRNN path** — and **no torch**, so the docker backend cannot run `OCR_ENGINE=crnn` at all.
- Runtime needs for CRNN: `torch` (imported by `bead_ocr_crnn_inference` and `bead_ocr_crnn`), `numpy`, `opencv`. **`torchvision` is never imported anywhere in the repo** (CLAUDE.md/AGENTS.md mention it, but no code uses it). Training additionally needs `PIL` (pillow) + fonts.

### 7. How the shared module is imported by the runtime (sys.path mechanics)

- Runtime does lazy `from training.models.bead_ocr_crnn import load_checkpoint` inside `_load_model()` and `from training.models.synth_generator import CHAR_TO_IDX, CODES` inside `ocr_cells_from_crop_crnn()`. **No `sys.path` manipulation in any backend file** (verified: `main.py`, `config.py`, `app/__init__.py`, `services/__init__.py` are all clean; the only shim in the repo is in `training/scripts/train_crnn.py`).
- Result: the documented invocations cannot satisfy both imports — from `backend/` (`uvicorn app.main:app`), `app` resolves but `training` does not (ModuleNotFoundError on first CRNN call); from repo root, `training` resolves but `app` does not. The runtime→training import therefore only works via undocumented ambient `PYTHONPATH`/env. `eval_stand.py` has the mirror problem (imports `app.*` from a training script).

---

## Dependency inventory (for the sever list)

| Direction | Edge | Evidence |
|---|---|---|
| runtime → training | `training.models.bead_ocr_crnn` (arch, load_checkpoint, decode) | `bead_ocr_crnn_inference.py` lazy imports |
| runtime → training | `training.models.synth_generator` (CHAR_TO_IDX, CODES) | same |
| runtime → backend | `app.config.settings` (CRNN_MODEL_PATH, OCR_MIN_CONF) | `bead_ocr_crnn_inference.py` |
| backend → runtime | `bead_ocr.py` dispatcher (engine=="crnn") → `bead_ocr_crnn_inference` | `bead_ocr.py` |
| backend → runtime | `bead_parser.py::_parse_via_crop_cells` → `bead_ocr.ocr_cells_from_crop` | `bead_parser.py` |
| training → backend | `eval_stand.py` imports `app.services.bead_ocr_crnn_inference` | `eval_stand.py::main` |
| training → backend | `synth_generator.py`, `bead_ocr_vlm.py` read `backend/app/data/default_colors.json` | `_LIB_PATH`/`_LIBRARY_PATH` |
| training → backend | `train_crnn.py` sys.path shim (repo root) | `train_crnn.py` lines ~30–34 |

---

## Recommendations

### R1 — Where the shared OCR core should live (one copy for training + Python image-service)

Create a **top-level standalone package `ocr_core/`** (sibling of `backend/`, `training/`, `frontend/`) owned by the Python image-service but importable by training:

```
ocr_core/
├── __init__.py            # __version__, public API (load_checkpoint, decode_cells, CHARSET_CONSTANTS)
├── charset.py             # CHARS/CHAR_TO_IDX/IDX_TO_CHAR + charset_hash() (single source of truth; delete the copies in synth_generator)
├── code_library.py        # loads the color-library snapshot artifact (NOT backend/app/data/default_colors.json)
├── bead_ocr_crnn.py       # CRNN class + save_checkpoint/load_checkpoint + ctc_greedy_decode/build_code_trie/constrained_decode (moved verbatim from training/models/)
└── inference.py           # crop → tensor → logits → constrained decode → {(r,c): (code, conf)} (what bead_ocr_crnn_inference.py does, minus app.config)
```

- **Move** `training/models/bead_ocr_crnn.py` → `ocr_core/bead_ocr_crnn.py` (single architecture, zero duplication today — keep it that way). Training imports `ocr_core`; the new internal Python service imports `ocr_core`; **neither imports the other**.
- **Delete** the charset constants from `training/models/synth_generator.py` and import from `ocr_core.charset` instead (or keep a deprecated alias re-export during transition, then remove).
- **Rationale (evidence):** runtime and training already both import the same architecture file; the failure points are (a) `sys.path` fragility (Finding 7) — solved by making `ocr_core/` a proper importable package (installable via `pip install -e` or added to PYTHONPATH by the compose service), and (b) duplicated charset/library constants (Finding 3) — solved by `ocr_core.charset` + snapshot-based `code_library.py`.
- Consistent with decision 002 ("训练和推理共享一个独立 OCR 核心模块，推理服务不依赖旧 backend 或训练脚本"). The old `backend/app/services/bead_ocr_crnn_inference.py` and `bead_ocr.py` dispatcher are deleted (R4), so `ocr_core` must not import `app.*`.

### R2 — Checkpoint metadata to add + load-time compatibility validation

Extend `save_checkpoint`/`load_checkpoint` payload (keep `weights_only=False` for now, or move to safetensors for the weights and a JSON manifest for metadata):

```
{
  "format_version": 1,            # schema evolution gate (hard)
  "model_arch": "crnn-v1",        # arch id, bumped on any arch change (hard)
  "num_classes": 14,              # hard: must equal len(chars)
  "hidden": 128,                  # hyperparams currently implied by defaults (hard: must match constructor)
  "input_size": [48, 48],         # hard: CNN geometry depends on it
  "input_channels": 1,            # hard
  "blank_index": 0,               # hard: decoders hardcode blank=0 today — record it so decoders can assert
  "chars": ["<blank>", "F", "G", "H", "0", ...],   # charset (hard)
  "charset_hash": "sha256:...",   # hash of chars (hard: == ocr_core.charset.charset_hash() at runtime)
  "code_dict_version": "sha256:...",  # hash of sorted CODES from the library snapshot (soft)
  "code_dict": [...],             # optional: embedded snapshot of the codes the model was trained on (soft)
  "created_at": "ISO-8601",       # soft
  "training": {"seed": 0, "epochs": 30, "style": "marked", "synth_n": 50000, "best_val_em": 0.95},  # soft, for provenance
  "state_dict": {...},
}
```

**Load-time check behavior (specify exactly):**
1. Load manifest keys first; if `format_version` missing → reject with `CheckpointFormatError` and message "checkpoint lacks format_version; retrain or migrate (old format = 3-key dict)".
2. Hard-fail (raise, refuse to serve) on any mismatch of: `model_arch`, `num_classes` vs `len(chars)`, `input_size`, `input_channels`, `blank_index`, and `charset_hash` vs the runtime's `ocr_core.charset` (this eliminates the 37-vs-14 crash from Finding 4 — the service must decode with the *checkpoint's own* charset, never re-inject a global table).
3. Soft-warn (log + expose in `/health/model` fingerprint, continue) on `code_dict_version` drift: model trained against a different library snapshot than the one the service currently serves → suggestion: re-publish the library snapshot matching the model, or retrain.
4. After load, sanity-check `state_dict` keys against the constructed architecture and `num_classes` (shape assertion) — belt-and-braces for silent arch drift.
5. Because `constrained_decode` currently reads the module-global `_CHAR_TO_IDX`, remove that global: pass `idx_to_char`/`char_to_idx` explicitly through decode calls (make decoders pure functions). This also fixes the concurrent-request shared-state smell.

### R3 — How training artifacts publish to the Python image-service at runtime

- **Publish step (offline, in training):** add `training/scripts/publish_checkpoint.py` (or `--publish` flag on `train_crnn`) that writes an **immutable, versioned artifact directory**:
  ```
  artifacts/models/<model_name>-<version>/          # e.g. crnn_v3-2026-07-12T10-00-00Z/
  ├── model.pt               # checkpoint with metadata from R2
  ├── charset.json           # {"chars": [...], "charset_hash": "..."} (also embedded in model.pt)
  ├── code_dict.json         # sorted CODES snapshot the model was trained on + hash
  └── manifest.json          # model_name, version, format_version, hashes, metrics, created_at
  ```
  Naming is **immutable** (never overwrite; version string unique); the service points at one artifact via env `MODEL_ARTIFACT_DIR` (and an optional `artifacts/models/current` symlink/pinned version for dev ergonomics).
- **Runtime consumption (deployment):** per decision 005, first version is Docker Compose with the model delivered as a **fixed artifact** — mount the chosen artifact directory **read-only** into the Python image-service container (`volumes: - ./artifacts/models/crnn_v3-...:/models:ro`), env `MODEL_ARTIFACT_DIR=/models`. Local dev keeps the same contract (no reliance on `../training/checkpoints/...` relative CWD — that path resolution bug from Finding 4 disappears).
- **Color-library snapshot:** the service's `ocr_core.code_library` loads `code_dict.json` from the same artifact (or a separately versioned `artifacts/colors/<lib>-<version>.json` snapshot). Spring Boot owns the canonical library (005); the Python service only ever sees a snapshot copy. The current `backend/app/data/default_colors.json` read path in `synth_generator.py`/`bead_ocr_vlm.py` is severed.
- Remove `CRNN_MODEL_PATH` from old `config.py` semantics entirely (replaced by `MODEL_ARTIFACT_DIR` in the new service's own config).

### R4 — Complete removal of old backend dependencies (sever list)

Delete/move, in dependency order:
1. `backend/app/services/bead_ocr_crnn_inference.py` — **delete**; its logic (crop→48×48 letterbox, batched inference, constrained decode, conf normalization) moves to `ocr_core/inference.py` with config injected (no `app.config`).
2. `backend/app/services/bead_ocr.py` — **delete** the dispatcher entirely (decision 002 deletes EasyOCR/PaddleOCR/template/DeepSeek anyway). Also fixes the two latent broken imports: `app.services.beader_ocr_easy` (nonexistent module) and `app.services.bead_ocr_paddle` (nonexistent module).
3. `backend/app/services/bead_parser.py` — `_parse_via_crop_cells` moves into the new Python image-service (calls `ocr_core.inference`); the legacy dict-shaping helpers die with the FastAPI service.
4. `training/scripts/eval_stand.py` — replace `from app.services.bead_ocr_crnn_inference import ocr_cells_from_crop_crnn` with `from ocr_core.inference import ocr_cells_from_crop` (or keep eval inside `training/` using `ocr_core` directly). Training must stop importing `app.*`.
5. `training/models/synth_generator.py` + `bead_ocr_vlm.py` — charset constants and library path replaced by `ocr_core.charset` + snapshot loader; remove `Path(...)/backend/app/data/default_colors.json` hardcoding.
6. `training/scripts/train_crnn.py` — the `sys.path` repo-root shim can be dropped once `ocr_core` is importable; switch `derive_vocab` to derive from `ocr_core.charset`/snapshot so training and inference share one vocab definition (fixes the 14-vs-37 divergence).
7. Dependency manifests: `backend/requirements.txt` drop `easyocr`, `onnxruntime`, `ultralytics`, `scikit-learn`, `colour-science`; new service requirements = `torch`, `numpy`, `opencv-python-headless`, `pillow` (training only), `fastapi`, `uvicorn`, `pydantic-settings`. `backend/environment.yml` torch/torchvision comment: add `torch` (CPU wheel default in compose), drop `torchvision` (never imported).
8. `backend/app/config.py` — `CRNN_MODEL_PATH`/`OCR_ENGINE` die with the old service; new service env: `MODEL_ARTIFACT_DIR`, `OCR_MIN_CONF` (keep as plain env), `MAX_WORKERS`.

**Regression check suggested for the rewrite (matches map's "不得退化" item):** before deleting old FastAPI, snapshot `eval_stand` OVERALL exact_match_rate and per-image numbers as the baseline; the new service must reproduce them bit-for-bit given the same checkpoint + crop logic (letterbox params, batch size, blank_penalty=2.0, min_conf=0.5).

---

## Sources (all local, read in this investigation)

- `training/models/bead_ocr_crnn.py` — arch, decoders, checkpoint I/O, global `_CHAR_TO_IDX`
- `training/scripts/train_crnn.py` — vocab derivation, save-on-best, sys.path shim
- `training/scripts/eval_stand.py` — backend import dependency
- `training/models/synth_generator.py` — CHARS/CODES, library path hardcode
- `training/models/bead_ocr_vlm.py` — library path hardcode (2nd copy)
- `training/README.md`, `training/docs/PLAN.md`, `CLAUDE.md`, `AGENTS.md`, `backend/app/services/AGENTS.md` — documented conventions vs observed reality
- `backend/app/services/bead_ocr_crnn_inference.py`, `bead_ocr.py`, `bead_parser.py`, `bead_ocr_deepseek.py`, `bead_ocr_easy.py` (dispatcher refs), `config.py`, `main.py`, `api/blueprints.py`
- `backend/app/data/default_colors.json` — verified actual codes: only letters H, F, G
- `backend/environment.yml`, `backend/requirements.txt`, `docker-compose.yml`, `.gitignore`, `.env.example`
- Tracker: `.scratch/spring-kotlin-python-rewrite/000-map.md`, `issues/002-...md`, `issues/005-...md`

## Gaps

- **File sizes / exact contents of `training/checkpoints/`** — no shell available; only verified `crnn_v2.pt` is absent (ENOENT). A second pass with `ls -la training/checkpoints` and `du` should confirm whether any `.pt` exists locally.
- **Runtime behavior of the 14-vs-37 indexing mismatch** was inferred from code (tensor out-of-range) — not executed. Running `ocr_cells_from_crop_crnn` on a locally trained checkpoint would confirm the exact failure mode.
- **Which checkpoint `crnn_v2.pt` was actually trained with** (old 37-class flow vs current derive_vocab) — unknowable from this worktree since the file is absent.
- `eval_stand`'s exact working invocation (which cwd/env makes both `app` and `training` importable) is unresolved from static reading — try `PYTHONPATH=backend:repo-root python -m training.scripts.eval_stand` during the rewrite and record the convention.
