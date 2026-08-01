import { useParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useBlueprint } from '../hooks/useBlueprints';
import { staggerContainer, staggerItem } from '../lib/animations';

// 012 决议：终态只读棋盘 + 图例 + 警告。UNMAPPED 用斜纹 ? 豆粒。
export default function BlueprintDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: bp, isLoading, error } = useBlueprint(id ?? null);

  if (isLoading) return <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>;
  if (error) return <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>;
  if (!bp) return null;

  const unmapped = bp.cells.filter((c) => c.status === 'UNMAPPED');
  const legend = new Map<string, { code: string; name: string; hex: string; count: number }>();
  for (const c of bp.cells) {
    if (!c.color) continue;
    const cur = legend.get(c.color.code) ?? { ...c.color, count: 0 };
    cur.count += 1;
    legend.set(c.color.code, cur);
  }
  const cellSize = Math.max(6, Math.min(22, Math.floor(640 / Math.max(bp.cols, bp.rows))));

  return (
    <div className="max-w-5xl mx-auto">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem} className="flex items-center justify-between">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>图纸详情</h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 2 }}>
              {bp.rows} × {bp.cols} · 创建于 {new Date(bp.createdAt).toLocaleString()} · 只读
            </p>
          </div>
          <button onClick={() => navigate(-1)} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)' }}>← 返回</button>
        </motion.div>

        {unmapped.length > 0 && (
          <motion.div variants={staggerItem} className="px-4 py-3 rounded-lg text-sm" style={{ background: '#FDF4EA', border: '1px solid #F0D9B8' }}>
            <span style={{ color: '#D4802B', fontWeight: 600 }}>⚠ {unmapped.length} 个格子编码不在颜色库：</span>
            {unmapped.slice(0, 20).map((c) => `(${c.row + 1},${c.col + 1}) ${c.code}`).join('、')}
            {unmapped.length > 20 && ` 等 ${unmapped.length} 处`}
          </motion.div>
        )}

        <motion.div variants={staggerItem} className="flex gap-6 flex-wrap">
          {/* 棋盘 */}
          <div className="p-4 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', boxShadow: '0 4px 12px rgba(0,0,0,0.06)' }}>
            <div
              className="grid gap-px"
              role="img"
              aria-label={`${bp.rows}×${bp.cols} 拼豆图纸，共 ${legend.size} 色，${unmapped.length} 格未映射`}
              style={{
                gridTemplateColumns: `repeat(${bp.cols}, ${cellSize}px)`,
                background: '#d5d1c7',
              }}
            >
              {bp.cells.map((c) => {
                if (c.status === 'UNMAPPED') {
                  return (
                    <div
                      key={`${c.row}-${c.col}`}
                      aria-hidden="true"
                      title={`(${c.row + 1}, ${c.col + 1}) ${c.code} — 不在颜色库`}
                      style={{
                        width: cellSize, height: cellSize, background: '#f5f5f5',
                        backgroundImage: 'repeating-linear-gradient(45deg, #e8e5dd 0 2px, #fff 2px 4px)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: '#b0aca4', fontSize: Math.max(8, cellSize - 6), fontWeight: 700,
                      }}
                    >
                      ?
                    </div>
                  );
                }
                return (
                  <div
                    key={`${c.row}-${c.col}`}
                    aria-hidden="true"
                    title={`(${c.row + 1}, ${c.col + 1}) ${c.code} ${c.color?.name ?? ''}`}
                    style={{
                      width: cellSize, height: cellSize, background: `#${c.color?.hex ?? 'ccc'}`,
                      boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.5), inset 0 -1px 2px rgba(0,0,0,0.25)',
                      borderRadius: '50%',
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* 图例 */}
          <div className="p-4 rounded-xl min-w-44 flex-1" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
            <h2 style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: 10 }}>颜色图例（{legend.size} 色）</h2>
            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {[...legend.values()]
                .sort((a, b) => b.count - a.count)
                .map((l) => (
                  <div key={l.code} className="flex items-center gap-2 text-sm">
                    <span
                      className="shrink-0 rounded-full"
                      style={{ width: 16, height: 16, background: `#${l.hex}`, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)' }}
                    />
                    <span className="font-mono" style={{ fontSize: 'var(--text-xs)' }}>{l.code}</span>
                    <span className="flex-1 truncate" style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>{l.name}</span>
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>{l.count}</span>
                  </div>
                ))}
              {unmapped.length > 0 && (
                <div className="flex items-center gap-2 text-sm pt-2 border-t" style={{ borderColor: 'var(--color-border)' }}>
                  <span className="shrink-0 rounded-full" style={{ width: 16, height: 16, background: 'repeating-linear-gradient(45deg, #e8e5dd 0 2px, #fff 2px 4px)', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.15)' }} />
                  <span style={{ fontSize: 'var(--text-xs)' }}>UNMAPPED</span>
                  <span className="flex-1" style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>不在颜色库快照</span>
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)' }}>{unmapped.length}</span>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
