//! Domain entities + API contract DTOs — mirror of `server/.../schema/Dtos.kt`
//! and the JPA entities. JSON shapes must stay identical to the Kotlin cloud
//! server (frontend types/api.ts is the shared contract).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Enums (align with server/model/Enums.kt) ─────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobStatus {
    Pending,
    Processing,
    Succeeded,
    SucceededWithWarnings,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobStage {
    Queued,
    Ocr,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CellStatus {
    Mapped,
    Unmapped,
    Blank,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventType {
    JobStarted,
    CellProcessed,
    CellFailed,
    Heartbeat,
    RetryScheduled,
    JobSucceeded,
    JobFailed,
}

// ── Entities (align with server/model/*.kt + V1__initial_schema.sql) ─

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CropBox {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Debug)]
pub struct Job {
    pub id: Uuid,
    pub status: JobStatus,
    pub stage: JobStage,
    pub rows: i64,
    pub cols: i64,
    pub name: Option<String>,
    pub crop_box: CropBox,
    pub valid_codes: Option<Vec<String>>,
    pub input_image_path: String,
    pub color_library_version: String,
    pub model_snapshot: String,
    pub attempt: i64,
    pub retry_count: i64,
    pub max_retries: i64,
    pub processed_cells: i64,
    pub total_cells: i64,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub blueprint_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct JobEvent {
    pub job_id: Uuid,
    pub attempt: i64,
    pub sequence: i64,
    pub event_type: EventType,
    pub payload: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct JobCell {
    pub job_id: Uuid,
    pub row: i64,
    pub col: i64,
    pub code: String,
    pub status: CellStatus,
    pub color_code: Option<String>,
    pub color_name: Option<String>,
    pub color_hex: Option<String>,
    pub confidence: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct Blueprint {
    pub id: Uuid,
    pub job_id: Uuid,
    pub rows: i64,
    pub cols: i64,
    pub valid_codes: Option<Vec<String>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct BlueprintCell {
    pub blueprint_id: Uuid,
    pub row: i64,
    pub col: i64,
    pub code: String,
    pub status: CellStatus,
    pub color_code: Option<String>,
    pub color_name: Option<String>,
    pub color_hex: Option<String>,
    pub confidence: Option<f64>,
    pub corrected_code: Option<String>,
    pub corrected_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
pub struct ColorEntry {
    pub code: String,
    pub name: String,
    pub hex: String,
    pub brand: String,
    pub version: String,
}

// ── API DTOs (align with server/schema/Dtos.kt) ──────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageResponse<T> {
    pub items: Vec<T>,
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
    pub total_pages: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub details: Option<serde_json::Value>,
    pub trace_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColorDto {
    pub code: String,
    pub name: String,
    pub hex: String,
    pub brand: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub model: String,
    pub color_library_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub code: String,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDetail {
    pub id: Uuid,
    pub name: Option<String>,
    pub status: JobStatus,
    pub stage: JobStage,
    pub processed_cells: i64,
    pub total_cells: i64,
    pub heartbeat_at: Option<DateTime<Utc>>,
    pub attempt: i64,
    pub max_retries: i64,
    pub retry_count: i64,
    pub blueprint_id: Option<Uuid>,
    pub error: Option<JobError>,
    pub warnings: Vec<serde_json::Value>,
    pub snapshot: SnapshotInfo,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: Uuid,
    pub name: Option<String>,
    pub status: JobStatus,
    pub stage: JobStage,
    pub processed_cells: i64,
    pub total_cells: i64,
    pub rows: i64,
    pub cols: i64,
    pub attempt: i64,
    pub retry_count: i64,
    pub blueprint_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct RenameJobRequest {
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEventDto {
    pub attempt: i64,
    pub sequence: i64,
    #[serde(rename = "type")]
    pub event_type: EventType,
    pub timestamp: DateTime<Utc>,
    pub payload: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintSummary {
    pub id: Uuid,
    pub job_id: Uuid,
    pub rows: i64,
    pub cols: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintDetail {
    pub id: Uuid,
    pub job_id: Uuid,
    pub rows: i64,
    pub cols: i64,
    pub valid_codes: Option<Vec<String>>,
    pub cells: Vec<BlueprintCellDto>,
    pub crop_box: Option<CropBox>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintCellDto {
    pub row: i64,
    pub col: i64,
    pub code: String,
    pub status: CellStatus,
    pub color: Option<ColorDto>,
    pub confidence: Option<f64>,
    pub corrected_code: Option<String>,
    pub corrected_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct CellCorrectionRequest {
    pub updates: Vec<CellCorrectionUpdate>,
}

#[derive(Deserialize)]
pub struct CellCorrectionUpdate {
    pub row: i64,
    pub col: i64,
    pub code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellCorrectionResponse {
    pub cells: Vec<BlueprintCellDto>,
    pub corrected_count: i64,
    pub reverted_count: i64,
}

/// 008 决议：内部回调入站事件（本地模式由 OCR 线程进程内投递）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundEvent {
    pub job_id: Uuid,
    pub attempt: i64,
    pub sequence: i64,
    #[serde(rename = "type")]
    pub event_type: EventType,
    pub timestamp: Option<DateTime<Utc>>,
    #[serde(default)]
    pub payload: serde_json::Value,
}
