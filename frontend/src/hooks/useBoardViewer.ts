import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AXIS_GUTTER, clampZoom, drawBoard, drawBoardViewport } from '../lib/boardCanvas';
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
  /** 首次绘制完成前为 false（超大板子 fit 首次重绘可达 1-2s，页面应显示 loading） */
  ready: boolean;
  /** 视口裁剪模式（位图 = 视口大小，只画可见格）：wrapper 变换应为 none */
  viewportMode: boolean;
  cellAt: (clientX: number, clientY: number) => HoverCell | null;
  fitView: () => void;
  resetView: () => void;
  zoomBy: (factor: number) => void;
  zoomAt: (anchorX: number, anchorY: number, factor: number) => void;
}

const TAP_SLOP = 4;
/** tap 最长时长（ms）：超过视为拖动/长按，不算点击（移动端拖拽误触修复） */
const TAP_MAX_MS = 400;
/** tap 延迟触发窗口（ms）：双击（dblclick）在此窗口内到达则取消——双击缩放不算 tap */
const TAP_DBLCLICK_WINDOW_MS = 300;
const REDRAW_DEBOUNCE_MS = 150;
/** 整图模式位图上限：边长 4096（移动端 GPU/浏览器纹理上限——超限 canvas 显示异常/大面积消失，
 * iOS Safari 尤甚）或面积 24MP。超过即切视口裁剪模式：位图固定视口大小，只画可见格子。
 * 90×158 板 dpr2：scale > ~102% 即触发。 */
const FULL_BOARD_MAX_DIM = 4096;
const FULL_BOARD_MAX_MP = 24;

/**
 * pan 边界约束：板子与视口始终有交集——大板（bw>vw）贴边不能拖出，小板（bw≤vw）完全可见滑移。
 * 公式：板子左缘 canvasLeft = vw/2 + panX − bw/2，交集约束 canvasLeft ∈ [min(0,vw−bw), max(0,vw−bw)]。
 */
export function clampPan(
  panX: number,
  panY: number,
  viewportW: number,
  viewportH: number,
  boardW: number,
  boardH: number,
  scale: number,
): { panX: number; panY: number } {
  const bw = boardW * scale;
  const bh = boardH * scale;
  const loX = Math.min(0, viewportW - bw) - (viewportW - bw) / 2;
  const hiX = Math.max(0, viewportW - bw) - (viewportW - bw) / 2;
  const loY = Math.min(0, viewportH - bh) - (viewportH - bh) / 2;
  const hiY = Math.max(0, viewportH - bh) - (viewportH - bh) / 2;
  return {
    panX: Math.min(hiX, Math.max(loX, panX)),
    panY: Math.min(hiY, Math.max(loY, panY)),
  };
}

interface PointerDrag {
  pointerId: number;
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
  /** 按下时间戳：拖拽/长按不算 tap（移动端手指抖动 + 慢抬会误触发单元格点击） */
  startTime: number;
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
  const drawnRef = useRef<{ scale: number; highlight: string | null; mode: 'full' | 'viewport' }>({
    scale: 0,
    highlight: null,
    mode: 'full',
  });
  const redrawTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const redrawRafRef = useRef<number | null>(null); // 视口模式拖动/捏合期间的 rAF 合并
  const readyRef = useRef(false);
  const tapTimerRef = useRef<number | null>(null); // 延迟 tap：双击窗口内取消
  const didPinchRef = useRef(false); // 本轮手势捏合过 → 抬起不算 tap（移动端缩放误触）
  // 卸载清理
  useEffect(
    () => () => {
      if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
    },
    [],
  );
  // 回调走 ref：手势 effect 不随回调身份重绑
  const onCellTapRef = useRef(options.onCellTap);
  const onHoverRef = useRef(options.onHover);
  onCellTapRef.current = options.onCellTap;
  onHoverRef.current = options.onHover;
  const highlightRef = useRef(highlightCode);
  highlightRef.current = highlightCode;

  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewState>({ scale: 1, panX: 0, panY: 0 });
  const [ready, setReady] = useState(false);

  // 视口裁剪模式：整图位图边长超 4096（移动端纹理上限，超限显示异常/消失）或面积超 24MP
  // 时启用——位图固定视口大小，拖拽每帧重绘可见格
  const viewportMode = useMemo(() => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const boardW = cols * cellSize + AXIS_GUTTER * 2;
    const boardH = rows * cellSize + AXIS_GUTTER * 2;
    const renderScale = Math.max(1, Math.min(view.scale, 3));
    const w = boardW * renderScale * dpr;
    const h = boardH * renderScale * dpr;
    return w > FULL_BOARD_MAX_DIM || h > FULL_BOARD_MAX_DIM || (w * h) / 1e6 > FULL_BOARD_MAX_MP;
  }, [cols, cellSize, rows, view.scale]);
  const viewportModeRef = useRef(viewportMode);
  viewportModeRef.current = viewportMode;

  const boardWidth = cols * cellSize + AXIS_GUTTER * 2;
  const boardHeight = rows * cellSize + AXIS_GUTTER * 2;

  /** 拖动/缩放时直接改 DOM transform（不走 React state），松手才同步回 view。
   *  视口模式下位图按屏幕像素绘制（已含偏移），wrapper 只需中心对齐
   *  （left:50% top:50% 需 translate(-50%,-50%) 回拉，否则 canvas 偏到视口右下外）。 */
  const applyTransform = useCallback((panX: number, panY: number, scale: number) => {
    const el = wrapperRef.current;
    if (!el) return;
    if (viewportModeRef.current) {
      el.style.transform = 'translate(-50%, -50%)';
      return;
    }
    el.style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${scale})`;
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
    const bounded = clampPan(
      anchorLocalX - (anchorLocalX - current.panX) * ratio,
      anchorLocalY - (anchorLocalY - current.panY) * ratio,
      rect.width,
      rect.height,
      boardWidth,
      boardHeight,
      scale,
    );
    const next = {
      scale,
      panX: bounded.panX,
      panY: bounded.panY,
    };
    viewRef.current = next;
    setView(next);
  }, [boardHeight, boardWidth]);

  const zoomBy = useCallback((factor: number) => {
    setView((previous) => {
      const scale = clampZoom(previous.scale * factor);
      const ratio = scale / previous.scale;
      const bounded = clampPan(
        previous.panX * ratio,
        previous.panY * ratio,
        viewportSize.width,
        viewportSize.height,
        boardWidth,
        boardHeight,
        scale,
      );
      const next = { scale, panX: bounded.panX, panY: bounded.panY };
      viewRef.current = next;
      return next;
    });
  }, [boardHeight, boardWidth, viewportSize.height, viewportSize.width]);

  /** 100%：scale 归 1、pan 归零 */
  const resetView = useCallback(() => {
    const next = { scale: 1, panX: 0, panY: 0 };
    viewRef.current = next;
    setView(next);
  }, []);

  // 视口尺寸（ResizeObserver）：挂载时 blueprint 未加载、refs 未填充，必须在 rows/cols
  // 变化（数据到达）时重跑；观察期内的 resize 由 observer 覆盖。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [rows, cols]);

  // 首次挂载适应窗口：只在 viewportSize 就绪后 fit **一次**——fitView 依赖 viewportSize，
  // 若以 [fitView] 为依赖会在每次尺寸变化（如移动端输入法弹出导致容器 resize）时重新 fit，
  // 把用户缩放重置回 fit（实测 bug）。用户手动点"适应窗口"不受影响（直接调用 fitView）。
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    if (!viewportSize.width || !viewportSize.height) return; // 尺寸未就绪（blueprint 未加载），等下次
    fitView();
    didFitRef.current = true;
  }, [fitView, viewportSize]);

  /** 视口模式拖动/捏合期间的连续重绘（rAF 合并，每帧只画可见格子，~10ms） */
  const scheduleViewportRedraw = useCallback(() => {
    if (redrawRafRef.current !== null) return;
    redrawRafRef.current = requestAnimationFrame(() => {
      redrawRafRef.current = null;
      const canvas = canvasRef.current;
      if (!canvas || !viewportModeRef.current) return;
      const v = viewRef.current;
      drawBoardViewport(
        canvas, rows, cols, cellSize,
        v.scale, v.panX, v.panY,
        viewportSize.width, viewportSize.height,
        cellsByPosition, longestCode, highlightRef.current,
      );
      drawnRef.current = { scale: v.scale, highlight: highlightRef.current, mode: 'viewport' };
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      }
    });
  }, [cellsByPosition, cellSize, cols, longestCode, rows, viewportSize.height, viewportSize.width]);

  /** 统一绘制入口：视口模式 drawBoardViewport（立即，快）；整图模式 drawBoard（防抖/跳过缩小） */
  const drawFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const v = viewRef.current;
    const targetHighlight = highlightRef.current;
    if (viewportModeRef.current) {
      drawBoardViewport(
        canvas, rows, cols, cellSize,
        v.scale, v.panX, v.panY,
        viewportSize.width, viewportSize.height,
        cellsByPosition, longestCode, targetHighlight,
      );
      drawnRef.current = { scale: v.scale, highlight: targetHighlight, mode: 'viewport' };
    } else {
      // 缩小跳过仅限同模式内；视口→整图模式切换必须强制重绘（canvas 样式/位图需复位）
      if (drawnRef.current.mode !== 'viewport' && drawnRef.current.highlight === targetHighlight && v.scale <= drawnRef.current.scale) return;
      drawBoard(canvas, rows, cols, cellSize, v.scale, cellsByPosition, longestCode, targetHighlight);
      drawnRef.current = { scale: v.scale, highlight: targetHighlight, mode: 'full' };
    }
    if (!readyRef.current) {
      readyRef.current = true;
      setReady(true);
    }
  }, [cellsByPosition, cellSize, cols, longestCode, rows, viewportSize.height, viewportSize.width]);

  // 重绘：视口模式立即 rAF（快，无需防抖，保证捏合/缩放连续帧）；
  // 整图模式保持锁定切换/首次强制立即、缩放 150ms 防抖、缩小跳过。
  useEffect(() => {
    if (!canvasRef.current) return;
    if (redrawTimerRef.current !== null) {
      window.clearTimeout(redrawTimerRef.current);
      redrawTimerRef.current = null;
    }
    if (viewportModeRef.current) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        drawFrame();
      });
      return;
    }
    const highlight = highlightRef.current;
    // 视口→整图模式切换（drawn.mode==='viewport'）必须强制重绘：canvas 位图/样式需复位
    const force = drawnRef.current.highlight !== highlight || drawnRef.current.scale === 0 || drawnRef.current.mode === 'viewport';
    const scale = view.scale;
    if (!force && scale <= drawnRef.current.scale) return;
    if (force) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        drawFrame();
      });
    } else {
      redrawTimerRef.current = window.setTimeout(() => {
        redrawTimerRef.current = null;
        drawFrame();
      }, REDRAW_DEBOUNCE_MS);
    }
  }, [rows, cols, cellSize, view.scale, highlightCode, cellsByPosition, longestCode, viewportMode, viewportSize, drawFrame]);

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
          startTime: event.timeStamp,
        };
      } else if (pointersRef.current.size === 2) {
        dragRef.current = null;
        didPinchRef.current = true;
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
          const bounded = clampPan(
            midX - (midX - current.panX) * ratio,
            midY - (midY - current.panY) * ratio,
            rect.width,
            rect.height,
            boardWidth,
            boardHeight,
            scale,
          );
          const next = {
            scale,
            panX: bounded.panX,
            panY: bounded.panY,
          };
          viewRef.current = next;
          applyTransform(next.panX, next.panY, next.scale);
          // 视口模式：位图只覆盖视口，捏合期间每帧重绘可见格（快）；整图模式仅 transform 即可
          if (viewportModeRef.current) scheduleViewportRedraw();
        }
        event.preventDefault();
        return;
      }
      const drag = dragRef.current;
      // 单指拖动（4px 阈值防漂移）
      if (drag && drag.pointerId === event.pointerId) {
        const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        if (moved < TAP_SLOP) return;
        const scale = viewRef.current.scale;
        const rect = viewport.getBoundingClientRect();
        const bounded = clampPan(
          drag.startPanX + event.clientX - drag.startX,
          drag.startPanY + event.clientY - drag.startY,
          rect.width,
          rect.height,
          boardWidth,
          boardHeight,
          scale,
        );
        const next = {
          scale,
          panX: bounded.panX,
          panY: bounded.panY,
        };
        // 已到边界：不再更新 transform / 重绘
        const current = viewRef.current;
        if (next.panX === current.panX && next.panY === current.panY && next.scale === current.scale) return;
        viewRef.current = next;
        applyTransform(next.panX, next.panY, next.scale);
        if (viewportModeRef.current) scheduleViewportRedraw();
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
          startTime: event.timeStamp,
        };
        return;
      }
      if (pointersRef.current.size > 1) return;
      const drag = dragRef.current;
      dragRef.current = null;
      viewport.style.cursor = 'grab';
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      // 无拖动 = 点击：位移 < TAP_SLOP、时长 < TAP_MAX_MS、且本轮回合未捏合过
      const moved = drag ? Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) : 99;
      const quick = drag ? event.timeStamp - drag.startTime < TAP_MAX_MS : false;
      if (moved < TAP_SLOP && quick && !didPinchRef.current) {
        const cell = cellAt(event.clientX, event.clientY);
        // 延迟触发：双击（dblclick）在窗口内到达时取消（双击缩放不算 tap）
        if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
        tapTimerRef.current = window.setTimeout(() => {
          tapTimerRef.current = null;
          onCellTapRef.current?.(cell);
        }, TAP_DBLCLICK_WINDOW_MS);
      }
      // 手势完全结束：重置捏合标志
      if (pointersRef.current.size === 0) didPinchRef.current = false;
      // 松手把最新 pan/scale 同步回 React state（缩放百分比等 UI 依赖）
      setView(viewRef.current);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 0.88 : 1.12);
    };

    const onDoubleClick = (event: MouseEvent) => {
      // 双击缩放：取消待触发的 tap（延迟窗口内的单点不算点击）
      if (tapTimerRef.current !== null) {
        window.clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
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
  }, [applyTransform, boardHeight, boardWidth, cellAt, scheduleViewportRedraw, zoomAt]);

  return useMemo(
    () => ({
      viewportRef,
      wrapperRef,
      canvasRef,
      view,
      viewportSize,
      boardWidth,
      boardHeight,
      ready,
      viewportMode,
      cellAt,
      fitView,
      resetView,
      zoomBy,
      zoomAt,
    }),
    [view, viewportSize, boardWidth, boardHeight, cellAt, fitView, resetView, zoomBy, zoomAt, ready, viewportMode],
  );
}
