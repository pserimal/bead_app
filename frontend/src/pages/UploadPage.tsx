import { useState, useRef, useEffect, useCallback } from 'react';
import { getModels, activateModel, type ModelMeta } from '../api/models';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useCreateJob } from '../hooks/useJobs';
import { useToast } from '../components/ToastContext';
import Button from '../components/Button';
import Spinner from '../components/Spinner';
import { staggerContainer, staggerItem } from '../lib/animations';
import {
  clearPendingCrop,
  clearPendingUpload,
  clearPendingWizard,
  loadPendingUpload,
  readPendingCrop,
  readPendingWizard,
  savePendingCrop,
  savePendingUpload,
  savePendingWizard,
} from '../lib/pendingUpload';
import type { LegendEntry } from '../api/materials';
import Stepper from '../components/Stepper';
import { readLastSelection } from '../lib/selectionMemory';
import { cacheImageFile } from '../lib/imageCache';

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

interface UploadRestoreState {
  restoreUpload?: boolean;
  imageUrl?: string;
  imageFile?: File;
  imageW?: number;
  imageH?: number;
  crop?: CropRect | null;
  rows?: number;
  cols?: number;
  codes?: string;
  jobName?: string;
  skipLegendPrompt?: boolean;
  legendInventory?: Array<{ code: string; count: number; confirmed: boolean; row?: number; col?: number; bbox?: CropRect }>;
}

const MIN_CROP = 8;
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_UPLOAD_MB = 30;

function toLegendEntries(items: UploadRestoreState['legendInventory']): LegendEntry[] {
  return (items ?? []).map((item, index) => ({
    ordinal: index,
    rowIndex: item.row ?? 0,
    colIndex: item.col ?? index,
    code: item.code,
    count: item.count,
    status: item.confirmed ? 'accepted' : 'needs_confirmation',
    source: 'manual',
    confirmed: item.confirmed,
    bbox: { x: item.bbox?.x ?? 0, y: item.bbox?.y ?? 0, width: item.bbox?.w ?? 0, height: item.bbox?.h ?? 0 },
  }));
}

export default function UploadPage() {
  const navigate = useNavigate();
  const createJob = useCreateJob();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const location = useLocation();
  const routeState = location.state as UploadRestoreState | null;
  const [pendingWizard] = useState(() => readPendingWizard());
  const initialRestore = routeState?.restoreUpload ? routeState : pendingWizard;

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(routeState?.imageFile ?? null);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(() => (
    initialRestore?.imageW && initialRestore.imageH ? { w: initialRestore.imageW, h: initialRestore.imageH } : null
  ));
  const [crop, setCrop] = useState<CropRect | null>(initialRestore?.crop ?? null);
  const [rows, setRows] = useState(initialRestore?.rows ?? 29);
  const [cols, setCols] = useState(initialRestore?.cols ?? 29);
  const [codes, setCodes] = useState(initialRestore?.codes ?? '');
  const [jobName, setJobName] = useState(() => {
    if (typeof initialRestore?.jobName === 'string') return initialRestore.jobName;
    try {
      return sessionStorage.getItem('pendingJobName') ?? '';
    } catch {
      return '';
    }
  });
  // 识别模型动态切换（模型列表 + 当前激活 + 切换）
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  // 物料清单（开始识别前框选；随创建任务一并落库）
  const [legendEntries, setLegendEntries] = useState<LegendEntry[]>(() => toLegendEntries(initialRestore?.legendInventory));
  const [confirmLegend, setConfirmLegend] = useState(false);
  const [skipLegendPrompt, setSkipLegendPrompt] = useState(initialRestore?.skipLegendPrompt ?? false);

  const buildLegendNavState = () => {
    const inventory = legendEntries.map((entry) => ({
      code: entry.code,
      count: entry.count,
      confirmed: entry.confirmed,
      row: entry.rowIndex,
      col: entry.colIndex,
      bbox: { x: entry.bbox.x, y: entry.bbox.y, w: entry.bbox.width, h: entry.bbox.height },
    }));
    savePendingWizard({
      step: 'materials',
      imageUrl: imageUrl ?? undefined,
      imageW: imageSize?.w,
      imageH: imageSize?.h,
      crop,
      rows,
      cols,
      codes,
      jobName,
      skipLegendPrompt,
      legendInventory: inventory,
    });
    return {
      imageUrl,
      imageW: imageSize?.w ?? 0,
      imageH: imageSize?.h ?? 0,
      imageFile,
      crop,
      rows,
      cols,
      codes,
      jobName,
      legendInventory: inventory,
    };
  };
  const restoredKeyRef = useRef<string | null>(null);

  // 从物料清单页返回，或在刷新后从 sessionStorage 恢复整个上传现场。
  useEffect(() => {
    const effective = routeState?.restoreUpload ? routeState : initialRestore;
    if (!effective || restoredKeyRef.current === location.key) return;
    restoredKeyRef.current = location.key;
    let active = true;
    /* eslint-disable react-hooks/set-state-in-effect */
    if (effective.imageW && effective.imageH) setImageSize({ w: effective.imageW, h: effective.imageH });
    const restoredFile = 'imageFile' in effective ? effective.imageFile : undefined;
    if (restoredFile instanceof File) {
      setImageFile(restoredFile);
      // 先异步解码再挂载 <img>：避免大图同步解码阻塞页面进入首帧（切换卡顿/黑帧）
      // 复用跨页稳定 blob URL，命中浏览器已解码缓存时近乎瞬时
      const url = cacheImageFile('upload', restoredFile);
      const probe = new Image();
      probe.onload = () => {
        if (active) setImageUrl(url);
      };
      probe.onerror = () => {
        if (active) setImageUrl(url);
      };
      probe.src = url;
    }
    if (effective.crop) setCrop(effective.crop);
    if (typeof effective.rows === 'number') setRows(effective.rows);
    if (typeof effective.cols === 'number') setCols(effective.cols);
    if (typeof effective.codes === 'string') setCodes(effective.codes);
    if (typeof effective.jobName === 'string') setJobName(effective.jobName);
    if (typeof effective.skipLegendPrompt === 'boolean') setSkipLegendPrompt(effective.skipLegendPrompt);
    if (effective.legendInventory) {
      const restored = toLegendEntries(effective.legendInventory);
      setLegendEntries(restored);
      if (restored.length > 0 && routeState?.restoreUpload) toast(`已带回物料清单 ${restored.length} 项，请点击「开始识别」`, 'success');
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      active = false;
    };
  }, [initialRestore, location.key, routeState, toast]);

  // If the browser reopens the app at /, resume the route that was active when
  // the tab was closed. Normal completion writes step='upload' and stays here.
  useEffect(() => {
    if (!pendingWizard || routeState?.restoreUpload || pendingWizard.step === 'upload') return;
    navigate(pendingWizard.step === 'materials' ? '/materials' : '/crop', { replace: true });
  }, [navigate, pendingWizard, routeState]);

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
        toast('识别模型已切换');
      })
      .catch(() => toast('模型切换失败'))
      .finally(() => setModelSwitching(false));
  }, [currentModel, toast]);

  const codeError = useMemoCodeError(codes);

  function applyCropResult(c: CropRect, url: string, w?: number, h?: number, nextRows?: number, nextCols?: number) {
    setCrop(c);
    if (url !== imageUrl) setImageUrl(url);
    if (w && h) setImageSize({ w, h });
    if (nextRows != null && Number.isFinite(nextRows)) setRows(Math.max(1, Math.min(500, Math.round(nextRows))));
    if (nextCols != null && Number.isFinite(nextCols)) setCols(Math.max(1, Math.min(500, Math.round(nextCols))));
  }

  /* 从裁剪页返回：读取裁剪结果（location.state + sessionStorage 兜底） */
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const routeCrop = location.state as ({ restoreUpload?: boolean; crop?: CropRect; imageUrl?: string; imageW?: number; imageH?: number; rows?: number; cols?: number } | null);
    if (routeCrop?.crop && routeCrop.imageUrl && !routeCrop.restoreUpload) {
      // 路由导航返回 → 响应外部系统（路由）变化
      applyCropResult(routeCrop.crop, routeCrop.imageUrl, routeCrop.imageW, routeCrop.imageH, routeCrop.rows, routeCrop.cols);
      clearPendingCrop();
      return;
    }
    const stored = readPendingCrop();
    if (!stored?.crop) return;
    if (stored.imageUrl) {
      applyCropResult(stored.crop, stored.imageUrl, stored.imageW, stored.imageH, stored.rows, stored.cols);
    } else {
      // The URL may be unavailable after a hard refresh; the File restore effect
      // below will replace it, while these coordinates remain useful now.
      setCrop(stored.crop);
      setImageSize({ w: stored.imageW, h: stored.imageH });
      setRows(stored.rows);
      setCols(stored.cols);
    }
    clearPendingCrop();
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  /* The crop page intentionally performs a full navigation. Restore the File
     from IndexedDB after that navigation; blob URLs alone are not enough for
     the multipart recognition request. */
  useEffect(() => {
    if (imageFile || (!imageUrl && !initialRestore)) return;
    let active = true;
    void loadPendingUpload().then((file) => {
      if (!active || !file) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        toast(`图片超过 ${MAX_UPLOAD_MB}MB 上限，请压缩后重新选择`, 'error');
        setImageFile(null);
        return;
      }
      setImageFile(file);
      // 复用跨页稳定 blob URL，命中已解码缓存
      const url = cacheImageFile('upload', file);
      setImageUrl(url);
      if (!imageSize) {
        const image = new Image();
        image.onload = () => active && setImageSize({ w: image.naturalWidth, h: image.naturalHeight });
        image.src = url;
      }
    });
    return () => { active = false; };
  }, [imageFile, imageSize, imageUrl, initialRestore, toast]);

  useEffect(() => {
    if (!imageUrl || !imageSize || !crop) return;
    // A root render used only to resume /crop or /materials must not downgrade
    // that pending step to 'upload' before the redirect effect runs.
    if (pendingWizard && pendingWizard.step !== 'upload' && !routeState?.restoreUpload) return;
    savePendingWizard({
      step: 'upload',
      imageUrl,
      imageW: imageSize.w,
      imageH: imageSize.h,
      crop,
      rows,
      cols,
      codes,
      jobName,
      skipLegendPrompt,
      legendInventory: legendEntries.map((entry) => ({ code: entry.code, count: entry.count, confirmed: entry.confirmed, row: entry.rowIndex, col: entry.colIndex, bbox: { x: entry.bbox.x, y: entry.bbox.y, w: entry.bbox.width, h: entry.bbox.height } })),
    });
  }, [codes, cols, crop, imageSize, imageUrl, jobName, legendEntries, pendingWizard, routeState, rows, skipLegendPrompt]);

  function onFileSelected(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      toast(`图片超过 ${MAX_UPLOAD_MB}MB 上限（当前 ${(file.size / 1024 / 1024).toFixed(1)}MB），请压缩后重新选择`, 'error');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setImageFile(file);
    setLegendEntries([]);
    setSkipLegendPrompt(false);
    const persisted = savePendingUpload(file);
    // 统一走跨页缓存：同一张图在上传/裁剪/物料页共享同一 blob URL
    const url = cacheImageFile('upload', file);
    const img = new Image();
    img.onload = async () => {
      await persisted;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const fullCrop = { x: 0, y: 0, w, h };
      const initialCrop = readLastSelection('crop', w, h) ?? fullCrop;
      setImageUrl(url);
      setImageSize({ w, h });
      setCrop(null); // 新图 → 去裁剪页重新框选
      savePendingCrop({ imageUrl: url, imageW: w, imageH: h, crop: initialCrop, rows, cols });
      savePendingWizard({ step: 'crop', imageUrl: url, imageW: w, imageH: h, crop: initialCrop, rows, cols, codes, jobName, legendInventory: [] });
      navigate('/crop', {
        state: { imageUrl: url, imageW: w, imageH: h, initialCrop },
      });
    };
    img.src = url;
  }

  /* 再次调整 → 带当前裁剪结果进入裁剪页 */
  function handleRecrop() {
    if (!imageUrl || !imageSize) return;
    const currentCrop = crop ?? { x: 0, y: 0, w: imageSize.w, h: imageSize.h };
    savePendingCrop({ imageUrl, imageW: imageSize.w, imageH: imageSize.h, crop: currentCrop, rows, cols });
    savePendingWizard({
      step: 'crop',
      imageUrl,
      imageW: imageSize.w,
      imageH: imageSize.h,
      crop,
      rows,
      cols,
      codes,
      jobName,
      skipLegendPrompt,
      legendInventory: legendEntries.map((entry) => ({ code: entry.code, count: entry.count, confirmed: entry.confirmed, row: entry.rowIndex, col: entry.colIndex, bbox: { x: entry.bbox.x, y: entry.bbox.y, w: entry.bbox.width, h: entry.bbox.height } })),
    });
    navigate('/crop', {
      state: { imageUrl, imageW: imageSize.w, imageH: imageSize.h, initialCrop: crop ?? undefined, rows, cols },
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
    // 开始识别前提示是否需要图例（一次；跳过后本次会话不再问）
    if (!legendEntries.length && !skipLegendPrompt) {
      setConfirmLegend(true);
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
        legend: legendEntries.length ? legendEntries : undefined,
      },
      {
        onSuccess: (job) => {
          clearPendingWizard();
          clearPendingCrop();
          void clearPendingUpload();
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

  // 注意：imageUrl 可能来自跨页共享的 imageCache（'upload' key），
  // 不能在卸载时 revoke，否则切回时缓存的 URL 已失效、图纸加载不出来。

  return (
    <div className="max-w-4xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-6">
        <motion.div variants={staggerItem}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 700, lineHeight: 1.2 }}>
            上传图纸并识别
          </h1>
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 2 }}>
            选择图片 → 框选拼豆区域 → 设置行列 → 识别
          </p>
        </motion.div>

        <motion.div variants={staggerItem}>
          <Stepper
            steps={[
              { id: 'upload', label: '上传' },
              { id: 'crop', label: '裁剪' },
              { id: 'materials', label: '物料清单', optional: true },
            ]}
            current={!imageUrl ? 0 : !crop ? 1 : !legendEntries.length && !skipLegendPrompt ? 2 : 2}
            completed={[!!imageUrl, !!crop, !!legendEntries.length || skipLegendPrompt]}
            onStepClick={(idx) => {
              if (idx === 0) return;
              if (idx === 1 && imageUrl) handleRecrop();
              if (idx === 2 && imageUrl && crop) navigate('/materials', { state: buildLegendNavState() });
            }}
          />
        </motion.div>

        {/* 任务名称 + 模型选择 + 网格 + 开始识别（顶部操作排） */}
        {confirmLegend && (
          <motion.div variants={staggerItem} className="mb-3 p-4 rounded-xl flex flex-wrap items-center gap-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-sm)' }}>
            <span style={{ fontSize: 'var(--text-sm)' }}>🏷️ 开始识别前，是否先录入图纸底部的物料清单（色号+数量）？物料清单可在校正页用于对比校验。</span>
            <div className="flex flex-wrap items-center gap-2" style={{ marginLeft: 'auto' }}>
              <Button onClick={() => { setConfirmLegend(false); navigate('/materials', { state: buildLegendNavState() }); }}>去录入物料清单</Button>
              <Button variant="secondary" onClick={() => { setSkipLegendPrompt(true); setConfirmLegend(false); }}>跳过，直接识别</Button>
              <Button variant="ghost" onClick={() => setConfirmLegend(false)}>取消</Button>
            </div>
          </motion.div>
        )}
        {!confirmLegend && legendEntries.length > 0 && (
          <motion.div variants={staggerItem} className="mb-3 px-4 py-2 rounded-full inline-flex items-center gap-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)', width: 'fit-content' }}>
            🏷️ 已记录物料清单 ×{legendEntries.length}
            <button type="button" onClick={() => { setLegendEntries([]); setSkipLegendPrompt(false); }} style={{ color: 'var(--color-error)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)' }}>清除</button>
            <button type="button" onClick={() => navigate('/materials', { state: buildLegendNavState() })} style={{ color: 'var(--color-accent)', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 'var(--text-xs)' }}>查看/修改</button>
          </motion.div>
        )}
        <motion.div variants={staggerItem} className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
              <span style={{ color: 'var(--color-error)', fontWeight: 600, lineHeight: 1 }} title="必填">*</span>
              <input
                id="job-name"
                name="jobName"
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
                id="recognition-model"
                name="recognitionModel"
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
            id="upload-image"
            name="image"
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
              onClick={() => {
                // 任务名称必填：未填写不允许选图/上传
                if (!jobName.trim()) {
                  toast('请先填写任务名称，再选择图片', 'error');
                  return;
                }
                fileRef.current?.click();
              }}
            >
              <div style={{ fontSize: 40 }}>🖼️</div>
              <p style={{ marginTop: 12, fontWeight: 500 }}>点击选择图片（JPEG/PNG，≤30MB）</p>
              <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>选择文件不会自动开始识别</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4 py-6">
              {/* 图纸预览（非裁剪交互，仅展示）：容器按图片比例撑开，百分比定位与图片显示区精确对齐 */}
              <div className="relative w-full overflow-hidden rounded-lg" style={{ background: 'var(--color-bg-secondary)' }}>
                <div style={{ position: 'relative', width: '100%', paddingTop: `${((imageSize!.h / imageSize!.w) * 100).toFixed(4)}%` }}>
                  <img
                    src={imageUrl}
                    alt="upload preview"
                    decoding="async"
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
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!imageUrl || !imageSize || !imageFile) return;
                    navigate('/materials', { state: buildLegendNavState() });
                  }}
                  disabled={!imageUrl || !imageSize}
                  title="逐个录入底部物料清单项，识别编码+数量"
                >
                  🏷️ 录入物料清单
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
                  id="board-codes"
                  name="boardCodes"
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
