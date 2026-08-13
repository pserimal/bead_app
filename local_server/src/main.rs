//! bead-local-server — ai_dou local LAN runtime (Rust).
//!
//! Single binary replacing (for local deployments) the Kotlin Spring cloud
//! server + Python image-service pair: embedded axum API + SQLite + ONNX
//! CRNN OCR. The /api/v1 contract and the shared React frontend are
//! identical to the cloud deployment.
//!
//! Current status: OCR core (P1). The axum HTTP layer lands in P2.

fn main() {
    println!("bead-local-server 0.1.0 — OCR core (P1). axum API arrives in P2.");
}
