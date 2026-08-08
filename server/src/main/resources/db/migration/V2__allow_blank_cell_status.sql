-- BLANK is a recognized empty-cell state, not an unmapped color.
ALTER TABLE recognition_job_cell
    DROP CONSTRAINT chk_cell_status;

ALTER TABLE recognition_job_cell
    ADD CONSTRAINT chk_cell_status
    CHECK (status IN ('MAPPED', 'UNMAPPED', 'BLANK'));

ALTER TABLE blueprint_cell
    DROP CONSTRAINT chk_bp_cell_status;

ALTER TABLE blueprint_cell
    ADD CONSTRAINT chk_bp_cell_status
    CHECK (status IN ('MAPPED', 'UNMAPPED', 'BLANK'));
