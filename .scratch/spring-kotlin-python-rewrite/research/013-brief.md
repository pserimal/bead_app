# Research: Docker Compose 服务拓扑、健康检查与恢复 (ticket 013)

**State:** research brief (does not close ticket 013)
**Source decisions:** 002, 004, 005, 006 (full text read); 007–010 (parent-provided resolution summaries — see Gaps); 013 (ticket).
**Grounding inspected:** `docker-compose.yml` (current), `backend/app/main.py` (lifespan + old `/api/health`), `backend/app/config.py` (env surface), `backend/Dockerfile`, `backend/requirements.txt`, `backend/.env.example`, `training/README.md`, `000-map.md`, `AGENTS.md` (anti-patterns).

---

## Summary

The new compose v2 stack has exactly one host-exposed HTTP service: **spring-boot (public, :8080)**. **postgres** and **python-crnn** are internal-only, on a private network, never published to the host (002/005). Startup gating is a one-way chain — `postgres → spring-boot` via `service_healthy`; `python-crnn` is a soft downstream with no hard dependency, because ticket 008's recovery sweep (90s stale heartbeat, retry max 2) and ticket 009's callback backoff (1s..16s) already make the system resilient to python downtime — `depends_on` orders startup, it does not supervise runtime. Runtime recovery is owned by `restart: unless-stopped` + the app-level protocols in 004/008/009, not by compose dependencies.

---

## Findings

1. **Current compose anti-patterns to drop** — the live `docker-compose.yml` hardcodes `admin:123456`, publishes `5432` and `8000` to the host, bind-mounts `./backend:/app` with `uvicorn --reload`, pins nothing (`postgres:16` unpinned), and has no `restart` policy and no `start_period` on its healthcheck. All of these violate the new decisions (002 internal-only python, 005 DB/storage owned by spring, AGENTS.md "Hardcoded DB credentials" anti-pattern). [docker-compose.yml](file:docker-compose.yml), [AGENTS.md](../AGENTS.md)

2. **Service boundary per decisions** — python keeps only CRNN inference as an internal FastAPI service (002: "只供 Spring Boot 调用…内部服务…不暴露给宿主机"); its DB/asyncpg/SQLAlchemy/EasyOCR/ultralytics dependencies die with the old backend (001). Spring Boot owns PostgreSQL and original image storage (005); python keeps only temp copies. [002-python-crnn-service-and-training-assets.md](../issues/002-python-crnn-service-and-training-assets.md), [005-data-color-snapshot-and-deployment.md](../issues/005-data-color-snapshot-and-deployment.md)

3. **The 004/008/009 recovery protocol is the real supervisor** — `depends_on` cannot recover a crashed container; it only orders startup. The system's correctness under python/postgres restarts comes from: heartbeat staleness (90s) + recovery sweep re-dispatch + retry max 2 (008), callback/idempotency by `jobId + attempt + sequence` (004), and python callback backoff 1s..16s (009). Compose's job is just: restart crashed containers (`restart:`), gate first boot (`depends_on` + healthchecks), and keep data in named volumes. [004-recognition-job-progress-and-trace.md](../issues/004-recognition-job-progress-and-trace.md), [013-compose-runtime-recovery.md](../issues/013-compose-runtime-recovery.md)

4. **No circular dependency is possible if python never hard-depends on spring** — spring does not need python healthy to boot (jobs sit in `PENDING`; the sweep re-dispatches after python returns). python needs spring reachable only when it processes a task (callback URL `http://spring-boot:8080`, 009). Therefore `python-crnn` should depend on `spring-boot` with at most `condition: service_started`, and `spring-boot` should depend on nothing but `postgres: service_healthy`. A spring→python `service_healthy` gate would delay spring startup by python's torch cold start (30–90s) for zero correctness gain, and risks a startup deadlock if either ever adds a back-dependency. [009 resolution summary (parent context)], [013-compose-runtime-recovery.md](../issues/013-compose-runtime-recovery.md)

5. **Healthcheck shapes** — postgres: `pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"` (use `$$` escaping so the *container* env is read, not compose interpolation). spring-boot: `spring-boot-starter-actuator` (version follows the Spring Boot BOM), healthcheck hits `http://localhost:8080/actuator/health` and greps for `"status":"UP"` — the endpoint already includes a DataSource health contributor when JDBC/JPA are present, making it a truthful Flyway+DB readiness gate; `curl` (or busybox `wget`) must be present in the runtime image (temurin-alpine ships busybox wget). python-crnn: `/health` returns `{"status":"ok","model_ready":true,...}` and `/health/model` returns artifact metadata (model_id, charset hash, `code_dict_version` per 010); healthcheck greps for `"model_ready":true`. Best-practice interval/timeout/retries/start_period: postgres 5s/3s/10/10s; spring 10s/5s/12/60s (JVM + Flyway); python 10s/5s/6/60s (torch import + checkpoint load). Rationale: `start_period` prevents false crash-loop detection during cold starts; intervals of 5–10s keep healthcheck cost negligible.

6. **Model artifact mount** — per 010 the artifact is an *immutable directory* (not a single `.pt` path like the old `CRNN_MODEL_PATH`), mounted `:ro` into python at `MODEL_ARTIFACT_DIR=/models`; per 005 local dev mounts a checkpoint read-only. The bind source is host path `./artifacts/models` by default, overridable to `./training/checkpoints` for local dev (005: "本地开发可只读挂载 checkpoint"). The old `CRNN_MODEL_PATH`/`../training/checkpoints/crnn_v2.pt` convention dies with the old config surface. [010 resolution summary (parent context)], [005-data-color-snapshot-and-deployment.md](../issues/005-data-color-snapshot-and-deployment.md), [training/README.md](../../../training/README.md)

7. **Postgres data dir + image** — `postgres:16-alpine`, data at `/var/lib/postgresql/data` (correct for PG16; note PG18 moved PGDATA). Pin a minor (`16.x-alpine`) and optionally a digest at implementation time. 16-alpine is small (~80MB compressed) and matches the current `postgres:16` choice. Publish `5432` only via a dev override, never in the base file.

8. **Local dev** — frontend stays on the host (`npm run dev`, :5173), Vite proxies `/api` → `http://localhost:8080`; spring must CORS-allow `http://localhost:5173` (and `http://127.0.0.1:5173`) and the current *hardcoded* CORS origin should become env-configurable (AGENTS.md anti-pattern). A `docker-compose.override.yml` (dev) publishes 5432 for psql/IDE, optionally publishes python 8000 for debugging, bind-mounts uploads for inspection, sets `SPRING_PROFILES_ACTIVE=dev`, and points `MODEL_ARTIFACT_HOST_DIR` at `./training/checkpoints` (:ro). Spring devtools/hot-reload is out of scope (task statement).

---

## Recommended compose topology

### `docker-compose.yml` (sketch)

```yaml
# Compose v2 — bead-app rewrite topology. Secrets come from .env (never committed).
# Frontend runs on the host (npm run dev :5173) and reaches Spring via published :8080.
name: bead-app

services:
  postgres:
    image: postgres:16-alpine            # pin minor + digest at implementation time
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:?set in .env}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set in .env}   # never hardcoded
      POSTGRES_DB: ${POSTGRES_DB:-bead_app}
    volumes:
      - pgdata:/var/lib/postgresql/data  # PG16 data dir
    # no `ports:` — internal only; dev publishes 5432 via docker-compose.override.yml
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  spring-boot:
    build: ./services/spring-boot        # Kotlin service, Gradle multi-stage build
    restart: unless-stopped
    ports:
      - "8080:8080"                      # sole host-exposed HTTP port (007 external /api/v1)
    environment:
      SPRING_DATASOURCE_URL: jdbc:postgresql://postgres:5432/${POSTGRES_DB:-bead_app}
      SPRING_DATASOURCE_USERNAME: ${POSTGRES_USER}
      SPRING_DATASOURCE_PASSWORD: ${POSTGRES_PASSWORD}
      APP_CALLBACK_BASE_URL: http://spring-boot:8080        # 009: callbackUrl in compose
      APP_PYTHON_BASE_URL: http://python-crnn:8000          # 009: dispatch target
      MANAGEMENT_ENDPOINT_HEALTH_PROBES_ENABLED: "true"     # actuator liveness/readiness
      MANAGEMENT_ENDPOINTS_WEB_EXPOSURE_INCLUDE: health,info
      APP_CORS_ORIGINS: ${APP_CORS_ORIGINS:-http://localhost:5173,http://127.0.0.1:5173}
    volumes:
      - spring-uploads:/app/uploads      # 005: Spring owns original images
    depends_on:
      postgres:
        condition: service_healthy       # Flyway + pool need a live DB
    networks: [frontend, internal]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8080/actuator/health | grep -q '\"status\":\"UP\"'"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 60s                  # JVM boot + Flyway + Hikari pool warm-up

  python-crnn:
    build: ./services/python-crnn        # FastAPI, CRNN inference only (002)
    restart: unless-stopped
    # no `ports:` — internal-only, never exposed to host (002)
    environment:
      MODEL_ARTIFACT_DIR: /models        # 010: immutable artifact directory
      OCR_ENGINE: crnn
      OCR_MIN_CONF: ${OCR_MIN_CONF:-0.5}
      CALLBACK_URL: http://spring-boot:8080                  # 009: POST /internal/jobs/{jobId}/events
    volumes:
      - ${MODEL_ARTIFACT_HOST_DIR:-./artifacts/models}:/models:ro   # 010 :ro; dev → ./training/checkpoints
      - python-tmp:/tmp/ocr              # 005: temp copies only, survives restarts for debugging
    depends_on:
      spring-boot:
        condition: service_started       # soft courtesy only; 008/009 own outage resilience
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:8000/health | grep -q '\"model_ready\":true'"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 60s                  # torch import + CRNN checkpoint load

networks:
  frontend:    # host-reachable: spring :8080 published here
  internal:    # no host exposure: postgres + python-crnn (+ spring backend traffic)

volumes:
  pgdata:
  spring-uploads:
  python-tmp:
```

### `.env` (repo root, gitignored; ship a `.env.example`)

```
POSTGRES_USER=bead
POSTGRES_PASSWORD=<long-random-string>      # anti-pattern admin:123456 must die
POSTGRES_DB=bead_app
MODEL_ARTIFACT_HOST_DIR=./artifacts/models  # local dev: ./training/checkpoints
OCR_MIN_CONF=0.5
APP_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
```

### Networks & ports rationale

- `internal`: postgres + python-crnn only. python has **no** DB access by design (005: DB is Spring-owned; python keeps temp copies), so it only needs to resolve `spring-boot` — reachable because spring bridges both networks.
- `frontend`: only spring `:8080` published. This satisfies 002 ("not exposed to host") for python and 005 (DB is Spring-owned — don't hand host apps a DB port by default).
- Host loopback traffic: browser → `localhost:8080` (spring) and Vite → `localhost:8080` proxy. python is unreachable from the host in the base file.

### Startup/ordering rationale

1. `postgres` boots and passes `pg_isready` (5s polls, 10s grace).
2. `spring-boot` starts only after postgres is healthy → Flyway migrates against a live DB; actuator health then includes the DataSource contributor, so spring's healthcheck is a genuine "DB + app ready" signal.
3. `python-crnn` starts in parallel-with-spring (only gated on `service_started`, so it is *not* blocked by spring's 60s healthcheck window). It preloads the CRNN artifact at startup and flips `/health` `model_ready:true`; heartbeats/callbacks to spring retry with 1s..16s backoff (009) if spring isn't ready yet.
4. **spring does NOT wait for python.** Jobs enter `PENDING`; if dispatch POST fails because python is down, spring keeps the job `PENDING` and retries dispatch with backoff — connection errors must **not** consume the 008 attempt budget (attempts are for OCR/processing failures). Once python is healthy, the sweep/next dispatch picks the job up.
5. Answer to the ticket's question ("does spring depend on python healthy?"): **no** — spring is deliberately resilient to python being down (008 sweep re-dispatches after 90s stale heartbeat; retry max 2). A hard dependency would convert a recoverable python outage into a blocked stack and slow spring cold start for nothing. The only hard gate is `postgres → spring`.

### Recovery matrix (what happens on each failure)

| Failure | Effect | Recovery mechanism |
|---|---|---|
| postgres down at first boot | spring exits (Flyway fails) | `depends_on: service_healthy` re-gates boot; `restart: unless-stopped` retries until postgres healthy |
| postgres crashes at runtime | HikariCP borrow errors; in-flight jobs fail | pool reconnects on next borrow — **no container restart needed**; failed jobs retried per 008 (max 2); Flyway runs only at startup |
| python-crnn crashes mid-job | heartbeats stop → stale after 90s | `restart: unless-stopped` restarts it (stateless, trivially restartable per 005); sweep re-dispatches (attempt ≤ 2); duplicate events dropped via `jobId+attempt+sequence` idempotency (004) |
| python-crnn down at dispatch | spring POST /v1/tasks fails | job stays `PENDING`; dispatch retried with backoff; attempt budget reserved for real failures (008) |
| spring-boot crashes | API down; python callbacks fail | `restart: unless-stopped`; python retries callbacks/heartbeat 1s..16s (009) and resumes; no data loss (all state in postgres) |
| host reboot | all containers stop | `unless-stopped` auto-restarts on daemon start; named volumes + bind mounts survive |
| `docker compose down` | containers gone | data persists in `pgdata`/`spring-uploads`; `up` restores stack — but the `./artifacts/models` bind source must exist or python fails healthcheck |

Key principle: **`depends_on` is a boot-order gate, not a supervisor.** Runtime recovery = `restart:` policy + the 004/008/009 application protocols. Keep it that way; don't try to encode supervision into `depends_on`.

### Local-dev notes

- Frontend: `npm run dev` on host (:5173); Vite proxy `/api` → `http://localhost:8080`; spring CORS allows `localhost:5173` + `127.0.0.1:5173` (env-configurable, not hardcoded as in the old `main.py`).
- Model: default `MODEL_ARTIFACT_HOST_DIR=./artifacts/models`; for dev point it at `./training/checkpoints` (contains `crnn_v2.pt`) — read-only bind, per 005/010. The artifact dir should carry model + metadata (charset hash, `code_dict_version`) as decided in 010.
- `docker-compose.override.yml` (dev-only, gitignored): publish `5432:5432` for psql/IDE, optionally publish `8000:8000` for python debugging, bind-mount `spring-uploads` for inspection, `SPRING_PROFILES_ACTIVE=dev`.
- Spring devtools/hot-reload: out of scope; python changes require `docker compose build` + restart.
- Old backend's `/api/health` (`{"status":"ok","version":"1.0.0"}`) is superseded: spring uses actuator, python uses `/health` + `/health/model`. The old `backend` service (FastAPI + SQLAlchemy + EasyOCR + `--reload` bind mount) is retired entirely (001).

### What the current `docker-compose.yml` must NOT carry over

1. Hardcoded `admin:123456` → env-injected secrets (AGENTS.md anti-pattern).
2. `./backend:/app` bind mount + `uvicorn --reload` → image copies code; no reload in compose.
3. Published `5432:5432` and `8000:8000` → internal only (002/005); dev override if needed.
4. Unpinned `postgres:16` → `postgres:16-alpine` + minor pin.
5. Missing `restart:` policies → `unless-stopped` on all three services.
6. Healthcheck without `start_period` → add (cold starts otherwise false-trigger restart loops).
7. Single flat default network → explicit `frontend`/`internal` split.
8. Old backend dependencies (SQLAlchemy/asyncpg/EasyOCR/ultralytics/alembic) in the python image → python-crnn image is FastAPI + `ocr_core` + torch-CPU + httpx only (002: EasyOCR/Paddle/template/deepseek deleted).

---

## Sources

- **Kept:**
  - `issues/013-compose-runtime-recovery.md` — the ticket being researched.
  - `issues/002-python-crnn-service-and-training-assets.md` — python internal-only, CRNN inference only.
  - `issues/004-recognition-job-progress-and-trace.md` — job lifecycle, idempotency (`jobId+attempt+sequence`), stale heartbeat, retry.
  - `issues/005-data-color-snapshot-and-deployment.md` — spring owns DB/storage, python temp copies, first version compose, read-only model mount.
  - `issues/006-frontend-and-api-scope.md` — frontend on host, React Query polling, `/api/v1`.
  - `docker-compose.yml` (current) — baseline to be replaced; anti-pattern inventory.
  - `backend/app/main.py`, `backend/app/config.py`, `backend/Dockerfile`, `backend/requirements.txt`, `backend/.env.example` — old env surface being replaced.
  - `training/README.md` — checkpoint layout, lazy-load convention, `CRNN_MODEL_PATH` to be superseded by `MODEL_ARTIFACT_DIR`.
  - Best-practice references (knowledge-based, no live web in this environment): Docker Compose spec `healthcheck`/`depends_on`/`restart`, Spring Boot Actuator health/probes, official postgres image `pg_isready` + PG16 PGDATA path.
- **Dropped:** none (no web sources available in this run; see Gaps).

## Gaps

1. **No web tooling in this environment** — best-practice claims (compose `service_healthy`/`start_period` syntax, actuator dependency/version, `postgres:16-alpine` current digest, `spring-boot-starter-actuator` exact version for the chosen Boot BOM) are from established knowledge as of the brief date, not live-verified. Verify at implementation: pin Boot 3.x latest stable, postgres `16.x-alpine` + digest, and confirm the local `docker compose` supports `condition: service_healthy` (Compose spec ≥2.17 / Docker Engine ≥25).
2. **Ticket files 007–010 could not be located** — the `issues/` directory is not listable with available tools and filename guesses failed; their resolutions were taken from the parent's Context summary. Before implementation, re-read the actual files to confirm exact env var names (`MODEL_ARTIFACT_DIR`, `CALLBACK_URL`), protocol paths (`/v1/tasks`, `/internal/jobs/{jobId}/events`), and the 008 sweep/retry semantics that the recovery matrix relies on.
3. **Proposed endpoints** — `/health`, `/health/model` (with `model_ready`, charset hash, `code_dict_version`) are proposed shapes; the exact JSON contract is not yet decided (010 territory).
4. **Model preload vs lazy load is open** — `training/README.md` says the old backend loads checkpoints lazily on first OCR call; the `start_period: 60s` sizing assumes python preloads the artifact at startup so `model_ready` is truthful. Decide in 010's implementation and size `start_period` accordingly.
5. **Dispatch-retry semantics** — "connection errors must not consume the 008 attempt budget" is a recommendation, not yet a decision in 008's text (which the brief did not read in full).
