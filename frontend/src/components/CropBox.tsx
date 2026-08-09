import {
  useState,
  useRef,
  useEffect,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from 'react';

/* ═══════════════════════════════════════════════════════
   Types (preserved for backward compatibility)
   ═══════════════════════════════════════════════════════ */

interface Region {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Regions {
  A?: Region;
  B?: Region;
}

export interface CropBoxHandle {
  applyCrop: (
    id: string,
    cb: (blob: Blob, region: { x: number; y: number; w: number; h: number }) => void,
  ) => void;
  clearCrop: (id: string) => void;
  hasCrop: () => boolean;
}

interface RegionData {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CropBoxProps {
  image: string;
  mode?: 'single' | 'dual';
  labels?: [string, string];
  onSelectionChange?: (has: boolean) => void;
  onCropComplete?: (result: {
    regionABlob: Blob;
    regionBBlob: Blob;
    regionAData: RegionData;
    regionBData: RegionData;
  }) => void;
}

/* ═══════════════════════════════════════════════════════
   Internal types
   ═══════════════════════════════════════════════════════ */

type RegionKey = 'A' | 'B';
type HandleType = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface DragState {
  regionKey: RegionKey;
  handleType: HandleType;
  startClientX: number;
  startClientY: number;
  startRegion: Region;
}

interface PinchState {
  initialDist: number;
  initialZoom: number;
}

type Interaction =
  | { type: 'drag'; state: DragState }
  | {
      type: 'pan';
      startX: number;
      startY: number;
      startPanX: number;
      startPanY: number;
    };

/* ═══════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════ */

const COLORS: Record<RegionKey, string> = {
  A: '#6366f1',
  B: '#10b981',
};

const HANDLE_SIZE = 10;
const TOUCH_TARGET = 44;
const MIN_REGION = 20;
const OVERLAY_COLOR = 'rgba(0,0,0,0.5)';
const ZOOM_MAX = 3;
// 下限动态：fit 视图可能 < 0.5（大图），放大后必须能缩回初始 fit
function zoomFloor(initialZoom: number): number {
  return Math.min(0.5, initialZoom || 1);
}

interface HandleConfig {
  type: HandleType;
  cursor: string;
  style: React.CSSProperties;
}

function makeHandles(w: number, h: number): HandleConfig[] {
  const hs = HANDLE_SIZE;
  return [
    { type: 'nw', cursor: 'nwse-resize', style: { top: -hs / 2, left: -hs / 2 } },
    { type: 'n', cursor: 'ns-resize', style: { top: -hs / 2, left: w / 2 - hs / 2 } },
    { type: 'ne', cursor: 'nesw-resize', style: { top: -hs / 2, right: -hs / 2 } },
    { type: 'e', cursor: 'ew-resize', style: { top: h / 2 - hs / 2, right: -hs / 2 } },
    { type: 'se', cursor: 'nwse-resize', style: { bottom: -hs / 2, right: -hs / 2 } },
    { type: 's', cursor: 'ns-resize', style: { bottom: -hs / 2, left: w / 2 - hs / 2 } },
    { type: 'sw', cursor: 'nesw-resize', style: { bottom: -hs / 2, left: -hs / 2 } },
    { type: 'w', cursor: 'ew-resize', style: { top: h / 2 - hs / 2, left: -hs / 2 } },
  ];
}

/* ═══════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════ */

function clampRegion(r: Region, imgW: number, imgH: number): Region {
  let { top, bottom, left, right } = r;
  left = Math.max(0, Math.min(left, imgW - MIN_REGION));
  right = Math.max(left + MIN_REGION, Math.min(right, imgW));
  top = Math.max(0, Math.min(top, imgH - MIN_REGION));
  bottom = Math.max(top + MIN_REGION, Math.min(bottom, imgH));
  return {
    top: Math.round(top),
    bottom: Math.round(bottom),
    left: Math.round(left),
    right: Math.round(right),
  };
}

function computeNewRegion(
  handleType: HandleType,
  start: Region,
  dx: number,
  dy: number,
  imgW: number,
  imgH: number,
): Region {
  let { top, bottom, left, right } = start;
  switch (handleType) {
    case 'move':
      left += dx;
      right += dx;
      top += dy;
      bottom += dy;
      break;
    case 'n':
      top += dy;
      break;
    case 's':
      bottom += dy;
      break;
    case 'e':
      right += dx;
      break;
    case 'w':
      left += dx;
      break;
    case 'ne':
      top += dy;
      right += dx;
      break;
    case 'nw':
      top += dy;
      left += dx;
      break;
    case 'se':
      bottom += dy;
      right += dx;
      break;
    case 'sw':
      bottom += dy;
      left += dx;
      break;
  }
  return clampRegion({ top, bottom, left, right }, imgW, imgH);
}

function fingerDist(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): number {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ═══════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════ */

const CropBox = forwardRef<CropBoxHandle, CropBoxProps>(
  (
    {
      image,
      mode = 'single',
      labels = ['区域 A', '区域 B'],
      onSelectionChange,
      onCropComplete,
    },
    ref,
  ) => {
    /* ── State ── */
    const [regions, setRegions] = useState<Regions>({});
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
    const [confirmed, setConfirmed] = useState(false);
    const [topRegion, setTopRegion] = useState<RegionKey>('B');

    /* ── Refs ── */
    const imgRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const interactionRef = useRef<Interaction | null>(null);
    const pinchRef = useRef<PinchState | null>(null);
    const zoomRef = useRef(zoom);
    zoomRef.current = zoom;
    const panRef = useRef(pan);
    panRef.current = pan;
    const imgSizeRef = useRef(imgSize);
    imgSizeRef.current = imgSize;
    // 最小缩放：允许缩回 fit 初始值（大图 fit < 0.5）
    const minZoom = zoomFloor(initialZoom);

    /* ── Image load → set display size + default regions ── */
    const handleImageLoad = useCallback(() => {
      const img = imgRef.current;
      if (!img) return;
      const w = img.clientWidth;
      const h = img.clientHeight;
      setImgSize({ w, h });
      setRegions({
        A: {
          top: Math.floor(h * 0.75),
          bottom: h,
          left: 0,
          right: w,
        },
        B: {
          top: 0,
          bottom: Math.floor(h * 0.78),
          left: Math.floor(w * 0.05),
          right: Math.floor(w * 0.95),
        },
      });
    }, []);

    /* ── Selection change callback ── */
    useEffect(() => {
      if (mode === 'dual') {
        onSelectionChange?.(confirmed && !!regions.A && !!regions.B);
      } else {
        onSelectionChange?.(confirmed && !!regions.A);
      }
    }, [confirmed, regions, mode, onSelectionChange]);

    /* ── Wheel zoom (centered on cursor) ── */
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const prev = zoomRef.current;
        const factor = e.deltaY > 0 ? 0.88 : 1.12;
        const next = Math.max(minZoom, Math.min(ZOOM_MAX, prev * factor));
        if (next === prev) return;
        setPan((pp) => ({
          x: cx - (cx - pp.x) * (next / prev),
          y: cy - (cy - pp.y) * (next / prev),
        }));
        setZoom(next);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, []);

    /* ── Window mouse listeners (drag / pan) ── */
    useEffect(() => {
      const onMove = (e: MouseEvent) => {
        const iv = interactionRef.current;
        if (!iv) return;
        if (iv.type === 'drag') {
          const ds = iv.state;
          const z = zoomRef.current;
          const isz = imgSizeRef.current;
          const dx = (e.clientX - ds.startClientX) / z;
          const dy = (e.clientY - ds.startClientY) / z;
          const nr = computeNewRegion(ds.handleType, ds.startRegion, dx, dy, isz.w, isz.h);
          setRegions((prev) => ({ ...prev, [ds.regionKey]: nr }));
        } else {
          const dx = e.clientX - iv.startX;
          const dy = e.clientY - iv.startY;
          setPan({ x: iv.startPanX + dx, y: iv.startPanY + dy });
        }
      };
      const onUp = () => {
        interactionRef.current = null;
        document.body.style.cursor = '';
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
    }, []);

    /* ── Mouse: start region drag ── */
    const startDrag = useCallback(
      (
        e: React.MouseEvent,
        regionKey: RegionKey,
        handleType: HandleType,
      ) => {
        e.stopPropagation();
        e.preventDefault();
        const r = regions[regionKey];
        if (!r || confirmed) return;
        setTopRegion(regionKey);
        interactionRef.current = {
          type: 'drag',
          state: {
            regionKey,
            handleType,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startRegion: { ...r },
          },
        };
        document.body.style.cursor =
          handleType === 'move'
            ? 'move'
            : handleType === 'n' || handleType === 's'
              ? 'ns-resize'
              : handleType === 'e' || handleType === 'w'
                ? 'ew-resize'
                : handleType === 'ne' || handleType === 'sw'
                  ? 'nesw-resize'
                  : 'nwse-resize';
      },
      [regions, confirmed],
    );

    /* ── Mouse: start pan ── */
    const handleContainerMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (confirmed || e.button !== 0) return;
        interactionRef.current = {
          type: 'pan',
          startX: e.clientX,
          startY: e.clientY,
          startPanX: pan.x,
          startPanY: pan.y,
        };
        document.body.style.cursor = 'grabbing';
      },
      [pan, confirmed],
    );

    /* ── Touch handlers ── */
    const handleTouchStart = useCallback(
      (e: React.TouchEvent) => {
        if (confirmed) return;
        if (e.touches.length === 2) {
          pinchRef.current = {
            initialDist: fingerDist(e.touches[0], e.touches[1]),
            initialZoom: zoomRef.current,
          };
          return;
        }
        if (e.touches.length === 1) {
          // handled by region/handle onTouchStart (stopPropagation)
          // or falls through here for pan
          if (!interactionRef.current) {
            const t = e.touches[0];
            interactionRef.current = {
              type: 'pan',
              startX: t.clientX,
              startY: t.clientY,
              startPanX: panRef.current.x,
              startPanY: panRef.current.y,
            };
          }
        }
      },
      [confirmed],
    );

    const handleTouchMove = useCallback(
      (e: React.TouchEvent) => {
        e.preventDefault();
        // Pinch
        if (e.touches.length === 2 && pinchRef.current) {
          const dist = fingerDist(e.touches[0], e.touches[1]);
          const ps = pinchRef.current;
          const next = Math.max(
            minZoom,
            Math.min(ZOOM_MAX, ps.initialZoom * (dist / ps.initialDist)),
          );
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
            const mx =
              (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
            const my =
              (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
            const prev = zoomRef.current;
            if (prev > 0) {
              setPan((pp) => ({
                x: mx - (mx - pp.x) * (next / prev),
                y: my - (my - pp.y) * (next / prev),
              }));
            }
          }
          setZoom(next);
          return;
        }
        // Single finger
        if (e.touches.length === 1) {
          const iv = interactionRef.current;
          const t = e.touches[0];
          if (iv?.type === 'drag') {
            const ds = iv.state;
            const z = zoomRef.current;
            const isz = imgSizeRef.current;
            const dx = (t.clientX - ds.startClientX) / z;
            const dy = (t.clientY - ds.startClientY) / z;
            const nr = computeNewRegion(
              ds.handleType,
              ds.startRegion,
              dx,
              dy,
              isz.w,
              isz.h,
            );
            setRegions((prev) => ({ ...prev, [ds.regionKey]: nr }));
          } else if (iv?.type === 'pan') {
            setPan({
              x: iv.startPanX + (t.clientX - iv.startX),
              y: iv.startPanY + (t.clientY - iv.startY),
            });
          }
        }
      },
      [],
    );

    const handleTouchEnd = useCallback(() => {
      interactionRef.current = null;
      pinchRef.current = null;
    }, []);

    /* ── Confirm flow ── */
    const handleConfirm = useCallback(() => {
      setConfirmed(true);
      onSelectionChange?.(true);

      // Fire onCropComplete if provided and both regions valid
      if (
        onCropComplete &&
        imgRef.current &&
        imgSizeRef.current.w > 0
      ) {
        const genBlob = (
          key: RegionKey,
        ): Promise<{ blob: Blob; data: RegionData } | null> => {
          const r = regions[key];
          if (!r) return Promise.resolve(null);
          const w = r.right - r.left;
          const h = r.bottom - r.top;
          if (w < 10 || h < 10) return Promise.resolve(null);
          const sx = imgRef.current!.naturalWidth / imgSizeRef.current.w;
          const sy = imgRef.current!.naturalHeight / imgSizeRef.current.h;
          const c = document.createElement('canvas');
          c.width = Math.round(w * sx);
          c.height = Math.round(h * sy);
          const ctx = c.getContext('2d');
          if (!ctx) return Promise.resolve(null);
          ctx.drawImage(
            imgRef.current!,
            r.left * sx,
            r.top * sy,
            w * sx,
            h * sy,
            0,
            0,
            c.width,
            c.height,
          );
          return new Promise((resolve) =>
            c.toBlob(
              (blob) =>
                blob
                  ? resolve({
                      blob,
                      data: {
                        x: Math.round(r.left * sx),
                        y: Math.round(r.top * sy),
                        w: c.width,
                        h: c.height,
                      },
                    })
                  : resolve(null),
              'image/jpeg',
              0.95,
            ),
          );
        };
        Promise.all([genBlob('A'), genBlob('B')]).then(([a, b]) => {
          if (a && b) {
            onCropComplete({
              regionABlob: a.blob,
              regionBBlob: b.blob,
              regionAData: a.data,
              regionBData: b.data,
            });
          }
        });
      }
    }, [regions, onSelectionChange, onCropComplete]);

    const handleReadjust = useCallback(() => {
      setConfirmed(false);
      onSelectionChange?.(false);
    }, [onSelectionChange]);

    /* ── Imperative API ── */
    useImperativeHandle(ref, () => ({
      applyCrop(id, cb) {
        const key = mode === 'dual' ? (id as RegionKey) : 'A';
        const region = regions[key];
        if (!region || !imgRef.current) return;
        const w = region.right - region.left;
        const h = region.bottom - region.top;
        if (w < 10 || h < 10) return;
        const sx = imgRef.current.naturalWidth / imgSize.w;
        const sy = imgRef.current.naturalHeight / imgSize.h;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * sx);
        canvas.height = Math.round(h * sy);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(
          imgRef.current,
          region.left * sx,
          region.top * sy,
          w * sx,
          h * sy,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        canvas.toBlob(
          (blob) => {
            if (blob) {
              cb(blob, {
                x: Math.round(region.left * sx),
                y: Math.round(region.top * sy),
                w: canvas.width,
                h: canvas.height,
              });
            }
          },
          'image/jpeg',
          0.95,
        );
      },
      clearCrop(id) {
        if (mode === 'dual') {
          const key = id as RegionKey;
          setRegions((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
        } else {
          setRegions({});
        }
        setConfirmed(false);
      },
      hasCrop() {
        if (mode === 'dual') {
          return confirmed && !!regions.A && !!regions.B;
        }
        return confirmed && !!regions.A;
      },
    }));

    /* ═══════════════════════════════════════════════════
       Render helpers
       ═══════════════════════════════════════════════════ */

    const renderOverlayForRegion = (region: Region | undefined) => {
      if (!region || !imgSize.w || !imgSize.h) return null;
      const { top, bottom, left, right } = region;
      const w = right - left;
      const h = bottom - top;
      if (w < 1 || h < 1) return null;
      const bar: React.CSSProperties = {
        position: 'absolute',
        background: OVERLAY_COLOR,
        pointerEvents: 'none',
      };
      return (
        <>
          {top > 0 && (
            <div
              style={{
                ...bar,
                left: 0,
                top: 0,
                width: imgSize.w,
                height: top,
              }}
            />
          )}
          {bottom < imgSize.h && (
            <div
              style={{
                ...bar,
                left: 0,
                top: bottom,
                width: imgSize.w,
                height: imgSize.h - bottom,
              }}
            />
          )}
          {left > 0 && (
            <div
              style={{
                ...bar,
                left: 0,
                top,
                width: left,
                height: h,
              }}
            />
          )}
          {right < imgSize.w && (
            <div
              style={{
                ...bar,
                left: right,
                top,
                width: imgSize.w - right,
                height: h,
              }}
            />
          )}
        </>
      );
    };

    const renderRegionRect = (key: RegionKey, region: Region) => {
      const color = COLORS[key];
      const w = region.right - region.left;
      const h = region.bottom - region.top;
      const z = topRegion === key ? 20 : 10;
      const handles = makeHandles(w, h);
      return (
        <div
          key={`region-${key}`}
          onMouseDown={(e) => startDrag(e, key, 'move')}
          onTouchStart={(e) => {
            if (confirmed || e.touches.length !== 1) return;
            e.stopPropagation();
            const t = e.touches[0];
            setTopRegion(key);
            interactionRef.current = {
              type: 'drag',
              state: {
                regionKey: key,
                handleType: 'move',
                startClientX: t.clientX,
                startClientY: t.clientY,
                startRegion: { ...region },
              },
            };
          }}
          style={{
            position: 'absolute',
            left: region.left,
            top: region.top,
            width: w,
            height: h,
            border: `3px solid ${color}`,
            boxShadow: `0 0 0 3px ${color}40`,
            cursor: confirmed ? 'default' : 'move',
            zIndex: z,
            touchAction: 'none',
          }}
        >
          {/* Label badge */}
          <div
            style={{
              position: 'absolute',
              top: -24,
              left: 0,
              background: color,
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              lineHeight: '18px',
              pointerEvents: 'none',
            }}
          >
            {key} {labels[key === 'A' ? 0 : 1]}
          </div>

          {/* Size annotation */}
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: '#fff',
              fontSize: 13,
              fontWeight: 500,
              background: 'rgba(0,0,0,0.6)',
              padding: '2px 8px',
              borderRadius: 4,
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {w} × {h}
          </div>

          {/* Resize handles */}
          {!confirmed &&
            handles.map((hc) => (
              <div
                key={hc.type}
                onMouseDown={(e) => startDrag(e, key, hc.type)}
                onTouchStart={(e) => {
                  if (confirmed || e.touches.length !== 1) return;
                  e.stopPropagation();
                  e.preventDefault();
                  const t = e.touches[0];
                  setTopRegion(key);
                  interactionRef.current = {
                    type: 'drag',
                    state: {
                      regionKey: key,
                      handleType: hc.type,
                      startClientX: t.clientX,
                      startClientY: t.clientY,
                      startRegion: { ...region },
                    },
                  };
                }}
                style={{
                  position: 'absolute',
                  width: HANDLE_SIZE,
                  height: HANDLE_SIZE,
                  background: color,
                  borderRadius: 2,
                  cursor: hc.cursor,
                  zIndex: 1,
                  boxSizing: 'content-box',
                  padding: (TOUCH_TARGET - HANDLE_SIZE) / 2,
                  margin: -(TOUCH_TARGET - HANDLE_SIZE) / 2,
                  ...hc.style,
                }}
              />
            ))}
        </div>
      );
    };

    /* ═══════════════════════════════════════════════════
       Main render
       ═══════════════════════════════════════════════════ */

    const hasBoth =
      mode === 'dual' ? !!(regions.A && regions.B) : !!regions.A;

    return (
      <div style={{ minWidth: 0 }}>
        {/* ── Header ── */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <span
            style={{
              background: confirmed
                ? 'var(--color-success)'
                : hasBoth
                  ? 'var(--color-warning)'
                  : 'var(--color-text-muted)',
              color: 'var(--color-text-inverse)',
              fontSize: 13,
              fontWeight: 600,
              padding: '4px 12px',
              borderRadius: 16,
            }}
          >
            {confirmed
              ? '✓ 已确认'
              : hasBoth
                ? '拖动调整选区'
                : '加载中...'}
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              onClick={() => setZoom((z) => Math.max(minZoom, z - 0.25))}
              disabled={zoom <= minZoom}
              style={{
                width: 36,
                height: 36,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border-strong)',
                background: 'var(--color-surface)',
                color:
                  zoom <= minZoom
                    ? 'var(--color-text-muted)'
                    : 'var(--color-text)',
                cursor: zoom <= minZoom ? 'not-allowed' : 'pointer',
                fontSize: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              −
            </button>
            <span
              style={{
                color: 'var(--color-text-secondary)',
                fontSize: 12,
                minWidth: 42,
                textAlign: 'center',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {zoom.toFixed(1)}x
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z + 0.25))}
              disabled={zoom >= ZOOM_MAX}
              style={{
                width: 36,
                height: 36,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border-strong)',
                background: 'var(--color-surface)',
                color:
                  zoom >= ZOOM_MAX
                    ? 'var(--color-text-muted)'
                    : 'var(--color-text)',
                cursor: zoom >= ZOOM_MAX ? 'not-allowed' : 'pointer',
                fontSize: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              +
            </button>
          </div>
        </div>

        {/* ── Image container ── */}
        <div
          ref={containerRef}
          onMouseDown={handleContainerMouseDown}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          style={{
            position: 'relative',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--color-bg-secondary)',
            overflow: 'hidden',
            cursor: 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          {/* Transform wrapper */}
          <div
            style={{
              transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
              transformOrigin: '0 0',
              width: imgSize.w || 'auto',
              height: imgSize.h || 'auto',
              position: 'relative',
            }}
          >
            {/* Image */}
            <img
              ref={imgRef}
              src={image}
              alt="Crop source"
              onLoad={handleImageLoad}
              draggable={false}
              style={{
                maxWidth: '100%',
                display: 'block',
                pointerEvents: 'none',
              }}
            />

            {/* Overlay masks */}
            {renderOverlayForRegion(regions.A)}
            {renderOverlayForRegion(regions.B)}

            {/* Region rectangles */}
            {regions.A && renderRegionRect('A', regions.A)}
            {regions.B && renderRegionRect('B', regions.B)}
          </div>
        </div>

        {/* ── Confirm / readjust ── */}
        <div style={{ marginTop: 12 }}>
          {!confirmed ? (
            <button
              onClick={handleConfirm}
              disabled={!hasBoth}
              style={{
                width: '100%',
                height: 48,
                borderRadius: 'var(--radius-md)',
                border: 'none',
                background: hasBoth
                  ? 'var(--color-accent)'
                  : 'var(--color-border-strong)',
                color: hasBoth
                  ? 'var(--color-text-inverse)'
                  : 'var(--color-text-muted)',
                fontSize: 15,
                fontWeight: 600,
                cursor: hasBoth ? 'pointer' : 'not-allowed',
                transition: 'background var(--transition-fast)',
              }}
            >
              确认裁减
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <div
                style={{
                  flex: 1,
                  height: 48,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-success-light)',
                  border: '1px solid var(--color-success)',
                  color: 'var(--color-success)',
                  fontSize: 15,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                已确认 ✓
              </div>
              <button
                onClick={handleReadjust}
                style={{
                  height: 48,
                  padding: '0 16px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-border-strong)',
                  background: 'var(--color-surface)',
                  color: 'var(--color-text-secondary)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                重新调整
              </button>
            </div>
          )}
        </div>

        {/* ── Hint ── */}
        <p
          style={{
            marginTop: 8,
            fontSize: 11,
            color: 'var(--color-text-muted)',
            textAlign: 'center',
          }}
        >
          滚轮缩放 · 拖拽空白区域平移 · 拖拽框体调整选区
        </p>
      </div>
    );
  },
);

CropBox.displayName = 'CropBox';

export default CropBox;
export type { CropBoxProps };
