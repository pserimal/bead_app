import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useBlueprints, useDeleteBlueprint } from '../hooks/useBlueprints';
import Button from '../components/Button';
import Modal from '../components/Modal';
import ErrorDisplay from '../components/ErrorDisplay';
import SkeletonCard from '../components/SkeletonCard';
import { staggerContainer, staggerItem } from '../lib/animations';

const PAGE_SIZE = 12;

const statusStyles: Record<string, { bg: string; text: string; label: string }> = {
  ready: {
    bg: 'var(--color-success-light)',
    text: 'var(--color-success)',
    label: '就绪',
  },
  processing: {
    bg: 'var(--color-warning-light)',
    text: 'var(--color-warning)',
    label: '解析中',
  },
  error: {
    bg: 'var(--color-error-light)',
    text: 'var(--color-error)',
    label: '错误',
  },
};

export default function HistoryPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useBlueprints(page);
  const deleteBlueprint = useDeleteBlueprint();
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    await deleteBlueprint.mutateAsync(confirmDelete);
    setConfirmDelete(null);
  };

  if (isLoading) {
    return (
      <div
        className="max-w-6xl mx-auto py-8 px-4"
        style={{ fontFamily: 'var(--font-body)' }}
      >
        <div className="flex items-center justify-between mb-6 md:mb-8 gap-3">
          <h1
            className="font-semibold tracking-tight"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-2xl)',
              color: 'var(--color-text)',
            }}
          >
            图纸列表
          </h1>
        </div>
        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5"
          variants={staggerContainer}
          initial="initial"
          animate="animate"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <motion.div key={i} variants={staggerItem}>
              <SkeletonCard />
            </motion.div>
          ))}
        </motion.div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="max-w-6xl mx-auto py-8 px-4"
        style={{ fontFamily: 'var(--font-body)' }}
      >
        <ErrorDisplay message="加载图纸列表失败" onRetry={() => refetch()} />
      </div>
    );
  }

  const blueprints = data?.items || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div
      className="max-w-6xl mx-auto py-8 px-4"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="flex items-center justify-between mb-6 md:mb-8 gap-3">
        <h1
          className="font-semibold tracking-tight"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--text-2xl)',
            color: 'var(--color-text)',
          }}
        >
          图纸列表
        </h1>
        <Button onClick={() => navigate('/')} className="shrink-0">+ 上传新图纸</Button>
      </div>

      {blueprints.length === 0 ? (
        <motion.div
          className="text-center py-20"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          <div
            className="text-6xl mb-6"
            role="img"
            aria-label="空状态图标"
          >
            📋
          </div>
          <p
            className="mb-6"
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-2xl)',
              color: 'var(--color-text-secondary)',
              fontStyle: 'italic',
            }}
          >
            还没有图纸
          </p>
          <p
            className="mb-8"
            style={{
              fontSize: 'var(--text-base)',
              color: 'var(--color-text-muted)',
            }}
          >
            上传一张图片，开始创作你的拼豆作品
          </p>
          <Button onClick={() => navigate('/')}>去上传一张图纸</Button>
        </motion.div>
      ) : (
        <>
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            <AnimatePresence mode="popLayout">
              {blueprints.map((bp) => (
                <motion.div
                  key={bp.id}
                  variants={staggerItem}
                  layout
                  whileHover={{
                    y: -4,
                    boxShadow: 'var(--shadow-lg)',
                  }}
                  transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                  onClick={() => navigate(`/blueprints/${bp.id}`)}
                  className="rounded-xl overflow-hidden cursor-pointer"
                  style={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    boxShadow: 'var(--shadow-sm)',
                  }}
                  data-testid="blueprint-card"
                >
                  <div
                    className="h-32 flex items-center justify-center"
                    style={{ background: 'var(--color-bg-secondary)' }}
                  >
                    <span className="text-3xl" style={{ color: 'var(--color-border-strong)' }}>
                      🧩
                    </span>
                  </div>

                  <div className="p-4">
                    <h3
                      className="font-medium truncate"
                      style={{
                        color: 'var(--color-text)',
                        fontSize: 'var(--text-base)',
                      }}
                    >
                      {bp.name || '未命名'}
                    </h3>

                    <div
                      className="flex items-center justify-between mt-2"
                      style={{ fontSize: 'var(--text-xs)' }}
                    >
                      <span style={{ color: 'var(--color-text-muted)' }}>
                        {bp.grid_rows}×{bp.grid_cols}
                      </span>
                      <span
                        className="px-2 py-0.5 rounded-full"
                        style={{
                          background: statusStyles[bp.status]?.bg || statusStyles.error.bg,
                          color: statusStyles[bp.status]?.text || statusStyles.error.text,
                          fontSize: 'var(--text-xs)',
                        }}
                      >
                        {statusStyles[bp.status]?.label || bp.status}
                      </span>
                    </div>

                    <div
                      className="mt-2"
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-text-muted)',
                      }}
                    >
                      {new Date(bp.created_at).toLocaleDateString('zh-CN')}
                    </div>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(bp.id);
                      }}
                      className="mt-3 transition-colors duration-[var(--transition-fast)]"
                      style={{
                        fontSize: 'var(--text-xs)',
                        color: 'var(--color-error)',
                        opacity: 0.7,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
                      data-testid="delete-button"
                    >
                      删除
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>

          {totalPages > 1 && (
            <motion.div
              className="flex items-center justify-center gap-3 mt-10"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.3 }}
            >
              <Button
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← 上一页
              </Button>
              <span
                className="px-3 py-1 rounded-lg"
                style={{
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-text-secondary)',
                  background: 'var(--color-bg-secondary)',
                }}
              >
                {page} / {totalPages}
              </span>
              <Button
                variant="ghost"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页 →
              </Button>
            </motion.div>
          )}
        </>
      )}

      <AnimatePresence>
        {confirmDelete && (
          <Modal title="确认删除" onClose={() => setConfirmDelete(null)}>
            <p
              className="mb-6"
              style={{
                fontSize: 'var(--text-sm)',
                color: 'var(--color-text-secondary)',
              }}
            >
              确定要删除这个图纸吗？此操作不可撤销。
            </p>
            <div className="flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                取消
              </Button>
              <Button variant="danger" onClick={handleDelete}>
                删除
              </Button>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}
