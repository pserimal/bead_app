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

// ── Entities (align with server/model/*.kt + V1__initial_schema.sql) ─

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CropBox {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// Normalized material-list capture rectangle (fractions of the source image,
/// 0..=1). Mirrors the frontend Box {x,y,w,h} in image coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialsBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// 归一化矩形：无值/非法时保持 None；坐标会被限制到 [0,1]。
pub fn parse_materials_box(s: &str) -> Option<MaterialsBox> {
    let b: MaterialsBox = serde_json::from_str(s).ok()?;
    Some(b.clamped())
}

impl MaterialsBox {
    /// 归一化矩形必须位于 [0,1]² 且宽高为正；非法时返回 None（调用方按未保存处理）。
    pub fn clamped(self) -> MaterialsBox {
        let x = self.x.clamp(0.0, 1.0);
        let y = self.y.clamp(0.0, 1.0);
        let w = self.w.clamp(0.0, 1.0 - x);
        let h = self.h.clamp(0.0, 1.0 - y);
        MaterialsBox { x, y, w, h }
    }
    pub fn is_valid(&self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.w.is_finite()
            && self.h.is_finite()
            && (0.0..=1.0).contains(&self.x)
            && (0.0..=1.0).contains(&self.y)
            && (0.0..=1.0).contains(&self.w)
            && (0.0..=1.0).contains(&self.h)
            && self.w > 0.0
            && self.h > 0.0
    }
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
    /// Optional material-list capture config persisted with the blueprint
    /// (None for old data / never saved). Stored normalized (0..=1).
    pub materials_box: Option<MaterialsBox>,
    pub materials_rows: Option<i64>,
    pub materials_cols: Option<i64>,
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
    /// 物料拆分配置（框选位置 + 行列数），归一化存储；旧数据为 null/None。
    pub materials_box: Option<MaterialsBox>,
    pub materials_rows: Option<i64>,
    pub materials_cols: Option<i64>,
    pub created_at: DateTime<Utc>,
}

// Legend entry DTOs (图例识别与对比) — persisted per job, read via
// blueprint (1:1). `LegendEntryDto` doubles as the save-request item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendBboxDto {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendEntryDto {
    /// Stable per-job ordering (frontend assigns; UNIQUE with job_id).
    pub ordinal: i64,
    pub row_index: i64,
    pub col_index: i64,
    pub code: String,
    pub count: i64,
    /// accepted | needs_confirmation | manual
    #[serde(default = "default_legend_status")]
    pub status: String,
    /// rec | manual | edit
    #[serde(default = "default_legend_source")]
    pub source: String,
    #[serde(default)]
    pub confirmed: bool,
    /// Source-image crop rect (for sample export).
    #[serde(default = "default_legend_bbox")]
    pub bbox: LegendBboxDto,
}

fn default_legend_status() -> String {
    "accepted".to_string()
}
fn default_legend_source() -> String {
    "manual".to_string()
}
fn default_legend_bbox() -> LegendBboxDto {
    LegendBboxDto { x: 0.0, y: 0.0, width: 0.0, height: 0.0 }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendSaveCount {
    pub count: i64,
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

// 拆分配置（归一化材料框 + 网格行列数）——blueprint 可选持久化字段。
// 保存请求：PATCH /blueprints/{id}（与摘要/详情共用同一套字段名）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintMaterialsConfig {
    /// 归一化框选矩形（源图坐标比例 0..=1）。
    #[serde(default)]
    pub materials_box: Option<MaterialsBox>,
    /// 网格行数/列数（1..=20，0 表示未设置）。
    #[serde(default)]
    pub materials_rows: Option<i64>,
    #[serde(default)]
    pub materials_cols: Option<i64>,
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

