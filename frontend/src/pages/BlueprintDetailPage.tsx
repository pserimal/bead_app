import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useBlueprint } from '../hooks/useBlueprints';
import type { BlueprintCellDto } from '../types/api';
import { staggerContainer, staggerItem } from '../lib/animations';

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 8;
const AXIS_GUTTER = 56;

interface ViewState {
  scale: number;
  panX: number;
  panY: number;
}

interface HoverCell {
  row: number;
  col: number;
  code: string;
  x: number;
  y: number;
}

interface PointerDrag {
  pointerId: number;
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
}

function normalizeHex(hex: string | null | undefined): string | null {
  const value = (hex ?? '').replace(/^#/, '').trim();
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null;
}

let cachedMonoFamily: string | null = null;

/**
 * ctx.font 不支持 CSS 变量：赋含 var(--font-mono) 的字体串会被静默忽略，
 * 画布回退到默认 10px sans-serif，导致大图纸文字/刻度大于单元格。
 * 这里把 var() 解析成真实字体族（带纯 monospace 兜底）再交给画布。
 */
function monoFontFamily(): string {
  if (cachedMonoFamily) return cachedMonoFamily;
  if (typeof document !== 'undefined') {
    const resolved = getComputedStyle(document.body).getPropertyValue('--font-mono').trim();
    if (resolved) {
      cachedMonoFamily = resolved;
      return resolved;
    }
  }
  cachedMonoFamily = "ui-monospace, 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";
  return cachedMonoFamily;
}

function readableTextColor(hex: string | null): string {
  if (!hex) return '#3e3832';
  const value = hex.slice(1);
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? '#2f2924' : '#fffaf0';
}

function clampZoom(scale: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
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

function drawBoard(
  canvas: HTMLCanvasElement,
  rows: number,
  cols: number,
  cellSize: number,
  scale: number,
  cellsByPosition: Map<string, BlueprintCellDto>,
  longestCode: string,
) {
  const dpr = window.devicePixelRatio || 1;
  const boardWidth = cols * cellSize;
  const boardHeight = rows * cellSize;
  const width = boardWidth + AXIS_GUTTER * 2;
  const height = boardHeight + AXIS_GUTTER * 2;
  // 清晰渲染：位图分辨率随缩放提升（renderScale = max(1, scale)），放大不模糊。
  // 但分辨率无需 1:1 追到极限：MAX_RENDER_SCALE=3 封顶（最大位图 ≈34M px），
  // 兼顾拖动流畅（巨纹理合成卡顿）与可读性，超过后由 CSS 放大（轻微变糊可接受）。
  // 画布尺寸/面积上限（Chrome 2D ≈ 32767 边 / 268M 面积）作为硬性兜底。
  const MAX_RENDER_SCALE = 3;
  const MAX_CANVAS_DIM = 32767;
  const MAX_CANVAS_AREA = 268_000_000;
  const dimCap = MAX_CANVAS_DIM / (Math.max(width, height) * dpr);
  const areaCap = Math.sqrt(MAX_CANVAS_AREA / (width * height * dpr * dpr));
  const renderScale = Math.max(1, Math.min(scale, MAX_RENDER_SCALE, dimCap, areaCap));
  canvas.width = Math.ceil(width * renderScale * dpr);
  canvas.height = Math.ceil(height * renderScale * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr * renderScale, 0, 0, dpr * renderScale, 0, 0);
  context.clearRect(0, 0, width, height);

  const fontFamily = monoFontFamily();
  // 编码填满单元格 ≈85% 宽度：最长编码宽度（mono 字符宽 ≈ 0.62em）≈ 0.85 × cellSize，
  // 用 measureText 实测最长编码在 100px 字号下的宽度反推 fontSize（不同字体/字距都精确）。
  // 下限 2 字符：避免全 1 字符编码时字号超过格高被裁切。
  const maxCodeLen = Math.max(2, longestCode.length);
  context.font = `700 100px ${fontFamily}`;
  const probe = Math.max(0.1, context.measureText(longestCode || 'MM').width) / 100;
  const fontSize = Math.min((0.85 * cellSize) / probe, cellSize / (0.62 * maxCodeLen));
  // 小字号才需要描边加强对比；放大到字号足够大后省掉 strokeText（每格一次调用）
  const useStroke = fontSize * scale < 28;
  // 坐标刻度画在固定 56px 轴边距内，不受单元格限制；保留 5-9px 可读下限。
  const axisFontSize = Math.max(5, Math.min(9, cellSize * 0.12));
  const left = AXIS_GUTTER;
  const top = AXIS_GUTTER;

  context.fillStyle = '#f8f4ed';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#eee8de';
  context.fillRect(left, top, boardWidth, boardHeight);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = cellsByPosition.get(`${row}:${col}`);
      const x = left + col * cellSize;
      const y = top + row * cellSize;
      const hex = normalizeHex(cell?.color?.hex);
      const isBlank = cell?.status === 'BLANK' || cell?.code === 'BLANK';

      if (isBlank) {
        // BLANK is a recognized empty cell, not an unmapped color. Keep it
        // visually neutral and distinct from the diagonal UNMAPPED hatch.
        context.fillStyle = '#faf9f5';
        context.fillRect(x, y, cellSize, cellSize);
        context.save();
        context.setLineDash([2, 2]);
        context.strokeStyle = 'rgba(112, 103, 92, 0.42)';
        context.lineWidth = Math.max(0.7, cellSize / 32);
        context.strokeRect(x + cellSize * 0.18, y + cellSize * 0.18,
          cellSize * 0.64, cellSize * 0.64);
        context.restore();
      } else {
        context.fillStyle = hex ?? '#e6e0d7';
        context.fillRect(x, y, cellSize, cellSize);
      }

      if (!isBlank && (!hex || cell?.status === 'UNMAPPED')) {
        context.save();
        context.beginPath();
        context.rect(x, y, cellSize, cellSize);
        context.clip();
        context.strokeStyle = 'rgba(92, 84, 75, 0.28)';
        context.lineWidth = Math.max(0.6, cellSize / 36);
        const step = Math.max(5, cellSize / 3);
        for (let line = -cellSize; line < cellSize * 2; line += step) {
          context.beginPath();
          context.moveTo(x + line, y);
          context.lineTo(x + line + cellSize, y + cellSize);
          context.stroke();
        }
        context.restore();
      }

      const code = isBlank ? '' : (cell?.code ?? '');
      if (code) {
        context.font = `700 ${fontSize}px ${fontFamily}`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.lineJoin = 'round';
        const textColor = readableTextColor(hex);
        // 编码按 85% 格宽布局，任意长度都不溢出，无需逐格裁切（省 save/clip/restore × 14k）
        if (useStroke) {
          context.lineWidth = Math.max(0.4, fontSize / 8);
          context.strokeStyle = textColor === '#fffaf0'
            ? 'rgba(0, 0, 0, 0.32)'
            : 'rgba(255, 250, 240, 0.55)';
          context.strokeText(code, x + cellSize / 2, y + cellSize / 2);
        }
        context.fillStyle = textColor;
        context.fillText(code, x + cellSize / 2, y + cellSize / 2);
      }
    }
  }

  // 网格线：默认浅灰；每 5 格加一条更粗的蓝色参考线。
  // 半像素偏移随 renderScale 缩放（0.5/(renderScale×dpr)），避免高分辨率下错位。
  const halfDevicePx = 0.5 / (renderScale * dpr);
  context.beginPath();
  context.strokeStyle = '#d6d1c5';
  context.lineWidth = Math.max(0.5, 0.5 / dpr);
  for (let col = 1; col < cols; col += 1) {
    if (col % 5 === 0) continue;
    const x = left + col * cellSize + halfDevicePx;
    context.moveTo(x, top);
    context.lineTo(x, top + boardHeight);
  }
  for (let row = 1; row < rows; row += 1) {
    if (row % 5 === 0) continue;
    const y = top + row * cellSize + halfDevicePx;
    context.moveTo(left, y);
    context.lineTo(left + boardWidth, y);
  }
  context.stroke();

  context.beginPath();
  context.strokeStyle = '#3D72D8';
  context.lineWidth = Math.max(1.4, 1.4 / dpr);
  for (let col = 5; col < cols; col += 5) {
    const x = left + col * cellSize + halfDevicePx;
    context.moveTo(x, top);
    context.lineTo(x, top + boardHeight);
  }
  for (let row = 5; row < rows; row += 5) {
    const y = top + row * cellSize + halfDevicePx;
    context.moveTo(left, y);
    context.lineTo(left + boardWidth, y);
  }
  context.stroke();

  // 外边框
  context.strokeStyle = '#2E5BAA';
  context.lineWidth = Math.max(1.5, 1.5 / dpr);
  context.strokeRect(left, top, boardWidth, boardHeight);

  // Column labels above and below; row labels on both sides. All are 1-based.
  context.fillStyle = '#655c53';
  context.font = `600 ${axisFontSize}px ${fontFamily}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (let col = 0; col < cols; col += 1) {
    const x = left + (col + 0.5) * cellSize;
    const label = String(col + 1);
    context.fillText(label, x, top * 0.48);
    context.fillText(label, x, top + boardHeight + top * 0.52);
  }
  context.textAlign = 'center';
  for (let row = 0; row < rows; row += 1) {
    const y = top + (row + 0.5) * cellSize;
    const label = String(row + 1);
    context.fillText(label, left * 0.48, y);
    context.fillText(label, left + boardWidth + left * 0.52, y);
  }
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
  // 已渲染位图的蓝图 id + 分辨率倍数（用于判断何时需要重绘）
  const drawnRef = useRef<{ blueprintId: string | null; scale: number }>({ blueprintId: null, scale: 0 });
  const redrawTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const [hover, setHover] = useState<HoverCell | null>(null);

  const unmapped = useMemo(
    () => blueprint?.cells.filter((cell) => cell.status === 'UNMAPPED') ?? [],
    [blueprint],
  );
  const blankCells = useMemo(
    () => blueprint?.cells.filter((cell) => cell.status === 'BLANK' || cell.code === 'BLANK') ?? [],
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
  // 最长编码：只算一次（hover tooltip 和 drawBoard 共用）
  const longestCode = useMemo(() => {
    if (!blueprint) return '';
    let best = '';
    for (const cell of blueprint.cells) {
      if (cell.status !== 'BLANK' && cell.code !== 'BLANK' && cell.code && cell.code.length > best.length) best = cell.code;
    }
    return best;
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
    return {
      row,
      col,
      code: cell?.status === 'BLANK' || cell?.code === 'BLANK' ? '空白' : (cell?.code ?? '—'),
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
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startPanX: current.panX,
        startPanY: current.panY,
      };
      viewport.style.cursor = 'grabbing';
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch {
        // 指针可能已释放（合成事件/快速松开），忽略
      }
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId) {
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
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
      dragRef.current = null;
      viewport.style.cursor = 'grab';
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      // 拖动结束，把最新 pan 同步回 React state（100%/缩放显示依赖它）
      setView(viewRef.current);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const current = viewRef.current;
      const nextScale = clampZoom(current.scale * (event.deltaY > 0 ? 0.88 : 1.12));
      if (nextScale === current.scale) return;
      const cursorX = event.clientX - rect.left - rect.width / 2;
      const cursorY = event.clientY - rect.top - rect.height / 2;
      const ratio = nextScale / current.scale;
      const next = {
        scale: nextScale,
        panX: cursorX - (cursorX - current.panX) * ratio,
        panY: cursorY - (cursorY - current.panY) * ratio,
      };
      viewRef.current = next;
      setView(next);
    };

    const onPointerLeave = () => {
      if (!dragRef.current) setHover(null);
    };

    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', finishPointer);
    viewport.addEventListener('pointercancel', finishPointer);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('pointerleave', onPointerLeave);
    return () => {
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', finishPointer);
      viewport.removeEventListener('pointercancel', finishPointer);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [cellAt, applyTransform]);

  if (isLoading) return <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>;
  if (error) return <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>;
  if (!blueprint) return null;

  return (
    <div className="max-w-6xl mx-auto">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem} className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>图纸详情</h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 3 }}>
              {blueprint.rows} × {blueprint.cols} · {blueprint.cells.length.toLocaleString()} 格 · 创建于 {new Date(blueprint.createdAt).toLocaleString()} · 只读
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => navigate(-1)} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)', padding: '6px 8px' }}>← 返回</button>
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

        {blankCells.length > 0 && (
          <motion.div variants={staggerItem} className="px-4 py-3 rounded-lg text-sm" style={{ background: '#F5F5F2', border: '1px solid #D8D6CE', color: '#625E57' }}>
            <span style={{ fontWeight: 600 }}>□ {blankCells.length} 个空白单元格</span>
            <span style={{ marginLeft: 8 }}>这些格子已识别为空白，不属于颜色库未映射项。</span>
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
                  left: Math.min(hover.x, Math.max(8, viewportSize.width - 180)),
                  top: Math.min(hover.y, Math.max(8, viewportSize.height - 44)),
                  padding: '7px 10px',
                  borderRadius: 7,
                  background: 'rgba(38, 33, 29, 0.92)',
                  color: '#fffaf0',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  pointerEvents: 'none',
                  zIndex: 5,
                  whiteSpace: 'nowrap',
                }}
              >
                行 {hover.row + 1} · 列 {hover.col + 1} · {hover.code}
              </div>
            )}

            <div style={{ position: 'absolute', left: 12, bottom: 10, padding: '5px 9px', borderRadius: 6, background: 'rgba(38,33,29,0.68)', color: '#fffaf0', fontSize: 'var(--text-xs)', pointerEvents: 'none' }}>
              拖动平移 · 滚轮缩放
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
