import { useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useUploadBlueprint } from '../hooks/useBlueprints';
import apiClient from '../api/client';
import Button from '../components/Button';
import Spinner from '../components/Spinner';
import CropBox, { type CropBoxHandle } from '../components/CropBox';
import { staggerContainer, staggerItem } from '../lib/animations';

export default function UploadPage() {
  const navigate = useNavigate();
  const upload = useUploadBlueprint();
  const cropBoxRef = useRef<CropBoxHandle>(null);
  const regionABlobRef = useRef<Blob | null>(null);
  const lastDetectedFileRef = useRef<File | null>(null);
  const regionBDataRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const [mainImage, setMainImage] = useState<string | null>(null);
  const [mainFile, setMainFile] = useState<File | null>(null);
  const [gridCropFile, setGridCropFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [gridRows, setGridRows] = useState(79);
  const [gridCols, setGridCols] = useState(57);
  const [validCodes, setValidCodes] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legendCodes, setLegendCodes] = useState<string[] | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [autoDetectStatus, setAutoDetectStatus] = useState<'idle' | 'detecting' | 'success' | 'failed'>('idle');

  const handleFile = useCallback((f: File) => {
    if (!f.type.startsWith('image/')) {
      setError('仅支持 JPG/PNG 格式');
      return;
    }
    setMainFile(f);
    setGridCropFile(null);
    setLegendCodes(null);
    setValidCodes('');
    setError(null);
    setAutoDetectStatus('idle');
    lastDetectedFileRef.current = null;
    const reader = new FileReader();
    reader.onload = (e) => setMainImage(e.target?.result as string);
    reader.readAsDataURL(f);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const retryParseLegend = useCallback(() => {
    const blob = regionABlobRef.current;
    if (!blob && !mainFile) return;
    setIsParsing(true);
    setError(null);
    const formData = new FormData();
    formData.append('image', blob || mainFile!);
    apiClient
      .post('/blueprints/parse-legend', formData)
      .then((res) => {
        const data = res.data;
        if (data.codes && data.codes.length > 0) {
          setLegendCodes(data.codes);
          setValidCodes(data.codes.join(','));
        } else {
          setError('未识别到色卡编码');
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '识别失败');
      })
      .finally(() => {
        setIsParsing(false);
      });
  }, [mainFile]);

  const handleCropComplete = useCallback(
    async (result: {
      regionABlob: Blob;
      regionBBlob: Blob;
      regionAData: { x: number; y: number; w: number; h: number };
      regionBData: { x: number; y: number; w: number; h: number };
    }) => {
      regionABlobRef.current = result.regionABlob;
      regionBDataRef.current = result.regionBData;

      const file = new File([result.regionBBlob], 'grid.jpg', { type: 'image/jpeg' });
      setGridCropFile(file);

      setIsParsing(true);
      setError(null);
      try {
        const formData = new FormData();
        formData.append('image', result.regionABlob);
        const res = await apiClient.post('/blueprints/parse-legend', formData);
        const data = res.data;
        if (data.codes && data.codes.length > 0) {
          setLegendCodes(data.codes);
          setValidCodes(data.codes.join(','));
        } else {
          setError('未识别到色卡编码');
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : '识别失败');
      } finally {
        setIsParsing(false);
      }
    },
    [],
  );

  const handleAutoDetect = useCallback(async (file: File) => {
    setAutoDetectStatus('detecting');
    setError(null);
    try {
      const formData = new FormData();
      formData.append('image', file);
      formData.append('grid_rows', String(gridRows));
      formData.append('grid_cols', String(gridCols));
      if (validCodes) {
        formData.append('valid_codes', validCodes);
      }

      const res = await apiClient.post('/blueprints/upload', formData);
      const data = res.data;
      setAutoDetectStatus('success');
      navigate(`/blueprints/${data.id}`);
    } catch (err: unknown) {
      setAutoDetectStatus('failed');
      setError(err instanceof Error ? err.message : 'AI 识别失败');
    }
  }, [gridRows, gridCols, validCodes, navigate]);

  useEffect(() => {
    if (mainFile && mainFile !== lastDetectedFileRef.current && autoDetectStatus === 'idle') {
      lastDetectedFileRef.current = mainFile;
      handleAutoDetect(mainFile);
    }
  }, [mainFile, autoDetectStatus, handleAutoDetect]);

  const handleUpload = async () => {
    if (!mainFile) return;
    if (!regionBDataRef.current) { setError('请先框选图纸区域'); return; }
    setError(null);
    const { x, y, w, h } = regionBDataRef.current;
    const boardBbox = `${x},${y},${w},${h}`;
    try {
      const result = await upload.mutateAsync({
        file: mainFile,
        name: name || undefined,
        gridRows,
        gridCols,
        validCodes: validCodes || undefined,
        boardBbox,
      });
      navigate(`/blueprints/${result.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '上传失败');
    }
  };

  return (
    <motion.div
      variants={staggerContainer}
      initial="initial"
      animate="animate"
      className="max-w-3xl mx-auto py-12 px-4"
    >
      <motion.h1
        variants={staggerItem}
        style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}
        className="text-3xl md:text-4xl font-bold mb-8 md:mb-10 tracking-tight"
      >
        上传拼豆图纸
      </motion.h1>

      <motion.section variants={staggerItem} className="border-t pt-8">
        <h2
          style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}
          className="text-xl font-semibold mb-5"
        >
          📄 上传完整图纸
        </h2>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className="rounded-xl p-8 md:p-12 text-center transition-all duration-300 cursor-pointer"
          style={{
            border: dragOver
              ? '2px dashed var(--color-accent)'
              : '2px dashed var(--color-border-strong)',
            background: dragOver
              ? 'var(--color-accent-light)'
              : 'var(--color-surface)',
            opacity: dragOver ? 0.9 : 1,
          }}
          onClick={() => document.getElementById('fileInput')?.click()}
        >
          <input
            id="fileInput"
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          {mainImage ? (
            <img
              src={mainImage}
              alt="Preview"
              className="max-h-64 mx-auto rounded-lg shadow"
            />
          ) : (
            <div style={{ color: 'var(--color-text-muted)' }}>
              <div className="text-4xl mb-3">📁</div>
              <p className="text-lg font-medium" style={{ color: 'var(--color-text)' }}>
                拖拽图纸到此处
              </p>
              <p className="text-sm mt-1">或点击选择文件 (JPG/PNG)</p>
            </div>
          )}
        </div>

        {mainFile && (
          <div
            className="mt-4 p-3 rounded-lg text-sm"
            style={{
              background: 'var(--color-bg-secondary)',
              color: 'var(--color-text-secondary)',
            }}
          >
            {mainFile.name} ({(mainFile.size / 1024).toFixed(1)} KB)
          </div>
        )}
      </motion.section>

      {mainImage && (
        <motion.section variants={staggerItem} className="mt-8 border-t pt-8">
          <h2
            style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}
            className="text-xl font-semibold mb-5"
          >
            ✂️ 调整选区
          </h2>

          {autoDetectStatus === 'detecting' && (
            <div
              className="flex items-center gap-2 p-3 rounded-lg mb-4"
              style={{ background: 'var(--color-bg-secondary)' }}
            >
              <Spinner size="sm" />
              <span style={{ color: 'var(--color-text-secondary)' }}>
                🤖 AI 正在自动识别色卡和图纸区域...
              </span>
            </div>
          )}

          {autoDetectStatus === 'success' && (
            <div
              className="flex items-center gap-2 p-3 rounded-lg mb-4"
              style={{
                background: 'var(--color-success-light)',
                border: '1px solid var(--color-success)',
              }}
            >
              <span style={{ color: 'var(--color-success)' }}>
                ✅ AI 识别成功，正在跳转...
              </span>
            </div>
          )}

          {autoDetectStatus === 'failed' && (
            <div
              className="p-3 rounded-lg mb-4"
              style={{
                background: 'var(--color-error-light)',
                border: '1px solid var(--color-error)',
                color: 'var(--color-text)',
              }}
            >
              <p className="text-sm mb-2">⚠️ AI 未能自动识别，请手动调整选框。</p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                直接拖拽图片上的选框调整色卡区域（紫色）和图纸区域（绿色）
              </p>
            </div>
          )}

          {autoDetectStatus === 'failed' && (
            <CropBox
              key={mainImage}
              ref={cropBoxRef}
              image={mainImage}
              mode="dual"
              labels={['色卡区域', '图纸区域']}
              onCropComplete={handleCropComplete}
            />
          )}

          <div className="mt-4">
            {isParsing && (
              <div
                className="flex items-center gap-2 text-sm"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                <Spinner size="sm" />
                <span>正在识别色卡...</span>
              </div>
            )}
          </div>

          {isParsing && (
            <motion.div
              className="mt-4 rounded-lg overflow-hidden"
              style={{
                height: '4px',
                background: 'var(--color-bg-secondary)',
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
            >
              <motion.div
                className="h-full rounded-lg"
                style={{ background: 'var(--color-accent)' }}
                initial={{ width: '0%' }}
                animate={{ width: ['0%', '60%', '90%', '60%', '30%', '70%'] }}
                transition={{
                  duration: 2.5,
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
              />
            </motion.div>
          )}
        </motion.section>
      )}

      {legendCodes && (
        <motion.div
          variants={staggerItem}
          className="mt-6 p-3 rounded-lg"
          style={{
            background: 'var(--color-success-light)',
            border: '1px solid var(--color-success)',
          }}
        >
          <p className="text-sm mb-2" style={{ color: 'var(--color-success)' }}>
            ✅ 识别到 {legendCodes.length} 个编码
          </p>
          <div className="flex flex-wrap gap-1">
            {legendCodes.map((code) => (
              <span
                key={code}
                className="px-2 py-0.5 rounded text-xs"
                style={{
                  background: 'var(--color-success-light)',
                  color: 'var(--color-success)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {code}
              </span>
            ))}
          </div>
        </motion.div>
      )}

      {error && (
        <motion.div
          variants={staggerItem}
          className="mt-4 p-3 rounded-lg text-sm flex items-center justify-between gap-3"
          style={{
            background: 'var(--color-error-light)',
            border: '1px solid var(--color-error)',
            color: 'var(--color-error)',
          }}
        >
          <span>{error}</span>
          <Button
            onClick={retryParseLegend}
            disabled={isParsing}
            variant="secondary"
            className="shrink-0"
          >
            重试
          </Button>
        </motion.div>
      )}

      {gridCropFile && (
        <>
          <motion.section variants={staggerItem} className="mt-6 border-t pt-6">
            <h2
              style={{ fontFamily: 'var(--font-display)', color: 'var(--color-text)' }}
              className="text-xl font-semibold mb-5"
            >
              ⚙️ 图纸设置
            </h2>

            <div className="mt-4">
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                图纸名称 (可选)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="给图纸起个名字..."
                className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                style={{
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                  background: 'var(--color-surface)',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border-focus)';
                  e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent-light)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              />
            </div>

            <div className="mt-4">
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                棋盘尺寸
              </label>
              <div className="flex gap-3">
                <div className="flex-1">
                  <input
                    type="number"
                    value={gridRows}
                    onChange={(e) =>
                      setGridRows(parseInt(e.target.value) || 79)
                    }
                    placeholder="行数"
                    min={1}
                    max={200}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                    style={{
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text)',
                      background: 'var(--color-surface)',
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-border-focus)';
                      e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent-light)';
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-border)';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  />
                </div>
                <span className="self-center" style={{ color: 'var(--color-text-muted)' }}>
                  ×
                </span>
                <div className="flex-1">
                  <input
                    type="number"
                    value={gridCols}
                    onChange={(e) =>
                      setGridCols(parseInt(e.target.value) || 57)
                    }
                    placeholder="列数"
                    min={1}
                    max={200}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none transition-colors"
                    style={{
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text)',
                      background: 'var(--color-surface)',
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-border-focus)';
                      e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent-light)';
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = 'var(--color-border)';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="mt-4">
              <label
                className="block text-sm font-medium mb-1"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                使用到的颜色编码{' '}
                <span className="font-normal" style={{ color: 'var(--color-text-muted)' }}>
                  (逗号分隔，留空则使用全量颜色库)
                </span>
              </label>
              <textarea
                value={validCodes}
                onChange={(e) => setValidCodes(e.target.value)}
                placeholder="例如: H2, H7, F2, B25, G2"
                rows={2}
                className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none transition-colors"
                style={{
                  border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                  background: 'var(--color-surface)',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border-focus)';
                  e.currentTarget.style.boxShadow = '0 0 0 2px var(--color-accent-light)';
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'var(--color-border)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              />
              <p className="mt-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                限制 OCR 只识别这些编码，颜色匹配也只对这些编码进行，显著提高准确率
              </p>
            </div>
          </motion.section>

          <motion.div variants={staggerItem} className="mt-6">
            <Button
              onClick={handleUpload}
              disabled={!gridCropFile || upload.isPending}
              className="w-full"
            >
              {upload.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner /> 解析中...
                </span>
              ) : (
                '开始解析'
              )}
            </Button>
          </motion.div>

          {upload.isPending && (
            <motion.div
              variants={staggerItem}
              className="mt-4 flex flex-col items-center gap-3"
            >
              <Spinner size="lg" />
              <p className="text-sm text-center" style={{ color: 'var(--color-text-muted)' }}>
                正在解析图纸，请稍候...
              </p>
            </motion.div>
          )}
        </>
      )}
    </motion.div>
  );
}