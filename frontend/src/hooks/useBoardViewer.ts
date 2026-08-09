import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AXIS_GUTTER, clampZoom, drawBoard } from '../lib/boardCanvas';
import type { HoverCell, ViewState } from '../lib/boardCanvas';
import type { BlueprintCellDto } from '../types/api';

/**
 * 画布查看器（Canvas Viewer）—— 拼豆图纸 pan/pinch/zoom/重绘的唯一实现。
 *
 * 详情页与沉浸模式共用：手势（单指拖动/双指捏合/双击/滚轮，4px tap 阈值）、
 * 点击检测（onCellTap）、悬停检测（onHover）、重绘调度（首次 rAF、其余 150ms
 * 防抖、缩小不重绘、dpr 上限 2）、视口尺寸监听、fitView/zoomAt 锚点数学。
 *
 * 组件只需提供数据（rows/cols/cells/highlightCode）与回调，挂载 refs 即用。
 */

interface BoardViewerOptions {
  rows: number;
  cols: number;
  cellsByPosition: Map<string, BlueprintCellDto>;
  longestCode: string;
  cellSize: number;
  /** 锁定高亮：该编码格子 100% + accent 细框，其余 35% 透明（变化时强制重绘） */
  highlightCode?: string | null;
  /** 点击（无拖动）时回调；null 表示点到轴外/空白 */
  onCellTap?: (cell: HoverCell | null) => void;
  /** 指针悬停（未拖动/捏合）时回调，组件可自行去重 */
  onHover?: (cell: HoverCell | null) => void;
}

interface BoardViewer {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  view: ViewState;
  viewportSize: { width: number; height: number };
  boardWidth: number;
  boardHeight: number;
  cellAt: (clientX: number, clientY: number) => HoverCell | null;
  fitView: () => void;
  resetView: () => void;
  zoomBy: (factor: number) => void;
  zoomAt: (anchorX: number, anchorY: number, factor: number) => void;
}

const TAP_SLOP = 4;
const REDRAW_DEBOUNCE_MS = 150;

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

export function useBoardViewer(options: BoardViewerOptions): BoardViewer {
  const { rows, cols, cellsByPosition, longestCode, cellSize, highlightCode = null } = options;

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
  // 回调走 ref：手势 effect 不随回调身份重绑
  const onCellTapRef = useRef(options.onCellTap);
  const onHoverRef = useRef(options.onHover);
  onCellTapRef.current = options.onCellTap;
  onHoverRef.current = options.onHover;
  const highlightRef = useRef(highlightCode);
  highlightRef.current = highlightCode;

  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewState>({ scale: 1, panX: 0, panY: 0 });

  const boardWidth = cols * cellSize + AXIS_GUTTER * 2;
  const boardHeight = rows * cellSize + AXIS_GUTTER * 2;

  /** 拖动/缩放时直接改 DOM transform（不走 React state），松手才同步回 view */
  const applyTransform = useCallback((panX: number, panY: number, scale: number) => {
    const el = wrapperRef.current;
    if (el) el.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${scale})`;
  }, []);

  const fitView = useCallback(() => {
    const rect = viewportRef.current?.getBoundingClientRect();
    const width = rect?.width ?? viewportSize.width;
    const height = rect?.height ?? viewportSize.height;
    if (!width || !height) return;
    const scale = clampZoom(Math.min((width - 24) / boardWidth, (height - 24) / boardHeight, 1.5));
    const next = { scale, panX: 0, panY: 0 };
    viewRef.current = next;
    setView(next);
  }, [boardHeight, boardWidth, viewportSize.height, viewportSize.width]);

  const cellAt = useCallback((clientX: number, clientY: number): HoverCell | null => {
    if (!viewportRef.current) return null;
    const rect = viewportRef.current.getBoundingClientRect();
    const current = viewRef.current;
    const localX = (clientX - rect.left - rect.width / 2 - current.panX) / current.scale + boardWidth / 2;
    const localY = (clientY - rect.top - rect.height / 2 - current.panY) / current.scale + boardHeight / 2;
    const col = Math.floor((localX - AXIS_GUTTER) / cellSize);
    const row = Math.floor((localY - AXIS_GUTTER) / cellSize);
    if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
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
  }, [rows, cols, boardHeight, boardWidth, cellSize, cellsByPosition]);

  /** 围绕屏幕锚点缩放（双击点 / 捏合中点 / 滚轮光标统一公式） */
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

  const zoomBy = useCallback((factor: number) => {
    setView((previous) => {
      const scale = clampZoom(previous.scale * factor);
      const ratio = scale / previous.scale;
      const next = { scale, panX: previous.panX * ratio, panY: previous.panY * ratio };
      viewRef.current = next;
      return next;
    });
  }, []);

  /** 100%：scale 归 1、pan 归零 */
  const resetView = useCallback(() => {
    const next = { scale: 1, panX: 0, panY: 0 };
    viewRef.current = next;
    setView(next);
  }, []);

  // 视口尺寸（ResizeObserver）
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // 挂载即适应窗口
  useEffect(() => {
    fitView();
  }, [fitView]);

  // 重绘：锁定切换/首次强制立即；缩放一律 150ms 防抖（连续缩放只做 transform，停止后清晰化）
  useEffect(() => {
    if (!canvasRef.current) return;
    if (redrawTimerRef.current !== null) {
      window.clearTimeout(redrawTimerRef.current);
      redrawTimerRef.current = null;
    }
    const highlight = highlightRef.current;
    const force = drawnRef.current.highlight !== highlight || drawnRef.current.scale === 0;
    const scale = view.scale;
    if (!force && scale <= drawnRef.current.scale) return;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const target = viewRef.current.scale;
      const targetHighlight = highlightRef.current;
      if (drawnRef.current.highlight === targetHighlight && target <= drawnRef.current.scale) return;
      drawBoard(canvas, rows, cols, cellSize, target, cellsByPosition, longestCode, targetHighlight);
      drawnRef.current = { scale: target, highlight: targetHighlight };
    };
    if (force) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        draw();
      });
    } else {
      redrawTimerRef.current = window.setTimeout(() => {
        redrawTimerRef.current = null;
        draw();
      }, REDRAW_DEBOUNCE_MS);
    }
  }, [rows, cols, cellSize, view.scale, highlightCode, cellsByPosition, longestCode]);

  // 手势：单指拖动 / 双指捏合 / 双击 / 滚轮 / 点击（4px 阈值）
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
      // 双指捏合（围绕两指中点）
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
      // 单指拖动（4px 阈值防漂移）
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
        onHoverRef.current?.(null);
        event.preventDefault();
        return;
      }
      // 悬停（桌面 tooltip）
      onHoverRef.current?.(cellAt(event.clientX, event.clientY));
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
      const drag = dragRef.current;
      dragRef.current = null;
      viewport.style.cursor = 'grab';
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      // 无拖动 = 点击
      const moved = drag ? Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) : 99;
      if (moved < TAP_SLOP) {
        onCellTapRef.current?.(cellAt(event.clientX, event.clientY));
      }
      // 松手把最新 pan/scale 同步回 React state（缩放百分比等 UI 依赖）
      setView(viewRef.current);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 0.88 : 1.12);
    };

    const onDoubleClick = (event: MouseEvent) => {
      const current = viewRef.current;
      zoomAt(event.clientX, event.clientY, current.scale > 1 ? 1 / 1.6 : 1.6);
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
  }, [applyTransform, cellAt, zoomAt]);

  return useMemo(
    () => ({
      viewportRef,
      wrapperRef,
      canvasRef,
      view,
      viewportSize,
      boardWidth,
      boardHeight,
      cellAt,
      fitView,
      resetView,
      zoomBy,
      zoomAt,
    }),
    [view, viewportSize, boardWidth, boardHeight, cellAt, fitView, resetView, zoomBy, zoomAt],
  );
}
