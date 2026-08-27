//! bead-local-server library crate.
//!
//! OCR core (P1, `ocr/`) + axum API / SQLite service layer (P2, `api.rs`,
//! `service.rs`, `db.rs`, `models.rs`, `export.rs`) — a single-binary local
//! LAN runtime mirroring the Kotlin cloud server's /api/v1 contract.

pub mod api;
pub mod db;
pub mod export;
pub mod legend;
pub mod legend_enhance;
pub mod legend_ocr;
pub mod models;
pub mod ocr;
pub mod service;
