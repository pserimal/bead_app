//! bead-local-server — ai_dou local LAN runtime (Rust).
//!
//! Single binary replacing (for local deployments) the Kotlin Spring cloud
//! server + Python image-service pair: embedded axum API + SQLite + ONNX
//! CRNN OCR. The /api/v1 contract and the shared React frontend are
//! identical to the cloud deployment.
//!
//! Env: BEAD_PORT (default 8080), BEAD_ARTIFACT_DIR (model.onnx dir),
//! BEAD_DB_PATH (SQLite file, default data/bead-local.db),
//! BEAD_UPLOADS_DIR (default uploads/), BEAD_COLORS_PATH (seed JSON),
//! ORT_DYLIB_PATH (onnxruntime.dll).

use std::sync::{Arc, Mutex};

use bead_local_server::api::{router, AppState};
use bead_local_server::db;
use bead_local_server::models::ColorEntry;
use bead_local_server::service::JobService;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn load_color_seed(path: &str) -> Vec<ColorEntry> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("[colors] seed file missing ({path}): {e}; color API will be empty");
        "[]".to_string()
    });
    let version = "seed-3";
    serde_json::from_str::<Vec<serde_json::Value>>(&text)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| {
            let code = v.get("code")?.as_str()?.to_string();
            let name = v.get("color_name").or_else(|| v.get("name"))?.as_str()?.to_string();
            // ColorSeedRunner strips the '#' prefix; the API contract has no '#'.
            let hex = v
                .get("color_hex")
                .or_else(|| v.get("hex"))?
                .as_str()?
                .trim_start_matches('#')
                .to_string();
            let brand = v.get("brand").and_then(|b| b.as_str()).unwrap_or("mard").to_string();
            Some(ColorEntry { code, name, hex, brand, version: version.to_string() })
        })
        .collect()
}

fn load_mard_codes(library_path: &str) -> Vec<String> {
    let text = std::fs::read_to_string(library_path).unwrap_or_else(|e| {
        eprintln!("[lib] library.json missing ({library_path}): {e}; OCR vocabulary empty");
        "[]".to_string()
    });
    serde_json::from_str::<Vec<serde_json::Value>>(&text)
        .unwrap_or_default()
        .into_iter()
        .filter(|v| v.get("brand").and_then(|b| b.as_str()) == Some("mard"))
        .filter_map(|v| v.get("code").and_then(|c| c.as_str()).map(String::from))
        .collect()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port: u16 = env_or("BEAD_PORT", "8080").parse().unwrap_or(8080);
    let artifact_dir = env_or(
        "BEAD_ARTIFACT_DIR",
        "artifacts/models/crnn_color_mard_v8-2026-08-09T04-30-00Z",
    );
    let db_path = env_or("BEAD_DB_PATH", "data/bead-local.db");
    let uploads_dir = env_or("BEAD_UPLOADS_DIR", "uploads");
    let colors_path = env_or("BEAD_COLORS_PATH", "server/src/main/resources/default_colors.json");
    let library_path = env_or("BEAD_LIBRARY_PATH", "artifacts/colors/library.json");

    let db = db::open(std::path::Path::new(&db_path))?;
    let service = JobService::new(Arc::new(db));
    service.seed_colors(&load_color_seed(&colors_path))?;
    let seed_version = service.color_library_version();

    let model = bead_local_server::ocr::OnnxModel::load(std::path::Path::new(&artifact_dir))?;
    let mard_codes = load_mard_codes(&library_path);
    println!(
        "[start] model={artifact_dir} chars={} mard_codes={} colors_version={seed_version} db={db_path}",
        model.chars.len(),
        mard_codes.len()
    );

    let state = Arc::new(AppState {
        service,
        model: Arc::new(Mutex::new(Some(model))),
        mard_codes,
        uploads_dir: std::path::PathBuf::from(uploads_dir),
        seed_version,
        auto_ocr: true,
    });

    let app = router(state).layer(tower_http::cors::CorsLayer::permissive());
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("[start] bead-local-server listening on http://{addr}  (LAN: http://<this-machine-ip>:{port})");
    axum::serve(listener, app).await?;
    Ok(())
}
