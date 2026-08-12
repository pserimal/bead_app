import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useBlueprint } from '../hooks/useBlueprints';
import { getColors } from '../api/colors';
import { updateBlueprintCells } from '../api/blueprints';
import type { BlueprintCellDto, ColorDto } from '../types/api';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { HoverCell } from '../lib/boardCanvas';
import { useBoardViewer } from '../hooks/useBoardViewer';
import CorrectionEditorModal from '../components/CorrectionEditorModal';
import { useToast } from '../components/ToastContext';
import ImmersionBoard from '../components/ImmersionBoard';

function controlStyle(): React.CSSProperties {
  return {
    minWidth: 34,
    height: 32,
    padding: '0 9px',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    background: 'var(--color-card)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  };
}

export default function BlueprintDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: blueprint, isLoading, error } = useBlueprint(id ?? null);
  const [hover, setHover] = useState<HoverCell | null>(null);
  // 点击单元格编辑（单格修正弹窗，复用校正页的 CorrectionEditorModal）
  const [editor, setEditor] = useState<{ keys: string[] } | null>(null);
  const [immersive, setImmersive] = useState(false);

  const unmapped = useMemo(
    // 兼容旧 blueprint：历史 BLANK 可能曾被保存为 UNMAPPED；编码优先。
    () => blueprint?.cells.filter((cell) => cell.status === 'UNMAPPED' && cell.code !== 'BLANK') ?? [],
    [blueprint],
  );
  // 按 position 索引的格子 Map：只建一次（drawBoard 每帧重绘都复用，省 14k 次分配/GC）
  const cellsByPosition = useMemo(() => {
    const map = new Map<string, BlueprintCellDto>();
    if (blueprint) {
      for (const cell of blueprint.cells) map.set(`${cell.row}:${cell.col}`, cell);
    }
    return map;
  }, [blueprint]);
  // 最长编码：只算一次（hover tooltip 和 drawBoard 共用）；用有效码（修正 ?? 识别）
  const longestCode = useMemo(() => {
    if (!blueprint) return '';
    let best = '';
    for (const cell of blueprint.cells) {
      const eff = cell.correctedCode ?? cell.code;
      if (eff !== 'BLANK' && eff && eff.length > best.length) best = eff;
    }
    return best;
  }, [blueprint]);
  // 待复核数（详情页角标；与校正页默认档位 90% 一致）
  const reviewCount = useMemo(() => {
    if (!blueprint) return 0;
    return blueprint.cells.filter(
      (c) => c.status === 'UNMAPPED' || (c.confidence != null && c.confidence < 0.9),
    ).length;
  }, [blueprint]);

  // 点击单元格 → 打开单格修正弹窗（编辑坐标与 hover tooltip 同一来源）
  const handleCellTap = useMemo(
    () => (cell: HoverCell | null) => {
      if (cell) setEditor({ keys: [`${cell.row}:${cell.col}`] });
    },
    [],
  );

  // 单格提交：设置新码 / 恢复原码（code=null），成功后刷新详情（静态层/文字层随 cells 重建）
  const applySingleCorrection = useMemo(
    () => async (code: string | null) => {
      if (!id || !editor) return false;
      try {
        const [row, col] = editor.keys[0].split(':').map(Number);
        await updateBlueprintCells(id, [{ row, col, code }]);
        toast(code == null ? '已恢复原识别码' : `已设为 ${code}`, 'success');
        setEditor(null);
        void queryClient.invalidateQueries({ queryKey: ['blueprint', id] });
        return true;
      } catch (e) {
        toast((e as Error).message, 'error');
        return false;
      }
    },
    [editor, id, queryClient, toast],
  );

  // 色板/合法编码（懒加载：首次点击单元格才拉全量颜色库；与校正页共享 queryKey 缓存）
  const { data: allColors } = useQuery({
    queryKey: ['colors', 'all'],
    queryFn: async () => {
      const items: ColorDto[] = [];
      let page = 1;
      for (;;) {
        const res = await getColors({ pageSize: 100, page });
        items.push(...res.items);
        if (res.page >= res.totalPages) break;
        page += 1;
      }
      return items;
    },
    enabled: editor != null,
  });
  const colorsByCode = useMemo(() => {
    const map = new Map<string, ColorDto>();
    for (const c of allColors ?? []) map.set(c.code, c);
    return map;
  }, [allColors]);
  const validCodeList = useMemo(() => {
    const codes = (blueprint?.validCodes?.length ? blueprint.validCodes : allColors?.map((c) => c.code)) ?? [];
    return codes;
  }, [blueprint, allColors]);
  // 色板：按色相排序（与校正页一致）
  const swatches = useMemo(() => {
    const hue = (hex: string) => {
      const v = hex.replace(/^#/, '');
      const r = Number.parseInt(v.slice(0, 2), 16) / 255;
      const g = Number.parseInt(v.slice(2, 4), 16) / 255;
      const b = Number.parseInt(v.slice(4, 6), 16) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return -1;
      const d = max - min;
      let h = 0;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return h * 60;
    };
    return validCodeList
      .map((code) => colorsByCode.get(code))
      .filter((c): c is ColorDto => c != null)
      .sort((a, b) => hue(a.hex) - hue(b.hex));
  }, [validCodeList, colorsByCode]);

  const cellSize = blueprint ? Math.max(12, Math.min(48, 1440 / Math.max(blueprint.cols, blueprint.rows))) : 48;

  // 画布查看器：手势/重绘/坐标数学全部来自共享 hook
  const viewer = useBoardViewer({
    rows: blueprint?.rows ?? 0,
    cols: blueprint?.cols ?? 0,
    cellsByPosition,
    longestCode,
    cellSize,
    // 悬停 tooltip：同格内移动不更新（React 同引用 bail-out）
    onHover: (cell) => setHover((prev) => (prev && cell && prev.row === cell.row && prev.col === cell.col ? prev : cell)),
    // 点击（无拖动）→ 打开单格编码编辑弹窗
    onCellTap: handleCellTap,
  });

  if (isLoading) return <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>;
  if (error) return <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>;
  if (!blueprint) return null;

  const { viewportRef, wrapperRef, canvasRef, view } = viewer;

  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-5">
        <motion.div variants={staggerItem} className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>图纸详情</h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 3 }}>
              {blueprint.rows} × {blueprint.cols} · {blueprint.cells.length.toLocaleString()} 格 · 创建于 {new Date(blueprint.createdAt).toLocaleString()} · 可校正
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={() => navigate('/blueprints')} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)', padding: '6px 8px' }}>← 任务历史</button>
            <button
              type="button"
              onClick={() => navigate(`/blueprints/${id}/correct`)}
              style={{ ...controlStyle(), fontWeight: 600, color: '#fff', background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}
            >
              校正{reviewCount > 0 ? `（${reviewCount}）` : ''}
            </button>
            <button
              type="button"
              onClick={() => setImmersive(true)}
              style={{ ...controlStyle(), fontWeight: 600, color: '#fff', background: 'var(--color-accent)', borderColor: 'var(--color-accent)' }}
              title="全屏浏览拼豆图纸：点击格子查看并锁定其编码"
            >
              沉浸模式
            </button>
            <button type="button" onClick={() => viewer.zoomBy(0.8)} style={controlStyle()} aria-label="缩小">−</button>
            <button type="button" onClick={viewer.resetView} style={controlStyle()} aria-label="100%">100%</button>
            <span style={{ minWidth: 48, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--color-text-muted)' }}>{Math.round(view.scale * 100)}%</span>
            <button type="button" onClick={() => viewer.zoomBy(1.25)} style={controlStyle()} aria-label="放大">+</button>
            <button type="button" onClick={viewer.fitView} style={{ ...controlStyle(), fontFamily: 'var(--font-body)' }}>适应窗口</button>
          </div>
        </motion.div>

        {unmapped.length > 0 && (
          <motion.div variants={staggerItem} className="px-4 py-3 rounded-lg text-sm" style={{ background: 'var(--color-warning-light)', border: '1px solid var(--color-warning)' }}>
            <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>⚠ {unmapped.length} 个格子编码不在颜色库：</span>
            {unmapped.slice(0, 20).map((cell) => `(${cell.row + 1},${cell.col + 1}) ${cell.code}`).join('、')}
            {unmapped.length > 20 && ` 等 ${unmapped.length} 处`}
          </motion.div>
        )}

        <motion.div variants={staggerItem}>
          <div
            ref={viewportRef}
            className="relative overflow-hidden rounded-xl"
            role="application"
            aria-label={`${blueprint.rows}×${blueprint.cols} 拼豆图纸预览`}
            style={{ height: 'min(72vh, 760px)', minHeight: 360, background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
          >
            <div
              ref={wrapperRef}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                width: viewer.viewportMode ? '100%' : viewer.boardWidth,
                height: viewer.viewportMode ? '100%' : viewer.boardHeight,
                transform: viewer.viewportMode
                  ? 'translate(-50%, -50%)'
                  : `translate(calc(-50% + ${view.panX}px), calc(-50% + ${view.panY}px)) scale(${view.scale})`,
                transformOrigin: 'center center',
              }}
            >
              <canvas ref={canvasRef} aria-label="彩色拼豆图纸" />
            </div>

            {!viewer.ready && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--color-bg-secondary)',
                  zIndex: 4,
                  fontSize: 'var(--text-sm)',
                  color: 'var(--color-text-muted)',
                }}
              >
                绘制中…
              </div>
            )}

            {hover && (
              <div
                style={{
                  position: 'absolute',
                  left: Math.min(hover.x, Math.max(8, viewer.viewportSize.width - 240)),
                  top: Math.min(hover.y, Math.max(8, viewer.viewportSize.height - 64)),
                  padding: '7px 10px',
                  borderRadius: 7,
                  background: 'rgba(61, 43, 31, 0.92)',
                  color: 'var(--color-surface)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-xs)',
                  pointerEvents: 'none',
                  zIndex: 5,
                  whiteSpace: 'nowrap',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <span>
                  行 {hover.row + 1} · 列 {hover.col + 1} · {hover.code}
                  {hover.conf != null && ` · ${Math.round(hover.conf * 100)}%`}
                </span>
                {hover.corrected != null && (
                  <span style={{ opacity: 0.85 }}>
                    已修正：原 {cellsByPosition.get(`${hover.row}:${hover.col}`)?.code} → {hover.corrected}
                  </span>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>

      {/* 点击单元格编辑编码（复用校正页弹窗：输入校验 + 色板 + 恢复原码） */}
      {editor && (
        <CorrectionEditorModal
          editor={editor}
          cellsByPos={cellsByPosition}
          swatches={swatches}
          validCodes={validCodeList}
          onClose={() => setEditor(null)}
          onConfirmSet={(code) => applySingleCorrection(code)}
          onConfirmRevert={() => applySingleCorrection(null)}
        />
      )}

      {/* 沉浸拼豆模式：全屏浏览 + 点击锁定编码高亮 */}
      {immersive && blueprint && (
        <ImmersionBoard blueprint={blueprint} onClose={() => setImmersive(false)} />
      )}
    </div>
  );
}
