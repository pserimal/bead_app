import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BlueprintDetail } from '../types/api';
import { AXIS_GUTTER } from '../lib/boardCanvas';
import type { HoverCell } from '../lib/boardCanvas';
import { useBoardViewer } from '../hooks/useBoardViewer';

/**
 * 沉浸拼豆模式：页面内全屏（fixed inset-0 覆盖整个视口，隐藏导航）。
 * 手势/重绘全部来自 useBoardViewer（详情页共用）；本组件只负责：
 * 点击锁定状态机 + 信息条 + 退出。
 * - 点格子 → 直接锁定该编码（有效码），信息条显示坐标/编码/置信度
 * - 锁定后同编码格高亮（accent 细框）、其余格子 35% 透明；点其他格子自动切换
 * - "解锁"按钮 恢复常态；Esc 或右上角按钮退出
 */
export default function ImmersionBoard({
  blueprint,
  onClose,
}: {
  blueprint: BlueprintDetail;
  onClose: () => void;
}) {
  const [lockedCode, setLockedCode] = useState<string | null>(null);
  const [info, setInfo] = useState<HoverCell | null>(null);

  const cellsByPosition = useMemo(() => {
    const map = new Map<string, BlueprintDetail['cells'][number]>();
    for (const cell of blueprint.cells) map.set(`${cell.row}:${cell.col}`, cell);
    return map;
  }, [blueprint]);

  const longestCode = useMemo(() => {
    let best = '';
    for (const cell of blueprint.cells) {
      const eff = cell.correctedCode ?? cell.code;
      if (eff !== 'BLANK' && eff && eff.length > best.length) best = eff;
    }
    return best;
  }, [blueprint]);

  const cellSize = Math.max(12, Math.min(48, 1440 / Math.max(blueprint.cols, blueprint.rows)));

  // 锁定编码的格子数（信息条展示）
  const lockedCount = useMemo(() => {
    if (lockedCode == null) return 0;
    let n = 0;
    for (const cell of blueprint.cells) {
      if ((cell.correctedCode ?? cell.code) === lockedCode) n += 1;
    }
    return n;
  }, [blueprint, lockedCode]);

  // 点击格子：显示信息 + 直接锁定其编码（同码重复点击不变化）
  const handleTap = useCallback((cell: HoverCell | null) => {
    setInfo(cell);
    if (cell) setLockedCode(cell.effective);
  }, []);

  const viewer = useBoardViewer({
    rows: blueprint.rows,
    cols: blueprint.cols,
    cellsByPosition,
    longestCode,
    cellSize,
    highlightCode: lockedCode,
    onCellTap: handleTap,
  });

  // Esc 退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { viewportRef, wrapperRef, canvasRef, view } = viewer;

  return (
    <div className="fixed inset-0 z-50 flex flex-col" style={{ background: '#17130f' }}>
      <div
        ref={viewportRef}
        className="absolute inset-0"
        role="application"
        aria-label="沉浸拼豆模式"
        style={{ touchAction: 'none', cursor: 'grab', userSelect: 'none' }}
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
              ? 'translate(-50%, -50%)'
              : `translate(calc(-50% + ${view.panX}px), calc(-50% + ${view.panY}px)) scale(${view.scale})`,
            transformOrigin: 'center center',
          }}
        >
          <canvas ref={canvasRef} aria-label="拼豆图纸全屏预览" />
        </div>

        {!viewer.ready && (
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: '#17130f', color: 'rgba(255,250,240,0.6)', fontSize: 'var(--text-sm)' }}
          >
            绘制中…
          </div>
        )}

        {/* 缩放百分比 + 适应窗口（右下角） */}
        <div
          className="absolute flex items-center gap-2"
          style={{ right: 14, bottom: 14 }}
        >
          <button
            type="button"
            onClick={viewer.fitView}
            style={{
              padding: '5px 12px',
              borderRadius: 7,
              border: '1px solid rgba(255,250,240,0.25)',
              background: 'rgba(0,0,0,0.55)',
              color: '#fffaf0',
              fontFamily: 'var(--font-body)',
              fontSize: 'var(--text-xs)',
              cursor: 'pointer',
            }}
          >
            适应窗口
          </button>
          <div
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              background: 'rgba(0,0,0,0.45)',
              color: 'rgba(255,250,240,0.75)',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--text-xs)',
              pointerEvents: 'none',
            }}
          >
            {Math.round(view.scale * 100)}%
          </div>
        </div>
      </div>

      {/* 退出（右上角） */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-10 px-4 py-2 rounded-lg"
        style={{
          background: 'rgba(0,0,0,0.55)',
          border: '1px solid rgba(255,250,240,0.25)',
          color: '#fffaf0',
          fontSize: 'var(--text-sm)',
          cursor: 'pointer',
          backdropFilter: 'blur(4px)',
        }}
        aria-label="退出沉浸模式"
      >
        退出沉浸 ✕
      </button>

      {/* 信息条（底部居中）：坐标/编码/置信度 + 锁定状态 + 解锁（无点击时不显示） */}
      {info && (
        <div
          className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 px-4 py-2.5 rounded-xl max-w-[calc(100vw-2rem)]"
          style={{
            background: 'rgba(23,19,15,0.88)',
            border: '1px solid rgba(255,250,240,0.16)',
            color: '#fffaf0',
            backdropFilter: 'blur(6px)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span style={{ fontSize: 'var(--text-sm)' }}>
            行 {info.row + 1} · 列 {info.col + 1}
          </span>
          <span style={{ fontSize: 'var(--text-base)', fontWeight: 700 }}>{info.code}</span>
          {info.conf != null && (
            <span style={{ fontSize: 'var(--text-xs)', opacity: 0.7 }}>
              {Math.round(info.conf * 100)}%
            </span>
          )}
          {info.corrected != null && (
            <span style={{ fontSize: 'var(--text-xs)', opacity: 0.85 }}>
              修正 {cellsByPosition.get(`${info.row}:${info.col}`)?.code} → {info.corrected}
            </span>
          )}
          {lockedCode != null && (
            <>
              <span className="hidden sm:inline" style={{ width: 1, height: 20, background: 'rgba(255,250,240,0.22)' }} />
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)', fontWeight: 600 }}>
                ◎ {lockedCode === 'BLANK' ? '空白' : lockedCode} · {lockedCount} 格
              </span>
              <button
                  type="button"
                  onClick={() => setLockedCode(null)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,250,240,0.35)',
                    background: 'transparent',
                    color: '#fffaf0',
                    fontSize: 'var(--text-xs)',
                    cursor: 'pointer',
                  }}
                >
                  解锁
                </button>
              </>
            )}
        </div>
      )}
    </div>
  );
}
