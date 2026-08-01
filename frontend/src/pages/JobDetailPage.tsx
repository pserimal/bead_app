import { useParams, useNavigate, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useJob, useJobEvents } from '../hooks/useJobs';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { JobStatus, EventType } from '../types/api';

const statusMeta: Record<JobStatus, { label: string; color: string; bg: string }> = {
  PENDING: { label: '排队中', color: '#6B6860', bg: '#F3F1EB' },
  PROCESSING: { label: '处理中', color: '#D4802B', bg: '#FDF4EA' },
  SUCCEEDED: { label: '成功', color: '#389E5C', bg: '#EDF7F1' },
  SUCCEEDED_WITH_WARNINGS: { label: '成功（有警告）', color: '#D4802B', bg: '#FDF4EA' },
  FAILED: { label: '失败', color: '#C43529', bg: '#FEF0EE' },
};

const eventLabel: Record<EventType, string> = {
  JOB_STARTED: '任务开始',
  CELL_PROCESSED: '格子识别',
  CELL_FAILED: '格子失败',
  HEARTBEAT: '心跳',
  RETRY_SCHEDULED: '重试调度',
  JOB_SUCCEEDED: '任务完成',
  JOB_FAILED: '任务失败',
};

// 012 决议：处理中/失败任务不展示半成品棋盘，追踪视图是替代呈现
export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: job, isLoading, error } = useJob(id ?? null);
  const { data: events } = useJobEvents(id ?? null);

  const processing = job?.status === 'PENDING' || job?.status === 'PROCESSING';
  const terminal = job?.status === 'SUCCEEDED' || job?.status === 'SUCCEEDED_WITH_WARNINGS' || job?.status === 'FAILED';

  return (
    <div className="max-w-4xl mx-auto">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem} className="flex items-center justify-between">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>任务追踪</h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 2 }}>
              {id} · React Query 每 2s 轮询 · 心跳每 30s
            </p>
          </div>
          <button onClick={() => navigate('/blueprints')} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)' }}>
            ← 返回历史
          </button>
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

              {/* 警告横幅 */}
              {job.status === 'SUCCEEDED_WITH_WARNINGS' && (
                <div className="px-4 py-3 rounded-lg text-sm" style={{ background: '#FDF4EA', border: '1px solid #F0D9B8' }}>
                  <span style={{ color: '#D4802B', fontWeight: 600 }}>⚠ 存在未映射编码：</span>
                  {job.warnings.length > 0
                    ? job.warnings.map((w) => `(${w.row}, ${w.col}) ${w.code}`).join('、')
                    : '部分格子编码不在颜色库中'}
                </div>
              )}

              {/* 失败横幅 */}
              {job.status === 'FAILED' && job.error && (
                <div className="px-4 py-3 rounded-lg text-sm" style={{ background: '#FEF0EE', border: '1px solid #F5C6C0' }}>
                  <span style={{ color: '#C43529', fontWeight: 600 }}>✕ 识别失败：</span>
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

            {/* 事件时间线（只读） */}
            <motion.div variants={staggerItem} className="p-5 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
              <h2 style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: 12 }}>
                事件时间线（{events?.total ?? 0} 条）
              </h2>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {events?.items.map((ev) => (
                  <div key={`${ev.attempt}-${ev.sequence}`} className="flex items-start gap-3 text-sm py-1.5 border-b" style={{ borderColor: 'var(--color-border)' }}>
                    <span className="shrink-0 px-2 py-0.5 rounded text-xs" style={{ background: 'var(--color-surface)', color: 'var(--color-text-muted)' }}>
                      #{ev.sequence}
                    </span>
                    <span className="shrink-0 font-medium w-20">{eventLabel[ev.type]}</span>
                    <span className="flex-1 truncate" style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                      {JSON.stringify(ev.payload)}
                    </span>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }} className="shrink-0">
                      {new Date(ev.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
                {events && events.items.length === 0 && <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>暂无事件</p>}
              </div>
            </motion.div>
          </>
        )}
      </motion.div>
    </div>
  );
}
