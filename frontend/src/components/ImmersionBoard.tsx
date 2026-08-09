import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BlueprintDetail } from '../types/api';
import { AXIS_GUTTER, clampZoom, drawBoard } from '../lib/boardCanvas';
import type { HoverCell, ViewState } from '../lib/boardCanvas';

interface PointerDrag {
  pointerId: number;
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
}

interface PinchState {
  startDist: number;
  startScale: number;
}

const TAP_SLOP = 4;

/**
 * 沉浸拼豆模式：页面内全屏（fixed inset-0 覆盖整个视口，隐藏导航）。
 * - 点格子 → 直接锁定该编码（有效码），信息条显示坐标/编码/置信度
 * - 锁定后同编码格高亮（accent 描边）、其余格子 45% 变淡；点其他格子自动切换
 * - "解锁"按钮 / 点空白 恢复常态；Esc 或右上角按钮退出
 * - 手势复用详情页：单指拖动 / 双指捏合 / 双击 / 滚轮缩放
 */
export default function ImmersionBoard({
  blueprint,
  onClose,
}: {
  blueprint: BlueprintDetail;
  onClose: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const dragRef = useRef<PointerDrag | null>(null);
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<PinchState | null>(null);
  const drawnRef = useRef<{ scale: number; highlight: string | null }>({ scale: 0, highlight: null });
  const redrawTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const [lockedCode, setLockedCode] = useState<string | null>(null);
  const [info, setInfo] = useState<HoverCell | null>(null);
  // 重绘 effect 读最新锁定值（ref 避免闭包过期）
  const lockedCodeRef = useRef<string | null>(null);
  lockedCodeRef.current = lockedCode;

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
  const boardWidth = blueprint.cols * cellSize + AXIS_GUTTER * 2;
  const boardHeight = blueprint.rows * cellSize + AXIS_GUTTER * 2;

  // 锁定编码的格子数（信息条展示）
  const lockedCount = useMemo(() => {
    if (lockedCode == null) return 0;
    let n = 0;
    for (const cell of blueprint.cells) {
      if ((cell.correctedCode ?? cell.code) === lockedCode) n += 1;
    }
    return n;
  }, [blueprint, lockedCode]);

  const applyTransform = useCallback((panX: number, panY: number, scale: number) => {
    const el = wrapperRef.current;
    if (el) el.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${scale})`;
  }, []);

  const fitView = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const width = rect?.width ?? window.innerWidth;
    const height = rect?.height ?? window.innerHeight;
    if (!width || !height) return;
    const scale = clampZoom(Math.min(
      (width - 24) / boardWidth,
      (height - 24) / boardHeight,
      1.5,
    ));
    const next = { scale, panX: 0, panY: 0 };
    viewRef.current = next;
    setView(next);
  }, [boardHeight, boardWidth]);

  const cellAt = useCallback((clientX: number, clientY: number): HoverCell | null => {
    if (!viewportRef.current) return null;
    const rect = viewportRef.current.getBoundingClientRect();
    const current = viewRef.current;
    const localX = (clientX - rect.left - rect.width / 2 - current.panX) / current.scale + boardWidth / 2;
    const localY = (clientY - rect.top - rect.height / 2 - current.panY) / current.scale + boardHeight / 2;
    const col = Math.floor((localX - AXIS_GUTTER) / cellSize);
    const row = Math.floor((localY - AXIS_GUTTER) / cellSize);
    if (row < 0 || row >= blueprint.rows || col < 0 || col >= blueprint.cols) return null;
    const cell = cellsByPosition.get(`${row}:${col}`);
    const effective = cell?.correctedCode ?? cell?.code ?? '—';
    return {
      row,
      col,
      code: cell?.status === 'BLANK' || effective === 'BLANK' ? '空白' : effective,
      conf: cell?.confidence ?? null,
      corrected: cell?.correctedCode ?? null,
      effective,
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, [blueprint.rows, blueprint.cols, boardHeight, boardWidth, cellSize, cellsByPosition]);

  // 点击格子：显示信息 + 直接锁定其编码（同码重复点击不变化）
  const handleTap = useCallback((cell: HoverCell | null) => {
    setInfo(cell);
    if (cell) setLockedCode(cell.effective);
  }, []);

  // Esc 退出
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 进入即适应窗口
  useEffect(() => {
    fitView();
  }, [fitView]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // 重绘：缩放或锁定变化时（锁定切换强制重绘；大图防抖）
  useEffect(() => {
    if (!canvasRef.current) return;
    if (redrawTimerRef.current !== null) {
      window.clearTimeout(redrawTimerRef.current);
      redrawTimerRef.current = null;
    }
    const highlight = lockedCode;
    const force = drawnRef.current.highlight !== highlight || drawnRef.current.scale === 0;
    const scale = view.scale;
    if (!force && scale <= drawnRef.current.scale) return;
    const dpr = window.devicePixelRatio || 1;
    const canvasW = blueprint.cols * cellSize + AXIS_GUTTER * 2;
    const canvasH = blueprint.rows * cellSize + AXIS_GUTTER * 2;
    const renderScale = Math.max(1, scale);
    const targetPx = canvasW * renderScale * dpr * canvasH * renderScale * dpr;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const target = viewRef.current.scale;
      const targetHighlight = lockedCodeRef.current;
      if (drawnRef.current.highlight === targetHighlight && target <= drawnRef.current.scale) return;
      drawBoard(canvas, blueprint.rows, blueprint.cols, cellSize, target, cellsByPosition, longestCode, targetHighlight);
      drawnRef.current = { scale: target, highlight: targetHighlight };
    };
    if (force || targetPx <= 16_000_000) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        draw();
      });
    } else {
      redrawTimerRef.current = window.setTimeout(() => {
        redrawTimerRef.current = null;
        draw();
      }, 180);
    }
  }, [blueprint, cellSize, view.scale, lockedCode, cellsByPosition, longestCode]);

  // 手势 + 点击（与详情页同构：单指拖动 / 双指捏合 / 双击 / 滚轮）
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const current = viewRef.current;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointersRef.current.size === 1) {
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startPanX: current.panX,
          startPanY: current.panY,
        };
      } else if (pointersRef.current.size === 2) {
        dragRef.current = null;
        const [a, b] = [...pointersRef.current.values()];
        pinchRef.current = {
          startDist: Math.hypot(b.x - a.x, b.y - a.y),
          startScale: current.scale,
        };
      }
      viewport.style.cursor = 'grabbing';
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch {
        // 合成事件/快速松开，忽略
      }
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pinchRef.current && pointersRef.current.has(event.pointerId)) {
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const [a, b] = [...pointersRef.current.values()];
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (dist > 0) {
          const rect = viewport.getBoundingClientRect();
          const current = viewRef.current;
          const scale = clampZoom((pinchRef.current.startScale * dist) / pinchRef.current.startDist);
          const ratio = scale / current.scale;
          const midX = (a.x + b.x) / 2 - rect.left - rect.width / 2;
          const midY = (a.y + b.y) / 2 - rect.top - rect.height / 2;
          const next = {
            scale,
            panX: midX - (midX - current.panX) * ratio,
            panY: midY - (midY - current.panY) * ratio,
          };
          viewRef.current = next;
          applyTransform(next.panX, next.panY, next.scale);
        }
        event.preventDefault();
        return;
      }
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
        const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (moved < TAP_SLOP) return;
        const next = {
          scale: viewRef.current.scale,
          panX: drag.startPanX + event.clientX - drag.startX,
          panY: drag.startPanY + event.clientY - drag.startY,
        };
        viewRef.current = next;
        applyTransform(next.panX, next.panY, next.scale);
        setInfo(null);
        event.preventDefault();
      }
    };

    const finishPointer = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId);
      if (pinchRef.current && pointersRef.current.size < 2) pinchRef.current = null;
      if (pointersRef.current.size === 1) {
        const current = viewRef.current;
        const [remaining] = [...pointersRef.current.entries()];
        dragRef.current = {
          pointerId: remaining[0],
          startX: remaining[1].x,
          startY: remaining[1].y,
          startPanX: current.panX,
          startPanY: current.panY,
        };
        return;
      }
      if (pointersRef.current.size > 1) return;
      // 全部抬起：判断是否为"点击"（无拖动）→ 锁定
      const drag = dragRef.current;
      dragRef.current = null;
      viewport.style.cursor = 'grab';
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      const moved = drag ? Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) : 99;
      if (moved < TAP_SLOP) {
        handleTap(cellAt(event.clientX, event.clientY));
      }
      setView(viewRef.current);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const current = viewRef.current;
      const scale = clampZoom(current.scale * (event.deltaY > 0 ? 0.88 : 1.12));
      if (scale === current.scale) return;
      const anchorX = event.clientX - rect.left - rect.width / 2;
      const anchorY = event.clientY - rect.top - rect.height / 2;
      const ratio = scale / current.scale;
      const next = {
        scale,
        panX: anchorX - (anchorX - current.panX) * ratio,
        panY: anchorY - (anchorY - current.panY) * ratio,
      };
      viewRef.current = next;
      setView(next);
    };

    const onDoubleClick = (event: MouseEvent) => {
      const current = viewRef.current;
      const rect = viewport.getBoundingClientRect();
      const anchorX = event.clientX - rect.left - rect.width / 2;
      const anchorY = event.clientY - rect.top - rect.height / 2;
      const scale = clampZoom(current.scale * (current.scale > 1 ? 1 / 1.6 : 1.6));
      if (scale === current.scale) return;
      const ratio = scale / current.scale;
      const next = {
        scale,
        panX: anchorX - (anchorX - current.panX) * ratio,
        panY: anchorY - (anchorY - current.panY) * ratio,
      };
      viewRef.current = next;
      setView(next);
    };

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', finishPointer);
    viewport.addEventListener('pointercancel', finishPointer);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('dblclick', onDoubleClick);
    return () => {
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', finishPointer);
      viewport.removeEventListener('pointercancel', finishPointer);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('dblclick', onDoubleClick);
    };
  }, [applyTransform, cellAt, handleTap]);

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
            width: boardWidth,
            height: boardHeight,
            transform: `translate(calc(-50% + ${view.panX}px), calc(-50% + ${view.panY}px)) scale(${view.scale})`,
            transformOrigin: 'center center',
          }}
        >
          <canvas ref={canvasRef} aria-label="拼豆图纸全屏预览" />
        </div>

        {/* 缩放百分比（右下角，极小） */}
        <div
          className="absolute"
          style={{
            right: 14,
            bottom: 14,
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

      {/* 信息条（底部居中）：坐标/编码/置信度 + 锁定状态 + 解锁 */}
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
        {info ? (
          <>
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
            <span className="hidden sm:inline" style={{ width: 1, height: 20, background: 'rgba(255,250,240,0.22)' }} />
            {lockedCode != null ? (
              <>
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
            ) : (
              <span style={{ fontSize: 'var(--text-xs)', opacity: 0.6 }}>
                点击格子锁定其编码
              </span>
            )}
          </>
        ) : (
          <span style={{ fontSize: 'var(--text-xs)', opacity: 0.6 }}>
            点击任意格子查看并锁定其编码 · 拖动平移 · 双指/滚轮缩放 · 双击放大
          </span>
        )}
      </div>
    </div>
  );
}
