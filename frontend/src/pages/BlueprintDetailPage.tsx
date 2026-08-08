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
  cells: BlueprintCellDto[],
  rows: number,
  cols: number,
  cellSize: number,
) {
  const dpr = window.devicePixelRatio || 1;
  const boardWidth = cols * cellSize;
  const boardHeight = rows * cellSize;
  const width = boardWidth + AXIS_GUTTER * 2;
  const height = boardHeight + AXIS_GUTTER * 2;
  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const cellsByPosition = new Map(cells.map((cell) => [`${cell.row}:${cell.col}`, cell]));
  // 字号必须保证不超单元格宽度：单字符宽度 ≈ 0.62 × fontSize，
  // 三字符编码宽度 ≈ 1.86 × fontSize，留 8% 边距后得 fontSize ≤ cellSize / 2.16。
  const idealFont = Math.max(5, Math.min(9, cellSize * 0.16));
  const fontSize = Math.min(idealFont, Math.max(5, cellSize / 2.16));
  const idealAxis = Math.max(5, Math.min(7, cellSize * 0.12));
  const axisFontSize = Math.min(idealAxis, Math.max(5, cellSize / 5));
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

      context.fillStyle = hex ?? '#e6e0d7';
      context.fillRect(x, y, cellSize, cellSize);

      if (!hex || cell?.status === 'UNMAPPED') {
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

      const code = cell?.code ?? '';
      if (code) {
        context.font = `700 ${fontSize}px var(--font-mono), ui-monospace, monospace`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.lineJoin = 'round';
        // 文字裁到单元格内，跨格文字会被截断而不是重叠
        context.save();
        context.beginPath();
        context.rect(x + 1, y + 1, cellSize - 2, cellSize - 2);
        context.clip();
        context.lineWidth = Math.max(0.4, fontSize / 8);
        context.strokeStyle = readableTextColor(hex) === '#fffaf0'
          ? 'rgba(0, 0, 0, 0.32)'
          : 'rgba(255, 250, 240, 0.55)';
        context.strokeText(code, x + cellSize / 2, y + cellSize / 2);
        context.fillStyle = readableTextColor(hex);
        context.fillText(code, x + cellSize / 2, y + cellSize / 2);
        context.restore();
      }
    }
  }

  // 网格线：默认浅灰；每 5 格加一条更粗的蓝色参考线
  context.beginPath();
  context.strokeStyle = '#d6d1c5';
  context.lineWidth = Math.max(0.5, 0.5 / dpr);
  for (let col = 1; col < cols; col += 1) {
    if (col % 5 === 0) continue;
    const x = left + col * cellSize + 0.5;
    context.moveTo(x, top);
    context.lineTo(x, top + boardHeight);
  }
  for (let row = 1; row < rows; row += 1) {
    if (row % 5 === 0) continue;
    const y = top + row * cellSize + 0.5;
    context.moveTo(left, y);
    context.lineTo(left + boardWidth, y);
  }
  context.stroke();

  context.beginPath();
  context.strokeStyle = '#3D72D8';
  context.lineWidth = Math.max(1.4, 1.4 / dpr);
  for (let col = 5; col < cols; col += 5) {
    const x = left + col * cellSize + 0.5;
    context.moveTo(x, top);
    context.lineTo(x, top + boardHeight);
  }
  for (let row = 5; row < rows; row += 5) {
    const y = top + row * cellSize + 0.5;
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
  context.font = `600 ${axisFontSize}px var(--font-mono), ui-monospace, monospace`;
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
  const viewRef = useRef<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const dragRef = useRef<PointerDrag | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const [hover, setHover] = useState<HoverCell | null>(null);

  const unmapped = blueprint?.cells.filter((cell) => cell.status === 'UNMAPPED') ?? [];
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
    const cell = blueprint.cells.find((item) => item.row === row && item.col === col);
    return {
      row,
      col,
      code: cell?.code ?? '—',
      x: clientX - rect.left + 14,
      y: clientY - rect.top + 14,
    };
  }, [blueprint, boardHeight, boardWidth, cellSize]);

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
    drawBoard(canvasRef.current, blueprint.cells, blueprint.rows, blueprint.cols, cellSize);
  }, [blueprint, cellSize]);

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
      viewport.setPointerCapture(event.pointerId);
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
        setView(next);
        setHover(null);
        event.preventDefault();
        return;
      }
      setHover(cellAt(event.clientX, event.clientY));
    };

    const finishPointer = (event: PointerEvent) => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
      dragRef.current = null;
      viewport.style.cursor = 'grab';
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
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
  }, [cellAt]);

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

        <motion.div variants={staggerItem}>
          <div
            ref={viewportRef}
            className="relative overflow-hidden rounded-xl"
            role="application"
            aria-label={`${blueprint.rows}×${blueprint.cols} 拼豆图纸预览`}
            style={{ height: 'min(72vh, 760px)', minHeight: 360, background: '#e9e2d8', border: '1px solid var(--color-border)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
          >
            <div
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
