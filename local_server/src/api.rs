//! axum HTTP API — mirrors the Kotlin controllers (`/api/v1/jobs`,
//! `/api/v1/blueprints`, `/api/v1/colors`) + the internal event endpoint.
//! The 007 contract (PageResponse/ApiError/JobDetail/...) is byte-identical.

use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::legend::{expand_bbox, parse_legend_box, validate_bbox, BoxWord, LegendBoxBbox};
use crate::models::*;
use crate::ocr::OnnxModel;
use crate::service::{ApiException, JobService};

/// Frontend build output served from disk (`dist/` next to the exe, or
/// `frontend/dist` when developing). Decoupled from the binary on purpose:
/// updating the frontend = replacing the dist directory, no recompile.
#[derive(Clone)]
pub struct Frontend {
    pub dist_dir: std::path::PathBuf,
}

impl Frontend {
    pub fn resolve(dist_dir: &str) -> Self {
        // env → exe-dir candidates (release layout: dist/) → cwd candidates
        if let Ok(v) = std::env::var("BEAD_DIST_DIR") {
            if !v.is_empty() {
                return Self { dist_dir: std::path::PathBuf::from(v) };
            }
        }
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default();
        for c in [dist_dir, "../frontend/dist"] {
            let p = exe_dir.join(c);
            if p.join("index.html").exists() {
                return Self { dist_dir: p };
            }
        }
        for c in [dist_dir, "frontend/dist"] {
            if std::path::Path::new(c).join("index.html").exists() {
                return Self { dist_dir: std::path::PathBuf::from(c) };
            }
        }
        Self { dist_dir: std::path::PathBuf::from(dist_dir) }
    }

    fn index_html(&self) -> Option<Vec<u8>> {
        std::fs::read(self.dist_dir.join("index.html")).ok()
    }
}

pub struct AppState {
    pub service: JobService,
    /// OCR model pool: up to MAX_CONCURRENT_JOBS slots, each an independent
    /// onnxruntime session — parallel inference for concurrent jobs. None
    /// when OCR is disabled (contract tests); workers only run when
    /// `auto_ocr` is set.
    pub model_pool: ModelPool,
    pub mard_codes: Vec<String>,
    pub uploads_dir: std::path::PathBuf,
    pub seed_version: String,
    /// Spawn the in-process OCR worker on job creation (disabled in tests,
    /// where events are delivered manually through /internal/jobs/...).
    pub auto_ocr: bool,
    pub frontend: Frontend,
    /// Model artifacts directory (`artifacts/models/` — scanned live on
    /// every /api/v1/models request, so dropping files in/out takes effect
    /// on the next page refresh, no restart).
    pub models_dir: std::path::PathBuf,
    /// Persisted active model id (data/model-current.txt).
    pub model_current_file: std::path::PathBuf,
    /// Legend text recognition engine (PP-OCRv5 rec). `None` when the model
    /// files are absent — legend endpoints then degrade to 503.
    pub legend_rec: Option<Arc<Mutex<crate::legend_ocr::LegendRecModel>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeta {
    pub id: String,
    /// Display name: manifest `model_name` if present, else the artifact
    /// dir name (id).
    pub name: String,
    pub arch: Option<String>,
    pub num_classes: Option<usize>,
}

/// Pool of OCR model slots. Each slot owns an onnxruntime session with a
/// bounded thread count; jobs round-robin a slot for the whole task, so at
/// most MAX_CONCURRENT_JOBS infer simultaneously (per-slot sessions keep
/// total CPU usage near the core count instead of oversubscribing).
///
/// Concurrency and per-session threads are derived from the machine's CPU
/// count (generic, not tuned for one box): max_concurrent = clamp(cores/4,
/// 1, 4), threads_per_session = clamp(cores/max_concurrent, 1, 8). Both can
/// be overridden via BEAD_MAX_CONCURRENT / BEAD_ORT_THREADS.
#[derive(Clone)]
pub struct ModelPool {
    slots: Arc<Vec<Mutex<Option<OnnxModel>>>>,
    active_id: Arc<Mutex<Option<String>>>,
    models_dir: Arc<std::path::PathBuf>,
    threads_per_session: usize,
}

impl ModelPool {
    pub fn new(models_dir: std::path::PathBuf) -> Self {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .max(1);
        let max_concurrent = std::env::var("BEAD_MAX_CONCURRENT")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n >= 1 && *n <= 8)
            .unwrap_or_else(|| (cores / 8).clamp(1, 4));
        let threads_per_session = std::env::var("BEAD_ORT_THREADS")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| *n >= 1 && *n <= 64)
            .unwrap_or_else(|| (cores / max_concurrent).clamp(1, 4));
        let slots = (0..max_concurrent)
            .map(|_| Mutex::new(None))
            .collect::<Vec<_>>();
        Self {
            slots: Arc::new(slots),
            active_id: Arc::new(Mutex::new(None)),
            models_dir: Arc::new(models_dir),
            threads_per_session,
        }
    }

    pub fn concurrency(&self) -> usize {
        self.slots.len()
    }

    pub fn active_id(&self) -> Option<String> {
        self.active_id.lock().unwrap().clone()
    }

    /// Set the activated artifact id; affects new workers only (jobs already
    /// running keep their slot's model).
    pub fn set_active(&self, id: String) {
        *self.active_id.lock().unwrap() = Some(id);
    }

    /// Round-robin acquire a slot, (re)loading the active model into it when
    /// stale (model switched or first use). Blocks while all slots are busy —
    /// this is the concurrency limiter.
    pub fn acquire_worker(&self) -> anyhow::Result<std::sync::MutexGuard<'_, Option<OnnxModel>>> {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let idx = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % self.slots.len();
        let mut slot = self.slots[idx].lock().unwrap();
        let active = self.active_id.lock().unwrap().clone();
        let stale = match &*slot {
            Some(m) => Some(m.artifact_id.clone()) != active,
            None => true,
        };
        if stale {
            if let Some(id) = active {
                let dir = self.models_dir.join(id);
                *slot = Some(OnnxModel::load_with_threads(&dir, self.threads_per_session)?);
            }
        }
        Ok(slot)
    }
}

impl AppState {
    /// Scan `models_dir` for artifacts (dirs containing model.onnx) and load
    /// their metadata from manifest.json.
    pub fn discover_models(models_dir: &std::path::Path) -> Vec<ModelMeta> {
        let mut metas = Vec::new();
        let Ok(entries) = std::fs::read_dir(models_dir) else {
            return metas;
        };
        for e in entries.flatten() {
            let dir = e.path();
            if !dir.is_dir() || !dir.join("model.onnx").exists() {
                continue;
            }
            let id = dir.file_name().unwrap_or_default().to_string_lossy().to_string();
            let (name, arch, num_classes) = match std::fs::read_to_string(dir.join("manifest.json")) {
                Ok(text) => {
                    let m: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                    (
                        m.get("model_name")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                            .unwrap_or_else(|| id.clone()),
                        m.get("model_arch").and_then(|v| v.as_str()).map(String::from),
                        m.get("num_classes").and_then(|v| v.as_u64()).map(|v| v as usize),
                    )
                }
                Err(_) => (id.clone(), None, None),
            };
            metas.push(ModelMeta { id, name, arch, num_classes });
        }
        metas.sort_by(|a, b| a.id.cmp(&b.id));
        metas
    }

    /// Activate a model by artifact id: load from disk, swap under the lock,
    /// persist the choice. In-flight jobs pick it up at their next batch.
    /// The registry is scanned live, so a freshly dropped-in artifact works
    /// immediately.
    pub fn activate_model(&self, id: &str) -> anyhow::Result<ModelMeta> {
        let meta = Self::discover_models(&self.models_dir)
            .into_iter()
            .find(|m| m.id == id)
            .ok_or_else(|| anyhow::anyhow!(ApiException::not_found("MODEL_NOT_FOUND", format!("模型不存在: {id}"))))?;
        // Probe-load to validate the artifact, then switch the pool's active
        // id — new jobs pick it up; in-flight jobs keep their slot's model.
        let dir = self.models_dir.join(id);
        let _probe = OnnxModel::load(&dir)?;
        self.model_pool.set_active(id.to_string());
        if let Some(parent) = self.model_current_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.model_current_file, id);
        Ok(meta)
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    // axum's default multipart body limit is 2MB — raise it to 32MB so
    // phone photos upload like on the Kotlin server (30MB app-level cap).
    let body_limit = DefaultBodyLimit::max(32 * 1024 * 1024);
    Router::new()
        .route("/api/v1/jobs", post(create_job).get(list_jobs))
        .route("/api/v1/jobs/{id}", get(job_detail).patch(rename_job))
        .route("/api/v1/jobs", delete(delete_jobs))
        .route("/api/v1/blueprints", get(list_blueprints))
        .route("/api/v1/blueprints/{id}", get(blueprint_detail).patch(update_blueprint_materials_config))
        .route("/api/v1/blueprints/{id}/cells", patch(update_blueprint_cells))
        .route("/api/v1/blueprints/{id}/image", get(blueprint_image))
        .route("/api/v1/blueprints/{id}/cells/export-corrections", get(export_corrections))
        .route("/api/v1/blueprints/{id}/cells/export-all", get(export_all_cells))
        .route(
            "/api/v1/blueprints/{id}/legend",
            get(get_blueprint_legend).post(save_blueprint_legend),
        )
        .route("/api/v1/blueprints/{id}/legend/export", get(export_blueprint_legend))
        .route("/api/v1/colors", get(list_colors))
        .route("/api/v1/colors/{code}", get(get_color))
        .route("/api/v1/models", get(list_models))
        .route("/api/v1/models/current", get(current_model))
        .route("/api/v1/models/{id}/activate", post(activate_model))
        .route("/api/v1/legend/box", post(legend_box))
        .route("/api/v1/legend/grid", post(legend_grid))
        .route_layer(body_limit)
        .fallback(serve_static)
        .with_state(state)
}

/// SPA static serving from the dist directory: exact files, unknown non-API
/// paths fall back to index.html (react-router), unknown API paths get the
/// standard JSON 404. index.html is served no-cache so frontend updates are
/// picked up immediately after replacing the dist directory.
async fn serve_static(
    State(state): State<Arc<AppState>>,
    uri: axum::http::Uri,
) -> Response {
    if uri.path().starts_with("/api/") || uri.path().starts_with("/internal/") {
        return ApiException::not_found("NOT_FOUND", format!("资源不存在: {}", uri.path())).into_response();
    }
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    // Prevent path traversal outside the dist dir.
    let rel = std::path::Path::new(path);
    if rel.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return (StatusCode::BAD_REQUEST, "bad path").into_response();
    }
    let file = state.frontend.dist_dir.join(rel);
    match std::fs::read(&file) {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&file).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], bytes).into_response()
        }
        Err(_) => {
            // SPA fallback for client-side routes — text/html + no-cache.
            match state.frontend.index_html() {
                Some(html) => (
                    [
                        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                        (header::CACHE_CONTROL, "no-cache"),
                    ],
                    html,
                )
                    .into_response(),
                None => (
                    StatusCode::NOT_FOUND,
                    format!("index.html not found in {:?}", state.frontend.dist_dir),
                )
                    .into_response(),
            }
        }
    }
}

// ── Error plumbing ───────────────────────────────────────────────────

impl IntoResponse for ApiException {
    fn into_response(self) -> Response {
        let err = ApiError {
            code: self.code.to_string(),
            message: self.message,
            details: None,
            trace_id: Some(Uuid::new_v4().to_string()),
        };
        (StatusCode::from_u16(self.status).unwrap(), Json(err)).into_response()
    }
}

fn to_api(e: anyhow::Error) -> ApiException {
    match e.downcast::<ApiException>() {
        Ok(api) => api,
        Err(other) => ApiException::new(500, "INTERNAL_ERROR", other.to_string()),
    }
}

// ── Query params ─────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct PageParams {
    pub page: Option<i64>,
    pub page_size: Option<i64>,
    pub sort_by: Option<String>,
    pub sort_dir: Option<String>,
    pub status: Option<String>,
    pub q: Option<String>,
    pub ids: Option<String>,
}

fn page_params(p: &PageParams, default_size: i64) -> (i64, i64) {
    let page = p.page.unwrap_or(1).max(1);
    let page_size = p.page_size.unwrap_or(default_size).clamp(1, 100);
    (page, page_size)
}

// ── DTO mappers ──────────────────────────────────────────────────────

pub fn job_to_detail(job: &Job) -> JobDetail {
    let error = if job.status == JobStatus::Failed && job.error_code.is_some() {
        Some(JobError {
            code: job.error_code.clone().unwrap(),
            message: job.error_message.clone().unwrap_or_default(),
        })
    } else {
        None
    };
    JobDetail {
        id: job.id,
        name: job.name.clone(),
        status: job.status,
        stage: job.stage,
        processed_cells: job.processed_cells,
        total_cells: job.total_cells,
        heartbeat_at: job.heartbeat_at,
        attempt: job.attempt,
        max_retries: job.max_retries,
        retry_count: job.retry_count,
        blueprint_id: job.blueprint_id,
        error,
        warnings: Vec::new(),
        snapshot: SnapshotInfo {
            model: job.model_snapshot.clone(),
            color_library_version: job.color_library_version.clone(),
        },
        created_at: job.created_at,
        updated_at: job.updated_at,
    }
}

fn job_to_summary(job: &Job) -> JobSummary {
    JobSummary {
        id: job.id,
        name: job.name.clone(),
        status: job.status,
        stage: job.stage,
        processed_cells: job.processed_cells,
        total_cells: job.total_cells,
        rows: job.rows,
        cols: job.cols,
        attempt: job.attempt,
        retry_count: job.retry_count,
        blueprint_id: job.blueprint_id,
        created_at: job.created_at,
        updated_at: job.updated_at,
    }
}

fn bp_cell_to_dto(c: &crate::models::BlueprintCell) -> BlueprintCellDto {
    BlueprintCellDto {
        row: c.row,
        col: c.col,
        code: c.code.clone(),
        status: c.status,
        color: c.color_code.as_ref().map(|cc| ColorDto {
            code: cc.clone(),
            name: c.color_name.clone().unwrap_or_default(),
            hex: c.color_hex.clone().unwrap_or_default(),
            brand: None,
        }),
        confidence: c.confidence,
        corrected_code: c.corrected_code.clone(),
        corrected_at: c.corrected_at,
    }
}

fn paged<T>(items: Vec<T>, page: i64, page_size: i64, total: i64) -> PageResponse<T> {
    PageResponse {
        items,
        page,
        page_size,
        total,
        total_pages: (total + page_size - 1) / page_size,
    }
}

// ── Jobs ─────────────────────────────────────────────────────────────

/// 007: create job from multipart (image + crop box + rows/cols + codes).
async fn create_job(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, ApiException> {
    let mut image: Option<(String, String, Bytes)> = None;
    let mut crop_box = CropBox { x: 0, y: 0, width: 0, height: 0 };
    let mut rows = 0i64;
    let mut cols = 0i64;
    let mut codes: Option<String> = None;
    let mut name: Option<String> = None;
    let mut legend: Option<Vec<LegendEntryDto>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiException::bad_request("INVALID_REQUEST", "multipart 解析失败"))?
    {
        match field.name().unwrap_or("").to_string().as_str() {
            "image" => {
                let filename = field.file_name().unwrap_or("image.jpg").to_string();
                let content_type = field.content_type().unwrap_or("").to_string();
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|_| ApiException::bad_request("INVALID_REQUEST", "图片读取失败"))?;
                image = Some((filename, content_type, bytes));
            }
            "cropBoxX" => crop_box.x = field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cropBoxX 无效"))?.trim().parse().map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cropBoxX 无效"))?,
            "cropBoxY" => crop_box.y = field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cropBoxY 无效"))?.trim().parse().map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cropBoxY 无效"))?,
            "cropBoxWidth" => crop_box.width = field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cropBoxWidth 无效"))?.trim().parse().map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cropBoxWidth 无效"))?,
            "cropBoxHeight" => crop_box.height = field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cropBoxHeight 无效"))?.trim().parse().map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cropBoxHeight 无效"))?,
            "rows" => rows = field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "rows 无效"))?.trim().parse().map_err(|_| ApiException::bad_request("INVALID_REQUEST", "rows 无效"))?,
            "cols" => cols = field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cols 无效"))?.trim().parse().map_err(|_| ApiException::bad_request("INVALID_REQUEST", "cols 无效"))?,
            "codes" => codes = Some(field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "codes 无效"))?),
            "name" => name = Some(field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "name 无效"))?),
            "legend" => {
                let text = field.text().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "legend 无效"))?;
                if !text.trim().is_empty() {
                    legend = match serde_json::from_str::<Vec<LegendEntryDto>>(&text) {
                        Ok(v) => Some(v),
                        Err(e) => return Err(ApiException::bad_request("INVALID_LEGEND", format!("legend 解析失败: {e}"))),
                    };
                }
            }
            _ => {}
        }
    }

    let (filename, content_type, bytes) = image
        .ok_or_else(|| ApiException::bad_request("INVALID_REQUEST", "缺少 image 文件"))?;
    let ct = content_type.to_lowercase();
    if ct != "image/jpeg" && ct != "image/png" {
        return Err(ApiException::new(415, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JPEG/PNG 图片"));
    }
    if bytes.len() > 30 * 1024 * 1024 {
        return Err(ApiException::new(413, "FILE_TOO_LARGE", "文件超过 30MB 上限"));
    }
    if crop_box.width < 1 || crop_box.height < 1 {
        return Err(ApiException::bad_request("INVALID_REQUEST", "非法裁剪区域"));
    }
    if !(1..=500).contains(&rows) || !(1..=500).contains(&cols) {
        return Err(ApiException::bad_request("INVALID_REQUEST", "rows/cols 必须在 1-500"));
    }
    let parsed_codes = parse_codes(codes.as_deref())?;

    // 无模型模式（模型未安装——main.rs 降级启动时 active_id 为 None）：
    // 拒绝创建识别任务，前端会把 message 直接提示给用户。
    // 注意：必须在写文件/建 job 之前检查，避免留下孤儿任务。
    if state.auto_ocr && state.model_pool.active_id().is_none() {
        return Err(ApiException::new(
            503,
            "MODEL_NOT_INSTALLED",
            "识别模型未安装：请按 README 安装说明下载模型，解压到应用目录 models 文件夹后重启应用",
        ));
    }

    std::fs::create_dir_all(&state.uploads_dir)
        .map_err(|_| ApiException::new(500, "STORAGE_ERROR", "存储目录创建失败"))?;
    let safe_name: String = filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let stored = format!("{}-{}", Uuid::new_v4(), safe_name);
    std::fs::write(state.uploads_dir.join(&stored), &bytes)
        .map_err(|_| ApiException::new(500, "STORAGE_ERROR", "图片保存失败"))?;

    let job = state
        .service
        .create_job(
            rows,
            cols,
            crop_box.clone(),
            parsed_codes.clone(),
            stored,
            state.seed_version.clone(),
            "bean-mard-v12".to_string(),
            name,
        )
        .map_err(to_api)?;

    // Persist the pre-recognition legend inventory (optional; best-effort —
    // a legend save failure must not fail an already-created job).
    if let Some(entries) = legend {
        if let Err(e) = state.service.replace_legend_entries(job.id, &entries) {
            eprintln!("[legend] persist on create failed (job {}): {e}", job.id);
        }
    }

    // Dispatch OCR in-process (replaces PythonTaskDispatcher + callbacks).
    if state.auto_ocr && state.model_pool.active_id().is_some() {
        let svc = state.service.clone();
        let model_pool = state.model_pool.clone();
        let mard_codes = state.mard_codes.clone();
        let job_id = job.id;
        std::thread::spawn(move || {
            run_ocr_worker(&svc, &model_pool, &mard_codes, job_id, rows, cols, crop_box, parsed_codes, bytes);
        });
    }

    Ok((StatusCode::ACCEPTED, Json(job_to_detail(&job))))
}

/// 003 决议: codes format ^[A-Za-z][0-9]{1,3}$, uppercased.
fn parse_codes(codes: Option<&str>) -> Result<Option<Vec<String>>, ApiException> {
    let Some(s) = codes else { return Ok(None) };
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parsed: Vec<String> = trimmed.split(',').map(|c| c.trim().to_uppercase()).collect();
    let invalid: Vec<&String> = parsed
        .iter()
        .filter(|c| {
            let mut chars = c.chars();
            let first_alpha = chars.next().is_some_and(|ch| ch.is_ascii_alphabetic());
            let rest = c.get(1..);
            let rest_ok = rest.is_some_and(|s| {
                !s.is_empty() && s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit())
            });
            !(first_alpha && rest_ok)
        })
        .collect();
    if !invalid.is_empty() {
        let joined = invalid.iter().map(|c| c.as_str()).collect::<Vec<_>>().join(", ");
        return Err(ApiException::bad_request("INVALID_CODE_FORMAT", format!("非法编码格式: {joined}")));
    }
    Ok(Some(parsed))
}

async fn rename_job(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<RenameJobRequest>,
) -> Result<Json<JobDetail>, ApiException> {
    let job = state.service.rename_job(id, Some(req.name)).map_err(to_api)?;
    Ok(Json(job_to_detail(&job)))
}

async fn delete_jobs(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PageParams>,
) -> Result<Json<serde_json::Value>, ApiException> {
    // 019: ids is a comma-separated query param (`/jobs?ids=a,b`).
    let ids_str = params.ids.as_deref().unwrap_or("");
    let parsed: Vec<Uuid> = ids_str
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            Uuid::parse_str(s).map_err(|_| ApiException::bad_request("INVALID_ID", format!("无效的任务 ID：{s}")))
        })
        .collect::<Result<_, _>>()?;
    if parsed.is_empty() {
        return Err(ApiException::bad_request("EMPTY_IDS", "未指定要删除的任务"));
    }
    let deleted = state.service.delete_jobs(&parsed).map_err(to_api)?;
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}

async fn list_jobs(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PageParams>,
) -> Result<Json<PageResponse<JobSummary>>, ApiException> {
    let (page, page_size) = page_params(&params, 20);
    let sort_by = params.sort_by.clone().unwrap_or_else(|| "createdAt".into());
    let sort_dir = params.sort_dir.clone().unwrap_or_else(|| "desc".into());
    let (jobs, total) = state
        .service
        .list_jobs(params.status.clone(), page, page_size, &sort_by, &sort_dir)
        .map_err(to_api)?;
    Ok(Json(paged(
        jobs.iter().map(job_to_summary).collect(),
        page,
        page_size,
        total,
    )))
}

async fn job_detail(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<JobDetail>, ApiException> {
    let job = state.service.get_job(id).map_err(to_api)?;
    Ok(Json(job_to_detail(&job)))
}

// ── Models (dynamic switching) ────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelsResponse {
    items: Vec<ModelMeta>,
    current: Option<String>,
}

async fn list_models(State(state): State<Arc<AppState>>) -> Json<ModelsResponse> {
    let current = state.model_pool.active_id();
    // Live scan: replacing files under models_dir is picked up on refresh.
    Json(ModelsResponse { items: AppState::discover_models(&state.models_dir), current })
}

async fn current_model(State(state): State<Arc<AppState>>) -> Json<ModelsResponse> {
    let current = state.model_pool.active_id();
    Json(ModelsResponse { items: AppState::discover_models(&state.models_dir), current })
}

async fn activate_model(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, ApiException> {
    let meta = state.activate_model(&id).map_err(to_api)?;
    println!("[model] activated {}", meta.id);
    Ok(Json(serde_json::json!({"current": meta.id, "switched": true})))
}

// ── OCR worker (in-process replacement of the Python image-service) ──

/// Resume jobs that were PROCESSING when the server stopped: bump the attempt
/// via a JOB_FAILED(STALE_RESTART) event (auto-retry or terminal), then
/// re-run the OCR worker from the stored image for those still PROCESSING.
pub fn resume_interrupted(state: &Arc<AppState>) {
    let jobs = state.service.processing_jobs();
    for job in jobs {
        let _ = state.service.fail_job(job.id, "STALE_RESTART", "服务重启，任务恢复重试");
        let Ok(job) = state.service.get_job(job.id) else { continue };
        if job.status != JobStatus::Processing {
            continue; // retries exhausted → FAILED
        }
        // Re-run from the stored image.
        let path = state.uploads_dir.join(&job.input_image_path);
        let Ok(bytes) = std::fs::read(&path) else {
            eprintln!("[recover] image missing for {}: {:?}", job.id, path);
            continue;
        };
        let svc = state.service.clone();
        let model_pool = state.model_pool.clone();
        let mard_codes = state.mard_codes.clone();
        std::thread::spawn(move || {
            run_ocr_worker(
                &svc,
                &model_pool,
                &mard_codes,
                job.id,
                job.rows,
                job.cols,
                job.crop_box,
                job.valid_codes,
                axum::body::Bytes::from(bytes),
            );
        });
        println!("[recover] re-running job {}", job.id);
    }
}

fn run_ocr_worker(
    svc: &JobService,
    model_pool: &ModelPool,
    mard_codes: &[String],
    job_id: Uuid,
    rows: i64,
    cols: i64,
    crop_box: CropBox,
    valid_codes: Option<Vec<String>>,
    image_bytes: Bytes,
) {
    loop {
        // Acquire a pool slot for the whole attempt — blocks while all
        // slots are busy (concurrency limiter); stale slots reload the
        // currently activated model.
        let outcome = match model_pool.acquire_worker() {
            Ok(mut slot) => run_ocr_once(svc, &mut slot, mard_codes, job_id, rows, cols, &crop_box, valid_codes.clone(), &image_bytes),
            Err(e) => Err(format!("MODEL_LOAD_FAILED: {e}")),
        };
        match outcome {
            Ok(()) => {
                svc.compact();
                return;
            }
            Err(msg) => {
                let _ = svc.fail_job(job_id, "OCR_ERROR", &msg.chars().take(500).collect::<String>());
                // Retry until the service flips the job to FAILED (attempt bumped).
                match svc.get_job(job_id).map(|j| j.status) {
                    Ok(JobStatus::Failed) | Err(_) => return,
                    _ => continue,
                }
            }
        }
    }
}

fn run_ocr_once(
    svc: &JobService,
    slot: &mut std::sync::MutexGuard<'_, Option<OnnxModel>>,
    mard_codes: &[String],
    job_id: Uuid,
    rows: i64,
    cols: i64,
    crop_box: &CropBox,
    valid_codes: Option<Vec<String>>,
    image_bytes: &[u8],
) -> Result<(), String> {
    let img = image::load_from_memory(image_bytes)
        .map_err(|e| format!("IMAGE_DECODE_FAILED: {e}"))?
        .to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut rgb = vec![0f32; w * h * 3];
    for (i, px) in img.pixels().enumerate() {
        rgb[i * 3] = px[0] as f32;
        rgb[i * 3 + 1] = px[1] as f32;
        rgb[i * 3 + 2] = px[2] as f32;
    }
    let results = {
        crate::ocr::ocr_cells_from_crop(
            slot.as_mut().unwrap(),
            &rgb,
            w,
            h,
            rows as usize,
            cols as usize,
            (crop_box.x as usize, crop_box.y as usize, crop_box.width as usize, crop_box.height as usize),
            mard_codes,
            valid_codes.as_deref(),
            // Live progress: report recognized cells after each inference
            // batch so the frontend sees the bar move during OCR.
            // (touch_progress uses MAX() so progress never moves backwards.)
            Some(&|done| svc.touch_progress(job_id, done as i64)),
        )
        .map_err(|e| format!("OCR_ERROR: {e}"))?
    };
    // Fill cells the OCR pipeline dropped (decode output outside the closed
    // vocabulary): emit UNMAPPED so JOB_SUCCEEDED's processed==total check
    // passes and the cell is surfaced for correction instead of failing the
    // whole job (cloud server fails the job; local mode is friendlier).
    let present: std::collections::HashSet<(usize, usize)> =
        results.iter().map(|(r, c, _, _)| (*r, *c)).collect();
    let mut cells: Vec<(i64, i64, String, f64)> = results
        .iter()
        .map(|(r, c, code, conf)| {
            (*r as i64, *c as i64, code.to_uppercase(), ((conf * 10_000.0).round() / 10_000.0) as f64)
        })
        .collect();
    for r in 0..rows {
        for c in 0..cols {
            if !present.contains(&(r as usize, c as usize)) {
                cells.push((r, c, "UNMAPPED".to_string(), 0.0));
            }
        }
    }
    cells.sort_by_key(|(r, c, _, _)| (*r, *c));
    // Batched writes: one transaction per CELL_BATCH cells keeps concurrent
    // workers off the db lock (per-cell transactions serialized them).
    const CELL_BATCH: usize = 512;
    let total = (rows * cols) as i64;
    let mut recognized_total = 0i64;
    for chunk in cells.chunks(CELL_BATCH) {
        recognized_total = (recognized_total + chunk.len() as i64).min(total);
        svc.apply_cell_batch(job_id, chunk, recognized_total)
            .map_err(|e| e.to_string())?;
    }
    svc.complete_job(job_id).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Blueprints ───────────────────────────────────────────────────────

async fn list_blueprints(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PageParams>,
) -> Result<Json<PageResponse<BlueprintSummary>>, ApiException> {
    let (page, page_size) = page_params(&params, 20);
    let (bps, total) = state.service.list_blueprints(page, page_size).map_err(to_api)?;
    Ok(Json(paged(
        bps.iter()
            .map(|b| BlueprintSummary {
                id: b.id,
                job_id: b.job_id,
                rows: b.rows,
                cols: b.cols,
                created_at: b.created_at,
            })
            .collect(),
        page,
        page_size,
        total,
    )))
}

async fn blueprint_detail(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<BlueprintDetail>, ApiException> {
    let (bp, job, cells) = state.service.get_blueprint(id).map_err(to_api)?;
    Ok(Json(BlueprintDetail {
        id: bp.id,
        job_id: bp.job_id,
        rows: bp.rows,
        cols: bp.cols,
        valid_codes: bp.valid_codes.clone(),
        cells: cells.iter().map(bp_cell_to_dto).collect(),
        crop_box: Some(job.crop_box),
        materials_box: bp.materials_box,
        materials_rows: bp.materials_rows,
        materials_cols: bp.materials_cols,
        created_at: bp.created_at,
    }))
}

/// 03: 保存物料清单的框选位置 + 行列数（PATCH /blueprints/{id}）。
/// 归一化矩形，0..=1；行列 0..=20；非法数值返回 400 契约错误。
async fn update_blueprint_materials_config(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<BlueprintMaterialsConfig>,
) -> Result<Json<BlueprintDetail>, ApiException> {
    for v in [req.materials_rows, req.materials_cols].into_iter().flatten() {
        if !(0..=20).contains(&v) {
            return Err(ApiException::bad_request(
                "INVALID_MATERIALS_GRID",
                "物料清单行列数必须在 0-20",
            ));
        }
    }
    if let Some(b) = req.materials_box {
        if !b.is_valid() {
            return Err(ApiException::bad_request(
                "INVALID_MATERIALS_BOX",
                "物料清单框选矩形必须在 0-1 归一化范围内且宽高为正",
            ));
        }
    }
    state
        .service
        .update_blueprint_materials_config(id, &req)
        .map_err(to_api)?;
    let (bp, job, cells) = state.service.get_blueprint(id).map_err(to_api)?;
    Ok(Json(BlueprintDetail {
        id: bp.id,
        job_id: bp.job_id,
        rows: bp.rows,
        cols: bp.cols,
        valid_codes: bp.valid_codes.clone(),
        cells: cells.iter().map(bp_cell_to_dto).collect(),
        crop_box: Some(job.crop_box),
        materials_box: bp.materials_box,
        materials_rows: bp.materials_rows,
        materials_cols: bp.materials_cols,
        created_at: bp.created_at,
    }))
}

async fn update_blueprint_cells(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    Json(req): Json<CellCorrectionRequest>,
) -> Result<Json<CellCorrectionResponse>, ApiException> {
    let resp = state
        .service
        .update_blueprint_cells(id, &req.updates)
        .map_err(to_api)?;
    Ok(Json(resp))
}

async fn blueprint_image(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Response, ApiException> {
    let stored = state.service.blueprint_image_path(id).map_err(to_api)?;
    let path = state.uploads_dir.join(&stored);
    let bytes = std::fs::read(&path)
        .map_err(|_| ApiException::not_found("NOT_FOUND", format!("图片不存在: {stored}")))?;
    let content_type = if stored.to_lowercase().ends_with(".png") {
        "image/png"
    } else {
        "image/jpeg"
    };
    Ok(([(header::CONTENT_TYPE, content_type)], bytes).into_response())
}

/// Shared zip cell-export: decode the source image, crop every (row,col,code)
/// cell into PNGs + manifest.csv, return (zip_bytes, default filename).
/// 调用方负责空检查（各自错误码语义不同：NO_CORRECTIONS / NO_CELLS_TO_EXPORT）。
async fn build_cell_export_zip(
    state: &Arc<AppState>,
    id: Uuid,
    cells: Vec<(i64, i64, String)>,
    prefix: &str,
) -> Result<(Vec<u8>, String), ApiException> {
    let (bp, _) = state.service.corrected_cells(id).map_err(to_api)?;
    let job = state.service.get_job(bp.job_id).map_err(to_api)?;
    let stored = job.input_image_path.clone();
    let path = state.uploads_dir.join(&stored);
    let img = image::ImageReader::open(&path)
        .map_err(|_| ApiException::new(500, "IMAGE_DECODE_FAILED", "原图解码失败"))?
        .decode()
        .map_err(|_| ApiException::new(500, "IMAGE_DECODE_FAILED", "原图解码失败"))?
        .to_rgb8();
    let zip_bytes = crate::export::build_corrections_zip(&img, &job.crop_box, bp.rows, bp.cols, &cells)
        .map_err(|e| ApiException::new(500, "EXPORT_FAILED", e.to_string()))?;
    let stamp = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let filename = format!("{prefix}-{}-{stamp}.zip", id.to_string().get(..8).unwrap_or(""));
    Ok((zip_bytes, filename))
}

async fn export_corrections(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Response, ApiException> {
    let (_, cells) = state.service.corrected_cells(id).map_err(to_api)?;
    if cells.is_empty() {
        return Err(ApiException::bad_request("NO_CORRECTIONS", "没有已校正的格子"));
    }
    let corrected: Vec<(i64, i64, String)> = cells
        .iter()
        .map(|c| (c.row, c.col, c.corrected_code.clone().unwrap()))
        .collect();
    let (zip_bytes, filename) = build_cell_export_zip(&state, id, corrected, "corrections").await?;
    let disp = format!("attachment; filename={filename}");
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip"),
            (header::CONTENT_DISPOSITION, disp.as_str()),
        ],
        zip_bytes,
    )
        .into_response())
}

/// 导出全部单元格数据：格式与导出校正数据一致（manifest.csv + 每格 PNG），
/// 但覆盖所有有效内容格（MAPPED/UNMAPPED，未修正格用原识别码），BLANK 空位跳过。
async fn export_all_cells(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Response, ApiException> {
    let (_, cells) = state.service.all_content_cells(id).map_err(to_api)?;
    if cells.is_empty() {
        return Err(ApiException::bad_request("NO_CELLS_TO_EXPORT", "没有可导出的格子"));
    }
    let all: Vec<(i64, i64, String)> = cells
        .iter()
        .map(|c| {
            let code = c.corrected_code.clone().unwrap_or_else(|| c.code.clone());
            (c.row, c.col, code)
        })
        .collect();
    let (zip_bytes, filename) = build_cell_export_zip(&state, id, all, "cells-all").await?;
    let disp = format!("attachment; filename={filename}");
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip"),
            (header::CONTENT_DISPOSITION, disp.as_str()),
        ],
        zip_bytes,
    )
        .into_response())
}

// ── Colors ───────────────────────────────────────────────────────────

async fn list_colors(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PageParams>,
) -> Result<Json<PageResponse<ColorDto>>, ApiException> {
    let (page, page_size) = page_params(&params, 100);
    let (colors, total) = state
        .service
        .list_colors(params.q.as_deref(), page, page_size)
        .map_err(to_api)?;
    Ok(Json(paged(
        colors
            .iter()
            .map(|c| ColorDto {
                code: c.code.clone(),
                name: c.name.clone(),
                hex: c.hex.clone(),
                brand: Some(c.brand.clone()),
            })
            .collect(),
        page,
        page_size,
        total,
    )))
}

async fn get_color(
    State(state): State<Arc<AppState>>,
    AxumPath(code): AxumPath<String>,
) -> Result<Json<ColorDto>, ApiException> {
    let c = state.service.get_color(code.trim()).map_err(to_api)?;
    Ok(Json(ColorDto {
        code: c.code,
        name: c.name,
        hex: c.hex,
        brand: Some(c.brand),
    }))
}

// ── Legend box (single user-selected rect) ───────────────────────────

/// POST /api/v1/legend/box  multipart: image (JPEG/PNG) + x,y,width,height (+brand).
/// Returns the structured LegendBoxResult JSON.  OCR engine is not yet wired,
/// so a valid request returns `model_unavailable` (503 body) until the legend
/// ONNX model is integrated; bbox validation still returns 400.
async fn legend_box(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Response, ApiException> {
    let mut image: Option<Bytes> = None;
    let mut content_type: Option<String> = None;
    let mut bbox = LegendBoxBbox { x: 0.0, y: 0.0, width: 0.0, height: 0.0 };
    let mut has_bbox = false;
    let mut words_json: Option<String> = None;

    while let Some(field) = multipart.next_field().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "multipart 解析失败"))? {
        match field.name().unwrap_or("") {
            "image" => {
                content_type = Some(field.content_type().unwrap_or("").to_string());
                let bytes = field.bytes().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "图片读取失败"))?;
                image = Some(bytes);
            }
            "x" => { bbox.x = field.text().await.unwrap_or_default().trim().parse().unwrap_or(f64::NAN); has_bbox = true; }
            "y" => { bbox.y = field.text().await.unwrap_or_default().trim().parse().unwrap_or(f64::NAN); has_bbox = true; }
            "width" => { bbox.width = field.text().await.unwrap_or_default().trim().parse().unwrap_or(f64::NAN); has_bbox = true; }
            "height" => { bbox.height = field.text().await.unwrap_or_default().trim().parse().unwrap_or(f64::NAN); has_bbox = true; }
            "words" => { words_json = Some(field.text().await.unwrap_or_default()); }
            _ => {}
        }
    }
    let bytes = image.ok_or_else(|| ApiException::bad_request("INVALID_REQUEST", "缺少 image 文件"))?;
    if !has_bbox { return Err(ApiException::bad_request("INVALID_BBOX_MISSING_FIELD", "缺少 bbox 字段 x/y/width/height")); }
    let ct = content_type.unwrap_or_default().to_lowercase();
    if ct != "image/jpeg" && ct != "image/png" && !ct.is_empty() {
        return Err(ApiException::new(415, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JPEG/PNG 图片"));
    }
    if bytes.len() > 30 * 1024 * 1024 {
        return Err(ApiException::new(413, "FILE_TOO_LARGE", "文件超过 30MB 上限"));
    }
    let img = image::load_from_memory(&bytes).map_err(|e| ApiException::bad_request("IMAGE_DECODE_FAILED", format!("图片解码失败: {e}")))?;
    let (img_w, img_h) = (img.width() as i64, img.height() as i64);
    let valid = validate_bbox(&bbox, img_w, img_h).map_err(|code| {
        let msg: String = match code {
            "INVALID_BBOX_NOT_FINITE" => "bbox 含非有限数值".to_string(),
            "INVALID_BBOX_SIZE" => "bbox 宽高必须为正".to_string(),
            "INVALID_BBOX_TOO_SMALL" => format!("bbox 过小，需至少 {}px", crate::legend::MIN_BOX_SIZE as i64),
            "INVALID_BBOX_OUT_OF_BOUNDS" => "bbox 完全位于图片外".to_string(),
            _ => "bbox 无效".to_string(),
        };
        ApiException::new(400, code, msg)
    })?;
    let expanded = expand_bbox(&valid, img_w, img_h);

    // Test hook: if caller supplies OCR words JSON, run the pure parsing core.
    // This lets contract tests verify legend parsing via HTTP without an OCR engine.
    if let Some(wj) = words_json {
        if !wj.trim().is_empty() {
            let words: Vec<BoxWord> = serde_json::from_str(&wj).map_err(|e| ApiException::bad_request("INVALID_WORDS", format!("words JSON 解析失败: {e}")))?;
            let mard_set: std::collections::HashSet<String> = state.mard_codes.iter().cloned().collect();
            let res = parse_legend_box(words, &mard_set, Some(valid), Some(expanded));
            let status = match res.status.as_str() {
                "accepted" | "needs_confirmation" => StatusCode::OK,
                "recognition_failed" => StatusCode::UNPROCESSABLE_ENTITY,
                _ => StatusCode::OK,
            };
            return Ok((status, Json(res)).into_response());
        }
    }

    // Try in-process legend OCR via Python EasyOCR baseline in dev.
    // In release (no Python) this will fall through to model_unavailable.
    let mard_set: std::collections::HashSet<String> = state.mard_codes.iter().cloned().collect();
    if mard_set.is_empty() {
        let res = crate::legend::LegendBoxResult {
            code: None, count: None, raw_code: None, raw_count: None,
            code_confidence: None, count_confidence: None, overall_confidence: 0.0,
            status: "model_unavailable".to_string(), candidates: Default::default(),
            bbox: Some(valid), expanded_bbox: Some(expanded),
            diagnostics: Some("颜色库为空，无法校验编码".to_string()),
        };
        return Ok((StatusCode::SERVICE_UNAVAILABLE, Json(res)).into_response());
    }

    // In-process PP-OCRv5 rec engine (Rust, same ort runtime as the board
    // CRNN). Degrades to 503 when the model files are absent.
    let Some(engine) = state.legend_rec.clone() else {
        let res = crate::legend::legend_empty_result(
            Some(valid),
            Some(expanded),
            "model_unavailable",
            "图例识别模型未安装：请在 models 目录放入 ppocrv5-mobile-rec.onnx 与 ppocrv5_dict.txt 后重启",
        );
        return Ok((StatusCode::SERVICE_UNAVAILABLE, Json(res)).into_response());
    };
    let mard_set: std::collections::HashSet<String> = state.mard_codes.iter().cloned().collect();

    // BGR u8 buffer — parity with the cv2.imread-based validated reference.
    let rgb = img.to_rgb8();
    let (iw, ih) = (rgb.width() as usize, rgb.height() as usize);
    let mut bgr = rgb.into_raw();
    for px in bgr.chunks_exact_mut(3) {
        px.swap(0, 2);
    }
    let (ex, ey, ew, eh) = (
        expanded.x.max(0.0) as usize,
        expanded.y.max(0.0) as usize,
        expanded.width.ceil() as usize,
        expanded.height.ceil() as usize,
    );
    let mard_for_rec = mard_set.clone();
    let recognized = tokio::task::spawn_blocking(move || {
        let mut e = engine.lock().map_err(|_| anyhow::anyhow!("legend engine poisoned"))?;
        e.recognize(&bgr, iw, ih, ex.min(iw), ey.min(ih), (ex + ew).min(iw), (ey + eh).min(ih), &mard_for_rec)
    })
    .await;
    let (text, conf) = match recognized {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            let res = crate::legend::legend_empty_result(
                Some(valid),
                Some(expanded),
                "model_unavailable",
                &format!("图例引擎推理失败：{e}"),
            );
            return Ok((StatusCode::SERVICE_UNAVAILABLE, Json(res)).into_response());
        }
        Err(e) => {
            let res = crate::legend::legend_empty_result(
                Some(valid),
                Some(expanded),
                "model_unavailable",
                &format!("图例引擎任务失败：{e}"),
            );
            return Ok((StatusCode::SERVICE_UNAVAILABLE, Json(res)).into_response());
        }
    };

    let parsed = crate::legend_ocr::parse_card_text(&text, &mard_set);
    let status = if parsed.code.is_none() {
        "recognition_failed"
    } else if parsed.count.is_none()
        || conf < crate::legend::ACCEPT_CODE_CONF
        || parsed.count.map(|c| c > crate::legend::MAX_COUNT).unwrap_or(false)
    {
        "needs_confirmation"
    } else {
        "accepted"
    };
    let mut candidates = std::collections::HashMap::new();
    if status == "needs_confirmation" {
        if let Some(tok) = text
            .to_uppercase()
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '(' || c == ')'))
            .find(|s| !s.is_empty())
        {
            let top: Vec<String> = crate::legend::code_candidates(tok, &mard_set, 3)
                .into_iter()
                .map(|(c, _)| c)
                .collect();
            if !top.is_empty() {
                candidates.insert("code".to_string(), top);
            }
        }
    }
    let res = crate::legend::LegendBoxResult {
        code: parsed.code.clone(),
        count: parsed.count,
        raw_code: Some(text.clone()),
        raw_count: Some(text.clone()),
        code_confidence: parsed.code.as_ref().map(|_| conf),
        count_confidence: parsed.count.map(|_| conf),
        overall_confidence: conf,
        status: status.to_string(),
        candidates,
        bbox: Some(valid),
        expanded_bbox: Some(expanded),
        diagnostics: match status {
            "recognition_failed" => Some("未在选区内找到有效 mard 编码".to_string()),
            "needs_confirmation" => Some("识别结果需要人工确认".to_string()),
            _ => None,
        },
    };
    let http = match status {
        "accepted" | "needs_confirmation" => StatusCode::OK,
        "recognition_failed" => StatusCode::UNPROCESSABLE_ENTITY,
        _ => StatusCode::OK,
    };
    Ok((http, Json(res)).into_response())
}

/// POST /api/v1/legend/grid  multipart: image + x,y,width,height + rows,cols
async fn legend_grid(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Response, ApiException> {
    let mut image: Option<Bytes> = None;
    let mut content_type: Option<String> = None;
    let mut bbox = LegendBoxBbox { x: 0.0, y: 0.0, width: 0.0, height: 0.0 };
    let mut has_bbox = false;
    let mut rows: Option<i64> = None;
    let mut cols: Option<i64> = None;
    while let Some(field) = multipart.next_field().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "multipart 解析失败"))? {
        match field.name().unwrap_or("") {
            "image" => {
                content_type = Some(field.content_type().unwrap_or("").to_string());
                let bytes = field.bytes().await.map_err(|_| ApiException::bad_request("INVALID_REQUEST", "图片读取失败"))?;
                image = Some(bytes);
            }
            "x" => { bbox.x = field.text().await.unwrap_or_default().trim().parse().unwrap_or(f64::NAN); has_bbox = true; }
            "y" => { bbox.y = field.text().await.unwrap_or_default().trim().parse().unwrap_or(f64::NAN); has_bbox = true; }
            "width" => { bbox.width = field.text().await.unwrap_or_default().trim().parse().unwrap_or(f64::NAN); has_bbox = true; }
            "height" => { bbox.height = field.text().await.unwrap_or_default().trim().parse().unwrap_or(f64::NAN); has_bbox = true; }
            "rows" => { rows = Some(field.text().await.unwrap_or_default().trim().parse().unwrap_or(0)); }
            "cols" => { cols = Some(field.text().await.unwrap_or_default().trim().parse().unwrap_or(0)); }
            _ => {}
        }
    }
    let bytes = image.ok_or_else(|| ApiException::bad_request("INVALID_REQUEST", "缺少 image 文件"))?;
    if !has_bbox { return Err(ApiException::bad_request("INVALID_BBOX_MISSING_FIELD", "缺少 bbox")); }
    let r = rows.ok_or_else(|| ApiException::bad_request("INVALID_REQUEST", "缺少 rows"))?;
    let c = cols.ok_or_else(|| ApiException::bad_request("INVALID_REQUEST", "缺少 cols"))?;
    if !(1..=20).contains(&r) || !(1..=20).contains(&c) { return Err(ApiException::bad_request("INVALID_REQUEST", "rows/cols 必须在 1..20")); }
    if (r*c) > 100 { return Err(ApiException::bad_request("INVALID_REQUEST", "网格过大，最多100格")); }
    let ct = content_type.unwrap_or_default().to_lowercase();
    if ct != "image/jpeg" && ct != "image/png" && !ct.is_empty() {
        return Err(ApiException::new(415, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JPEG/PNG"));
    }
    if bytes.len() > 30*1024*1024 { return Err(ApiException::new(413, "FILE_TOO_LARGE", "文件超过 30MB")); }
    let img = image::load_from_memory(&bytes).map_err(|e| ApiException::bad_request("IMAGE_DECODE_FAILED", format!("图片解码失败: {e}")))?;
    let (img_w, img_h) = (img.width() as i64, img.height() as i64);
    let valid = validate_bbox(&bbox, img_w, img_h).map_err(|code| {
        let msg: String = match code {
            "INVALID_BBOX_NOT_FINITE" => "bbox 含非有限数值".to_string(),
            "INVALID_BBOX_SIZE" => "bbox 宽高必须为正".to_string(),
            "INVALID_BBOX_TOO_SMALL" => format!("bbox 过小，需至少 {}px", crate::legend::MIN_BOX_SIZE as i64),
            "INVALID_BBOX_OUT_OF_BOUNDS" => "bbox 完全位于图片外".to_string(),
            _ => "bbox 无效".to_string(),
        };
        ApiException::new(400, code, msg)
    })?;
    // In-process PP-OCRv5 rec over each grid cell (3% inset to avoid
    // neighbour bleed). Degrades per-cell on engine errors.
    let Some(engine) = state.legend_rec.clone() else {
        return Err(ApiException::new(
            503,
            "MODEL_NOT_AVAILABLE",
            "图例识别模型未安装：请在 models 目录放入 ppocrv5-mobile-rec.onnx 与 ppocrv5_dict.txt 后重启",
        ));
    };
    let mard_set: std::collections::HashSet<String> = state.mard_codes.iter().cloned().collect();

    let rgb = img.to_rgb8();
    let (iw, ih) = (rgb.width() as usize, rgb.height() as usize);
    let mut bgr = rgb.into_raw();
    for px in bgr.chunks_exact_mut(3) {
        px.swap(0, 2);
    }

    // 注意：cols 切横向宽度，rows 切纵向高度（此前写反导致每格变成整行宽×细条高）
    let cell_w = valid.width / c as f64;
    let cell_h = valid.height / r as f64;
    let pad_x = (cell_w * crate::legend::SAFE_MARGIN_RATIO).max(1.0);
    let pad_y = (cell_h * crate::legend::SAFE_MARGIN_RATIO).max(1.0);

    let mut cells_out: Vec<LegendGridCellDto> = Vec::with_capacity((r * c) as usize);
    for ri in 0..r {
        for ci in 0..c {
            let cx = valid.x + ci as f64 * cell_w;
            let cy = valid.y + ri as f64 * cell_h;
            let cell_bbox = LegendBoxBbox {
                x: cx,
                y: cy,
                width: cell_w,
                height: cell_h,
            };
            let x0 = ((cx + pad_x).max(0.0)) as usize;
            let y0 = ((cy + pad_y).max(0.0)) as usize;
            let x1 = ((cx + cell_w - pad_x).min(iw as f64)) as usize;
            let y1 = ((cy + cell_h - pad_y).min(ih as f64)) as usize;
            let (text, conf) = if x0 < x1 && y0 < y1 {
                let eng = engine.clone();
                let bgr = bgr.clone();
                let mard_for_rec = mard_set.clone();
                match tokio::task::spawn_blocking(move || {
                    let mut e = eng.lock().map_err(|_| anyhow::anyhow!("poisoned"))?;
                    e.recognize(&bgr, iw, ih, x0, y0, x1, y1, &mard_for_rec)
                })
                .await
                {
                    Ok(Ok(v)) => v,
                    Ok(Err(e)) => {
                        eprintln!("[legend] grid cell ({ri},{ci}) rec failed: {e}");
                        (String::new(), 0.0)
                    }
                    Err(e) => {
                        eprintln!("[legend] grid cell ({ri},{ci}) task failed: {e}");
                        (String::new(), 0.0)
                    }
                }
            } else {
                (String::new(), 0.0)
            };
            let parsed = crate::legend_ocr::parse_card_text(&text, &mard_set);
            let status = if parsed.code.is_none() {
                "recognition_failed"
            } else if parsed.count.is_none() || conf < crate::legend::ACCEPT_CODE_CONF {
                "needs_confirmation"
            } else {
                "accepted"
            };
            cells_out.push(LegendGridCellDto {
                row: ri,
                col: ci,
                bbox: cell_bbox,
                code: parsed.code,
                count: parsed.count,
                raw_code: Some(text.clone()),
                raw_count: Some(text),
                overall_confidence: conf,
                status: status.to_string(),
            });
        }
    }
    Ok((
        StatusCode::OK,
        Json(LegendGridResponseDto { rows: r, cols: c, bbox: valid, cells: cells_out }),
    )
        .into_response())
}

// ── Legend persistence (per-job storage, blueprint-scoped API) ──────────

/// Typed grid response (replaces the old untyped Python JSON passthrough;
/// shape matches frontend `LegendGridResponse`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendGridResponseDto {
    pub rows: i64,
    pub cols: i64,
    pub bbox: LegendBoxBbox,
    pub cells: Vec<LegendGridCellDto>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendGridCellDto {
    pub row: i64,
    pub col: i64,
    pub bbox: LegendBoxBbox,
    pub code: Option<String>,
    pub count: Option<i64>,
    pub raw_code: Option<String>,
    pub raw_count: Option<String>,
    pub overall_confidence: f64,
    pub status: String,
}

async fn get_blueprint_legend(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<Vec<LegendEntryDto>>, ApiException> {
    let entries = state.service.get_legend_entries_for_blueprint(id).map_err(to_api)?;
    Ok(Json(entries))
}

async fn save_blueprint_legend(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    Json(entries): Json<Vec<LegendEntryDto>>,
) -> Result<Json<LegendSaveCount>, ApiException> {
    for e in &entries {
        if e.code.trim().is_empty() || e.count < 0 {
            return Err(ApiException::bad_request(
                "INVALID_LEGEND_ENTRY",
                "图例条目无效：编码不能为空且数量不能为负",
            ));
        }
    }
    let (bp, _, _) = state.service.get_blueprint(id).map_err(to_api)?;
    state.service.replace_legend_entries(bp.job_id, &entries).map_err(to_api)?;
    Ok(Json(LegendSaveCount { count: entries.len() as i64 }))
}

async fn export_blueprint_legend(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Response, ApiException> {
    let entries = state.service.get_legend_entries_for_blueprint(id).map_err(to_api)?;
    let confirmed: Vec<LegendEntryDto> = entries.into_iter().filter(|e| e.confirmed).collect();
    if confirmed.is_empty() {
        return Err(ApiException::bad_request("NO_LEGEND_ENTRIES", "没有已确认的图例条目"));
    }
    let (bp, job, _) = state.service.get_blueprint(id).map_err(to_api)?;
    let path = state.uploads_dir.join(&job.input_image_path);
    let img = image::ImageReader::open(&path)
        .map_err(|_| ApiException::new(500, "IMAGE_DECODE_FAILED", "原图解码失败"))?
        .decode()
        .map_err(|_| ApiException::new(500, "IMAGE_DECODE_FAILED", "原图解码失败"))?
        .to_rgb8();
    let crops: Vec<crate::export::LegendSampleCrop> = confirmed
        .iter()
        .map(|e| crate::export::LegendSampleCrop {
            row: e.row_index,
            col: e.col_index,
            code: e.code.clone(),
            count: e.count,
            bbox: (e.bbox.x, e.bbox.y, e.bbox.width, e.bbox.height),
        })
        .collect();
    let zip_bytes = crate::export::build_legend_samples_zip(&img, &crops)
        .map_err(|e| ApiException::new(500, "EXPORT_FAILED", e.to_string()))?;
    let _ = bp;
    let stamp = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let filename = format!("legend-samples-{}-{stamp}.zip", id.to_string().get(..8).unwrap_or(""));
    let disp = format!("attachment; filename={filename}");
    Ok((
        [
            (header::CONTENT_TYPE, "application/zip"),
            (header::CONTENT_DISPOSITION, disp.as_str()),
        ],
        zip_bytes,
    )
        .into_response())
}
