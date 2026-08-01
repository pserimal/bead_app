import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useCreateJob } from '../hooks/useJobs';
import { useToast } from '../components/ToastContext';
import Button from '../components/Button';
import Spinner from '../components/Spinner';
import { staggerContainer, staggerItem } from '../lib/animations';

type DragMode = 'none' | 'move' | 'draw' | ResizeHandle;

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 手柄位置（相对裁剪框的百分比定位） */
const HANDLE_POS: Record<ResizeHandle, { left: string; top: string; cursor: string }> = {
  nw: { left: '0%', top: '0%', cursor: 'nwse-resize' },
  n: { left: '50%', top: '0%', cursor: 'ns-resize' },
  ne: { left: '100%', top: '0%', cursor: 'nesw-resize' },
  e: { left: '100%', top: '50%', cursor: 'ew-resize' },
  se: { left: '100%', top: '100%', cursor: 'nwse-resize' },
  s: { left: '50%', top: '100%', cursor: 'ns-resize' },
  sw: { left: '0%', top: '100%', cursor: 'nesw-resize' },
  w: { left: '0%', top: '50%', cursor: 'ew-resize' },
};

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_CROP = 8; // 最小裁剪尺寸（原图像素）

// 012 决议：单裁剪上传。选文件不自动识别，点击「开始识别」才创建任务。
export default function UploadPage() {
  const navigate = useNavigate();
  const createJob = useCreateJob();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [crop, setCrop] = useState<CropRect>({ x: 0, y: 0, w: 100, h: 100 }); // 原图像素
  const [rows, setRows] = useState(29);
  const [cols, setCols] = useState(29);
  const [codes, setCodes] = useState('');

  // 交互状态用 ref 避免 setState 异步导致的旧值判断
  const drag = useRef<{ mode: DragMode; startX: number; startY: number; origin: CropRect }>({
    mode: 'none',
    startX: 0,
    startY: 0,
    origin: { x: 0, y: 0, w: 0, h: 0 },
  });

  const codeError = useMemoCodeError(codes);

  function onFileSelected(file: File) {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setImageSize({ w, h });
      // 默认裁剪框：图片中央 60% 区域（可拖动/缩放手柄调整）
      setCrop({ x: Math.round(w * 0.2), y: Math.round(h * 0.2), w: Math.round(w * 0.6), h: Math.round(h * 0.6) });
    };
    img.src = url;
  }

  const canSubmit =
    !!imageUrl && !!imageSize && crop.w >= MIN_CROP && crop.h >= MIN_CROP && rows >= 1 && rows <= 500 && cols >= 1 && cols <= 500 && !codeError;

  async function handleSubmit() {
    const file = fileRef.current?.files?.[0];
    if (!file || !imageSize) return;
    createJob.mutate(
      {
        image: file,
        cropBoxX: Math.round(crop.x),
        cropBoxY: Math.round(crop.y),
        cropBoxWidth: Math.round(crop.w),
        cropBoxHeight: Math.round(crop.h),
        rows,
        cols,
        codes: codes.trim() ? codes : undefined,
      },
      {
        onSuccess: (job) => {
          toast('识别任务已创建', 'success');
          navigate(`/jobs/${job.id}`);
        },
        onError: (e) => {
          const err = e as Error & { code?: string };
          toast(err.message || '创建失败', 'error');
        },
      },
    );
  }

  // ── 坐标换算：以 img 实际渲染矩形为基准（消除 letterbox 错位） ──
  const imgRef = useRef<HTMLImageElement>(null);
  const toImageCoord = useCallback(
    (clientX: number, clientY: number) => {
      const el = imgRef.current;
      if (!el || !imageSize) return { x: 0, y: 0 };
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
      const scaleX = imageSize.w / rect.width;
      const scaleY = imageSize.h / rect.height;
      return {
        x: Math.max(0, Math.min(imageSize.w, (clientX - rect.left) * scaleX)),
        y: Math.max(0, Math.min(imageSize.h, (clientY - rect.top) * scaleY)),
      };
    },
    [imageSize],
  );

  function clampCrop(next: CropRect): CropRect {
    const w = imageSize?.w ?? 0;
    const h = imageSize?.h ?? 0;
    let { x, y } = next;
    let cw = Math.max(MIN_CROP, Math.min(next.w, w));
    let ch = Math.max(MIN_CROP, Math.min(next.h, h));
    x = Math.max(0, Math.min(x, w - cw));
    y = Math.max(0, Math.min(y, h - ch));
    return { x, y, w: cw, h: ch };
  }

  function onMouseDown(e: React.MouseEvent, mode: DragMode) {
    if (!imageSize || e.button !== 0) return;
    e.preventDefault();
    const p = toImageCoord(e.clientX, e.clientY);
    drag.current = { mode, startX: p.x, startY: p.y, origin: { ...crop } };
  }

  function onMouseMove(e: React.MouseEvent) {
    const d = drag.current;
    if (d.mode === 'none' || !imageSize) return;
    const p = toImageCoord(e.clientX, e.clientY);
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    const o = d.origin;

    switch (d.mode) {
      case 'draw': {
        // 从起点画新框（支持任意方向）
        const x = Math.min(d.startX, p.x);
        const y = Math.min(d.startY, p.y);
        setCrop(clampCrop({ x, y, w: Math.abs(p.x - d.startX), h: Math.abs(p.y - d.startY) }));
        break;
      }
      case 'move': {
        setCrop(clampCrop({ x: o.x + dx, y: o.y + dy, w: o.w, h: o.h }));
        break;
      }
      default: {
        // resize：对角锚点不动，按手柄方向调整
        let { x, y, w, h } = o;
        if (d.mode.includes('w')) { x = Math.min(o.x + dx, o.x + o.w - MIN_CROP); w = o.x + o.w - x; }
        if (d.mode.includes('e')) { w = Math.max(MIN_CROP, o.w + dx); }
        if (d.mode.includes('n')) { y = Math.min(o.y + dy, o.y + o.h - MIN_CROP); h = o.y + o.h - y; }
        if (d.mode.includes('s')) { h = Math.max(MIN_CROP, o.h + dy); }
        setCrop(clampCrop({ x, y, w, h }));
        break;
      }
    }
  }

  function onMouseUp() {
    drag.current.mode = 'none';
  }

  // 键盘微调：方向键移动裁剪框（1px），Shift+方向 = 10px；Alt+方向 = 缩放（1px）
  function onOverlayKeyDown(e: React.KeyboardEvent) {
    if (!imageSize || drag.current.mode !== 'none') return;
    const step = e.shiftKey ? 10 : 1;
    const resize = e.altKey;
    const k = e.key;
    let next: CropRect | null = null;
    if (k === 'ArrowLeft') next = resize ? { ...crop, x: crop.x, w: crop.w - step } : { ...crop, x: crop.x - step };
    else if (k === 'ArrowRight') next = resize ? { ...crop, w: crop.w + step } : { ...crop, x: crop.x + step };
    else if (k === 'ArrowUp') next = resize ? { ...crop, y: crop.y, h: crop.h - step } : { ...crop, y: crop.y - step };
    else if (k === 'ArrowDown') next = resize ? { ...crop, h: crop.h + step } : { ...crop, y: crop.y + step };
    if (next) {
      e.preventDefault();
      setCrop(clampCrop(next));
    }
  }

  // 数字输入：精确设置裁剪框参数
  function setCropField(field: 'x' | 'y' | 'w' | 'h', value: string) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    setCrop(clampCrop({ ...crop, [field]: n }));
  }

  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  const overlayStyle = imageSize
    ? {
        left: `${(crop.x / imageSize.w) * 100}%`,
        top: `${(crop.y / imageSize.h) * 100}%`,
        width: `${(crop.w / imageSize.w) * 100}%`,
        height: `${(crop.h / imageSize.h) * 100}%`,
      }
    : undefined;

  const cropFields: Array<{ key: 'x' | 'y' | 'w' | 'h'; label: string }> = [
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' },
    { key: 'w', label: '宽' },
    { key: 'h', label: '高' },
  ];

  return (
    <div className="max-w-4xl mx-auto">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-6">
        <motion.div variants={staggerItem}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>
            上传图纸并识别
          </h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
            选择图片 → 框选拼豆区域 → 设置行列数 → 开始识别
          </p>
        </motion.div>

        <motion.div variants={staggerItem} className="p-5 rounded-xl" style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFileSelected(e.target.files[0])}
          />
          {!imageUrl ? (
            <div
              className="flex flex-col items-center justify-center py-16 cursor-pointer rounded-lg"
              style={{ border: '2px dashed var(--color-border)' }}
              onClick={() => fileRef.current?.click()}
            >
              <div style={{ fontSize: 40 }}>🖼️</div>
              <p style={{ marginTop: 12, fontWeight: 500 }}>点击选择图片（JPEG/PNG，≤20MB）</p>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>选择文件不会自动开始识别</p>
            </div>
          ) : (
            <div
              className="relative w-full overflow-hidden rounded-lg select-none"
              style={{ background: '#111', touchAction: 'none' }}
              onMouseDown={(e) => { if (drag.current.mode === 'none') onMouseDown(e, 'draw'); }}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={onMouseUp}
            >
              {/* wrapper 贴合 img 实际渲染尺寸：overlay 与坐标换算共用同一参考系（消除 letterbox 错位） */}
              <div className="relative inline-block">
                <img
                  ref={imgRef}
                  src={imageUrl}
                  alt="upload"
                  className="block max-w-full max-h-[70vh] object-contain"
                  draggable={false}
                  style={{ pointerEvents: 'none' }}
                />
              {imageSize && crop.w >= MIN_CROP && crop.h >= MIN_CROP && (
                <div
                  className="absolute"
                  style={{
                    ...overlayStyle,
                    border: '2px solid var(--color-accent)',
                    background: 'rgba(220,69,56,0.06)',
                    boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
                    pointerEvents: 'none',
                    outline: 'none',
                  }}
                  tabIndex={0}
                  onKeyDown={onOverlayKeyDown}
                >
                  {/* 移动区域（框内透明，可拖动） */}
                  <div
                    className="absolute inset-0"
                    style={{ pointerEvents: 'auto', cursor: 'move' }}
                    onMouseDown={(e) => onMouseDown(e, 'move')}
                  />
                  {/* 8 个 resize 手柄：四角 20px 易命中，四边 14px */}
                  {HANDLES.map((h) => {
                    const isCorner = h.length === 2;
                    const size = isCorner ? 20 : 14;
                    return (
                      <div
                        key={h}
                        className="absolute"
                        style={{
                          ...HANDLE_POS[h],
                          width: size,
                          height: size,
                          transform: 'translate(-50%, -50%)',
                          background: '#fff',
                          border: '2px solid var(--color-accent)',
                          borderRadius: isCorner ? 4 : 2,
                          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                          pointerEvents: 'auto',
                          cursor: HANDLE_POS[h].cursor,
                          zIndex: 2,
                        }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          onMouseDown(e, h);
                        }}
                      />
                    );
                  })}
                </div>
              )}
              </div>
            </div>
          )}

          {imageUrl && (
            <div className="flex flex-wrap gap-4 mt-4">
              {/* 裁剪框精确数值输入（原图像素） */}
              <div className="flex items-end gap-2 flex-wrap">
                {cropFields.map((f) => (
                  <label key={f.key} className="flex flex-col gap-1">
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{f.label}</span>
                    <input
                      type="number"
                      min={0}
                      value={Math.round(crop[f.key])}
                      onChange={(e) => setCropField(f.key, e.target.value)}
                      className="px-2 py-1.5 rounded-lg border w-20"
                      style={{ borderColor: 'var(--color-border)', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}
                    />
                  </label>
                ))}
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', paddingBottom: 8, whiteSpace: 'nowrap' }}>
                  方向键微调 · Shift=10px · Alt=缩放
                </span>
              </div>
            </div>
          )}

          {imageUrl && (
            <div className="flex flex-wrap gap-4 mt-4">
              <label className="flex flex-col gap-1">
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>行数 (1-500)</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={rows}
                  onChange={(e) => setRows(Number(e.target.value))}
                  className="px-3 py-1.5 rounded-lg border w-24"
                  style={{ borderColor: 'var(--color-border)' }}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>列数 (1-500)</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={cols}
                  onChange={(e) => setCols(Number(e.target.value))}
                  className="px-3 py-1.5 rounded-lg border w-24"
                  style={{ borderColor: 'var(--color-border)' }}
                />
              </label>
              <label className="flex flex-col gap-1 flex-1 min-w-48">
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>
                  图纸级编码（可选，逗号分隔，如 A01,H12）
                </span>
                <input
                  type="text"
                  value={codes}
                  onChange={(e) => setCodes(e.target.value.toUpperCase())}
                  placeholder="A01,H12"
                  className="px-3 py-1.5 rounded-lg border"
                  style={{ borderColor: codeError ? 'var(--color-error)' : 'var(--color-border)' }}
                />
                {codeError && <span style={{ color: 'var(--color-error)', fontSize: 'var(--text-xs)' }}>{codeError}</span>}
              </label>
            </div>
          )}
        </motion.div>

        <motion.div variants={staggerItem} className="flex items-center justify-between">
          <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            网格：{rows} × {cols} = {rows * cols} 格
            {imageSize && <span style={{ marginLeft: 12 }}>裁剪框：{Math.round(crop.w)}×{Math.round(crop.h)}px @ ({Math.round(crop.x)},{Math.round(crop.y)})</span>}
          </span>
          <Button onClick={handleSubmit} disabled={!canSubmit || createJob.isPending}>
            {createJob.isPending ? <Spinner size="sm" /> : '开始识别'}
          </Button>
        </motion.div>
      </motion.div>
    </div>
  );
}

function useMemoCodeError(codes: string): string | null {
  if (!codes.trim()) return null;
  const regex = /^[A-Za-z][0-9]{1,3}$/;
  const parts = codes.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = parts.filter((p) => !regex.test(p));
  return invalid.length ? `非法编码格式: ${invalid.join(', ')}` : null;
}
