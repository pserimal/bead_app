import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useJobs } from '../hooks/useJobs';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { JobStatus } from '../types/api';

const STATUS_FILTERS: Array<{ value: JobStatus | ''; label: string }> = [  { value: '', label: '全部' },
  { value: 'PENDING', label: '排队中' },
  { value: 'PROCESSING', label: '处理中' },
  { value: 'SUCCEEDED', label: '成功' },
  { value: 'SUCCEEDED_WITH_WARNINGS', label: '有警告' },
  { value: 'FAILED', label: '失败' },
];

const statusStyle: Record<JobStatus, { bg: string; color: string; label: string }> = {
  PENDING: { bg: '#F3F1EB', color: '#6B6860', label: '排队中' },
  PROCESSING: { bg: '#FDF4EA', color: '#D4802B', label: '处理中' },
  SUCCEEDED: { bg: '#EDF7F1', color: '#389E5C', label: '成功' },
  SUCCEEDED_WITH_WARNINGS: { bg: '#FDF4EA', color: '#D4802B', label: '有警告' },
  FAILED: { bg: '#FEF0EE', color: '#C43529', label: '失败' },
};

export default function HistoryPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useJobs(status || undefined, page);

  return (
    <div className="max-w-5xl mx-auto">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>识别任务历史</h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
            点击任务查看只读追踪详情
          </p>
        </motion.div>

        <motion.div variants={staggerItem} className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => { setStatus(f.value); setPage(1); }}
              className="px-3 py-1.5 rounded-full text-sm"
              style={{
                background: status === f.value ? 'var(--color-accent)' : 'var(--color-card)',
                color: status === f.value ? '#fff' : 'var(--color-text)',
                border: `1px solid ${status === f.value ? 'var(--color-accent)' : 'var(--color-border)'}`,
              }}
            >
              {f.label}
            </button>
          ))}
        </motion.div>

        {isLoading && <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>}
        {error && <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>}

        {data && data.items.length === 0 && (
          <div className="py-16 text-center" style={{ color: 'var(--color-text-muted)' }}>
            <div style={{ fontSize: 40 }}>📋</div>
            <p style={{ marginTop: 8 }}>暂无识别任务，去上传页创建一个吧</p>
          </div>
        )}

        {data && data.items.length > 0 && (
          <motion.div variants={staggerItem} className="space-y-2">
            {data.items.map((job) => {
              const st = statusStyle[job.status];
              return (
                <div
                  key={job.id}
                  onClick={() => navigate(`/jobs/${job.id}`)}
                  className="flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition"
                  style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--color-border-strong)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--color-border)')}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="shrink-0 px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: st.bg, color: st.color }}>
                      {st.label}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm" style={{ fontWeight: 500 }}>{job.id.slice(0, 8)}…</p>
                      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                        {job.rows}×{job.cols} · {job.processedCells}/{job.totalCells} · 尝试 {job.attempt + 1}
                        {job.retryCount > 0 ? `（已重试 ${job.retryCount} 次）` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                      {new Date(job.createdAt).toLocaleString()}
                    </p>
                    {job.blueprintId && (
                      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-success)' }}>→ 图纸已生成</p>
                    )}
                  </div>
                </div>
              );
            })}

            <div className="flex items-center justify-between pt-3">
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                共 {data.total} 条 · 第 {data.page}/{Math.max(data.totalPages, 1)} 页
              </span>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1.5 rounded-lg text-sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  style={{ border: '1px solid var(--color-border)', opacity: page <= 1 ? 0.4 : 1 }}
                >
                  上一页
                </button>
                <button
                  className="px-3 py-1.5 rounded-lg text-sm"
                  disabled={page >= data.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  style={{ border: '1px solid var(--color-border)', opacity: page >= data.totalPages ? 0.4 : 1 }}
                >
                  下一页
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
