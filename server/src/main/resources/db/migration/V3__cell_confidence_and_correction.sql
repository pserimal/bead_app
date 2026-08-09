-- 低置信度校正：每格置信度（来自 CELL_PROCESSED payload）+ 用户修正字段。
-- corrected_code = 用户修正后的编码（保留原 code 用于对比）；corrected_at = 修正时间。
ALTER TABLE recognition_job_cell ADD COLUMN confidence DOUBLE PRECISION;

ALTER TABLE blueprint_cell ADD COLUMN confidence DOUBLE PRECISION;
ALTER TABLE blueprint_cell ADD COLUMN corrected_code VARCHAR(8);
ALTER TABLE blueprint_cell ADD COLUMN corrected_at TIMESTAMPTZ;
