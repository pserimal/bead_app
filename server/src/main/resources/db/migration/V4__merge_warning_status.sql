-- 018：合并警告状态到成功。历史 SUCCEEDED_WITH_WARNINGS 一律归入 SUCCEEDED
-- （新任务由 JobService 直接写 SUCCEEDED；warnings 明细仍在 recognition_job.warnings）
UPDATE recognition_job SET status = 'SUCCEEDED' WHERE status = 'SUCCEEDED_WITH_WARNINGS';
