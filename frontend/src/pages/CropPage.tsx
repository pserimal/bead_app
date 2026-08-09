import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import Button from '../components/Button';
import { staggerContainer, staggerItem } from '../lib/animations';

/*
 * 独立裁剪页。
 *
 * The interaction layer deliberately uses one native Pointer Events state
 * machine instead of mixing React mouse events, pointer events and wheel
 * delegation. Pointer capture keeps a drag alive even when the pointer leaves
 * a small corner handle; refs keep the event handlers independent of render
 * timing.
 */

type ResizeHandle = 'nw' | 'ne' | 'se' | 'sw';
type DragMode = 'pan' | ResizeHandle;

const HANDLES: ResizeHandle[] = ['nw', 'ne', 'se', 'sw'];
const MIN_CROP = 8;
const MIN_CELL_COUNT = 1;
const MAX_CELL_COUNT = 500;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 8;
// 下限动态：fit 视图可能更小（平板视口 + 手机照片），放大后必须能缩回 fit
function zoomFloor(fitScale: number): number {
  return Math.min(ZOOM_MIN, fitScale || ZOOM_MIN);
}

const HANDLE_STYLE: Record<ResizeHandle, { left: string; top: string; cursor: string }> = {
  nw: { left: '0%', top: '0%', cursor: 'nwse-resize' },
  ne: { left: '100%', top: '0%', cursor: 'nesw-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
  sw: { left: '0%', top: '100%', cursor: 'nesw-resize' },
};

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ImageSize {
  w: number;
  h: number;
}

interface ViewState {
  scale: number;
  x: number;
  y: number;
}

interface CropPageState {
  imageUrl: string;
  imageW: number;
  imageH: number;
  initialCrop?: CropRect;
  rows?: number;
  cols?: number;
}

interface DragState {
  mode: DragMode;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startImgX: number;
  startImgY: number;
  startView: ViewState;
  origin: CropRect;
}

function clampCrop(next: CropRect, size: ImageSize): CropRect {
  const width = Math.max(0, size.w);
  const height = Math.max(0, size.h);
  const w = Math.max(MIN_CROP, Math.min(width, next.w));
  const h = Math.max(MIN_CROP, Math.min(height, next.h));
  return {
    x: Math.max(0, Math.min(next.x, width - w)),
    y: Math.max(0, Math.min(next.y, height - h)),
    w,
    h,
  };
}

function clampCellCount(value: number): number {
  if (!Number.isFinite(value)) return 29;
  return Math.max(MIN_CELL_COUNT, Math.min(MAX_CELL_COUNT, Math.round(value)));
}

function defaultCrop(size: ImageSize): CropRect {
  return clampCrop(
    {
      x: 0,
      y: 0,
      w: Math.round(size.w),
      h: Math.round(size.h),
    },
    size,
  );
}

function resizeCrop(mode: ResizeHandle, origin: CropRect, dx: number, dy: number, size: ImageSize): CropRect {
  const right = origin.x + origin.w;
  const bottom = origin.y + origin.h;
  let next = { ...origin };

  if (mode.includes('w')) {
    next.x = Math.min(origin.x + dx, right - MIN_CROP);
    next.w = right - next.x;
  }
  if (mode.includes('e')) {
    next.w = origin.w + dx;
  }
  if (mode.includes('n')) {
    next.y = Math.min(origin.y + dy, bottom - MIN_CROP);
    next.h = bottom - next.y;
  }
  if (mode.includes('s')) {
    next.h = origin.h + dy;
  }

  return clampCrop(next, size);
}

export default function CropPage() {
  const location = useLocation();
  const state = (location.state as CropPageState | null) ?? null;
  const imageSize: ImageSize = { w: state?.imageW ?? 0, h: state?.imageH ?? 0 };
  const hasImage = !!state?.imageUrl && imageSize.w > 0 && imageSize.h > 0;

  const [crop, setCrop] = useState<CropRect>(() => defaultCrop(imageSize));
  const [rows, setRows] = useState(() => clampCellCount(state?.rows ?? 29));
  const [cols, setCols] = useState(() => clampCellCount(state?.cols ?? 29));
  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });

  const stageRef = useRef<HTMLDivElement>(null);
  const imageSizeRef = useRef(imageSize);
  const cropRef = useRef(crop);
  const viewRef = useRef(view);
  const dragRef = useRef<DragState | null>(null);
  // fit 时的 scale（缩放下限基准；初始与 ZOOM_MIN 一致）
  const fitScaleRef = useRef(ZOOM_MIN);
  imageSizeRef.current = imageSize;
  cropRef.current = crop;
  viewRef.current = view;

  const updateCrop = useCallback((next: CropRect) => {
    const value = clampCrop(next, imageSizeRef.current);
    cropRef.current = value;
    setCrop(value);
  }, []);

  const fitView = useCallback((size: ImageSize) => {
    const stage = stageRef.current;
    const stageWidth = stage?.clientWidth ?? size.w;
    const stageHeight = stage?.clientHeight ?? size.h;
    const scale = Math.min(stageWidth / size.w, stageHeight / size.h, 1.5);
    const next = {
      scale,
      x: (stageWidth - size.w * scale) / 2,
      y: (stageHeight - size.h * scale) / 2,
    };
    viewRef.current = next;
    setView(next);
    fitScaleRef.current = scale;
  }, []);

  const toImageCoord = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    const size = imageSizeRef.current;
    if (!stage || !size.w || !size.h) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const current = viewRef.current;
    return {
      x: Math.max(0, Math.min(size.w, (clientX - rect.left - current.x) / current.scale)),
      y: Math.max(0, Math.min(size.h, (clientY - rect.top - current.y) / current.scale)),
    };
  }, []);

  const zoomAt = useCallback((clientX: number, clientY: number, deltaY: number) => {
    const stage = stageRef.current;
    const size = imageSizeRef.current;
    if (!stage || !size.w || !size.h) return;
    const rect = stage.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const previous = viewRef.current;
    // 动态下限：允许缩回 fit 初始 scale（大图/平板下 fit 可能 < 0.2）
    const floor = zoomFloor(fitScaleRef.current);
    const nextScale = Math.max(floor, Math.min(ZOOM_MAX, previous.scale * (deltaY > 0 ? 0.88 : 1.12)));
    if (nextScale === previous.scale) return;
    const next = {
      scale: nextScale,
      x: cx - (cx - previous.x) * (nextScale / previous.scale),
      y: cy - (cy - previous.y) * (nextScale / previous.scale),
    };
    viewRef.current = next;
    setView(next);
  }, []);

  /* Missing route state means the user opened /crop directly. */
  useEffect(() => {
    if (!state) window.location.href = '/';
  }, [state]);

  /* Initialize only when the actual image/crop inputs change. */
  useEffect(() => {
    if (!hasImage) return;
    const initial = state?.initialCrop ? clampCrop(state.initialCrop, imageSize) : defaultCrop(imageSize);
    cropRef.current = initial;
    setCrop(initial);
    setRows(clampCellCount(state?.rows ?? 29));
    setCols(clampCellCount(state?.cols ?? 29));
    const frame = requestAnimationFrame(() => fitView(imageSize));
    return () => cancelAnimationFrame(frame);
  }, [fitView, hasImage, imageSize.h, imageSize.w, state?.cols, state?.imageUrl, state?.initialCrop?.h, state?.initialCrop?.w, state?.initialCrop?.x, state?.initialCrop?.y, state?.rows]);

  /* Keep the image fitted when the viewport itself changes size. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !hasImage) return;
    const observer = new ResizeObserver(() => fitView(imageSizeRef.current));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fitView, hasImage]);

  /* One native interaction state machine: pointer capture + non-passive wheel. */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !hasImage) return;

    const finishPointer = (e: PointerEvent) => {
      const active = dragRef.current;
      if (!active || active.pointerId !== e.pointerId) return;
      dragRef.current = null;
      stage.style.cursor = 'grab';
      try {
        if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const target = e.target instanceof Element ? e.target.closest('[data-crop-handle]') : null;
      const handle = target?.getAttribute('data-crop-handle') as ResizeHandle | null;
      const point = toImageCoord(e.clientX, e.clientY);
      dragRef.current = {
        mode: handle ?? 'pan',
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startImgX: point.x,
        startImgY: point.y,
        startView: { ...viewRef.current },
        origin: { ...cropRef.current },
      };
      e.preventDefault();
      stage.focus({ preventScroll: true });
      stage.style.cursor = handle ? HANDLE_STYLE[handle].cursor : 'grabbing';
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture is unavailable in a few embedded browser contexts.
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const active = dragRef.current;
      if (!active || active.pointerId !== e.pointerId) return;
      e.preventDefault();

      if (active.mode === 'pan') {
        const next = {
          scale: active.startView.scale,
          x: active.startView.x + e.clientX - active.startClientX,
          y: active.startView.y + e.clientY - active.startClientY,
        };
        viewRef.current = next;
        setView(next);
        return;
      }

      const point = toImageCoord(e.clientX, e.clientY);
      updateCrop(
        resizeCrop(
          active.mode,
          active.origin,
          point.x - active.startImgX,
          point.y - active.startImgY,
          imageSizeRef.current,
        ),
      );
    };

    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target !== stage || dragRef.current) return;
      const step = e.shiftKey ? 10 : 1;
      const current = cropRef.current;
      let next: CropRect | null = null;
      if (e.key === 'ArrowLeft') next = e.altKey ? { ...current, w: current.w - step } : { ...current, x: current.x - step };
      if (e.key === 'ArrowRight') next = e.altKey ? { ...current, w: current.w + step } : { ...current, x: current.x + step };
      if (e.key === 'ArrowUp') next = e.altKey ? { ...current, h: current.h - step } : { ...current, y: current.y - step };
      if (e.key === 'ArrowDown') next = e.altKey ? { ...current, h: current.h + step } : { ...current, y: current.y + step };
      if (!next) return;
      e.preventDefault();
      updateCrop(next);
    };

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', finishPointer);
    stage.addEventListener('pointercancel', finishPointer);
    stage.addEventListener('lostpointercapture', finishPointer);
    stage.addEventListener('wheel', onNativeWheel, { passive: false });
    stage.addEventListener('keydown', onKeyDown);

    return () => {
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerup', finishPointer);
      stage.removeEventListener('pointercancel', finishPointer);
      stage.removeEventListener('lostpointercapture', finishPointer);
      stage.removeEventListener('wheel', onNativeWheel);
      stage.removeEventListener('keydown', onKeyDown);
    };
  }, [hasImage, toImageCoord, updateCrop, zoomAt]);

  function setCropField(field: keyof CropRect, value: string) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    updateCrop({ ...cropRef.current, [field]: number });
  }

  function setCellField(setter: (value: number) => void, value: string) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    setter(clampCellCount(number));
  }

  function handleConfirm() {
    if (!state) return;
    try {
      sessionStorage.setItem(
        'pendingCrop',
        JSON.stringify({
          crop: cropRef.current,
          imageUrl: state.imageUrl,
          imageW: state.imageW,
          imageH: state.imageH,
          rows,
          cols,
        }),
      );
    } catch {
      // sessionStorage may be blocked; the current page can still navigate.
    }
    window.location.href = '/';
  }

  if (!state || !hasImage) return null;

  const cropScreen = {
    left: view.x + crop.x * view.scale,
    top: view.y + crop.y * view.scale,
    width: crop.w * view.scale,
    height: crop.h * view.scale,
  };
  const fields: Array<{ key: keyof CropRect; label: string }> = [
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' },
    { key: 'w', label: '宽' },
    { key: 'h', label: '高' },
  ];
  const cellWidth = crop.w / cols;
  const cellHeight = crop.h / rows;
  const screenCellWidth = Math.max(1, cellWidth * view.scale);
  const screenCellHeight = Math.max(1, cellHeight * view.scale);

  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-4">
        <motion.div variants={staggerItem} className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>
              裁剪图纸区域
            </h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
              {typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
                ? '单指拖动图片 · 双指缩放 · 四角手柄调框'
                : '拖动平移图片 · 滚轮缩放 · 四角手柄调框 · 方向键微调'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={() => { window.location.href = '/'; }}>
              取消
            </Button>
            <Button onClick={handleConfirm}>✓ 确认裁剪</Button>
          </div>
        </motion.div>

        <motion.div variants={staggerItem}>
          <div
            ref={stageRef}
            className="relative w-full overflow-hidden rounded-lg select-none"
            tabIndex={0}
            role="application"
            aria-label="图纸裁剪工作区"
            style={{ background: '#17130f', touchAction: 'none', height: '72vh', cursor: 'grab', outline: 'none' }}
          >
            <img
              src={state.imageUrl}
              alt="crop source"
              draggable={false}
              style={{
                position: 'absolute',
                left: view.x,
                top: view.y,
                width: imageSize.w * view.scale,
                height: imageSize.h * view.scale,
                maxWidth: 'none',
                pointerEvents: 'none',
                userSelect: 'none',
              }}
            />

            {crop.w >= MIN_CROP && crop.h >= MIN_CROP && (
              <div
                className="absolute"
                style={{
                  left: cropScreen.left,
                  top: cropScreen.top,
                  width: cropScreen.width,
                  height: cropScreen.height,
                  border: '2px solid var(--color-accent)',
                  background: 'rgba(220,69,56,0.06)',
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                  outline: 'none',
                  zIndex: 2,
                }}
              >
                <div
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    backgroundImage: [
                      'linear-gradient(to right, rgba(199,91,57,0.55) 1px, transparent 1px)',
                      'linear-gradient(to bottom, rgba(199,91,57,0.55) 1px, transparent 1px)',
                    ].join(','),
                    backgroundSize: `${screenCellWidth}px 100%, 100% ${screenCellHeight}px`,
                    zIndex: 1,
                  }}
                />
                {HANDLES.map((handle) => (
                  <div
                    key={handle}
                    data-crop-handle={handle}
                    aria-label={`${handle} resize handle`}
                    role="button"
                    className="absolute"
                    style={{
                      ...HANDLE_STYLE[handle],
                      width: 18,
                      height: 18,
                      transform: 'translate(-50%, -50%)',
                      background: '#fff',
                      border: '2px solid var(--color-accent)',
                      borderRadius: 4,
                      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                      pointerEvents: 'auto',
                      zIndex: 3,
                    }}
                  />
                ))}
              </div>
            )}

            <div
              style={{
                position: 'absolute',
                left: 10,
                bottom: 10,
                background: 'rgba(0,0,0,0.5)',
                color: '#fff',
                fontSize: 11,
                padding: '4px 10px',
                borderRadius: 4,
                pointerEvents: 'none',
                fontFamily: 'var(--font-mono)',
                zIndex: 4,
              }}
            >
              {view.scale.toFixed(1)}x
            </div>
          </div>
        </motion.div>

        <motion.div variants={staggerItem}>
          <div
            className="rounded-xl p-4"
            style={{
              background: 'var(--color-card)',
              border: '1px solid var(--color-border)',
              boxShadow: '0 8px 24px rgba(35, 31, 32, 0.05)',
            }}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-accent)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  Cut map
                </div>
                <div style={{ fontWeight: 700, marginTop: 3 }}>切割预览</div>
                <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 3 }}>
                  框内区域会按横向列数 × 纵向行数均分
                </div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                <div style={{ color: 'var(--color-text)', fontWeight: 700, fontSize: 'var(--text-sm)' }}>{(rows * cols).toLocaleString()} 格</div>
                <div style={{ marginTop: 3 }}>每格约 {cellWidth >= 10 ? Math.round(cellWidth) : cellWidth.toFixed(1)} × {cellHeight >= 10 ? Math.round(cellHeight) : cellHeight.toFixed(1)} px</div>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3" style={{ marginTop: 14 }}>
              <label className="flex flex-col gap-1">
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>横向单元格（列）</span>
                <input
                  type="number"
                  min={MIN_CELL_COUNT}
                  max={MAX_CELL_COUNT}
                  value={cols}
                  onChange={(e) => setCellField(setCols, e.target.value)}
                  className="px-3 py-1.5 rounded-lg border w-28"
                  style={{ borderColor: 'var(--color-border)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>纵向单元格（行）</span>
                <input
                  type="number"
                  min={MIN_CELL_COUNT}
                  max={MAX_CELL_COUNT}
                  value={rows}
                  onChange={(e) => setCellField(setRows, e.target.value)}
                  className="px-3 py-1.5 rounded-lg border w-28"
                  style={{ borderColor: 'var(--color-border)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}
                />
              </label>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', paddingBottom: 8 }}>
                网格线已叠加到裁剪框内
              </span>
            </div>
          </div>
        </motion.div>

        <motion.div variants={staggerItem}>
          <div className="flex flex-wrap items-end gap-3">
            {fields.map((field) => (
              <label key={field.key} className="flex flex-col gap-1">
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{field.label}</span>
                <input
                  type="number"
                  min={0}
                  max={field.key === 'x' || field.key === 'w' ? imageSize.w : imageSize.h}
                  value={Math.round(crop[field.key])}
                  onChange={(e) => setCropField(field.key, e.target.value)}
                  className="px-2 py-1.5 rounded-lg border w-20"
                  style={{ borderColor: 'var(--color-border)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
                />
              </label>
            ))}
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', paddingBottom: 8, whiteSpace: 'nowrap' }}>
              裁剪框：{Math.round(crop.w)}×{Math.round(crop.h)}px @ ({Math.round(crop.x)},{Math.round(crop.y)})
            </span>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
