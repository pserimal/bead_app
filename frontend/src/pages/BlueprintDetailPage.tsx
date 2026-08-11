import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useBlueprint } from '../hooks/useBlueprints';
import type { BlueprintCellDto } from '../types/api';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { HoverCell } from '../lib/boardCanvas';
import { useBoardViewer } from '../hooks/useBoardViewer';
import ImmersionBoard from '../components/ImmersionBoard';

function controlStyle(): React.CSSProperties {
  return {
    minWidth: 34,
    height: 32,
    padding: '0 9px',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    background: 'var(--color-card)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  };
}

export default function BlueprintDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: blueprint, isLoading, error } = useBlueprint(id ?? null);
  const [hover, setHover] = useState<HoverCell | null>(null);
  const [immersive, setImmersive] = useState(false);
  // 触屏设备（平板/手机）：提示文案与交互方式不同（双指捏合、无滚轮）
  const isTouch = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
    [],
  );

  const unmapped = useMemo(
    // 兼容旧 blueprint：历史 BLANK 可能曾被保存为 UNMAPPED；编码优先。
    () => blueprint?.cells.filter((cell) => cell.status === 'UNMAPPED' && cell.code !== 'BLANK') ?? [],
    [blueprint],
  );
  // 按 position 索引的格子 Map：只建一次（drawBoard 每帧重绘都复用，省 14k 次分配/GC）
  const cellsByPosition = useMemo(() => {
    const map = new Map<string, BlueprintCellDto>();
    if (blueprint) {
      for (const cell of blueprint.cells) map.set(`${cell.row}:${cell.col}`, cell);
    }
    return map;
  }, [blueprint]);
  // 最长编码：只算一次（hover tooltip 和 drawBoard 共用）；用有效码（修正 ?? 识别）
  const longestCode = useMemo(() => {
    if (!blueprint) return '';
    let best = '';
    for (const cell of blueprint.cells) {
      const eff = cell.correctedCode ?? cell.code;
      if (eff !== 'BLANK' && eff && eff.length > best.length) best = eff;
    }
    return best;
  }, [blueprint]);
  // 待复核数（详情页角标；与校正页默认档位 90% 一致）
  const reviewCount = useMemo(() => {
    if (!blueprint) return 0;
    return blueprint.cells.filter(
      (c) => c.status === 'UNMAPPED' || (c.confidence != null && c.confidence < 0.9),
    ).length;
  }, [blueprint]);

  const cellSize = blueprint ? Math.max(12, Math.min(48, 1440 / Math.max(blueprint.cols, blueprint.rows))) : 48;

  // 画布查看器：手势/重绘/坐标数学全部来自共享 hook
  const viewer = useBoardViewer({
    rows: blueprint?.rows ?? 0,
    cols: blueprint?.cols ?? 0,
    cellsByPosition,
    longestCode,
    cellSize,
    // 悬停 tooltip：同格内移动不更新（React 同引用 bail-out）
    onHover: (cell) => setHover((prev) => (prev && cell && prev.row === cell.row && prev.col === cell.col ? prev : cell)),
  });

  if (isLoading) return <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>;
  if (error) return <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>;
  if (!blueprint) return null;

  const { viewportRef, wrapperRef, canvasRef, view } = viewer;

  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem} className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>图纸详情</h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 3 }}>
              {blueprint.rows} × {blueprint.cols} · {blueprint.cells.length.toLocaleString()} 格 · 创建于 {new Date(blueprint.createdAt).toLocaleString()} · 可校正
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate('/blueprints')} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)', padding: '6px 8px' }}>← 任务历史</button>
            <button
              type="button"
              onClick={() => navigate(`/blueprints/${id}/correct`)}
              style={{ ...controlStyle(), fontWeight: 600, color: '#fff', background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}
            >
              校正{reviewCount > 0 ? `（${reviewCount}）` : ''}
            </button>
            <button
              type="button"
              onClick={() => setImmersive(true)}
              style={{ ...controlStyle(), fontWeight: 600, color: '#fff', background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}
              title="全屏浏览拼豆图纸：点击格子查看并锁定其编码"
            >
              沉浸模式
            </button>
            <button type="button" onClick={() => viewer.zoomBy(0.8)} style={controlStyle()} aria-label="缩小">−</button>
            <button type="button" onClick={viewer.resetView} style={controlStyle()} aria-label="100%">100%</button>
            <span style={{ minWidth: 48, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{Math.round(view.scale * 100)}%</span>
            <button type="button" onClick={() => viewer.zoomBy(1.25)} style={controlStyle()} aria-label="放大">+</button>
            <button type="button" onClick={viewer.fitView} style={{ ...controlStyle(), fontFamily: 'var(--font-body)' }}>适应窗口</button>
          </div>
        </motion.div>

        {unmapped.length > 0 && (
          <motion.div variants={staggerItem} className="px-4 py-3 rounded-lg text-sm" style={{ background: 'var(--color-warning-light)', border: '1px solid var(--color-warning)' }}>
            <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>⚠ {unmapped.length} 个格子编码不在颜色库：</span>
            {unmapped.slice(0, 20).map((cell) => `(${cell.row + 1},${cell.col + 1}) ${cell.code}`).join('、')}
            {unmapped.length > 20 && ` 等 ${unmapped.length} 处`}
          </motion.div>
        )}

        <motion.div variants={staggerItem}>
          <div
            ref={viewportRef}
            className="relative overflow-hidden rounded-xl"
            role="application"
            aria-label={`${blueprint.rows}×${blueprint.cols} 拼豆图纸预览`}
            style={{ height: 'min(72vh, 760px)', minHeight: 360, background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
          >
            <div
              ref={wrapperRef}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: viewer.viewportMode ? '100%' : viewer.boardWidth,
                height: viewer.viewportMode ? '100%' : viewer.boardHeight,
                transform: viewer.viewportMode
                  ? 'none'
                  : `translate(calc(-50% + ${view.panX}px), calc(-50% + ${view.panY}px)) scale(${view.scale})`,
                transformOrigin: 'center center',
              }}
            >
              <canvas ref={canvasRef} aria-label="彩色拼豆图纸" />
            </div>

            {!viewer.ready && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--color-bg-secondary)',
                  zIndex: 4,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-text-muted)',
                }}
              >
                绘制中…
              </div>
            )}

            {hover && (
              <div
                style={{
                  position: 'absolute',
                  left: Math.min(hover.x, Math.max(8, viewer.viewportSize.width - 240)),
                  top: Math.min(hover.y, Math.max(8, viewer.viewportSize.height - 64)),
                  padding: '7px 10px',
                  borderRadius: 7,
                  background: 'rgba(61, 43, 31, 0.92)',
                  color: 'var(--color-surface)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  pointerEvents: 'none',
                  zIndex: 5,
                  whiteSpace: 'nowrap',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span>
                  行 {hover.row + 1} · 列 {hover.col + 1} · {hover.code}
                  {hover.conf != null && ` · ${Math.round(hover.conf * 100)}%`}
                </span>
                {hover.corrected != null && (
                  <span style={{ opacity: 0.85 }}>
                    已修正：原 {cellsByPosition.get(`${hover.row}:${hover.col}`)?.code} → {hover.corrected}
                  </span>
                )}
              </div>
            )}

            <div style={{ position: 'absolute', left: 12, bottom: 10, padding: '5px 9px', borderRadius: 6, background: 'rgba(61,43,31,0.72)', color: 'var(--color-surface)', fontSize: 'var(--text-xs)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
              {isTouch ? '单指拖动 · 双指缩放 · 双击放大' : '拖动平移 · 滚轮缩放 · 双击放大'}
            </div>
          </div>
        </motion.div>
      </motion.div>

      {/* 沉浸拼豆模式：全屏浏览 + 点击锁定编码高亮 */}
      {immersive && blueprint && (
        <ImmersionBoard blueprint={blueprint} onClose={() => setImmersive(false)} />
      )}
    </div>
  );
}
