import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useJob } from '../hooks/useJobs';
import Button from '../components/Button';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { JobStatus } from '../types/api';

const statusMeta: Record<JobStatus, { label: string; color: string; bg: string }> = {
  PENDING: { label: '排队中', color: 'var(--color-text-muted)', bg: 'var(--color-bg-secondary)' },
  PROCESSING: { label: '处理中', color: 'var(--color-warning)', bg: 'var(--color-warning-light)' },
  SUCCEEDED: { label: '成功', color: 'var(--color-success)', bg: 'var(--color-success-light)' },
  SUCCEEDED_WITH_WARNINGS: { label: '成功', color: 'var(--color-success)', bg: 'var(--color-success-light)' },
  FAILED: { label: '失败', color: 'var(--color-error)', bg: 'var(--color-error-light)' },
};

// 012 决议：处理中/失败任务不展示半成品棋盘，追踪视图是替代呈现
export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: job, isLoading, error } = useJob(id ?? null);

  const processing = job?.status === 'PENDING' || job?.status === 'PROCESSING';
  const terminal = job?.status === 'SUCCEEDED' || job?.status === 'SUCCEEDED_WITH_WARNINGS' || job?.status === 'FAILED';

  return (
    <div className="max-w-4xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem} className="flex items-center justify-between">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 700, lineHeight: 1.2 }}>任务追踪</h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 2 }}>
              {id}
            </p>
          </div>
          <Button variant="secondary" size="sm" className="!border !border-[var(--color-border-strong)]" onClick={() => navigate('/blueprints')}>← 返回历史</Button>
        </motion.div>

        {isLoading && <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>}
        {error && <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>}

        {job && (
          <>
            <motion.div variants={staggerItem} className="p-5 rounded-xl space-y-4" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
              <div className="flex items-center justify-between">
                <span className="px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: statusMeta[job.status].bg, color: statusMeta[job.status].color }}>
                  {statusMeta[job.status].label}
                </span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  尝试 {job.attempt + 1}/{job.maxRetries + 1} · 已重试 {job.retryCount} 次
                </span>
              </div>

              {/* 进度条：处理中显示，终态显示 100% */}
              <div>
                <div className="flex justify-between mb-1">
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                    {job.processedCells}/{job.totalCells} 格
                  </span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                    {job.totalCells > 0 ? Math.round((job.processedCells / job.totalCells) * 100) : 0}%
                  </span>
                </div>
                <div className="h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--color-surface)' }}>
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: processing ? 'var(--color-warning)' : 'var(--color-success)' }}
                    animate={{ width: `${job.totalCells > 0 ? (job.processedCells / job.totalCells) * 100 : 0}%` }}
                    transition={{ duration: 0.4 }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>模型</p>
                  <p>{job.snapshot.model}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>颜色库版本</p>
                  <p>{job.snapshot.colorLibraryVersion}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>创建时间</p>
                  <p>{new Date(job.createdAt).toLocaleString()}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>最后心跳</p>
                  <p>{job.heartbeatAt ? new Date(job.heartbeatAt).toLocaleTimeString() : '—'}</p>
                </div>
              </div>

              {/* 警告横幅（018：不依赖状态——按 warnings 明细展示未映射编码） */}
              {job.warnings.length > 0 && (
                <div className="px-4 py-3 rounded-lg text-sm" style={{ background: 'var(--color-warning-light)', border: '1px solid var(--color-warning)' }}>
                  <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>⚠ 存在未映射编码：</span>
                  {job.warnings.length > 0
                    ? job.warnings.map((w) => `(${w.row}, ${w.col}) ${w.code}`).join('、')
                    : '部分格子编码不在颜色库中'}
                </div>
              )}

              {/* 失败横幅 */}
              {job.status === 'FAILED' && job.error && (
                <div className="px-4 py-3 rounded-lg text-sm" style={{ background: 'var(--color-error-light)', border: '1px solid var(--color-error)' }}>
                  <span style={{ color: 'var(--color-error)', fontWeight: 600 }}>✕ 识别失败：</span>
                  {job.error.message}（{job.error.code}）
                </div>
              )}

              {/* 终态动作 */}
              {terminal && (
                <div className="flex gap-3 pt-1">
                  {job.blueprintId && (
                    <Link to={`/blueprints/${job.blueprintId}`}>
                      <button className="px-4 py-2 rounded-lg text-sm text-white" style={{ background: 'var(--color-accent)' }}>
                        查看图纸
                      </button>
                    </Link>
                  )}
                </div>
              )}
            </motion.div>
          </>
        )}
      </motion.div>
    </div>
  );
}
