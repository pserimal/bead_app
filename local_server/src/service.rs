//! Job/Blueprint/Color business logic — port of `server/.../service/JobService.kt`
//! + the controller query/mutation helpers. Events are applied in-process
//! (idempotent, same rules as the 008/009 protocol); the OCR worker thread
//! delivers them through the same `apply_event` path as the cloud callback.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::db::Db;
use crate::models::*;

pub const MAX_RETRIES: i64 = 2;

pub struct ApiException {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Debug for ApiException {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ApiException({}, {}, {})", self.status, self.code, self.message)
    }
}

impl std::fmt::Display for ApiException {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiException {}

impl ApiException {
    pub fn new(status: u16, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }
    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(404, code, message)
    }
    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(400, code, message)
    }
    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(409, code, message)
    }
}

fn now() -> DateTime<Utc> {
    Utc::now()
}

// ── Row mapping helpers ──────────────────────────────────────────────

fn job_from_row(row: &rusqlite::Row) -> rusqlite::Result<Job> {
    let crop_box: String = row.get("crop_box")?;
    let valid_codes: Option<String> = row.get("valid_codes")?;
    Ok(Job {
        id: Uuid::parse_str(&row.get::<_, String>("id")?).unwrap(),
        status: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>("status")?)).unwrap(),
        stage: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>("stage")?)).unwrap(),
        rows: row.get("rows")?,
        cols: row.get("cols")?,
        name: row.get("name")?,
        crop_box: serde_json::from_str(&crop_box).unwrap(),
        valid_codes: valid_codes.and_then(|v| serde_json::from_str(&v).ok()),
        input_image_path: row.get("input_image_path")?,
        color_library_version: row.get("color_library_version")?,
        model_snapshot: row.get("model_snapshot")?,
        attempt: row.get("attempt")?,
        retry_count: row.get("retry_count")?,
        max_retries: row.get("max_retries")?,
        processed_cells: row.get("processed_cells")?,
        total_cells: row.get("total_cells")?,
        heartbeat_at: row
            .get::<_, Option<String>>("heartbeat_at")?
            .as_deref()
            .map(crate::db::ts_from_sql),
        error_code: row.get("error_code")?,
        error_message: row.get("error_message")?,
        blueprint_id: row
            .get::<_, Option<String>>("blueprint_id")?
            .and_then(|s| Uuid::parse_str(&s).ok()),
        created_at: crate::db::ts_from_sql(&row.get::<_, String>("created_at")?),
        updated_at: crate::db::ts_from_sql(&row.get::<_, String>("updated_at")?),
    })
}

fn event_from_row(row: &rusqlite::Row) -> rusqlite::Result<JobEvent> {
    let payload: String = row.get("payload")?;
    Ok(JobEvent {
        job_id: Uuid::parse_str(&row.get::<_, String>("job_id")?).unwrap(),
        attempt: row.get("attempt")?,
        sequence: row.get("sequence")?,
        event_type: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>("type")?)).unwrap(),
        payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
        created_at: crate::db::ts_from_sql(&row.get::<_, String>("created_at")?),
    })
}

fn bp_cell_from_row(row: &rusqlite::Row) -> rusqlite::Result<BlueprintCell> {
    Ok(BlueprintCell {
        blueprint_id: Uuid::parse_str(&row.get::<_, String>("blueprint_id")?).unwrap(),
        row: row.get("row")?,
        col: row.get("col")?,
        code: row.get("code")?,
        status: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>("status")?)).unwrap(),
        color_code: row.get("color_code")?,
        color_name: row.get("color_name")?,
        color_hex: row.get("color_hex")?,
        confidence: row.get("confidence")?,
        corrected_code: row.get("corrected_code")?,
        corrected_at: row
            .get::<_, Option<String>>("corrected_at")?
            .as_deref()
            .map(crate::db::ts_from_sql),
    })
}

// ── Service ──────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct JobService {
    pub db: Arc<Db>,
}

impl JobService {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    /// Seed the color library (mard-only snapshot, same as ColorSeedRunner).
    pub fn seed_colors(&self, entries: &[ColorEntry]) -> Result<()> {
        let conn = self.db.lock().unwrap();
        for e in entries {
            conn.execute(
                "INSERT OR REPLACE INTO color_library(code, name, hex, brand, version)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![e.code, e.name, e.hex, e.brand, e.version],
            )?;
        }
        Ok(())
    }

    pub fn color_library_version(&self) -> String {
        let conn = self.db.lock().unwrap();
        conn.query_row("SELECT version FROM color_library LIMIT 1", [], |r| r.get::<_, String>(0))
            .unwrap_or_else(|_| "seed-3".into())
    }

    fn find_color(&self, conn: &Connection, code: &str) -> Option<ColorEntry> {
        conn.query_row(
            "SELECT code, name, hex, brand, version FROM color_library WHERE UPPER(code) = UPPER(?1)",
            [code],
            |r| {
                Ok(ColorEntry {
                    code: r.get(0)?,
                    name: r.get(1)?,
                    hex: r.get(2)?,
                    brand: r.get(3)?,
                    version: r.get(4)?,
                })
            },
        )
        .optional()
        .ok()
        .flatten()
    }

    /// 008: create job = job row + JOB_STARTED(sequence=0) in one transaction,
    /// then the caller dispatches OCR.
    pub fn create_job(
        &self,
        rows: i64,
        cols: i64,
        crop_box: CropBox,
        valid_codes: Option<Vec<String>>,
        input_image_path: String,
        color_library_version: String,
        model_snapshot: String,
        name: Option<String>,
    ) -> Result<Job> {
        let job = Job {
            id: Uuid::new_v4(),
            status: JobStatus::Pending,
            stage: JobStage::Queued,
            rows,
            cols,
            name: name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()),
            crop_box,
            valid_codes: valid_codes.map(|mut v| {
                v.sort();
                v
            }),
            input_image_path,
            color_library_version,
            model_snapshot,
            attempt: 0,
            retry_count: 0,
            max_retries: MAX_RETRIES,
            processed_cells: 0,
            total_cells: rows * cols,
            heartbeat_at: None,
            error_code: None,
            error_message: None,
            blueprint_id: None,
            created_at: now(),
            updated_at: now(),
        };
        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO recognition_job (id, status, stage, rows, cols, name, crop_box, valid_codes,
                input_image_path, color_library_version, model_snapshot, attempt, retry_count,
                max_retries, processed_cells, total_cells, heartbeat_at, error_code, error_message,
                blueprint_id, created_at, updated_at)
             VALUES (?1, 'PENDING', 'QUEUED', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, 0, ?10, 0, ?11,
                NULL, NULL, NULL, NULL, ?12, ?12)",
            params![
                job.id.to_string(),
                rows,
                cols,
                job.name,
                serde_json::to_string(&job.crop_box).unwrap(),
                job.valid_codes.as_ref().map(|v| serde_json::to_string(v).unwrap()),
                &job.input_image_path,
                &job.color_library_version,
                &job.model_snapshot,
                MAX_RETRIES,
                rows * cols,
                crate::db::ts_to_sql(job.created_at),
            ],
        )?;
        drop(conn);
        self.append_event(
            job.id,
            job.attempt,
            0,
            EventType::JobStarted,
            serde_json::json!({"rows": rows, "cols": cols}),
        )?;
        Ok(job)
    }

    pub fn rename_job(&self, id: Uuid, name: Option<String>) -> Result<Job> {
        let conn = self.db.lock().unwrap();
        let trimmed = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        let updated = conn.execute(
            "UPDATE recognition_job SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id.to_string(), trimmed, crate::db::ts_to_sql(now())],
        )?;
        if updated == 0 {
            return Err(anyhow!(ApiException::not_found("JOB_NOT_FOUND", format!("任务不存在: {id}"))));
        }
        self.get_job_conn(&conn, id)
    }

    pub fn delete_jobs(&self, ids: &[Uuid]) -> Result<usize> {
        let conn = self.db.lock().unwrap();
        let mut deleted = 0usize;
        let mut distinct: Vec<Uuid> = ids.to_vec();
        distinct.sort();
        distinct.dedup();
        for id in distinct {
            let id_s = id.to_string();
            if let Some(bp_id) = conn
                .query_row(
                    "SELECT id FROM blueprint WHERE job_id = ?1",
                    [&id_s],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                conn.execute("DELETE FROM blueprint_cell WHERE blueprint_id = ?1", [&bp_id])?;
                conn.execute("DELETE FROM blueprint WHERE id = ?1", [&bp_id])?;
            }
            conn.execute("DELETE FROM recognition_job_cell WHERE job_id = ?1", [&id_s])?;
            conn.execute("DELETE FROM recognition_job_event WHERE job_id = ?1", [&id_s])?;
            deleted += conn.execute("DELETE FROM recognition_job WHERE id = ?1", [&id_s])?;
        }
        Ok(deleted)
    }

    /// 008: idempotently apply an inbound event. Returns whether it was new.
    pub fn apply_event(&self, e: &InboundEvent) -> Result<bool> {
        let mut conn = self.db.lock().unwrap();
        let tx = conn.transaction()?;
        let job = self.get_job_conn(&tx, e.job_id)?;
        // Stale attempt: no-op (008).
        if e.attempt < job.attempt {
            return Ok(false);
        }
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM recognition_job_event WHERE job_id = ?1 AND attempt = ?2 AND sequence = ?3",
                params![e.job_id.to_string(), e.attempt, e.sequence],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            return Ok(false); // already applied (idempotent)
        }
        let terminal = matches!(job.status, JobStatus::Succeeded | JobStatus::SucceededWithWarnings | JobStatus::Failed);
        if terminal {
            return Err(anyhow!(ApiException::conflict(
                "JOB_ALREADY_TERMINAL",
                "任务已处于终态"
            )));
        }
        self.append_event_tx(&tx, e.job_id, e.attempt, e.sequence, e.event_type, e.payload.clone())?;
        match e.event_type {
            EventType::CellProcessed => self.apply_cell_processed(&tx, &job, &e.payload)?,
            EventType::CellFailed => {
                self.touch_job(&tx, &job, JobStatus::Processing, None)?;
            }
            EventType::Heartbeat => self.touch_heartbeat(&tx, &job)?,
            EventType::JobSucceeded => self.complete_job(&tx, &job, &e.payload)?,
            EventType::JobFailed => self.fail_or_retry(&tx, &job, &e.payload)?,
            EventType::JobStarted | EventType::RetryScheduled => {
                self.touch_heartbeat(&tx, &job)?;
            }
        }
        tx.commit()?;
        Ok(true)
    }

    fn apply_cell_processed(&self, tx: &Connection, job: &Job, payload: &serde_json::Value) -> Result<()> {
        let row = payload
            .get("row")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| anyhow!(ApiException::bad_request("INVALID_EVENT", "CELL_PROCESSED 缺少 row")))?;
        let col = payload
            .get("col")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| anyhow!(ApiException::bad_request("INVALID_EVENT", "CELL_PROCESSED 缺少 col")))?;
        let code = payload
            .get("code")
            .and_then(|v| v.as_str())
            .map(|s| s.to_uppercase())
            .ok_or_else(|| anyhow!(ApiException::bad_request("INVALID_EVENT", "CELL_PROCESSED 缺少 code")))?;
        let confidence = payload.get("confidence").and_then(|v| v.as_f64());
        let is_blank = code == "BLANK";
        let color = if is_blank { None } else { self.find_color(tx, &code) };
        let status = if is_blank {
            CellStatus::Blank
        } else if color.is_some() {
            CellStatus::Mapped
        } else {
            CellStatus::Unmapped
        };
        tx.execute(
            "INSERT OR REPLACE INTO recognition_job_cell (job_id, row, col, code, status, color_code,
                color_name, color_hex, confidence, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                job.id.to_string(),
                row,
                col,
                code,
                serde_json::to_string(&status).unwrap().trim_matches('"'),
                color.as_ref().map(|c| &c.code),
                color.as_ref().map(|c| &c.name),
                color.as_ref().map(|c| &c.hex),
                confidence,
                crate::db::ts_to_sql(now()),
            ],
        )?;
        let processed: i64 = tx.query_row(
            "SELECT COUNT(*) FROM recognition_job_cell WHERE job_id = ?1",
            [job.id.to_string()],
            |r| r.get(0),
        )?;
        self.touch_job(tx, job, JobStatus::Processing, Some(processed))
    }

    /// 008: JOB_SUCCEEDED → verify processed == total, atomically create blueprint.
    fn complete_job(&self, tx: &Connection, job: &Job, _payload: &serde_json::Value) -> Result<()> {
        if job.processed_cells < job.total_cells {
            return Err(anyhow!(ApiException::bad_request(
                "INVALID_EVENT",
                format!(
                    "JOB_SUCCEEDED 时 processed({}) != total({})",
                    job.processed_cells, job.total_cells
                )
            )));
        }
        let mut stmt = tx.prepare(
            "SELECT job_id, row, col, code, status, color_code, color_name, color_hex, confidence
             FROM recognition_job_cell WHERE job_id = ?1 ORDER BY row ASC, col ASC",
        )?;
        let cells: Vec<JobCell> = stmt
            .query_map([job.id.to_string()], |r| {
                Ok(JobCell {
                    job_id: Uuid::parse_str(&r.get::<_, String>(0)?).unwrap(),
                    row: r.get(1)?,
                    col: r.get(2)?,
                    code: r.get(3)?,
                    status: serde_json::from_str(&format!("\"{}\"", r.get::<_, String>(4)?)).unwrap(),
                    color_code: r.get(5)?,
                    color_name: r.get(6)?,
                    color_hex: r.get(7)?,
                    confidence: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let bp_id = Uuid::new_v4();
        tx.execute(
            "INSERT INTO blueprint (id, job_id, rows, cols, valid_codes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                bp_id.to_string(),
                job.id.to_string(),
                job.rows,
                job.cols,
                job.valid_codes.as_ref().map(|v| serde_json::to_string(v).unwrap()),
                crate::db::ts_to_sql(now()),
            ],
        )?;
        for c in &cells {
            tx.execute(
                "INSERT INTO blueprint_cell (blueprint_id, row, col, code, status, color_code,
                    color_name, color_hex, confidence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    bp_id.to_string(),
                    c.row,
                    c.col,
                    c.code,
                    serde_json::to_string(&c.status).unwrap().trim_matches('"'),
                    c.color_code,
                    c.color_name,
                    c.color_hex,
                    c.confidence,
                ],
            )?;
        }
        tx.execute(
            "UPDATE recognition_job SET blueprint_id = ?2, status = 'SUCCEEDED', updated_at = ?3 WHERE id = ?1",
            params![job.id.to_string(), bp_id.to_string(), crate::db::ts_to_sql(now())],
        )?;
        Ok(())
    }

    /// 008: JOB_FAILED → retry until max_retries, then terminal.
    fn fail_or_retry(&self, tx: &Connection, job: &Job, payload: &serde_json::Value) -> Result<()> {
        let error_code = payload.get("code").and_then(|v| v.as_str()).unwrap_or("RECOGNITION_FAILED");
        let error_message = payload.get("message").and_then(|v| v.as_str());
        if job.retry_count < job.max_retries {
            let attempt = job.attempt + 1;
            let retry_count = job.retry_count + 1;
            tx.execute(
                "UPDATE recognition_job SET retry_count = ?2, attempt = ?3, status = 'PROCESSING',
                    heartbeat_at = ?4, error_code = ?5, error_message = ?6, updated_at = ?4 WHERE id = ?1",
                params![
                    job.id.to_string(),
                    retry_count,
                    attempt,
                    crate::db::ts_to_sql(now()),
                    error_code,
                    error_message,
                ],
            )?;
            self.append_event_tx(
                tx,
                job.id,
                attempt,
                self.next_internal_sequence(tx, job.id, attempt),
                EventType::RetryScheduled,
                serde_json::json!({"nextAttempt": attempt}),
            )?;
            // Note: local mode has no re-dispatch — the caller (worker loop)
            // checks job.attempt changes and re-runs OCR if needed.
        } else {
            tx.execute(
                "UPDATE recognition_job SET status = 'FAILED', error_code = ?2, error_message = ?3,
                    heartbeat_at = ?4, updated_at = ?4 WHERE id = ?1",
                params![job.id.to_string(), error_code, error_message, crate::db::ts_to_sql(now())],
            )?;
        }
        Ok(())
    }

    fn touch_job(&self, tx: &Connection, job: &Job, status: JobStatus, processed: Option<i64>) -> Result<()> {
        let processed = processed.unwrap_or(job.processed_cells);
        tx.execute(
            "UPDATE recognition_job SET status = ?2, processed_cells = ?3, heartbeat_at = ?4,
                updated_at = ?4 WHERE id = ?1",
            params![
                job.id.to_string(),
                serde_json::to_string(&status).unwrap().trim_matches('"'),
                processed,
                crate::db::ts_to_sql(now()),
            ],
        )?;
        Ok(())
    }

    fn touch_heartbeat(&self, tx: &Connection, job: &Job) -> Result<()> {
        tx.execute(
            "UPDATE recognition_job SET heartbeat_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![job.id.to_string(), crate::db::ts_to_sql(now())],
        )?;
        Ok(())
    }

    fn append_event(
        &self,
        job_id: Uuid,
        attempt: i64,
        sequence: i64,
        event_type: EventType,
        payload: serde_json::Value,
    ) -> Result<()> {
        let conn = self.db.lock().unwrap();
        self.append_event_tx(&conn, job_id, attempt, sequence, event_type, payload)
    }

    fn append_event_tx(
        &self,
        conn: &Connection,
        job_id: Uuid,
        attempt: i64,
        sequence: i64,
        event_type: EventType,
        payload: serde_json::Value,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO recognition_job_event (job_id, attempt, sequence, type, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                job_id.to_string(),
                attempt,
                sequence,
                serde_json::to_string(&event_type).unwrap().trim_matches('"'),
                payload.to_string(),
                crate::db::ts_to_sql(now()),
            ],
        )?;
        Ok(())
    }

    /// Next free sequence within the current attempt (RETRY_SCHEDULED etc.).
    fn next_internal_sequence(&self, conn: &Connection, job_id: Uuid, attempt: i64) -> i64 {
        conn.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM recognition_job_event
             WHERE job_id = ?1 AND attempt = ?2",
            params![job_id.to_string(), attempt],
            |r| r.get(0),
        )
        .unwrap_or(1)
    }

    // ── Queries ──────────────────────────────────────────────────────

    fn get_job_conn(&self, conn: &Connection, id: Uuid) -> Result<Job> {
        conn.query_row(
            "SELECT * FROM recognition_job WHERE id = ?1",
            [id.to_string()],
            job_from_row,
        )
        .optional()?
        .ok_or_else(|| anyhow!(ApiException::not_found("JOB_NOT_FOUND", format!("识别任务不存在: {id}"))))
    }

    pub fn get_job(&self, id: Uuid) -> Result<Job> {
        let conn = self.db.lock().unwrap();
        self.get_job_conn(&conn, id)
    }

    /// Jobs stuck in PROCESSING (e.g. after a restart killed the worker).
    pub fn processing_jobs(&self) -> Vec<Job> {
        let conn = self.db.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM recognition_job WHERE status = 'PROCESSING'").unwrap();
        stmt.query_map([], job_from_row)
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    pub fn list_jobs(
        &self,
        status: Option<String>,
        page: i64,
        page_size: i64,
        sort_by: &str,
        sort_dir: &str,
    ) -> Result<(Vec<Job>, i64)> {
        let conn = self.db.lock().unwrap();
        let status_enum = match status {
            None => None,
            Some(s) => {
                let valid = ["PENDING", "PROCESSING", "SUCCEEDED", "SUCCEEDED_WITH_WARNINGS", "FAILED"];
                if !valid.contains(&s.as_str()) {
                    return Err(anyhow!(ApiException::bad_request("INVALID_JOB_STATUS", format!("非法状态: {s}"))));
                }
                Some(s)
            }
        };
        let sort_col = match sort_by {
            "createdAt" => "created_at",
            "updatedAt" => "updated_at",
            "status" => "status",
            "processedCells" => "processed_cells",
            _ => "created_at",
        };
        let dir = if sort_dir.eq_ignore_ascii_case("asc") { "ASC" } else { "DESC" };
        let where_clause = match &status_enum {
            Some(s) => format!("WHERE status = '{s}'"),
            None => String::new(),
        };
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM recognition_job {where_clause}"),
            [],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(&format!(
            "SELECT * FROM recognition_job {where_clause} ORDER BY {sort_col} {dir}, id LIMIT ?1 OFFSET ?2"
        ))?;
        let jobs = stmt
            .query_map(params![page_size, (page - 1) * page_size], job_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((jobs, total))
    }

    pub fn list_events(&self, job_id: Uuid, page: i64, page_size: i64, sort_dir: &str) -> Result<(Vec<JobEvent>, i64)> {
        let conn = self.db.lock().unwrap();
        self.get_job_conn(&conn, job_id)?; // 404 check
        let dir = if sort_dir.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" };
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM recognition_job_event WHERE job_id = ?1",
            [job_id.to_string()],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(&format!(
            "SELECT job_id, attempt, sequence, type, payload, created_at FROM recognition_job_event
             WHERE job_id = ?1 ORDER BY attempt {dir}, sequence {dir} LIMIT ?2 OFFSET ?3"
        ))?;
        let events = stmt
            .query_map(params![job_id.to_string(), page_size, (page - 1) * page_size], event_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((events, total))
    }

    pub fn get_blueprint(&self, id: Uuid) -> Result<(Blueprint, Job, Vec<BlueprintCell>)> {
        let conn = self.db.lock().unwrap();
        let bp = conn
            .query_row(
                "SELECT * FROM blueprint WHERE id = ?1",
                [id.to_string()],
                |r| {
                    Ok(Blueprint {
                        id: Uuid::parse_str(&r.get::<_, String>(0)?).unwrap(),
                        job_id: Uuid::parse_str(&r.get::<_, String>(1)?).unwrap(),
                        rows: r.get(2)?,
                        cols: r.get(3)?,
                        valid_codes: r
                            .get::<_, Option<String>>(4)?
                            .and_then(|v| serde_json::from_str(&v).ok()),
                        created_at: crate::db::ts_from_sql(&r.get::<_, String>(5)?),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!(ApiException::not_found("BLUEPRINT_NOT_FOUND", format!("图纸不存在: {id}"))))?;
        let job = self.get_job_conn(&conn, bp.job_id)?;
        let mut stmt = conn.prepare(
            "SELECT * FROM blueprint_cell WHERE blueprint_id = ?1 ORDER BY row ASC, col ASC",
        )?;
        let cells = stmt
            .query_map([id.to_string()], bp_cell_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((bp, job, cells))
    }

    pub fn list_blueprints(&self, page: i64, page_size: i64) -> Result<(Vec<Blueprint>, i64)> {
        let conn = self.db.lock().unwrap();
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM blueprint", [], |r| r.get(0))?;
        let mut stmt = conn.prepare("SELECT * FROM blueprint ORDER BY created_at DESC, id LIMIT ?1 OFFSET ?2")?;
        let bps = stmt
            .query_map(params![page_size, (page - 1) * page_size], |r| {
                Ok(Blueprint {
                    id: Uuid::parse_str(&r.get::<_, String>(0)?).unwrap(),
                    job_id: Uuid::parse_str(&r.get::<_, String>(1)?).unwrap(),
                    rows: r.get(2)?,
                    cols: r.get(3)?,
                    valid_codes: r
                        .get::<_, Option<String>>(4)?
                        .and_then(|v| serde_json::from_str(&v).ok()),
                    created_at: crate::db::ts_from_sql(&r.get::<_, String>(5)?),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((bps, total))
    }

    pub fn list_colors(&self, q: Option<&str>, page: i64, page_size: i64) -> Result<(Vec<ColorEntry>, i64)> {
        let conn = self.db.lock().unwrap();
        let prefix = q.map(|s| s.trim().to_uppercase());
        let (all, total): (Vec<ColorEntry>, i64) = match &prefix {
            Some(p) => {
                let mut stmt = conn.prepare(
                    "SELECT code, name, hex, brand, version FROM color_library WHERE UPPER(code) LIKE ?1",
                )?;
                let rows = stmt
                    .query_map([format!("{p}%")], |r| {
                        Ok(ColorEntry {
                            code: r.get(0)?,
                            name: r.get(1)?,
                            hex: r.get(2)?,
                            brand: r.get(3)?,
                            version: r.get(4)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let total = rows.len() as i64;
                (rows, total)
            }
            None => {
                let mut stmt = conn.prepare("SELECT code, name, hex, brand, version FROM color_library")?;
                let rows = stmt
                    .query_map([], |r| {
                        Ok(ColorEntry {
                            code: r.get(0)?,
                            name: r.get(1)?,
                            hex: r.get(2)?,
                            brand: r.get(3)?,
                            version: r.get(4)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let total = rows.len() as i64;
                (rows, total)
            }
        };
        // Natural numeric sort: A1 < A2 < A10 (mirrors ColorController).
        let mut sorted = all;
        sorted.sort_by(|a, b| {
            let ak = a.code.chars().next().unwrap_or('0');
            let bk = b.code.chars().next().unwrap_or('0');
            let an: i64 = a.code.get(1..).map(|s| s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(i64::MAX)).unwrap_or(i64::MAX);
            let bn: i64 = b.code.get(1..).map(|s| s.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(i64::MAX)).unwrap_or(i64::MAX);
            ak.cmp(&bk).then(an.cmp(&bn)).then(a.code.cmp(&b.code))
        });
        let start = ((page - 1) * page_size).min(sorted.len() as i64) as usize;
        let end = (start + page_size as usize).min(sorted.len());
        Ok((sorted[start..end].to_vec(), total))
    }

    pub fn get_color(&self, code: &str) -> Result<ColorEntry> {
        let conn = self.db.lock().unwrap();
        self.find_color(&conn, code).ok_or_else(|| {
            anyhow!(ApiException::not_found("COLOR_NOT_FOUND", format!("颜色不存在: {code}")))
        })
    }

    /// PATCH blueprint cells: batch set/revert corrected codes (atomic).
    pub fn update_blueprint_cells(&self, id: Uuid, updates: &[CellCorrectionUpdate]) -> Result<CellCorrectionResponse> {
        if updates.is_empty() {
            return Err(anyhow!(ApiException::bad_request("EMPTY_UPDATES", "updates 不能为空")));
        }
        let mut conn = self.db.lock().unwrap();
        let tx = conn.transaction()?;
        let bp = tx
            .query_row(
                "SELECT id, job_id, rows, cols, valid_codes, created_at FROM blueprint WHERE id = ?1",
                [id.to_string()],
                |r| {
                    Ok(Blueprint {
                        id: Uuid::parse_str(&r.get::<_, String>(0)?).unwrap(),
                        job_id: Uuid::parse_str(&r.get::<_, String>(1)?).unwrap(),
                        rows: r.get(2)?,
                        cols: r.get(3)?,
                        valid_codes: r
                            .get::<_, Option<String>>(4)?
                            .and_then(|v| serde_json::from_str(&v).ok()),
                        created_at: crate::db::ts_from_sql(&r.get::<_, String>(5)?),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!(ApiException::not_found("BLUEPRINT_NOT_FOUND", format!("图纸不存在: {id}"))))?;
        let valid: std::collections::HashSet<String> = match &bp.valid_codes {
            Some(v) if !v.is_empty() => v.iter().cloned().collect(),
            _ => {
                // Fallback to the full color library for legacy/no-codes jobs.
                let mut stmt = tx.prepare("SELECT code FROM color_library")?;
                stmt.query_map([], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<std::collections::HashSet<_>>>()?
            }
        };
        let mut corrected_count = 0i64;
        let mut reverted_count = 0i64;
        let mut cells_out = Vec::with_capacity(updates.len());
        for u in updates {
            if u.row < 0 || u.row >= bp.rows || u.col < 0 || u.col >= bp.cols {
                return Err(anyhow!(ApiException::bad_request(
                    "CELL_OUT_OF_BOUNDS",
                    format!("格子越界: ({}, {})", u.row, u.col)
                )));
            }
            let cell = tx
                .query_row(
                    "SELECT * FROM blueprint_cell WHERE blueprint_id = ?1 AND row = ?2 AND col = ?3",
                    params![id.to_string(), u.row, u.col],
                    bp_cell_from_row,
                )
                .optional()?
                .ok_or_else(|| {
                    anyhow!(ApiException::bad_request("CELL_NOT_FOUND", format!("格子不存在: ({}, {})", u.row, u.col)))
                })?;
            let new_code = u.code.as_deref().map(|s| s.trim().to_uppercase()).filter(|s| !s.is_empty());
            if let Some(c) = &new_code {
                if c.len() > 8 {
                    return Err(anyhow!(ApiException::bad_request("INVALID_CODE", format!("编码过长: {c}"))));
                }
                if c != "BLANK" && !valid.contains(c) {
                    return Err(anyhow!(ApiException::bad_request("INVALID_CODE", format!("编码不在颜色库: {c}"))));
                }
            }
            let effective = new_code.clone().unwrap_or_else(|| cell.code.clone());
            let is_blank = effective == "BLANK";
            let color = if is_blank { None } else { self.find_color(&tx, &effective) };
            let status = if is_blank {
                CellStatus::Blank
            } else if color.is_some() {
                CellStatus::Mapped
            } else {
                CellStatus::Unmapped
            };
            let (corrected_code, corrected_at) = match &new_code {
                Some(c) => {
                    corrected_count += 1;
                    (Some(c.clone()), Some(now()))
                }
                None => {
                    if cell.corrected_code.is_some() {
                        reverted_count += 1;
                    }
                    (None, None)
                }
            };
            tx.execute(
                "UPDATE blueprint_cell SET status = ?2, color_code = ?3, color_name = ?4, color_hex = ?5,
                    corrected_code = ?6, corrected_at = ?7 WHERE blueprint_id = ?1 AND row = ?8 AND col = ?9",
                params![
                    id.to_string(),
                    serde_json::to_string(&status).unwrap().trim_matches('"'),
                    color.as_ref().map(|c| &c.code),
                    color.as_ref().map(|c| &c.name),
                    color.as_ref().map(|c| &c.hex),
                    corrected_code,
                    corrected_at.map(crate::db::ts_to_sql),
                    u.row,
                    u.col,
                ],
            )?;
            cells_out.push(BlueprintCellDto {
                row: cell.row,
                col: cell.col,
                code: cell.code,
                status,
                color: color.map(|c| ColorDto { code: c.code, name: c.name, hex: c.hex, brand: Some(c.brand) }),
                confidence: cell.confidence,
                corrected_code,
                corrected_at,
            });
        }
        tx.commit()?;
        Ok(CellCorrectionResponse {
            cells: cells_out,
            corrected_count,
            reverted_count,
        })
    }

    /// Path of the stored original image for a blueprint.
    pub fn blueprint_image_path(&self, bp_id: Uuid) -> Result<String> {
        let conn = self.db.lock().unwrap();
        let job_id: String = conn
            .query_row(
                "SELECT job_id FROM blueprint WHERE id = ?1",
                [bp_id.to_string()],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| anyhow!(ApiException::not_found("BLUEPRINT_NOT_FOUND", format!("图纸不存在: {bp_id}"))))?;
        conn.query_row(
            "SELECT input_image_path FROM recognition_job WHERE id = ?1",
            [job_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!(ApiException::not_found("JOB_NOT_FOUND", "任务不存在")))
    }

    /// Corrected cells of a blueprint (for zip export).
    pub fn corrected_cells(&self, bp_id: Uuid) -> Result<(Blueprint, Vec<BlueprintCell>)> {
        let conn = self.db.lock().unwrap();
        let bp = conn
            .query_row(
                "SELECT * FROM blueprint WHERE id = ?1",
                [bp_id.to_string()],
                |r| {
                    Ok(Blueprint {
                        id: Uuid::parse_str(&r.get::<_, String>(0)?).unwrap(),
                        job_id: Uuid::parse_str(&r.get::<_, String>(1)?).unwrap(),
                        rows: r.get(2)?,
                        cols: r.get(3)?,
                        valid_codes: r
                            .get::<_, Option<String>>(4)?
                            .and_then(|v| serde_json::from_str(&v).ok()),
                        created_at: crate::db::ts_from_sql(&r.get::<_, String>(5)?),
                    })
                },
            )
            .optional()?
            .ok_or_else(|| anyhow!(ApiException::not_found("BLUEPRINT_NOT_FOUND", format!("图纸不存在: {bp_id}"))))?;
        let mut stmt = conn.prepare(
            "SELECT * FROM blueprint_cell WHERE blueprint_id = ?1 AND corrected_code IS NOT NULL ORDER BY row, col",
        )?;
        let cells = stmt
            .query_map([bp_id.to_string()], bp_cell_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((bp, cells))
    }
}
