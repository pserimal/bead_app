import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useJobs, useRenameJob, useDeleteJobs } from '../hooks/useJobs';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { JobStatus } from '../types/api';

const STATUS_FILTERS: Array<{ value: JobStatus | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'PENDING', label: '排队中' },
  { value: 'PROCESSING', label: '处理中' },
  { value: 'SUCCEEDED', label: '成功' },
  { value: 'SUCCEEDED_WITH_WARNINGS', label: '有警告' },
  { value: 'FAILED', label: '失败' },
];

const statusStyle: Record<JobStatus, { bg: string; color: string; label: string }> = {
  PENDING: { bg: 'var(--color-bg-secondary)', color: 'var(--color-text-muted)', label: '排队中' },
  PROCESSING: { bg: 'var(--color-warning-light)', color: 'var(--color-warning)', label: '处理中' },
  SUCCEEDED: { bg: 'var(--color-success-light)', color: 'var(--color-success)', label: '成功' },
  SUCCEEDED_WITH_WARNINGS: { bg: 'var(--color-success-light)', color: 'var(--color-success)', label: '成功' },
  FAILED: { bg: 'var(--color-error-light)', color: 'var(--color-error)', label: '失败' },
};

function actionBtn(disabled = false): React.CSSProperties {
  return {
    padding: '7px 14px',
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--color-border-strong)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontSize: 'var(--text-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

export default function HistoryPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<JobStatus | ''>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const renameJob = useRenameJob();
  const deleteJobs = useDeleteJobs();
  const { data, isLoading, error } = useJobs(status || undefined, page);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleRename = useCallback(
    async (name: string) => {
      if (!renameTarget) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        await renameJob.mutateAsync({ id: renameTarget.id, name: trimmed });
        setRenameTarget(null);
      } catch {
        // mutateAsync 抛错由调用方提示
      }
    },
    [renameJob, renameTarget],
  );

  const handleDelete = useCallback(async () => {
    try {
      await deleteJobs.mutateAsync([...selected]);
      setSelected(new Set());
      setConfirmDelete(false);
    } catch {
      // 保留选中，方便重试
    }
  }, [deleteJobs, selected]);

  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>识别任务历史</h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
            点击任务查看只读追踪详情 · 勾选后可批量删除（真删）
          </p>
        </motion.div>

        <motion.div variants={staggerItem} className="flex flex-wrap items-center gap-2">
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
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={deleteJobs.isPending}
              style={{ ...actionBtn(), background: 'var(--color-error)', borderColor: 'var(--color-error)', color: '#fff', fontWeight: 600 }}
            >
              删除所选（{selected.size}）
            </button>
          )}
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
              const isSelected = selected.has(job.id);
              return (
                <div
                  key={job.id}
                  onClick={() => navigate(`/jobs/${job.id}`)}
                  className="flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition"
                  style={{ background: 'var(--color-card)', border: `1px solid ${isSelected ? 'var(--color-accent)' : 'var(--color-border)'}` }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = isSelected ? 'var(--color-accent)' : 'var(--color-border-strong)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = isSelected ? 'var(--color-accent)' : 'var(--color-border)')}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(job.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`选择任务 ${job.name ?? job.id.slice(0, 8)}`}
                      style={{ width: 17, height: 17, accentColor: 'var(--color-accent)', cursor: 'pointer' }}
                    />
                    <span className="shrink-0 px-2.5 py-1 rounded-full text-xs font-medium" style={{ background: st.bg, color: st.color }}>
                      {st.label}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm" style={{ fontWeight: 600 }}>
                        {job.name ?? `${job.id.slice(0, 8)}…`}
                      </p>
                      <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>
                        {job.rows}×{job.cols} · {job.processedCells}/{job.totalCells} · 尝试 {job.attempt + 1}
                        {job.retryCount > 0 ? `（已重试 ${job.retryCount} 次）` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setRenameTarget({ id: job.id, name: job.name ?? '' }); }}
                      style={{ border: 'none', background: 'transparent', color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', cursor: 'pointer', padding: '4px 6px' }}
                      title="重命名任务"
                      aria-label={`重命名 ${job.name ?? job.id.slice(0, 8)}`}
                    >
                      ✎
                    </button>
                    <div className="text-right">
                      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                        {new Date(job.createdAt).toLocaleString()}
                      </p>
                      {job.blueprintId && (
                        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--color-success)' }}>→ 图纸已生成</p>
                      )}
                    </div>
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

      {/* 改名弹窗 */}
      {renameTarget && (
        <RenameModal
          initialName={renameTarget.name}
          busy={renameJob.isPending}
          onCancel={() => setRenameTarget(null)}
          onConfirm={handleRename}
        />
      )}

      {/* 删除确认 */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center p-4"
          style={{ background: 'rgba(61, 43, 31, 0.45)' }}
          onMouseDown={() => setConfirmDelete(false)}
        >
          <div
            className="w-[min(420px,92vw)] rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xl)]"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)' }}>删除 {selected.size} 个任务？</h2>
            <p className="mt-2 text-sm" style={{ color: 'var(--color-text-muted)' }}>
              将永久删除所选任务及其识别事件与生成的图纸（真删，不可恢复）。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleteJobs.isPending} style={actionBtn()}>
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleteJobs.isPending}
                style={{ ...actionBtn(), background: 'var(--color-error)', borderColor: 'var(--color-error)', color: '#fff', fontWeight: 600 }}
              >
                {deleteJobs.isPending ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RenameModal({
  initialName,
  busy,
  onCancel,
  onConfirm,
}: {
  initialName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center p-4"
      style={{ background: 'rgba(61, 43, 31, 0.45)' }}
      onMouseDown={onCancel}
    >
      <div
        className="w-[min(420px,92vw)] rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-xl)]"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-xl)' }}>重命名任务</h2>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) void onConfirm(name); }}
          placeholder="输入任务名称"
          maxLength={128}
          style={{
            width: '100%',
            height: 40,
            marginTop: 14,
            padding: '0 10px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
            fontSize: 'var(--text-sm)',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          aria-label="任务名称"
        />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} style={actionBtn()}>取消</button>
          <button
            type="button"
            onClick={() => void onConfirm(name)}
            disabled={!name.trim() || busy}
            style={{ ...actionBtn(!name.trim() || busy), background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: '#fff', fontWeight: 600 }}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
