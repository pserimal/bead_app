//! API contract tests — port of `server/src/test/.../ApiContractTest.kt`
//! (9 MockMvc tests) against the axum router with an in-memory SQLite DB
//! and the OCR worker disabled (events are delivered manually, exactly like
//! the Kotlin tests drive the internal callback endpoint).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use bead_local_server::api::{router, AppState};
use bead_local_server::db;
use bead_local_server::models::ColorEntry;
use bead_local_server::service::JobService;
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

const BOUNDARY: &str = "----beadtestboundary";
const PNG: &[u8] = include_bytes!("fixtures/white_300.png");

fn test_app() -> (Router, Arc<AppState>) {
    let db = db::open(std::path::Path::new(":memory:")).unwrap();
    let service = JobService::new(Arc::new(db));
    // mard seed: H1=white FDFBFF, H2/H3 dark, matching the Kotlin test DB.
    let version = "seed-3";
    service
        .seed_colors(&[
            ColorEntry { code: "H1".into(), name: "白".into(), hex: "FDFBFF".into(), brand: "mard".into(), version: version.into() },
            ColorEntry { code: "H2".into(), name: "灰".into(), hex: "A9A9A9".into(), brand: "mard".into(), version: version.into() },
            ColorEntry { code: "H3".into(), name: "深灰".into(), hex: "555555".into(), brand: "mard".into(), version: version.into() },
        ])
        .unwrap();
    let state = Arc::new(AppState {
        service,
        model_pool: bead_local_server::api::ModelPool::new(std::env::temp_dir().join("bead-test-models")),
        mard_codes: vec!["H1".into(), "H2".into(), "H3".into()],
        uploads_dir: std::env::temp_dir().join("bead-test-uploads"),
        seed_version: version.into(),
        auto_ocr: false,
        frontend: bead_local_server::api::Frontend {
            dist_dir: std::path::PathBuf::from("tests/fixtures/dist"),
        },
        models_dir: std::env::temp_dir().join("bead-test-models"),
        model_current_file: std::env::temp_dir().join("bead-test-model-current.txt"),
    });
    (router(state.clone()), state)
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
    (status, json)
}

fn get(_app: &Router, path: &str) -> Request<Body> {
    Request::builder().uri(path).body(Body::empty()).unwrap()
}

fn patch_json(_app: &Router, path: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(Method::PATCH)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn post_json(_app: &Router, path: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn multipart_create(extra: &str) -> Request<Body> {
    let mut body = String::new();
    body.push_str(&format!("--{BOUNDARY}\r\n"));
    body.push_str("Content-Disposition: form-data; name=\"image\"; filename=\"test.png\"\r\n");
    body.push_str("Content-Type: image/png\r\n\r\n");
    // binary part: PNG bytes must be appended raw; we build the request body manually below
    let fields = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"cropBoxX\"\r\n\r\n10\r\n\
         --{BOUNDARY}\r\nContent-Disposition: form-data; name=\"cropBoxY\"\r\n\r\n20\r\n\
         --{BOUNDARY}\r\nContent-Disposition: form-data; name=\"cropBoxWidth\"\r\n\r\n100\r\n\
         --{BOUNDARY}\r\nContent-Disposition: form-data; name=\"cropBoxHeight\"\r\n\r\n200\r\n\
         --{BOUNDARY}\r\nContent-Disposition: form-data; name=\"rows\"\r\n\r\n2\r\n\
         --{BOUNDARY}\r\nContent-Disposition: form-data; name=\"cols\"\r\n\r\n2\r\n{extra}\
         --{BOUNDARY}--\r\n"
    );
    let head = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"test.png\"\r\nContent-Type: image/png\r\n\r\n"
    );
    let mut bytes = Vec::new();
    bytes.extend_from_slice(head.as_bytes());
    bytes.extend_from_slice(PNG);
    bytes.extend_from_slice(b"\r\n");
    bytes.extend_from_slice(fields.as_bytes());
    Request::builder()
        .method(Method::POST)
        .uri("/api/v1/jobs")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from(bytes))
        .unwrap()
}

async fn create_job(app: &Router) -> Uuid {
    let (status, body) = send(app, multipart_create("")).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
}

/// Feed cells directly through the service (the /internal event endpoint is
/// gone; workers use the same batched path).
fn feed_cells(state: &Arc<AppState>, id: Uuid, cells: &[(i64, i64, &str, Option<f64>)]) {
    let mapped: Vec<(i64, i64, String, f64)> = cells
        .iter()
        .map(|(r, c, code, conf)| (*r, *c, code.to_string(), conf.unwrap_or(0.5)))
        .collect();
    state
        .service
        .apply_cell_batch(id, &mapped, mapped.len() as i64)
        .unwrap();
}

fn succeed_job(state: &Arc<AppState>, id: Uuid) {
    state.service.complete_job(id).unwrap();
}

async fn complete_blueprint(app: &Router, state: &Arc<AppState>) -> Uuid {
    let id = create_job(app).await;
    feed_cells(state, id, &[
        (0, 0, "H1", Some(0.87)),
        (0, 1, "H2", Some(0.99)),
        (1, 0, "Z99", Some(0.31)), // UNMAPPED
        (1, 1, "H1", Some(0.95)),
    ]);
    succeed_job(state, id);
    let (_, body) = send(app, get(app, &format!("/api/v1/jobs/{id}"))).await;
    Uuid::parse_str(body["blueprintId"].as_str().unwrap()).unwrap()
}

use uuid::Uuid;

#[tokio::test]
async fn create_job_returns_202_and_contract() {
    let (app, _) = test_app();
    let id = create_job(&app).await;
    let (status, body) = send(&app, get(&app, &format!("/api/v1/jobs/{id}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["stage"], "QUEUED");
    assert!(body["snapshot"]["model"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(body["snapshot"]["colorLibraryVersion"].as_str().is_some_and(|s| !s.is_empty()));
}

#[tokio::test]
async fn create_job_without_model_returns_503() {
    // Degraded mode (main.rs): model not installed → active_id is None →
    // job creation is rejected with a user-facing message; no orphan job.
    let db = db::open(std::path::Path::new(":memory:")).unwrap();
    let service = JobService::new(Arc::new(db));
    let state = Arc::new(AppState {
        service,
        model_pool: bead_local_server::api::ModelPool::new(std::env::temp_dir().join("bead-test-models")),
        mard_codes: vec![],
        uploads_dir: std::env::temp_dir().join("bead-test-uploads"),
        seed_version: "seed-3".into(),
        auto_ocr: true,
        frontend: bead_local_server::api::Frontend {
            dist_dir: std::path::PathBuf::from("tests/fixtures/dist"),
        },
        models_dir: std::env::temp_dir().join("bead-test-models"),
        model_current_file: std::env::temp_dir().join("bead-test-model-current.txt"),
    });
    let app = router(state.clone());
    let (status, body) = send(&app, multipart_create("")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "MODEL_NOT_INSTALLED");
    assert!(body["message"].as_str().is_some_and(|m| !m.is_empty()));
    // No job was persisted.
    let (status, body) = send(&app, get(&app, "/api/v1/jobs")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 0);
}

#[tokio::test]
async fn job_list_pagination_and_status_filter() {
    let (app, _) = test_app();
    create_job(&app).await;
    let (status, body) = send(&app, get(&app, "/api/v1/jobs?status=PENDING")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
    assert_eq!(body["items"][0]["status"], "PENDING");
    assert_eq!(body["items"][0]["totalCells"], 4);
    assert_eq!(body["page"], 1);
    assert_eq!(body["totalPages"], 1);
    assert_eq!(body["total"], 1);

    let (_, body) = send(&app, get(&app, "/api/v1/jobs?status=FAILED")).await;
    assert_eq!(body["items"].as_array().unwrap().len(), 0);

    let (status, body) = send(&app, get(&app, "/api/v1/jobs?status=NOPE")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "INVALID_JOB_STATUS");
}

#[tokio::test]
async fn succeeded_creates_blueprint_atomically() {
    let (app, state) = test_app();
    let id = create_job(&app).await;
    feed_cells(&state, id, &[
        (0, 0, "H1", None),
        (0, 1, "H2", None),
        (1, 0, "Z99", None), // UNMAPPED
        (1, 1, "H3", None),
    ]);
    succeed_job(&state, id);

    let (_, body) = send(&app, get(&app, &format!("/api/v1/jobs/{id}"))).await;
    assert_eq!(body["status"], "SUCCEEDED");
    let bp_id = body["blueprintId"].as_str().unwrap().to_string();

    let (status, bp) = send(&app, get(&app, &format!("/api/v1/blueprints/{bp_id}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bp["cells"].as_array().unwrap().len(), 4);
    assert_eq!(bp["cells"][2]["status"], "UNMAPPED");
    assert!(bp["cells"][2]["color"].is_null());
    assert_eq!(bp["cells"][0]["color"]["code"], "H1");
}

#[tokio::test]
async fn blank_cell_is_recognized_empty_state() {
    let (app, state) = test_app();
    let id = create_job(&app).await;
    feed_cells(&state, id, &[
        (0, 0, "H1", None),
        (0, 1, "BLANK", None),
        (1, 0, "H2", None),
        (1, 1, "H1", None),
    ]);
    succeed_job(&state, id);
    let (_, body) = send(&app, get(&app, &format!("/api/v1/jobs/{id}"))).await;
    assert_eq!(body["status"], "SUCCEEDED");
    let bp_id = body["blueprintId"].as_str().unwrap().to_string();
    let (_, bp) = send(&app, get(&app, &format!("/api/v1/blueprints/{bp_id}"))).await;
    assert_eq!(bp["cells"][1]["code"], "BLANK");
    assert_eq!(bp["cells"][1]["status"], "BLANK");
    assert!(bp["cells"][1]["color"].is_null());
}

#[tokio::test]
async fn confidence_persisted_and_crop_box_present() {
    let (app, state) = test_app();
    let bp_id = complete_blueprint(&app, &state).await;
    let (_, bp) = send(&app, get(&app, &format!("/api/v1/blueprints/{bp_id}"))).await;
    assert_eq!(bp["cells"][0]["confidence"], 0.87);
    assert_eq!(bp["cells"][2]["confidence"], 0.31);
    assert!(bp["cells"][0]["correctedCode"].is_null());
    assert_eq!(bp["cropBox"]["x"], 10);
    assert_eq!(bp["cropBox"]["width"], 100);
}

#[tokio::test]
async fn patch_cells_batch_correct_and_revert() {
    let (app, state) = test_app();
    let bp_id = complete_blueprint(&app, &state).await;
    let req = r#"{"updates":[{"row":0,"col":0,"code":"H2"},{"row":1,"col":0,"code":"H1"}]}"#;
    let (status, body) = send(
        &app,
        patch_json(&app, &format!("/api/v1/blueprints/{bp_id}/cells"), req),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["correctedCount"], 2);
    assert_eq!(body["revertedCount"], 0);
    assert_eq!(body["cells"].as_array().unwrap().len(), 2);
    assert_eq!(body["cells"][0]["code"], "H1"); // original kept
    assert_eq!(body["cells"][0]["correctedCode"], "H2");
    assert_eq!(body["cells"][0]["color"]["code"], "H2");
    assert_eq!(body["cells"][1]["status"], "MAPPED");
    assert_eq!(body["cells"][1]["correctedCode"], "H1");

    // revert (0,0): color back to H1
    let req = r#"{"updates":[{"row":0,"col":0}]}"#;
    let (_, body) = send(
        &app,
        patch_json(&app, &format!("/api/v1/blueprints/{bp_id}/cells"), req),
    )
    .await;
    assert_eq!(body["revertedCount"], 1);
    assert!(body["cells"][0]["correctedCode"].is_null());
    assert_eq!(body["cells"][0]["color"]["code"], "H1");
}

#[tokio::test]
async fn patch_rejects_out_of_library_and_out_of_bounds() {
    let (app, state) = test_app();
    let bp_id = complete_blueprint(&app, &state).await;
    let (status, body) = send(
        &app,
        patch_json(&app, &format!("/api/v1/blueprints/{bp_id}/cells"), r#"{"updates":[{"row":0,"col":0,"code":"X99"}]}"#),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "INVALID_CODE");

    let (status, body) = send(
        &app,
        patch_json(&app, &format!("/api/v1/blueprints/{bp_id}/cells"), r#"{"updates":[{"row":9,"col":9,"code":"H1"}]}"#),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "CELL_OUT_OF_BOUNDS");
}

#[tokio::test]
async fn patch_unknown_blueprint_404() {
    let (app, _) = test_app();
    let (status, body) = send(
        &app,
        patch_json(&app, &format!("/api/v1/blueprints/{}/cells", Uuid::new_v4()), r#"{"updates":[{"row":0,"col":0,"code":"H1"}]}"#),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "BLUEPRINT_NOT_FOUND");
}

#[tokio::test]
async fn export_corrections_zip_with_manifest() {
    let (app, state) = test_app();
    let bp_id = complete_blueprint(&app, &state).await;
    let req = r#"{"updates":[{"row":0,"col":0,"code":"H2"}]}"#;
    let (status, _) = send(&app, patch_json(&app, &format!("/api/v1/blueprints/{bp_id}/cells"), req)).await;
    assert_eq!(status, StatusCode::OK);

    let req = Request::builder()
        .uri(format!("/api/v1/blueprints/{bp_id}/cells/export-corrections"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()[header::CONTENT_TYPE], "application/zip");
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_ref())).unwrap();
    let names: Vec<String> = (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
    assert!(names.contains(&"manifest.csv".to_string()), "zip entries: {names:?}");
    let png_entry = names.iter().find(|n| n.ends_with(".png")).unwrap().clone();
    let manifest = zip.by_name("manifest.csv").unwrap();
    let manifest_text = std::io::read_to_string(manifest).unwrap();
    assert!(manifest_text.starts_with('\u{FEFF}'));
    assert!(manifest_text.contains(&format!("H2,{png_entry},1,1,")), "manifest: {manifest_text}");
}

#[tokio::test]
async fn export_no_corrections_400() {
    let (app, state) = test_app();
    let bp_id = complete_blueprint(&app, &state).await;
    let (status, body) = send(&app, get(&app, &format!("/api/v1/blueprints/{bp_id}/cells/export-corrections"))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "NO_CORRECTIONS");
}

#[tokio::test]
async fn error_contract_shape_and_validation() {
    let (app, _) = test_app();
    let (status, body) = send(&app, get(&app, &format!("/api/v1/jobs/{}", Uuid::new_v4()))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "JOB_NOT_FOUND");
    assert!(body["message"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(body["traceId"].as_str().is_some_and(|s| !s.is_empty()));

    // invalid codes format
    let extra = format!(
        "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"codes\"\r\n\r\nH1,12x\r\n"
    );
    let (status, body) = send(&app, multipart_create(&extra)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "INVALID_CODE_FORMAT");
}

#[tokio::test]
async fn delete_jobs_batch_removes_job_and_blueprint() {
    let (app, _) = test_app();
    let id1 = create_job(&app).await;
    let id2 = create_job(&app).await;
    let (status, body) = send(&app, Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/v1/jobs?ids={id1},{id2}"))
        .body(Body::empty())
        .unwrap())
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted"], 2);
    let (status, _) = send(&app, get(&app, &format!("/api/v1/jobs/{id1}"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // empty ids → 400
    let (status, body) = send(&app, Request::builder()
        .method(Method::DELETE)
        .uri("/api/v1/jobs?ids=")
        .body(Body::empty())
        .unwrap())
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "EMPTY_IDS");
}

#[tokio::test]
async fn models_list_and_activate_unknown() {
    let (app, _) = test_app();
    // empty registry in tests (no artifacts dir); current = None (OCR disabled)
    let (status, body) = send(&app, get(&app, "/api/v1/models")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
    assert!(body["current"].is_null() || body["current"].is_string());

    let (status, body) = send(&app, Request::builder()
        .method(Method::POST)
        .uri("/api/v1/models/does-not-exist/activate")
        .body(Body::empty())
        .unwrap())
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "MODEL_NOT_FOUND");
}

#[tokio::test]
async fn color_library_list_and_single() {
    let (app, _) = test_app();
    let (status, body) = send(&app, get(&app, "/api/v1/colors?q=H1")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"][0]["code"], "H1");
    assert_eq!(body["items"][0]["hex"], "FDFBFF");
    assert_eq!(body["items"][0]["brand"], "mard");

    let (status, body) = send(&app, get(&app, "/api/v1/colors/H1")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["code"], "H1");
    assert_eq!(body["brand"], "mard");

    let (status, body) = send(&app, get(&app, "/api/v1/colors/NOPE")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "COLOR_NOT_FOUND");
}
