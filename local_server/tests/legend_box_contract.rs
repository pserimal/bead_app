//! Legend box contract tests — single user-selected rect.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use bead_local_server::api::{router, AppState};
use bead_local_server::db;
use bead_local_server::models::ColorEntry;
use bead_local_server::service::JobService;
use http_body_util::BodyExt;
use tower::ServiceExt;

const BOUNDARY: &str = "----legendtest";
const PNG: &[u8] = include_bytes!("fixtures/white_300.png");

fn test_app() -> Router {
    let db = db::open(std::path::Path::new(":memory:")).unwrap();
    let service = JobService::new(Arc::new(db));
    service
        .seed_colors(&[
            ColorEntry { code: "A4".into(), name: "m".into(), hex: "FFFFFF".into(), brand: "mard".into(), version: "seed-3".into() },
            ColorEntry { code: "H7".into(), name: "m".into(), hex: "000000".into(), brand: "mard".into(), version: "seed-3".into() },
            ColorEntry { code: "H12".into(), name: "m".into(), hex: "111111".into(), brand: "mard".into(), version: "seed-3".into() },
        ])
        .unwrap();
    let state = Arc::new(AppState {
        service,
        model_pool: bead_local_server::api::ModelPool::new(std::env::temp_dir().join("bead-test-models-legend")),
        mard_codes: vec!["A4".into(), "H7".into(), "H12".into(), "M5".into()],
        uploads_dir: std::env::temp_dir().join("bead-test-uploads"),
        seed_version: "seed-3".into(),
        auto_ocr: false,
        frontend: bead_local_server::api::Frontend { dist_dir: std::path::PathBuf::from("tests/fixtures/dist") },
        models_dir: std::env::temp_dir().join("bead-test-models"),
        model_current_file: std::env::temp_dir().join("bead-test-model-current.txt"),
        legend_rec: None,
    });
    router(state)
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, serde_json::Value, Vec<u8>) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    (status, json, body.to_vec())
}

fn legend_req(bbox: Option<(f64, f64, f64, f64)>, words: Option<&str>) -> Request<Body> {
    let mut parts = Vec::new();
    // image
    parts.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"test.png\"\r\nContent-Type: image/png\r\n\r\n").as_bytes());
    parts.extend_from_slice(PNG);
    parts.extend_from_slice(b"\r\n");
    if let Some((x, y, w, h)) = bbox {
        for (k, v) in [("x", x), ("y", y), ("width", w), ("height", h)] {
            parts.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n").as_bytes());
        }
    }
    if let Some(wj) = words {
        parts.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"words\"\r\n\r\n{wj}\r\n").as_bytes());
    }
    parts.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    Request::builder()
        .method(Method::POST)
        .uri("/api/v1/legend/box")
        .header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}"))
        .body(Body::from(parts))
        .unwrap()
}

#[tokio::test]
async fn legend_bbox_validation_too_small() {
    let app = test_app();
    let (status, body, _) = send(&app, legend_req(Some((10.0, 10.0, 5.0, 5.0)), None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "INVALID_BBOX_TOO_SMALL");
}

#[tokio::test]
async fn legend_bbox_out_of_bounds() {
    let app = test_app();
    let (status, body, _) = send(&app, legend_req(Some((5000.0, 5000.0, 100.0, 100.0)), None)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "INVALID_BBOX_OUT_OF_BOUNDS");
}

#[tokio::test]
async fn legend_bbox_not_finite() {
    let app = test_app();
    let mut parts = Vec::new();
    parts.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"test.png\"\r\nContent-Type: image/png\r\n\r\n").as_bytes());
    parts.extend_from_slice(PNG);
    parts.extend_from_slice(b"\r\n");
    parts.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"x\"\r\n\r\nNaN\r\n").as_bytes());
    parts.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"y\"\r\n\r\n10\r\n").as_bytes());
    parts.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"width\"\r\n\r\n100\r\n").as_bytes());
    parts.extend_from_slice(format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"height\"\r\n\r\n100\r\n").as_bytes());
    parts.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    let req = Request::builder().method(Method::POST).uri("/api/v1/legend/box").header(header::CONTENT_TYPE, format!("multipart/form-data; boundary={BOUNDARY}")).body(Body::from(parts)).unwrap();
    let (status, body, _) = send(&app, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "INVALID_BBOX_NOT_FINITE");
}

#[tokio::test]
async fn legend_model_unavailable_without_words() {
    let app = test_app();
    let (status, body, _) = send(&app, legend_req(Some((10.0, 10.0, 100.0, 100.0)), None)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["status"], "model_unavailable");
    assert!(body["bbox"].is_object());
    assert!(body["expandedBbox"].is_object());
}

#[tokio::test]
async fn legend_parse_two_words_accepted() {
    let app = test_app();
    let words = r#"[{"text":"A4","confidence":0.99,"x0":0,"y0":0,"x1":20,"y1":20},{"text":"(98)","confidence":0.97,"x0":30,"y0":0,"x1":60,"y1":20}]"#;
    let (status, body, _) = send(&app, legend_req(Some((10.0, 10.0, 100.0, 100.0)), Some(words))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["code"], "A4");
    assert_eq!(body["count"], 98);
    assert_eq!(body["status"], "accepted");
    assert_eq!(body["overallConfidence"], 0.98);
}

#[tokio::test]
async fn legend_parse_single_merged() {
    let app = test_app();
    let words = r#"[{"text":"A4(98)","confidence":0.95,"x0":0,"y0":0,"x1":40,"y1":20}]"#;
    let (status, body, _) = send(&app, legend_req(Some((10.0, 10.0, 100.0, 100.0)), Some(words))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["code"], "A4");
    assert_eq!(body["count"], 98);
}

#[tokio::test]
async fn legend_needs_confirmation_low_conf() {
    let app = test_app();
    let words = r#"[{"text":"H7","confidence":0.4,"x0":0,"y0":0,"x1":20,"y1":20},{"text":"6227","confidence":0.4,"x0":30,"y0":0,"x1":60,"y1":20}]"#;
    let (status, body, _) = send(&app, legend_req(Some((10.0, 10.0, 100.0, 100.0)), Some(words))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "needs_confirmation");
    assert_eq!(body["code"], "H7");
}

#[tokio::test]
async fn legend_recognition_failed_empty() {
    let app = test_app();
    let words = r#"[]"#;
    let (status, body, _) = send(&app, legend_req(Some((10.0, 10.0, 100.0, 100.0)), Some(words))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["status"], "recognition_failed");
}

#[tokio::test]
async fn legend_comma_count_normalized() {
    let app = test_app();
    let words = r#"[{"text":"M5","confidence":0.95,"x0":0,"y0":0,"x1":20,"y1":20},{"text":"(1,248)","confidence":0.95,"x0":30,"y0":0,"x1":60,"y1":20}]"#;
    let (status, body, _) = send(&app, legend_req(Some((10.0, 10.0, 100.0, 100.0)), Some(words))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["count"], 1248);
}

#[tokio::test]
async fn legend_confusable_correction() {
    let app = test_app();
    let words = r#"[{"text":"HI2","confidence":0.9,"x0":0,"y0":0,"x1":20,"y1":20},{"text":"100","confidence":0.9,"x0":30,"y0":0,"x1":50,"y1":20}]"#;
    let (status, body, _) = send(&app, legend_req(Some((10.0, 10.0, 100.0, 100.0)), Some(words))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["code"], "H12");
}

#[tokio::test]
async fn legend_expanded_clipped_to_image() {
    let app = test_app();
    let words = r#"[{"text":"A4","confidence":0.99,"x0":0,"y0":0,"x1":20,"y1":20},{"text":"98","confidence":0.99,"x0":30,"y0":0,"x1":50,"y1":20}]"#;
    let (status, body, _) = send(&app, legend_req(Some((0.0, 0.0, 100.0, 100.0)), Some(words))).await;
    assert_eq!(status, StatusCode::OK);
    let exp = &body["expandedBbox"];
    assert!(exp["x"].as_f64().unwrap() >= 0.0);
    assert!(exp["y"].as_f64().unwrap() >= 0.0);
}
