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
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
    /// None when OCR is disabled (contract tests); the worker only runs when
    /// both `model` and `auto_ocr` are set.
    pub model: Arc<Mutex<Option<OnnxModel>>>,
    pub mard_codes: Vec<String>,
    pub uploads_dir: std::path::PathBuf,
    pub seed_version: String,
    /// Spawn the in-process OCR worker on job creation (disabled in tests,
    /// where events are delivered manually through /internal/jobs/...).
    pub auto_ocr: bool,
    pub frontend: Frontend,
    /// Discovered model artifacts (`artifacts/models/` dirs with model.onnx).
    pub models_dir: std::path::PathBuf,
    pub model_registry: Vec<ModelMeta>,
    /// Persisted active model id (data/model-current.txt).
    pub model_current_file: std::path::PathBuf,
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
    pub fn activate_model(&self, id: &str) -> anyhow::Result<ModelMeta> {
        let meta = self
            .model_registry
            .iter()
            .find(|m| m.id == id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!(ApiException::not_found("MODEL_NOT_FOUND", format!("模型不存在: {id}"))))?;
        let dir = self.models_dir.join(id);
        let model = OnnxModel::load(&dir)?;
        {
            let mut slot = self.model.lock().unwrap();
            *slot = Some(model);
        }
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
        .route("/api/v1/jobs/{id}/events", get(job_events))
        .route("/api/v1/blueprints", get(list_blueprints))
        .route("/api/v1/blueprints/{id}", get(blueprint_detail))
        .route("/api/v1/blueprints/{id}/cells", patch(update_blueprint_cells))
        .route("/api/v1/blueprints/{id}/image", get(blueprint_image))
        .route("/api/v1/blueprints/{id}/cells/export-corrections", get(export_corrections))
        .route("/api/v1/colors", get(list_colors))
        .route("/api/v1/colors/{code}", get(get_color))
        .route("/api/v1/models", get(list_models))
        .route("/api/v1/models/current", get(current_model))
        .route("/api/v1/models/{id}/activate", post(activate_model))
        .route("/internal/jobs/{id}/events", post(internal_event))
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
            "bean-mard-v11".to_string(),
            name,
        )
        .map_err(to_api)?;

    // Dispatch OCR in-process (replaces PythonTaskDispatcher + callbacks).
    if state.auto_ocr && state.model.lock().unwrap().is_some() {
        let svc = state.service.clone();
        let model = state.model.clone();
        let mard_codes = state.mard_codes.clone();
        let job_id = job.id;
        std::thread::spawn(move || {
            run_ocr_worker(&svc, &model, &mard_codes, job_id, rows, cols, crop_box, parsed_codes, bytes);
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

async fn job_events(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    Query(params): Query<PageParams>,
) -> Result<Json<PageResponse<JobEventDto>>, ApiException> {
    let (page, page_size) = page_params(&params, 20);
    let sort_dir = params.sort_dir.clone().unwrap_or_else(|| "asc".into());
    let (events, total) = state
        .service
        .list_events(id, page, page_size, &sort_dir)
        .map_err(to_api)?;
    Ok(Json(paged(
        events
            .iter()
            .map(|e| JobEventDto {
                attempt: e.attempt,
                sequence: e.sequence,
                event_type: e.event_type,
                timestamp: e.created_at,
                payload: e.payload.clone(),
            })
            .collect(),
        page,
        page_size,
        total,
    )))
}

// ── Internal events (in-process OCR delivery; also HTTP for contract tests) ──

#[derive(Serialize, Deserialize)]
struct InternalEventResponse {
    applied: bool,
}

async fn internal_event(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
    Json(mut ev): Json<InboundEvent>,
) -> Result<Json<InternalEventResponse>, ApiException> {
    ev.job_id = id; // path is authoritative
    let applied = state.service.apply_event(&ev).map_err(to_api)?;
    Ok(Json(InternalEventResponse { applied }))
}

// ── Models (dynamic switching) ────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelsResponse {
    items: Vec<ModelMeta>,
    current: Option<String>,
}

async fn list_models(State(state): State<Arc<AppState>>) -> Json<ModelsResponse> {
    let current = state
        .model
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.artifact_id.clone());
    Json(ModelsResponse { items: state.model_registry.clone(), current })
}

async fn current_model(State(state): State<Arc<AppState>>) -> Json<ModelsResponse> {
    let current = state
        .model
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.artifact_id.clone());
    Json(ModelsResponse { items: state.model_registry.clone(), current })
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
        let ev = InboundEvent {
            job_id: job.id,
            attempt: job.attempt,
            sequence: job.attempt * 10_000 + 1000,
            event_type: EventType::JobFailed,
            timestamp: None,
            payload: serde_json::json!({
                "code": "STALE_RESTART",
                "message": "服务重启，任务恢复重试",
            }),
        };
        let _ = state.service.apply_event(&ev);
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
        let model = state.model.clone();
        let mard_codes = state.mard_codes.clone();
        std::thread::spawn(move || {
            run_ocr_worker(
                &svc,
                &model,
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
    model: &Mutex<Option<OnnxModel>>,
    mard_codes: &[String],
    job_id: Uuid,
    rows: i64,
    cols: i64,
    crop_box: CropBox,
    valid_codes: Option<Vec<String>>,
    image_bytes: Bytes,
) {
    let mut attempt = 0i64;
    loop {
        let outcome = run_ocr_once(svc, model, mard_codes, job_id, rows, cols, &crop_box, valid_codes.clone(), &image_bytes);
        match outcome {
            Ok(()) => {
                svc.compact();
                return;
            }
            Err(msg) => {
                let payload = serde_json::json!({
                    "code": "OCR_ERROR",
                    "message": msg.chars().take(500).collect::<String>(),
                });
                let _ = svc.apply_event(&InboundEvent {
                    job_id,
                    attempt,
                    sequence: attempt * 10_000 + 1000,
                    event_type: EventType::JobFailed,
                    timestamp: None,
                    payload,
                });
                attempt += 1;
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
    model: &Mutex<Option<OnnxModel>>,
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
        let mut m = model.lock().unwrap();
        crate::ocr::ocr_cells_from_crop(
            m.as_mut().unwrap(),
            &rgb,
            w,
            h,
            rows as usize,
            cols as usize,
            (crop_box.x as usize, crop_box.y as usize, crop_box.width as usize, crop_box.height as usize),
            mard_codes,
            valid_codes.as_deref(),
        )
        .map_err(|e| format!("OCR_ERROR: {e}"))?
    };
    let base = sequence_base_for_attempt(svc, job_id);
    // Fill cells the OCR pipeline dropped (decode output outside the closed
    // vocabulary): emit UNMAPPED so JOB_SUCCEEDED's processed==total check
    // passes and the cell is surfaced for correction instead of failing the
    // whole job (cloud server fails the job; local mode is friendlier).
    let present: std::collections::HashSet<(usize, usize)> =
        results.iter().map(|(r, c, _, _)| (*r, *c)).collect();
    for (idx, (r, c, code, conf)) in results.iter().enumerate() {
        let ev = InboundEvent {
            job_id,
            attempt: current_attempt(svc, job_id),
            sequence: base + idx as i64 + 1,
            event_type: EventType::CellProcessed,
            timestamp: None,
            payload: serde_json::json!({
                "row": r, "col": c,
                "code": code.to_uppercase(),
                "confidence": (conf * 10_000.0).round() / 10_000.0,
            }),
        };
        svc.apply_event(&ev).map_err(|e| e.to_string())?;
    }
    let mut fill_seq = base + results.len() as i64 + 1;
    for r in 0..rows {
        for c in 0..cols {
            if present.contains(&(r as usize, c as usize)) {
                continue;
            }
            let ev = InboundEvent {
                job_id,
                attempt: current_attempt(svc, job_id),
                sequence: fill_seq,
                event_type: EventType::CellProcessed,
                timestamp: None,
                payload: serde_json::json!({
                    "row": r, "col": c, "code": "UNMAPPED", "confidence": 0.0,
                }),
            };
            fill_seq += 1;
            svc.apply_event(&ev).map_err(|e| e.to_string())?;
        }
    }
    let ev = InboundEvent {
        job_id,
        attempt: current_attempt(svc, job_id),
        sequence: fill_seq,
        event_type: EventType::JobSucceeded,
        timestamp: None,
        payload: serde_json::json!({"processedCells": (rows * cols) as usize, "totalCells": (rows * cols) as usize}),
    };
    svc.apply_event(&ev).map_err(|e| e.to_string())?;
    Ok(())
}

fn current_attempt(svc: &JobService, job_id: Uuid) -> i64 {
    svc.get_job(job_id).map(|j| j.attempt).unwrap_or(0)
}

/// Events for one OCR pass must not collide with JOB_STARTED(0) or
/// RETRY_SCHEDULED (which uses next-free in attempt). Offset per attempt.
fn sequence_base_for_attempt(svc: &JobService, job_id: Uuid) -> i64 {
    current_attempt(svc, job_id) * 10_000
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

async fn export_corrections(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Response, ApiException> {
    let (bp, cells) = state.service.corrected_cells(id).map_err(to_api)?;
    if cells.is_empty() {
        return Err(ApiException::bad_request("NO_CORRECTIONS", "没有已校正的格子"));
    }
    let job = state.service.get_job(bp.job_id).map_err(to_api)?;
    let stored = job.input_image_path.clone();
    let path = state.uploads_dir.join(&stored);
    let img = image::ImageReader::open(&path)
        .map_err(|_| ApiException::new(500, "IMAGE_DECODE_FAILED", "原图解码失败"))?
        .decode()
        .map_err(|_| ApiException::new(500, "IMAGE_DECODE_FAILED", "原图解码失败"))?
        .to_rgb8();
    let corrected: Vec<(i64, i64, String)> = cells
        .iter()
        .map(|c| (c.row, c.col, c.corrected_code.clone().unwrap()))
        .collect();
    let zip_bytes = crate::export::build_corrections_zip(&img, &job.crop_box, bp.rows, bp.cols, &corrected)
        .map_err(|e| ApiException::new(500, "EXPORT_FAILED", e.to_string()))?;
    let stamp = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let filename = format!("corrections-{}-{stamp}.zip", id.to_string().get(..8).unwrap_or(""));
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
