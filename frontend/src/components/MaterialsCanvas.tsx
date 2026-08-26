import { memo, useCallback, useEffect, useRef } from 'react';
import type { PointerEvent, RefObject } from 'react';
import { motion } from 'framer-motion';
import type { Box, View } from '../hooks/useMaterialsCapture';

type Props = {
  imageUrl: string;
  imageW: number;
  imageH: number;
  box: Box;
  highlightBox?: Box | null;
  view: View;
  rows: number;
  cols: number;
  stageRef: RefObject<HTMLDivElement | null>;
  /** 画框模式：按下拖动重画框选区域（拖出有效框后自动退出） */
  drawing?: boolean;
  onBox: (box: Box) => void;
  onView: (view: View) => void;
  onFit: () => void;
  onDrawingEnd?: () => void;
  onFocusLeave?: () => void;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const MIN_SCALE = 0.01;
const MAX_SCALE = 8;
const ZOOM_FACTOR = 1.12;
const ZOOM_OUT_FACTOR = 1 / ZOOM_FACTOR;

const MaterialsCanvas = memo(function MaterialsCanvas({
  imageUrl,
  imageW,
  imageH,
  box,
  highlightBox,
  view,
  rows,
  cols,
  stageRef,
  drawing = false,
  onBox,
  onView,
  onFit,
  onDrawingEnd,
  onFocusLeave,
}: Props) {
  const drag = useRef<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    lastClientX: number;
    lastClientY: number;
    box: Box;
    view: View;
    handle: string | null;
  } | null>(null);
  // 拖拽期间用 rAF 节流：每帧最多应用一次视图/选框更新，避免 pointermove
  // 高频率同步 dispatch 导致整个页面重渲染卡顿。
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);

  const schedule = (fn: () => void) => {
    pendingRef.current = fn;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const next = pendingRef.current;
      pendingRef.current = null;
      next?.();
    });
  };

  const flush = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const next = pendingRef.current;
    pendingRef.current = null;
    next?.();
  };

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  const pointAt = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    return {
      x: clamp((clientX - rect.left - view.x) / view.scale, 0, imageW),
      y: clamp((clientY - rect.top - view.y) / view.scale, 0, imageH),
    };
  };

  const capturePointer = (event: PointerEvent) => {
    // 合成事件/边缘条件下可能无活跃指针；capture 失败降级为普通事件流即可
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  };

  const handlePointerDown = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const position = pointAt(event.clientX, event.clientY);
    if (drawing) {
      // 画框模式：按下即从起点开画（不移动视图、不动旧框）
      drag.current = {
        x: position.x,
        y: position.y,
        clientX: event.clientX,
        clientY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        box: { x: position.x, y: position.y, w: 0, h: 0 },
        view,
        handle: 'draw',
      };
      capturePointer(event);
      return;
    }
    drag.current = {
      x: position.x,
      y: position.y,
      clientX: event.clientX,
      clientY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      box,
      view,
      handle: (event.target as HTMLElement).dataset.boxHandle ?? null,
    };
    capturePointer(event);
  };

  const handlePointerMove = (event: PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    current.lastClientX = event.clientX;
    current.lastClientY = event.clientY;
    schedule(() => {
      const d = drag.current;
      if (!d) return;
      if (d.handle === 'draw') {
        // 起点 → 当前点的矩形（图片坐标，clamp 到图片边界）
        const p = pointAt(d.lastClientX, d.lastClientY);
        d.box = { x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.max(4, Math.abs(p.x - d.x)), h: Math.max(4, Math.abs(p.y - d.y)) };
        onBox(d.box);
        return;
      }
      if (!d.handle) {
        // movementX/Y 在 Pointer Capture、触摸和部分浏览器事件中可能恒为 0；
        // 用同一拖动序列的 client 坐标差计算，避免放大后看起来无法平移。
        onView({
          ...d.view,
          x: d.view.x + d.lastClientX - d.clientX,
          y: d.view.y + d.lastClientY - d.clientY,
        });
        return;
      }
      const p = pointAt(d.lastClientX, d.lastClientY);
      const delta = { x: p.x - d.x, y: p.y - d.y };
      const original = d.box;
      const handle = d.handle;
      const next = { ...original };
      if (handle.includes('w')) {
        next.x = original.x + delta.x;
        next.w = original.w - delta.x;
      }
      if (handle.includes('e')) next.w = original.w + delta.x;
      if (handle.includes('n')) {
        next.y = original.y + delta.y;
        next.h = original.h - delta.y;
      }
      if (handle.includes('s')) next.h = original.h + delta.y;
      onBox({
        x: clamp(next.x, 0, imageW - 12),
        y: clamp(next.y, 0, imageH - 12),
        w: clamp(next.w, 12, imageW),
        h: clamp(next.h, 12, imageH),
      });
    });
  };

  const endDrag = () => {
    flush();
    const d = drag.current;
    // 画出有效框（拖动 ≥4 屏幕像素）→ 完成重新框选；否则保持画框模式（误触不退出）
    if (d?.handle === 'draw' && (Math.abs(d.lastClientX - d.clientX) >= 4 || Math.abs(d.lastClientY - d.clientY) >= 4)) {
      onDrawingEnd?.();
    }
    drag.current = null;
  };

  const handleWheel = useCallback((event: globalThis.WheelEvent) => {
    event.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const factor = event.deltaY > 0 ? ZOOM_OUT_FACTOR : ZOOM_FACTOR;
    const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    onView({
      scale: nextScale,
      x: x - (x - view.x) * nextScale / view.scale,
      y: y - (y - view.y) * nextScale / view.scale,
    });
  }, [onView, stageRef, view]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
  }, [handleWheel, stageRef]);

  const screenBox = (target: Box) => ({
    left: view.x + target.x * view.scale,
    top: view.y + target.y * view.scale,
    width: target.w * view.scale,
    height: target.h * view.scale,
  });
  const selection = screenBox(box);
  const highlight = highlightBox ? screenBox(highlightBox) : null;

  return (
    <div
      ref={stageRef}
      role="application"
      aria-label="物料清单框选工作区"
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onBlur={(event) => {
        // 焦点在画布内部元素（缩放按钮等）间移动时不算离开
        const related = event.relatedTarget as Node | null;
        if (related && stageRef.current?.contains(related)) return;
        onFocusLeave?.();
      }}
      style={{ position: 'relative', height: 'min(58vh, 520px)', overflow: 'hidden', background: 'var(--color-bg-secondary)', touchAction: 'none', cursor: drawing ? 'crosshair' : 'grab', outline: 'none' }}
    >
      <img src={imageUrl} alt="物料清单原图" draggable={false} decoding="async" style={{ position: 'absolute', left: view.x, top: view.y, width: imageW * view.scale, height: imageH * view.scale, maxWidth: 'none', pointerEvents: 'none', userSelect: 'none' }} />
      <div style={{ position: 'absolute', left: selection.left, top: selection.top, width: selection.width, height: selection.height, border: drawing ? '2px dashed var(--color-accent)' : '2px solid var(--color-accent)', background: 'rgba(199,91,57,.06)', pointerEvents: 'none' }}>
        {Array.from({ length: Math.max(0, rows - 1) }, (_, index) => (
          <i key={`row-${index}`} style={{ position: 'absolute', left: 6, right: 6, top: `${(index + 1) * 100 / rows}%`, borderTop: '1px solid var(--color-accent-alt)' }} />
        ))}
        {Array.from({ length: Math.max(0, cols - 1) }, (_, index) => (
          <i key={`col-${index}`} style={{ position: 'absolute', top: 6, bottom: 6, left: `${(index + 1) * 100 / cols}%`, borderLeft: '1px solid var(--color-accent-alt)' }} />
        ))}
        {!drawing && (['nw', 'ne', 'se', 'sw'] as const).map((handle) => (
          <b
            key={handle}
            data-box-handle={handle}
            style={{ position: 'absolute', left: handle.includes('w') ? '0' : '100%', top: handle.includes('n') ? '0' : '100%', width: 14, height: 14, margin: -7, background: 'var(--color-accent)', border: '2px solid white', borderRadius: 4, pointerEvents: 'auto' }}
          />
        ))}
      </div>
      {drawing && (
        <div className="absolute inset-x-0 top-0 z-10 text-center text-xs py-1.5" style={{ background: 'rgba(148, 64, 39, 0.88)', color: 'var(--color-text-inverse)', pointerEvents: 'none' }}>
          在图上按下并拖动，画出新的框选区域
        </div>
      )}
      {highlight && (
        <motion.div
          aria-label="已定位的物料清单格"
          style={{
            position: 'absolute',
            left: highlight.left,
            top: highlight.top,
            width: highlight.width,
            height: highlight.height,
            border: '4px solid var(--color-success)',
            borderRadius: 2,
            background: 'rgba(55, 145, 91, 0.16)',
            pointerEvents: 'none',
            zIndex: 3,
          }}
          animate={{
            boxShadow: [
              '0 0 0 2px rgba(55, 145, 91, 0.45), 0 0 16px 4px rgba(55, 145, 91, 0.6)',
              '0 0 0 7px rgba(55, 145, 91, 0.14), 0 0 30px 8px rgba(55, 145, 91, 0.32)',
              '0 0 0 2px rgba(55, 145, 91, 0.45), 0 0 16px 4px rgba(55, 145, 91, 0.6)',
            ],
          }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <div className="absolute right-3 bottom-3 flex gap-1.5">
        <button type="button" aria-label="缩小" onPointerDown={(event) => event.stopPropagation()} onClick={() => onView({ ...view, scale: Math.max(MIN_SCALE, view.scale * ZOOM_OUT_FACTOR) })}>−</button>
        <button type="button" aria-label="恢复适应窗口" title="恢复适应窗口" onPointerDown={(event) => event.stopPropagation()} onClick={onFit}>{Math.round(view.scale * 100)}%</button>
        <button type="button" aria-label="放大" onPointerDown={(event) => event.stopPropagation()} onClick={() => onView({ ...view, scale: Math.min(MAX_SCALE, view.scale * ZOOM_FACTOR) })}>+</button>
      </div>
    </div>
  );
});

export default MaterialsCanvas;
