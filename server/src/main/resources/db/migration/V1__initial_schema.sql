-- 008 决议：RecognitionJob 持久化 schema（Flyway 初始版本）
-- 017 修订：color_library 含 brand 列（官方编码库来源品牌，V2 已合并进 V1）
-- 表：recognition_job, recognition_job_event, recognition_job_cell, blueprint, blueprint_cell, color_library

CREATE TABLE recognition_job (
    id                  UUID PRIMARY KEY,
    status              VARCHAR(32) NOT NULL,
    stage               VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
    rows                INTEGER NOT NULL,
    cols                INTEGER NOT NULL,
    crop_box            JSONB NOT NULL,
    valid_codes         JSONB,
    input_image_path    VARCHAR(512) NOT NULL,
    color_library_version VARCHAR(128) NOT NULL,
    model_snapshot      VARCHAR(256) NOT NULL,
    attempt             INTEGER NOT NULL DEFAULT 0,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    max_retries         INTEGER NOT NULL DEFAULT 2,
    processed_cells     INTEGER NOT NULL DEFAULT 0,
    total_cells         INTEGER NOT NULL,
    heartbeat_at        TIMESTAMPTZ,
    error_code          VARCHAR(64),
    error_message       TEXT,
    blueprint_id        UUID UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_job_status CHECK (status IN ('PENDING','PROCESSING','SUCCEEDED','SUCCEEDED_WITH_WARNINGS','FAILED')),
    CONSTRAINT chk_job_stage CHECK (stage IN ('QUEUED','OCR'))
);

CREATE TABLE recognition_job_event (
    id          BIGSERIAL PRIMARY KEY,
    job_id      UUID NOT NULL REFERENCES recognition_job(id),
    attempt     INTEGER NOT NULL,
    sequence    BIGINT NOT NULL,
    type        VARCHAR(32) NOT NULL,
    payload     JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_job_event UNIQUE (job_id, attempt, sequence)
);

CREATE TABLE recognition_job_cell (
    job_id      UUID NOT NULL REFERENCES recognition_job(id),
    row         INTEGER NOT NULL,
    col         INTEGER NOT NULL,
    code        VARCHAR(8) NOT NULL,
    status      VARCHAR(16) NOT NULL,
    color_code  VARCHAR(8),
    color_name  VARCHAR(128),
    color_hex   VARCHAR(6),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_id, row, col),
    CONSTRAINT chk_cell_status CHECK (status IN ('MAPPED','UNMAPPED'))
);

CREATE TABLE blueprint (
    id          UUID PRIMARY KEY,
    job_id      UUID NOT NULL UNIQUE REFERENCES recognition_job(id),
    rows        INTEGER NOT NULL,
    cols        INTEGER NOT NULL,
    valid_codes JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE blueprint_cell (
    blueprint_id UUID NOT NULL REFERENCES blueprint(id),
    row          INTEGER NOT NULL,
    col          INTEGER NOT NULL,
    code         VARCHAR(8) NOT NULL,
    status       VARCHAR(16) NOT NULL,
    color_code   VARCHAR(8),
    color_name   VARCHAR(128),
    color_hex    VARCHAR(6),
    PRIMARY KEY (blueprint_id, row, col),
    CONSTRAINT chk_bp_cell_status CHECK (status IN ('MAPPED','UNMAPPED'))
);

CREATE TABLE color_library (
    code    VARCHAR(8) PRIMARY KEY,
    name    VARCHAR(128) NOT NULL,
    hex     VARCHAR(6) NOT NULL,
    brand   VARCHAR(32) NOT NULL,
    version VARCHAR(128) NOT NULL
);

CREATE INDEX idx_job_status ON recognition_job(status);
CREATE INDEX idx_job_heartbeat ON recognition_job(status, heartbeat_at);
CREATE INDEX idx_event_job ON recognition_job_event(job_id, attempt, sequence);
CREATE INDEX idx_bp_cells ON blueprint_cell(blueprint_id);
