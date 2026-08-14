import { useState, useRef, useEffect, useCallback } from 'react';
import { getModels, activateModel, type ModelMeta } from '../api/models';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useCreateJob } from '../hooks/useJobs';
import { useToast } from '../components/ToastContext';
import Button from '../components/Button';
import Spinner from '../components/Spinner';
import { staggerContainer, staggerItem } from '../lib/animations';
import { loadPendingUpload, savePendingUpload } from '../lib/pendingUpload';

/* ═══════════════════════════════════════════════════════════
   012 决议：单裁剪上传。选文件后跳到独立裁剪页，确认后返回。
   支持多次调整：保留图片，可反复进入裁剪页。
   ═══════════════════════════════════════════════════════════ */

interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_CROP = 8;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_UPLOAD_MB = 30;

export default function UploadPage() {
  const navigate = useNavigate();
  const createJob = useCreateJob();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const location = useLocation();

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [rows, setRows] = useState(29);
  const [cols, setCols] = useState(29);
  const [codes, setCodes] = useState('');
  // 识别模型动态切换（模型列表 + 当前激活 + 切换）
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);

  useEffect(() => {
    getModels()
      .then((r) => {
        setModels(r.items);
        setCurrentModel(r.current);
      })
      .catch(() => {});
  }, []);

  const handleModelChange = useCallback((id: string) => {
    if (!id || id === currentModel) return;
    setModelSwitching(true);
    activateModel(id)
      .then((r) => {
        setCurrentModel(r.current);
        toast?.show?.('识别模型已切换');
      })
      .catch(() => toast?.show?.('模型切换失败'))
      .finally(() => setModelSwitching(false));
  }, [currentModel, toast]);

  // 019：任务名称（必填，不允许留空提交）
  const [jobName, setJobName] = useState('');

  const codeError = useMemoCodeError(codes);

  /* 从裁剪页返回：读取裁剪结果（location.state + sessionStorage 兜底） */
  useEffect(() => {
    const s = location.state as {
      crop?: CropRect;
      imageUrl?: string;
      imageW?: number;
      imageH?: number;
      rows?: number;
      cols?: number;
    } | null;
    if (s?.crop && s.imageUrl) {
      applyCropResult(s.crop, s.imageUrl, s.imageW, s.imageH, s.rows, s.cols);
      return;
    }
    // sessionStorage 兜底（AnimatePresence 竞态时 state 可能未触发组件更新）
    try {
      const raw = sessionStorage.getItem('pendingCrop');
      if (raw) {
        const stored = JSON.parse(raw) as {
          crop: CropRect;
          imageUrl: string;
          imageW: number;
          imageH: number;
          rows?: number;
          cols?: number;
        };
        if (stored.crop && stored.imageUrl) {
          applyCropResult(stored.crop, stored.imageUrl, stored.imageW, stored.imageH, stored.rows, stored.cols);
          sessionStorage.removeItem('pendingCrop');
        }
      }
    } catch (e) { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  function applyCropResult(c: CropRect, url: string, w?: number, h?: number, nextRows?: number, nextCols?: number) {
    setCrop(c);
    if (url !== imageUrl) setImageUrl(url);
    if (w && h) setImageSize({ w, h });
    if (nextRows != null && Number.isFinite(nextRows)) setRows(Math.max(1, Math.min(500, Math.round(nextRows))));
    if (nextCols != null && Number.isFinite(nextCols)) setCols(Math.max(1, Math.min(500, Math.round(nextCols))));
  }

  /* The crop page intentionally performs a full navigation. Restore the File
     from IndexedDB after that navigation; blob URLs alone are not enough for
     the multipart recognition request. */
  useEffect(() => {
    if (!imageUrl || imageFile) return;
    let active = true;
    void loadPendingUpload().then((file) => {
      if (!active || !file) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        toast(`图片超过 ${MAX_UPLOAD_MB}MB 上限，请压缩后重新选择`, 'error');
        setImageFile(null);
        return;
      }
      setImageFile(file);
      // A blob URL can be invalid after a full navigation. Recreate it from
      // the persisted File so the returned preview is always renderable.
      setImageUrl(URL.createObjectURL(file));
    });
    return () => { active = false; };
  }, [imageFile, imageUrl]);

  function onFileSelected(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast(`图片超过 ${MAX_UPLOAD_MB}MB 上限（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB），请压缩后重新选择`, 'error');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setImageFile(file);
    const persisted = savePendingUpload(file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      await persisted;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setImageUrl(url);
      setImageSize({ w, h });
      setCrop(null); // 新图 → 去裁剪页重新框选
      // 跳到裁剪页
      navigate('/crop', {
        state: { imageUrl: url, imageW: w, imageH: h },
      });
    };
    img.src = url;
  }

  /* 再次调整 → 带当前裁剪结果进入裁剪页 */
  function handleRecrop() {
    if (!imageUrl || !imageSize) return;
    navigate('/crop', {
      state: {
        imageUrl,
        imageW: imageSize.w,
        imageH: imageSize.h,
        initialCrop: crop ?? undefined,
        rows,
        cols,
      },
    });
  }

  const canSubmit =
    !!imageFile && !!imageUrl && !!imageSize && !!crop && crop.w >= MIN_CROP && crop.h >= MIN_CROP && rows >= 1 && rows <= 500 && cols >= 1 && cols <= 500 && !codeError && jobName.trim().length > 0;

  async function handleSubmit() {
    if (!jobName.trim()) {
      toast('请先填写任务名称，再开始识别', 'error');
      return;
    }
    const file = imageFile ?? fileRef.current?.files?.[0];
    if (!file || !imageSize || !crop) {
      toast('图片文件已失效，请重新选择图片', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast(`图片超过 ${MAX_UPLOAD_MB}MB 上限，请压缩后重新选择`, 'error');
      return;
    }
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
        name: jobName.trim(), // 必填
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

  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  return (
    <div className="max-w-4xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-6">
        <motion.div variants={staggerItem}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>
            上传图纸并识别
          </h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)', marginTop: 4 }}>
            选择图片 → 框选拼豆区域 → 设置行列数 → 开始识别
          </p>
        </motion.div>

        {/* 任务名称 + 模型选择 + 网格 + 开始识别（顶部操作排） */}
        <motion.div variants={staggerItem} className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              <span style={{ color: 'var(--color-error)', fontWeight: 600, lineHeight: 1 }} title="必填">*</span>
              <input
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
                placeholder="任务名称（必填）"
                maxLength={128}
                style={{
                  height: 34,
                  padding: '0 10px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-surface)',
                  color: 'var(--color-text)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 'var(--text-sm)',
                  outline: 'none',
                }}
                aria-label="任务名称"
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)' }}>
              识别模型
              <select
                value={currentModel ?? ''}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={!models.length || modelSwitching}
                style={{
                  width: 240,
                  height: 34,
                  padding: '0 8px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-surface)',
                  color: 'var(--color-text)',
                  fontFamily: 'var(--font-body)',
                  fontSize: 'var(--text-sm)',
                  outline: 'none',
                }}
                aria-label="识别模型"
              >
                {models.length === 0 && <option value="">（无可用模型）</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
              </select>
              {modelSwitching && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-warning)' }}>切换中…</span>}
            </label>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              网格：{rows} × {cols} = {rows * cols} 格
              {crop && imageSize && (
                <span style={{ marginLeft: 12 }}>裁剪框：{Math.round(crop.w)}×{Math.round(crop.h)}px @ ({Math.round(crop.x)},{Math.round(crop.y)})</span>
              )}
            </span>
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit || createJob.isPending}
            title={!jobName.trim() ? '请先填写任务名称' : undefined}
          >
            {createJob.isPending ? <Spinner size="sm" /> : '开始识别'}
          </Button>
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
              <p style={{ marginTop: 12, fontWeight: 500 }}>点击选择图片（JPEG/PNG，≤30MB）</p>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>选择文件不会自动开始识别</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-6">
              {/* 图纸预览（非裁剪交互，仅展示）：容器按图片比例撑开，百分比定位与图片显示区精确对齐 */}
              <div className="relative w-full overflow-hidden rounded-lg" style={{ background: '#17130f' }}>
                <div style={{ position: 'relative', width: '100%', paddingTop: `${((imageSize!.h / imageSize!.w) * 100).toFixed(4)}%` }}>
                  <img
                    src={imageUrl}
                    alt="upload preview"
                    className="absolute inset-0 w-full h-full"
                    style={{ objectFit: 'fill' }}
                    draggable={false}
                  />
                  {crop && (
                    <div
                      className="absolute"
                      style={{
                        left: `${(crop.x / imageSize!.w) * 100}%`,
                        top: `${(crop.y / imageSize!.h) * 100}%`,
                        width: `${(crop.w / imageSize!.w) * 100}%`,
                        height: `${(crop.h / imageSize!.h) * 100}%`,
                        border: '2px solid var(--color-accent)',
                        boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
                        pointerEvents: 'none',
                      }}
                    />
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button variant="secondary" onClick={handleRecrop}>
                  {crop ? '✏️ 重新调整裁剪' : '✏️ 框选区域'}
                </Button>
                {crop && (
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
                    裁剪框：{Math.round(crop.w)}×{Math.round(crop.h)}px
                  </span>
                )}
              </div>
            </div>
          )}

          {imageUrl && (
            <div className="flex flex-wrap gap-4 mt-4">
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
