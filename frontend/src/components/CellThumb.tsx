import { memo, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { BlueprintCellDto, CropBoxDto } from '../types/api';
import { cellCropRect } from '../lib/correctionModel';

const THUMB = 56;

/**
 * 校正页格子缩略图：canvas 直绘原图裁剪（IntersectionObserver 懒裁剪，进视口才画）。
 * 带勾选框（批量）与 ✓ 修正徽章。
 */
/** 格子 key（row:col）由组件自身构造，回调只传 key → 回调引用稳定，memo 在滚动窗口化时真正生效 */
export default memo(function CellThumb({
  cell,
  rows,
  cols,
  cropBox,
  image,
  checked,
  onToggle,
  onShiftToggle,
  onContextMenu,
  onEdit,
}: {
  cell: BlueprintCellDto;
  rows: number;
  cols: number;
  cropBox: CropBoxDto | null;
  image: CanvasImageSource | null;
  checked: boolean;
  onToggle: (key: string) => void;
  onShiftToggle: (key: string) => void;
  onContextMenu: (e: ReactMouseEvent, key: string) => void;
  onEdit: (key: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawnRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !cropBox) return;
    const draw = () => {
      if (drawnRef.current) return;
      drawnRef.current = true;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const rect = cellCropRect(cropBox, rows, cols, cell.row, cell.col);
      try {
        ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, THUMB, THUMB);
      } catch {
        // 裁剪越界等罕见情况：留空即可
      }
    };
    // 懒裁剪：进入视口才画（大组一次渲染不卡）；jsdom 无 IntersectionObserver 时直接画
    if (typeof IntersectionObserver === 'undefined') {
      draw();
      return;
    }
    // 滚动中不抢帧：进入视口后交给 requestIdleCallback（浏览器空闲时批量补画，最多延迟 200ms）。
    // 移动端单次 drawImage 约 1-6ms，滚动中同步画会直接吃掉帧预算导致滑动卡顿。
    const scheduleDraw = () => {
      if (drawnRef.current) return;
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => draw(), { timeout: 200 });
      } else {
        setTimeout(draw, 100);
      }
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            scheduleDraw();
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px' },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [image, cropBox, rows, cols, cell]);

  const corrected = cell.correctedCode != null;
  const key = `${cell.row}:${cell.col}`;

  return (
    <div className="flex flex-col items-center gap-0.5 select-none" title={`行 ${cell.row + 1} · 列 ${cell.col + 1} · 识别 ${cell.code}${corrected ? ` → 修正 ${cell.correctedCode}` : ''}`}>
      <div className="relative block cursor-pointer" onClick={() => onEdit(key)} onContextMenu={(e) => onContextMenu(e, key)} role="button" aria-label={`修改格子 ${cell.row + 1},${cell.col + 1}`}>
          <span
            className="block rounded border overflow-hidden transition-shadow hover:shadow-[var(--shadow-sm)]"
            style={{
              width: THUMB,
              height: THUMB,
              borderColor: checked ? 'var(--color-accent)' : 'var(--color-border)',
              boxShadow: checked ? '0 0 0 2px var(--color-accent)' : undefined,
            }}
          >
            <canvas ref={canvasRef} width={THUMB} height={THUMB} className="block" style={{ width: THUMB, height: THUMB }} />
          </span>
        {corrected && (
          <span
            className="absolute rounded-full text-white text-[9px] leading-none flex items-center justify-center"
            style={{ top: -3, right: -3, width: 15, height: 15, background: 'var(--color-success)' }}
          >
            ✓
          </span>
        )}
        <label
          className="absolute flex items-center justify-center rounded cursor-pointer"
          style={{ top: -3, left: -3, width: 17, height: 17, background: checked ? 'var(--color-accent)' : 'rgba(255,255,255,0.9)', border: '1px solid var(--color-border)' }}
          title="勾选；Shift+点击连选/取下同编码格子"
          onClick={(e) => {
            e.stopPropagation();
            // Shift+点击 → 矩形连选（拦截 checkbox，避免触发普通 toggle）
            if (e.shiftKey) {
              e.preventDefault();
              onShiftToggle(key);
            }
          }}
        >
          <input type="checkbox" className="sr-only" checked={checked} onChange={() => onToggle(key)} aria-label={`勾选格子 ${cell.row + 1},${cell.col + 1}`} />
          {checked && <span className="text-white text-[10px] leading-none">✓</span>}
        </label>
      </div>
      <span className="text-[10px] leading-none" style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>
        {cell.row + 1}:{cell.col + 1}
      </span>
      <span
        className="text-[10px] leading-tight font-semibold"
        style={{ fontFamily: 'var(--font-mono)', color: corrected ? 'var(--color-success)' : (cell.status === 'BLANK' || cell.code === 'BLANK' ? 'var(--color-text-muted)' : 'var(--color-text)') }}
      >
        {cell.code === 'BLANK' ? '空白' : cell.code}
        {corrected && ` → ${cell.correctedCode}`}
      </span>
    </div>
  );
});
