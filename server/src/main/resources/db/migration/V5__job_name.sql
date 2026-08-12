-- 019: 任务自定义名称（上传时可选；历史任务可改名）
ALTER TABLE recognition_job ADD COLUMN name VARCHAR(128);
