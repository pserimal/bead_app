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

/// Resolve a path with precedence: env var → candidates relative to the exe
/// directory (release layout `data/…`, repo layout `../server/…`) → candidates
/// relative to the current working directory (dev: cargo run from repo root
/// or local_server/).
fn resolve_path(env_key: &str, exe_candidates: &[&str], cwd_candidates: &[&str]) -> String {
    if let Ok(v) = std::env::var(env_key) {
        if !v.is_empty() {
            return v;
        }
    }
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();
    for c in exe_candidates {
        let p = exe_dir.join(c);
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }
    for c in cwd_candidates {
        if std::path::Path::new(c).exists() {
            return c.to_string();
        }
    }
    exe_candidates[0].to_string()
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
    let db_path = env_or("BEAD_DB_PATH", "data/bead-local.db");
    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let uploads_dir = env_or("BEAD_UPLOADS_DIR", "uploads");
    let colors_path = resolve_path(
        "BEAD_COLORS_PATH",
        &["data/default_colors.json", "../server/src/main/resources/default_colors.json"],
        &["server/src/main/resources/default_colors.json"],
    );
    let library_path = resolve_path(
        "BEAD_LIBRARY_PATH",
        &["data/library.json", "../artifacts/colors/library.json"],
        &["artifacts/colors/library.json"],
    );
    // Models directory + persisted active model (BEAD_ARTIFACT_DIR env wins).
    let models_dir = resolve_path(
        "BEAD_MODELS_DIR",
        &["models", "../artifacts/models"],
        &["artifacts/models"],
    );
    let current_file = std::path::Path::new(&db_path)
        .parent()
        .map(|p| p.join("model-current.txt"))
        .unwrap_or_else(|| std::path::PathBuf::from("data/model-current.txt"));
    let persisted = std::fs::read_to_string(&current_file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let artifact_dir = std::env::var("BEAD_ARTIFACT_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| {
            // Persisted value is a bare artifact dir name — resolve against models_dir.
            persisted.map(|p| std::path::Path::new(&models_dir).join(p).to_string_lossy().to_string())
        })
        .unwrap_or_else(|| {
            let d = std::path::Path::new(&models_dir).join("bean-mard-v11-2026-08-14T00-00-00Z");
            d.to_string_lossy().to_string()
        });

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
        frontend: bead_local_server::api::Frontend::resolve("dist"),
        models_dir: std::path::PathBuf::from(models_dir.clone()),
        model_current_file: current_file,
    });

    // Resume jobs interrupted by a previous shutdown (re-run OCR in-process).
    bead_local_server::api::resume_interrupted(&state);
    // Historical cleanup: cap cell events / drop cell copies for jobs that
    // finished under an older version (keeps the db file compact).
    let pruned = state.service.prune_terminal_history();
    if pruned > 0 {
        println!("[start] pruned history for {pruned} terminal jobs");
    }

    let app = router(state).layer(tower_http::cors::CorsLayer::permissive());
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("[start] bead-local-server listening on http://{addr}  (LAN: http://<this-machine-ip>:{port})");
    axum::serve(listener, app).await?;
    Ok(())
}
