//! SQLite persistence — schema mirrors `V1__initial_schema.sql` (JSONB →
//! TEXT/JSON, BIGSERIAL → INTEGER PRIMARY KEY AUTOINCREMENT). Single
//! `Mutex<Connection>`: the local server is LAN-scale, write serialization
//! is fine and keeps everything simple.

use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::Connection;

pub type Db = Mutex<Connection>;

pub fn open(db_path: &Path) -> Result<Db> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    init_schema(&conn)?;
    Ok(Mutex::new(conn))
}

pub fn init_schema(conn: &Connection) -> Result<()> {
    // 2026-08-15: event timeline removed — drop the old table on upgrade.
    conn.execute_batch("DROP TABLE IF EXISTS recognition_job_event;")?;
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS recognition_job (
    id                  TEXT PRIMARY KEY,
    status              TEXT NOT NULL,
    stage               TEXT NOT NULL DEFAULT 'QUEUED',
    rows                INTEGER NOT NULL,
    cols                INTEGER NOT NULL,
    name                TEXT,
    crop_box            TEXT NOT NULL,
    valid_codes         TEXT,
    input_image_path    TEXT NOT NULL,
    color_library_version TEXT NOT NULL,
    model_snapshot      TEXT NOT NULL,
    attempt             INTEGER NOT NULL DEFAULT 0,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    max_retries         INTEGER NOT NULL DEFAULT 2,
    processed_cells     INTEGER NOT NULL DEFAULT 0,
    total_cells         INTEGER NOT NULL,
    heartbeat_at        TEXT,
    error_code          TEXT,
    error_message       TEXT,
    blueprint_id        TEXT UNIQUE,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recognition_job_cell (
    job_id      TEXT NOT NULL REFERENCES recognition_job(id),
    row         INTEGER NOT NULL,
    col         INTEGER NOT NULL,
    code        TEXT NOT NULL,
    status      TEXT NOT NULL,
    color_code  TEXT,
    color_name  TEXT,
    color_hex   TEXT,
    confidence  REAL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (job_id, row, col)
);

CREATE TABLE IF NOT EXISTS blueprint (
    id          TEXT PRIMARY KEY,
    job_id      TEXT NOT NULL UNIQUE REFERENCES recognition_job(id),
    rows        INTEGER NOT NULL,
    cols        INTEGER NOT NULL,
    valid_codes TEXT,
    -- 03: 物料清单「框选位置 + 行列数」按蓝图持久化（可选，旧数据为 NULL，不迁移）
    materials_box  TEXT,
    materials_rows INTEGER,
    materials_cols INTEGER,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blueprint_cell (
    blueprint_id TEXT NOT NULL REFERENCES blueprint(id),
    row          INTEGER NOT NULL,
    col          INTEGER NOT NULL,
    code         TEXT NOT NULL,
    status       TEXT NOT NULL,
    color_code   TEXT,
    color_name   TEXT,
    color_hex    TEXT,
    confidence   REAL,
    corrected_code TEXT,
    corrected_at   TEXT,
    PRIMARY KEY (blueprint_id, row, col)
);

CREATE TABLE IF NOT EXISTS color_library (
    code    TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    hex     TEXT NOT NULL,
    brand   TEXT NOT NULL,
    version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legend_entry (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL REFERENCES recognition_job(id) ON DELETE CASCADE,
    ordinal     INTEGER NOT NULL,
    row_index   INTEGER NOT NULL DEFAULT 0,
    col_index   INTEGER NOT NULL DEFAULT 0,
    code        TEXT NOT NULL,
    count       INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'accepted',
    source      TEXT NOT NULL DEFAULT 'manual',
    confirmed   INTEGER NOT NULL DEFAULT 0,
    bbox_x      REAL NOT NULL DEFAULT 0,
    bbox_y      REAL NOT NULL DEFAULT 0,
    bbox_w      REAL NOT NULL DEFAULT 0,
    bbox_h      REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (job_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_job_status ON recognition_job(status);
CREATE INDEX IF NOT EXISTS idx_job_heartbeat ON recognition_job(status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_bp_cells ON blueprint_cell(blueprint_id);
"#,
    )?;
    // 03 迁移：为旧库补拆分配置列（新库已在 CREATE TABLE 中带上；ALTER 幂等——
    // 列已存在会报 duplicate column，忽略即可，其余列继续）。
    // 注意类型：materials_rows/cols 必须 INTEGER（旧库曾被 TEXT 误建过，需修正）。
    let existing: Vec<(String, String)> = conn
        .prepare("SELECT name, type FROM pragma_table_info('blueprint')")?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let col_type = |c: &str| -> &str {
        match c {
            "materials_rows" | "materials_cols" => "INTEGER",
            _ => "TEXT",
        }
    };
    for col in ["materials_box", "materials_rows", "materials_cols"] {
        if existing.iter().any(|(n, _)| n == col) {
            // 类型错误（历史 ALTER 加成 TEXT）→ 重建为正确类型
            let t = col_type(col);
            if t == "INTEGER" {
                let _ = conn.execute(
                    &format!("ALTER TABLE blueprint DROP COLUMN {col}"),
                    [],
                );
                let _ = conn.execute(
                    &format!("ALTER TABLE blueprint ADD COLUMN {col} {t}"),
                    [],
                );
            }
        } else {
            let _ = conn.execute(
                &format!("ALTER TABLE blueprint ADD COLUMN {col} {}", col_type(col)),
                [],
            );
        }
    }
    Ok(())
}

/// Serialize a timestamp to the same ISO-8601 shape Kotlin emits
/// (`2026-08-13T12:00:00.123456+00:00`). Chrono's serde prints `Z`; the
/// frontend parses both, but tests assert against the Kotlin shape.
pub fn ts_to_sql(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

pub fn ts_from_sql(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now())
}
