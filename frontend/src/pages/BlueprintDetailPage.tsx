import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useBlueprint } from '../hooks/useBlueprints';
import type { BlueprintCellDto } from '../types/api';
import { staggerContainer, staggerItem } from '../lib/animations';
import ImmersionBoard from '../components/ImmersionBoard';
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

interface PinchState {
  startDist: number;
  startScale: number;
}

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
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const dragRef = useRef<PointerDrag | null>(null);
  // 多指触摸：所有活跃指针位置 + 捏合基准（触屏双指缩放）
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<PinchState | null>(null);
  // 已渲染位图的蓝图 id + 分辨率倍数（用于判断何时需要重绘）
  const drawnRef = useRef<{ blueprintId: string | null; scale: number }>({ blueprintId: null, scale: 0 });
  const redrawTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewState>({ scale: 1, panX: 0, panY: 0 });
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
  // 拖动时直接改 DOM transform，不走 React state（省每帧重渲染 + GC）；松手时才同步回 state
  const applyTransform = useCallback((panX: number, panY: number, scale: number) => {
    const el = wrapperRef.current;
    if (el) el.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${scale})`;
  }, []);
  const cellSize = blueprint ? Math.max(12, Math.min(48, 1440 / Math.max(blueprint.cols, blueprint.rows))) : 48;
  const boardWidth = (blueprint?.cols ?? 0) * cellSize + AXIS_GUTTER * 2;
  const boardHeight = (blueprint?.rows ?? 0) * cellSize + AXIS_GUTTER * 2;

  const fitView = useCallback(() => {
    if (!blueprint) return;
    // 直接读 DOM，绕过 state 可能为 0 的时机问题
    const rect = viewportRef.current?.getBoundingClientRect();
    const width = rect?.width ?? viewportSize.width;
    const height = rect?.height ?? viewportSize.height;
    if (!width || !height) return;
    const scale = clampZoom(Math.min(
      (width - 24) / boardWidth,
      (height - 24) / boardHeight,
      1.5,
    ));
    const next = { scale, panX: 0, panY: 0 };
    viewRef.current = next;
    setView(next);
  }, [boardHeight, boardWidth, blueprint, viewportSize.height, viewportSize.width]);

  const cellAt = useCallback((clientX: number, clientY: number): HoverCell | null => {
    if (!blueprint || !viewportRef.current) return null;
    const rect = viewportRef.current.getBoundingClientRect();
    const current = viewRef.current;
    const localX = (clientX - rect.left - rect.width / 2 - current.panX) / current.scale + boardWidth / 2;
    const localY = (clientY - rect.top - rect.height / 2 - current.panY) / current.scale + boardHeight / 2;
    const col = Math.floor((localX - AXIS_GUTTER) / cellSize);
    const row = Math.floor((localY - AXIS_GUTTER) / cellSize);
    if (row < 0 || row >= blueprint.rows || col < 0 || col >= blueprint.cols) return null;
    const cell = cellsByPosition.get(`${row}:${col}`);
    const effectiveCode = cell?.correctedCode ?? cell?.code;
    return {
      row,
      col,
      code: cell?.status === 'BLANK' || effectiveCode === 'BLANK' ? '空白' : (effectiveCode ?? '—'),
      conf: cell?.confidence ?? null,
      corrected: cell?.correctedCode ?? null,
      x: clientX - rect.left + 14,
      y: clientY - rect.top + 14,
    };
  }, [blueprint, boardHeight, boardWidth, cellSize, cellsByPosition]);

  const zoomBy = useCallback((factor: number) => {
    setView((previous) => {
      const scale = clampZoom(previous.scale * factor);
      const ratio = scale / previous.scale;
      const next = { scale, panX: previous.panX * ratio, panY: previous.panY * ratio };
      viewRef.current = next;
      return next;
    });
  }, []);

  /** 围绕屏幕坐标锚点缩放（双击点 / 捏合中点 / 滚轮光标） */
  const zoomAt = useCallback((anchorX: number, anchorY: number, factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const current = viewRef.current;
    const scale = clampZoom(current.scale * factor);
    if (scale === current.scale) return;
    const anchorLocalX = anchorX - rect.left - rect.width / 2;
    const anchorLocalY = anchorY - rect.top - rect.height / 2;
    const ratio = scale / current.scale;
    const next = {
      scale,
      panX: anchorLocalX - (anchorLocalX - current.panX) * ratio,
      panY: anchorLocalY - (anchorLocalY - current.panY) * ratio,
    };
    viewRef.current = next;
    setView(next);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    fitView();
  }, [fitView]);

  useEffect(() => {
    if (!blueprint || !canvasRef.current) return;
    // 位图分辨率随缩放提升，保证任意缩放级别都清晰：
    // - 新蓝图/小幅放大（位图 ≤ 16M px，≈2×）：rAF 立即重绘，逐级清晰；
    // - 大幅放大：180ms 防抖合并成一次重绘（滚轮/连点不卡顿，停下即清晰）；
    // - 缩小到已渲染分辨率以下：不重绘（CSS 降采样依然清晰）。
    if (redrawTimerRef.current !== null) {
      window.clearTimeout(redrawTimerRef.current);
      redrawTimerRef.current = null;
    }
    const force = drawnRef.current.blueprintId !== blueprint.id;
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
      if (drawnRef.current.blueprintId === blueprint.id && target <= drawnRef.current.scale) return;
      drawBoard(canvas, blueprint.rows, blueprint.cols, cellSize, target, cellsByPosition, longestCode);
      drawnRef.current = { blueprintId: blueprint.id, scale: target };
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
  }, [blueprint, cellSize, view.scale, cellsByPosition, longestCode]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const current = viewRef.current;
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointersRef.current.size === 1) {
        // 单指：开始拖动
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startPanX: current.panX,
          startPanY: current.panY,
        };
      } else if (pointersRef.current.size === 2) {
        // 第二指落下：进入双指捏合（取消拖动）
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
        // 指针可能已释放（合成事件/快速松开），忽略
      }
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      // 双指捏合缩放（围绕两指中点，触屏核心手势）
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
          setHover(null);
        }
        event.preventDefault();
        return;
      }
      const drag = dragRef.current;
      // 4px 移动阈值：双击/轻点不产生微小漂移
      if (drag && drag.pointerId === event.pointerId) {
        const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (moved < 4) return;
        const next = {
          scale: viewRef.current.scale,
          panX: drag.startPanX + event.clientX - drag.startX,
          panY: drag.startPanY + event.clientY - drag.startY,
        };
        viewRef.current = next;
        // 拖动直接改 DOM transform，不走 React state（省每帧重渲染 + GC）
        applyTransform(next.panX, next.panY, next.scale);
        setHover(null);
        event.preventDefault();
        return;
      }
      // 同格内移动不更新 tooltip（React 同引用 bail-out，省重渲染）
      const next = cellAt(event.clientX, event.clientY);
      setHover((prev) => (prev && next && prev.row === next.row && prev.col === next.col ? prev : next));
    };

    const finishPointer = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId);
      if (pinchRef.current && pointersRef.current.size < 2) {
        pinchRef.current = null;
      }
      if (pointersRef.current.size === 1) {
        // 捏合中抬起一指：剩余手指继续拖动
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
      dragRef.current = null;
      viewport.style.cursor = 'grab';
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      // 拖动/捏合结束，把最新 pan/scale 同步回 React state（100%/缩放显示依赖它）
      setView(viewRef.current);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 0.88 : 1.12);
    };

    const onDoubleClick = (event: MouseEvent) => {
      // 双击：放大 1.6×；已放大时还原。触屏浏览器同样触发 dblclick
      const current = viewRef.current;
      zoomAt(event.clientX, event.clientY, current.scale > 1 ? 1 / 1.6 : 1.6);
    };

    const onPointerLeave = () => {
      if (!dragRef.current && !pinchRef.current) setHover(null);
    };

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', finishPointer);
    viewport.addEventListener('pointercancel', finishPointer);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('dblclick', onDoubleClick);
    viewport.addEventListener('pointerleave', onPointerLeave);
    return () => {
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', finishPointer);
      viewport.removeEventListener('pointercancel', finishPointer);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('dblclick', onDoubleClick);
      viewport.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [cellAt, applyTransform, zoomAt]);

  if (isLoading) return <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>;
  if (error) return <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>;
  if (!blueprint) return null;

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
            <button type="button" onClick={() => navigate(-1)} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)', padding: '6px 8px' }}>← 返回</button>
            <button
              type="button"
              onClick={() => navigate(`/blueprints/${id}/correct`)}
              style={{ ...controlStyle(), fontWeight: 600, color: '#fff', background: '#3D72D8', borderColor: '#3D72D8' }}
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
            <button type="button" onClick={() => zoomBy(0.8)} style={controlStyle()} aria-label="缩小">−</button>
            <button type="button" onClick={() => { const next = { scale: 1, panX: 0, panY: 0 }; viewRef.current = next; setView(next); }} style={controlStyle()} aria-label="100%">100%</button>
            <span style={{ minWidth: 48, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{Math.round(view.scale * 100)}%</span>
            <button type="button" onClick={() => zoomBy(1.25)} style={controlStyle()} aria-label="放大">+</button>
            <button type="button" onClick={fitView} style={{ ...controlStyle(), fontFamily: 'var(--font-body)' }}>适应窗口</button>
          </div>
        </motion.div>

        {unmapped.length > 0 && (
          <motion.div variants={staggerItem} className="px-4 py-3 rounded-lg text-sm" style={{ background: '#FDF4EA', border: '1px solid #F0D9B8' }}>
            <span style={{ color: '#D4802B', fontWeight: 600 }}>⚠ {unmapped.length} 个格子编码不在颜色库：</span>
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
            style={{ height: 'min(72vh, 760px)', minHeight: 360, background: '#e9e2d8', border: '1px solid var(--color-border)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
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
              <canvas ref={canvasRef} aria-label="彩色拼豆图纸" />
            </div>

            {hover && (
              <div
                style={{
                  position: 'absolute',
                  left: Math.min(hover.x, Math.max(8, viewportSize.width - 240)),
                  top: Math.min(hover.y, Math.max(8, viewportSize.height - 64)),
                  padding: '7px 10px',
                  borderRadius: 7,
                  background: 'rgba(38, 33, 29, 0.92)',
                  color: '#fffaf0',
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

            <div style={{ position: 'absolute', left: 12, bottom: 10, padding: '5px 9px', borderRadius: 6, background: 'rgba(38,33,29,0.68)', color: '#fffaf0', fontSize: 'var(--text-xs)', pointerEvents: 'none', whiteSpace: 'nowrap' }}>
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