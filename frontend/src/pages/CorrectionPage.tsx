import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useBlueprint } from '../hooks/useBlueprints';
import { updateBlueprintCells } from '../api/blueprints';
import { getColors } from '../api/colors';
import apiClient from '../api/client';
import { useToast } from '../components/ToastContext';
import { staggerContainer, staggerItem } from '../lib/animations';
import CellThumb from '../components/CellThumb';
import CorrectionEditorModal from '../components/CorrectionEditorModal';
import {
  buildCodeList,
  computeBreakdown,
  computeReviewCells,
  computeVisibleCells,
  normalizeHex,
  rangeKeys,
  toggleKeys,
} from '../lib/correctionModel';
import type { BlueprintCellDto, CellCorrectionUpdate, ColorDto, CropBoxDto } from '../types/api';

// 置信度档位：标记 conf < 档位的 MAPPED/BLANK 格（UNMAPPED 无条件进列表）
const THRESHOLDS = [0.9, 0.8, 0.7] as const;
const DEFAULT_THRESHOLD: (typeof THRESHOLDS)[number] = 0.9;

/** 与 ocr_core.inference 相同的格子裁剪数学（含 10% 内缩跳过网格线） */
export default function CorrectionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: blueprint, isLoading, error } = useBlueprint(id ?? null);

  const [threshold, setThreshold] = useState<(typeof THRESHOLDS)[number]>(DEFAULT_THRESHOLD);
  const [mode, setMode] = useState<'review' | 'all'>('review');
  const [fixFilter, setFixFilter] = useState<'all' | 'unfixed' | 'fixed'>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ keys: string[] } | null>(null);
  // 右键菜单：{ 屏幕坐标, 菜单操作的格子 keys }
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; keys: string[] } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageError, setImageError] = useState(false);
  // 两栏布局：左栏选中编码 + 右栏该编码的全部格子（不分页，缩略图懒裁剪）
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  // 原图加载一次（校正页所有缩略图共用）
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!cancelled) {
        setImage(img);
        setImageError(false);
      }
    };
    img.onerror = () => {
      if (!cancelled) setImageError(true);
    };
    img.src = apiClient.getUri({ url: `/blueprints/${id}/image` });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const cellsByPos = useMemo(() => {
    const map = new Map<string, BlueprintCellDto>();
    if (blueprint) for (const cell of blueprint.cells) map.set(`${cell.row}:${cell.col}`, cell);
    return map;
  }, [blueprint]);

  // 全量颜色（色板用）：/colors 每页 100，拉完为止
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
  });
  const colorsByCode = useMemo(() => {
    const map = new Map<string, ColorDto>();
    for (const c of allColors ?? []) map.set(c.code, c);
    return map;
  }, [allColors]);

  // 校验/色板用的合法编码：任务 validCodes 优先；为空（老任务）回退到全颜色库
  const validCodeList = useMemo(() => {
    const codes = (blueprint?.validCodes?.length ? blueprint.validCodes : allColors?.map((c) => c.code)) ?? [];
    return codes;
  }, [blueprint, allColors]);

  // 色板：按色相排序（找"这个颜色的豆"更快）
  const swatches = useMemo(() => {
    const list = validCodeList
      .map((code) => colorsByCode.get(code))
      .filter((c): c is ColorDto => c != null);
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
    return [...list].sort((a, b) => hue(a.hex) - hue(b.hex));
  }, [validCodeList, colorsByCode]);

  const reviewCells = useMemo(() => {
    if (!blueprint) return [];
    return computeReviewCells(blueprint.cells, threshold);
  }, [blueprint, threshold]);

  const visibleCells = useMemo(() => {
    if (!blueprint) return [];
    return computeVisibleCells(blueprint.cells, reviewCells, mode, search, fixFilter);
  }, [blueprint, mode, reviewCells, search, fixFilter]);

  // 左栏编码列表（按有效码 = corrected ?? code 分组，自然序：A2 < A10，空白排最后）
  const codeList = useMemo(() => {
    return buildCodeList(visibleCells);
  }, [visibleCells]);
  const activeCode = selectedCode != null && codeList.some((l) => l.code === selectedCode)
    ? selectedCode
    : (codeList[0]?.code ?? null);
  // 右栏：当前编码（有效码）的全部格子，按 row,col 排序
  const codeCells = useMemo(() => {
    if (activeCode == null) return [];
    return visibleCells
      .filter((c) => (c.correctedCode ?? c.code) === activeCode)
      .sort((a, b) => a.row - b.row || a.col - b.col);
  }, [visibleCells, activeCode]);
  // 当前编码的实际豆色（右栏标题色点）
  const activeHex = useMemo(() => {
    if (activeCode == null || activeCode === 'BLANK') return null;
    return swatches.find((s) => s.code === activeCode)?.hex ?? codeCells[0]?.color?.hex ?? null;
  }, [activeCode, swatches, codeCells]);
  // 渐进渲染：初始只挂载前 N 个，右栏滚动近底部自动追加（避免大组一次渲染 5 千 DOM 卡顿）
  const RENDER_STEP = 300;
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);
  useEffect(() => {
    setRenderLimit(RENDER_STEP);
  }, [activeCode]);
  const onRightScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) {
      setRenderLimit((n) => Math.min(codeCells.length, n + RENDER_STEP));
    }
  }, [codeCells.length]);
  const renderedCells = codeCells.slice(0, renderLimit);

  const selectedKeys = useMemo(() => [...selected], [selected]);
  const selectedBreakdown = useMemo(() => computeBreakdown(selectedKeys, cellsByPos), [selectedKeys, cellsByPos]);

  // Shift 连选锚点：最近一次普通点击的格子（Shift+点击以它为起点）
  const anchorRef = useRef<string | null>(null);

  const toggleCell = useCallback((key: string) => {
    anchorRef.current = key; // 普通点击 → 更新连选锚点
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * Shift+点击：在当前编码组列表（codeCells 顺序）中锚点 → 目标之间连续连选/取下。
   * 锚点跨组/缺失时重置锚点并仅选目标格。
   */
  const shiftSelect = useCallback((key: string) => {
    const keys = rangeKeys(codeCells, anchorRef.current, key);
    if (keys == null) {
      setSelected(new Set([key]));
      anchorRef.current = key;
      return;
    }
    setSelected((prev) => toggleKeys(prev, keys));
  }, [codeCells]);

  /** 全选/取消全选当前编码的全部格子 */
  const toggleCodeAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = codeCells.every((c) => next.has(`${c.row}:${c.col}`));
      for (const c of codeCells) {
        const key = `${c.row}:${c.col}`;
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, [codeCells]);

  const applyUpdates = useCallback(
    async (updates: CellCorrectionUpdate[], message: string) => {
      if (!id) return null;
      try {
        await updateBlueprintCells(id, updates);
        toast(message, 'success');
        const applied = new Set(updates.map((u) => `${u.row}:${u.col}`));
        setSelected((prev) => {
          const next = new Set(prev);
          for (const key of applied) next.delete(key);
          return next;
        });
        setEditor(null);
        void queryClient.invalidateQueries({ queryKey: ['blueprint', id] });
        return true;
      } catch (e) {
        toast((e as Error).message, 'error');
        return null;
      }
    },
    [id, queryClient, toast],
  );

  const openEditor = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    setEditor({ keys });
  }, []);

  /** 右键格子：已选中 → 菜单操作整个选中集；未选中 → 先只选该格 */
  const handleCellContextMenu = useCallback((e: React.MouseEvent, key: string) => {
    e.preventDefault();
    const inSelection = selected.has(key);
    const keys = inSelection ? [...selected] : [key];
    if (!inSelection) setSelected(new Set([key]));
    const MENU_W = 160;
    const MENU_H = 132;
    setCtxMenu({
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
      keys,
    });
  }, [selected]);

  // 右键菜单 Esc 关闭
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctxMenu]);

  const confirmSet = useCallback(
    async (code: string) => {
      if (!editor) return;
      const updates = editor.keys.map((key) => {
        const [row, col] = key.split(':').map(Number);
        return { row, col, code };
      });
      await applyUpdates(updates, `已将 ${updates.length} 格设为 ${code}`);
    },
    [editor, applyUpdates],
  );

  const confirmRevert = useCallback(async () => {
    if (!editor) return;
    const updates = editor.keys.map((key) => {
      const [row, col] = key.split(':').map(Number);
      return { row, col, code: null };
    });
    await applyUpdates(updates, `已恢复 ${updates.length} 格的原识别码`);
  }, [editor, applyUpdates]);

  const exportCorrections = useCallback(async () => {
    if (!id) return;
    try {
      const res = await apiClient.get(`/blueprints/${id}/cells/export-corrections`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `corrections-${id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('已导出校正数据 zip（含 manifest.csv + 格子图片）', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [id, toast]);

  if (isLoading) return <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>;
  if (error) return <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>;
  if (!blueprint) return null;

  const unmappedCount = blueprint.cells.filter((c) => c.status === 'UNMAPPED').length;
  const correctedCount = blueprint.cells.filter((c) => c.correctedCode != null).length;
  const selectedCount = selected.size;

  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-4">
        <motion.div variants={staggerItem} className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 700 }}>图纸校正</h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 3 }}>
              {blueprint.rows} × {blueprint.cols} · {blueprint.cells.length.toLocaleString()} 格 · 勾选后批量设为编码或恢复原码
            </p>
          </div>
          <button type="button" onClick={() => navigate(`/blueprints/${id}`)} style={{ fontSize: 'var(--text-sm)', color: 'var(--color-accent)', padding: '6px 8px' }}>← 返回详情</button>
          <button
            type="button"
            onClick={exportCorrections}
            disabled={correctedCount === 0}
            style={{ ...controlStyle(), fontWeight: 600, color: '#fff', background: correctedCount > 0 ? 'var(--color-success)' : undefined, borderColor: correctedCount > 0 ? 'var(--color-success)' : undefined, opacity: correctedCount === 0 ? 0.45 : 1, cursor: correctedCount === 0 ? 'not-allowed' : 'pointer' }}
            title="导出全部已校正格子（zip：manifest.csv + 格子裁剪图），供模型训练"
          >
            导出校正数据{correctedCount > 0 ? `（${correctedCount}）` : ''}
          </button>
        </motion.div>

        <motion.div variants={staggerItem} className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
            {(['review', 'all'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  padding: '6px 14px',
                  fontSize: 'var(--text-sm)',
                  background: mode === m ? 'var(--color-accent)' : 'transparent',
                  color: mode === m ? '#fff' : 'var(--color-text)',
                }}
              >
                {m === 'review' ? `待复核（${reviewCells.length}）` : '全部格子'}
              </button>
            ))}
          </div>

          {mode === 'review' && (
            <select
              value={String(threshold)}
              onChange={(e) => setThreshold(Number(e.target.value) as (typeof THRESHOLDS)[number])}
              style={controlStyle()}
              aria-label="置信度阈值"
            >
              {THRESHOLDS.map((t) => (
                <option key={t} value={String(t)}>置信度 &lt; {Math.round(t * 100)}%</option>
              ))}
            </select>
          )}

          <div className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
            {([['all', '全部'], ['unfixed', '仅未修正'], ['fixed', '仅已修正']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFixFilter(value)}
                style={{
                  padding: '6px 12px',
                  fontSize: 'var(--text-xs)',
                  background: fixFilter === value ? 'var(--color-accent)' : 'transparent',
                  color: fixFilter === value ? '#fff' : 'var(--color-text)',
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === 'all' && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜坐标 1:23 或编码 A10"
              style={{ ...controlStyle(), minWidth: 180 }}
              aria-label="搜索格子"
            />
          )}

          {imageError && (
            <motion.p variants={staggerItem} className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--color-error-light)', border: '1px solid var(--color-error)', color: 'var(--color-error)' }}>
              ⚠ 原图加载失败（文件可能已被清理），缩略图无法显示，但修正功能不受影响
            </motion.p>
          )}

          {unmappedCount > 0 && (
            <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--color-warning-light)', color: 'var(--color-warning)' }}>
              ⚠ {unmappedCount} 格颜色库外（已全部列入待复核）
            </span>
          )}
        </motion.div>

        {codeList.length === 0 && (
          <motion.div variants={staggerItem} className="py-12 text-center" style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            {mode === 'review' ? '没有需要复核的格子 🎉' : '没有匹配的格子'}
          </motion.div>
        )}

        <div className="space-y-4">
          <motion.div variants={staggerItem} className="flex flex-col lg:flex-row items-start gap-4">
              {/* 左栏：编码列表（按有效码分组，自然序）；平板/手机 = 顶部横向 chips，lg+ = 侧栏 */}
              <div
                className="w-full lg:w-40 shrink-0 rounded-xl p-2 lg:max-h-[70vh] overflow-x-auto lg:overflow-y-auto"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-xs)' }}
              >
                <div className="flex lg:flex-col gap-1 w-max lg:w-auto">
                  {codeList.map(({ code, count }) => {
                    const selected = activeCode === code;
                    const label = code === 'BLANK' ? '空白' : code;
                    return (
                      <button
                        key={code}
                        type="button"
                        onClick={() => { setSelectedCode(code); }}
                        className="shrink-0 lg:w-full flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-md lg:mb-0.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                        style={{
                          background: selected ? 'var(--color-accent)' : 'transparent',
                          color: selected ? 'var(--color-text-inverse)' : 'var(--color-text)',
                          cursor: 'pointer',
                        }}
                      >
                        <span className="truncate" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: selected ? 700 : 500 }}>
                          {label}
                        </span>
                        <span
                          className="rounded-full px-1.5 text-[10px] leading-4 shrink-0"
                          style={{
                            background: selected ? 'rgba(255,255,255,0.22)' : 'var(--color-bg-secondary)',
                            color: selected ? '#fff' : 'var(--color-text-muted)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {codeList.length === 0 && (
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>无匹配</span>
                )}
              </div>
              {/* 右栏：当前编码的全部格子（卡片 + 独立滚动 + 渐进渲染） */}
              <div className="flex-1 min-w-0 w-full rounded-xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-xs)' }}>
                <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <span
                    className="w-4 h-4 rounded-full shrink-0"
                    style={{ background: normalizeHex(activeHex) ?? 'var(--color-bg-secondary)', border: '1px solid var(--color-border-strong)' }}
                    title={activeCode == null ? undefined : `色号 ${activeCode}`}
                  />
                  <span className="text-base" style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
                    {activeCode == null ? '—' : (activeCode === 'BLANK' ? '空白' : activeCode)}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{codeCells.length} 格</span>
                  <button
                    type="button"
                    onClick={toggleCodeAll}
                    disabled={codeCells.length === 0}
                    style={smallBtn()}
                  >
                    {codeCells.length > 0 && codeCells.every((c) => selected.has(`${c.row}:${c.col}`)) ? '取消全选' : '全选'}
                  </button>
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Shift+点击：连选/取下当前编码格子</span>
                  {renderLimit < codeCells.length && (
                    <span className="ml-auto text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      已加载 {renderLimit}/{codeCells.length} · 滚动继续加载
                    </span>
                  )}
                </div>
                <div className="max-h-[calc(70vh-53px)] overflow-y-auto p-3" style={{ scrollbarWidth: 'thin' }} onScroll={onRightScroll}>
                  <div className="flex flex-wrap gap-2">
                    {renderedCells.map((cell) => (
                      <CellThumb
                        key={`${cell.row}:${cell.col}`}
                        cell={cell}
                        rows={blueprint.rows}
                        cols={blueprint.cols}
                        cropBox={blueprint.cropBox}
                        image={image}
                        checked={selected.has(`${cell.row}:${cell.col}`)}
                        onToggle={() => toggleCell(`${cell.row}:${cell.col}`)}
                        onShiftToggle={() => shiftSelect(`${cell.row}:${cell.col}`)}
                        onContextMenu={(e) => handleCellContextMenu(e, `${cell.row}:${cell.col}`)}
                        onEdit={() => openEditor([`${cell.row}:${cell.col}`])}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
        </div>
      </motion.div>

      {/* 底部操作条（surface 卡片，与全局一致） */}
      {selectedCount > 0 && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-xl z-20 max-w-[calc(100vw-2rem)]"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>已选 <b>{selectedCount}</b> 格</span>
          {selectedBreakdown.length > 0 && (
            <span className="text-xs hidden sm:inline" style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
              {selectedBreakdown.slice(0, 3).map((b) => `${b.code}×${b.count}`).join(' ')}
            </span>
          )}
          <button type="button" onClick={() => openEditor(selectedKeys)} style={actionBtn('var(--color-accent)')}>设为编码…</button>
          <button type="button" onClick={() => openEditor(selectedKeys)} style={actionBtn('var(--color-success)')}>恢复原码</button>
          <button type="button" onClick={() => setSelected(new Set())} style={actionBtn('var(--color-text-muted)')}>清除全部</button>
        </div>
      )}

      {/* 右键菜单（选中格子上右键：设为编码/恢复原码/清除选择） */}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            className="fixed z-50 rounded-lg overflow-hidden shadow-[var(--shadow-xl)]"
            style={{ left: ctxMenu.x, top: ctxMenu.y, minWidth: 150, background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <p className="px-4 pt-2 pb-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              已选 <b style={{ color: 'var(--color-text)' }}>{ctxMenu.keys.length}</b> 格
            </p>
            <button
              type="button"
              className="block w-full text-left px-4 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text)' }}
              onClick={() => {
                openEditor(ctxMenu.keys);
                setCtxMenu(null);
              }}
            >
              设为编码…
            </button>
            <button
              type="button"
              className="block w-full text-left px-4 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text)' }}
              onClick={() => {
                openEditor(ctxMenu.keys);
                setCtxMenu(null);
              }}
            >
              恢复原码
            </button>
            <button
              type="button"
              className="block w-full text-left px-4 py-2 text-sm hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-muted)' }}
              onClick={() => {
                setSelected(new Set());
                setCtxMenu(null);
              }}
            >
              清除选择
            </button>
          </div>
        </>
      )}

      {/* 编辑弹窗 */}
      {editor && (
        <CorrectionEditorModal
          editor={editor}
          cellsByPos={cellsByPos}
          swatches={swatches}
          validCodes={validCodeList}
          onClose={() => setEditor(null)}
          onConfirmSet={confirmSet}
          onConfirmRevert={confirmRevert}
        />
      )}
    </div>
  );
}

function controlStyle(): React.CSSProperties {
  return {
    height: 34,
    padding: '0 10px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-body)',
    fontSize: 'var(--text-sm)',
  };
}

function smallBtn(): React.CSSProperties {
  return {
    padding: '3px 10px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-md)',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
    transition: 'background 0.15s',
  };
}

function actionBtn(color: string, disabled = false): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    background: color,
    color: '#fff',
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
