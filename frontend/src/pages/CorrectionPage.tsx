import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useBlueprint } from '../hooks/useBlueprints';
import { updateBlueprintCells } from '../api/blueprints';
import { getColors } from '../api/colors';
import { getBlueprintLegend } from '../api/materials';
import apiClient from '../api/client';
import { useToast } from '../components/ToastContext';
import Button from '../components/Button';
import { staggerContainer, staggerItem } from '../lib/animations';
import CellThumb from '../components/CellThumb';
import CorrectionEditorModal from '../components/CorrectionEditorModal';
import {
  buildAllCodeCounts,
  buildCodeList,
  computeBreakdown,
  computeVisibleCells,
  legendDiff,
  naturalCompare,
  normalizeHex,
  rangeKeys,
  toggleKeys,
} from '../lib/correctionModel';
import type { BlueprintCellDto, CellCorrectionUpdate, ColorDto } from '../types/api';

/** 与 ocr_core.inference 相同的格子裁剪数学（含 10% 内缩跳过网格线） */
export default function CorrectionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: blueprint, isLoading, error } = useBlueprint(id ?? null);

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

  // 物料清单（实时）：作为各编码「期望数量」基准，校正后编码条数字/颜色即时更新
  const { data: legendEntries } = useQuery({
    queryKey: ['legend', id],
    queryFn: () => getBlueprintLegend(id!),
    enabled: !!id,
  });
  const hasLegend = (legendEntries?.length ?? 0) > 0;

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

  // 缩略图绘制源：cropBox 区域缩到 ≤3000px 宽的离屏 canvas（大原图逐格 drawImage 裁剪缩放是移动端滚动卡顿主因）。
  // 原图已够小（cropBox ≤3000）则直接用原图，零开销。
  const drawSource = useMemo(() => {
    if (!image || !blueprint?.cropBox) return null;
    const cb = blueprint.cropBox;
    const MAX_W = 3000;
    const scale = Math.min(1, MAX_W / cb.width);
    if (scale >= 1) {
      return { source: image as CanvasImageSource, cropBox: cb };
    }
    const w = Math.max(1, Math.round(cb.width * scale));
    const h = Math.max(1, Math.round(cb.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(image, cb.x, cb.y, cb.width, cb.height, 0, 0, w, h);
    return { source: canvas, cropBox: { x: 0, y: 0, width: w, height: h } };
  }, [image, blueprint]);

  const cellsByPos = useMemo(() => {
    const map = new Map<string, BlueprintCellDto>();
    if (blueprint) for (const cell of blueprint.cells) map.set(`${cell.row}:${cell.col}`, cell);
    return map;
  }, [blueprint]);

  // 全量编码计数：搜索/筛选只影响左栏列表内容，对比数值始终基于全部格子的有效码
  const allCodeCounts = useMemo(() => {
    if (!blueprint) return new Map<string, number>();
    return buildAllCodeCounts(blueprint.cells);
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

  // 物料清单对比：库外码标记用全量颜色表
  const knownCodes = useMemo(
    () => new Set((allColors ?? []).map((c) => c.code.toUpperCase())),
    [allColors],
  );

  // 各编码的期望数量（实时，来自物料清单；同码多条合并求和）。
  // 空白格期望 = 棋盘总格数 − 清单非空白码数量之和（清单未覆盖的部分视为空）。
  const expectedByCode = useMemo(() => {
    const map = new Map<string, number>();
    if (!hasLegend || !blueprint) return map;
    let nonBlankTotal = 0;
    for (const e of legendEntries ?? []) {
      const code = e.code.trim().toUpperCase();
      if (!code || code === 'BLANK') continue;
      map.set(code, (map.get(code) ?? 0) + e.count);
      nonBlankTotal += e.count;
    }
    map.set('BLANK', Math.max(0, blueprint.rows * blueprint.cols - nonBlankTotal));
    return map;
  }, [hasLegend, blueprint, legendEntries]);

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
      // if/else 链全覆盖，直接 const 三元（消除冗余初始赋值）
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return h * 60;
    };
    return [...list].sort((a, b) => hue(a.hex) - hue(b.hex));
  }, [validCodeList, colorsByCode]);

  const visibleCells = useMemo(() => {
    if (!blueprint) return [];
    return computeVisibleCells(blueprint.cells, search, fixFilter);
  }, [blueprint, search, fixFilter]);

  // 左栏编码列表：全部格子 + 清单独有码（双向对比完整：图纸有清单无 → A1 20(-20)；清单有图纸无 → C11 0(+8)）。
  // 搜索只收窄列表与右栏格子，对比数值始终基于全部格子
  const codeList = useMemo(() => {
    const list = buildCodeList(blueprint?.cells ?? []);
    if (hasLegend) {
      const existing = new Set(list.map((l) => l.code));
      for (const code of expectedByCode.keys()) {
        if (code !== 'BLANK' && !existing.has(code)) list.push({ code, count: 0 });
      }
      list.sort((a, b) => naturalCompare(a.code, b.code));
    }
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      const visibleCodes = new Set(visibleCells.map((c) => c.correctedCode ?? c.code));
      return list.filter((l) => visibleCodes.has(l.code) || l.code.includes(q));
    }
    return list;
  }, [blueprint, hasLegend, expectedByCode, visibleCells, search]);
  // 默认选中第一个「当前列表中有格子」的码（避免默认落在 0 格的空面板上）
  const firstVisibleCode = useMemo(() => {
    if (!blueprint) return null;
    return codeList[0]?.code ?? null;
  }, [blueprint, codeList]);
  const activeCode = selectedCode != null && codeList.some((l) => l.code === selectedCode)
    ? selectedCode
    : firstVisibleCode;
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
  // 双向窗口化：只渲染视口内 ±2 屏的格子，滚出视口即卸载（深翻页不堆积 DOM，移动端流畅）
  // 固定网格列宽（CellThumb 56px + gap 8px，见 gridCols），行高按 CellThumb 实际高度 + gap 估算，略保守（多渲染不遗漏）
  const CELL_H = 96;
  const WINDOW_BUFFER_SCREENS = 2;
  const [viewport, setViewport] = useState({ w: 0, h: 0, scrollTop: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  // 容器尺寸变化（含初始）→ 重算窗口。注意：组件首渲染可能处于 isLoading early-return（容器未挂载），
  // 故依赖 isLoading——蓝图加载完成后容器出现，重新挂上 ResizeObserver
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => {
      setViewport((v) => (v.w === el.clientWidth && v.h === el.clientHeight ? v : { ...v, w: el.clientWidth, h: el.clientHeight }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isLoading]);
  // 滚动 → 100ms 节流更新窗口（滚动中不每帧重渲染 React 窗口；2 屏缓冲保证窗口跟随无感知滞后）
  const lastScrollUpdateRef = useRef(0);
  const onRightScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const now = performance.now();
    if (now - lastScrollUpdateRef.current < 100) return;
    lastScrollUpdateRef.current = now;
    setViewport((v) => (v.scrollTop === el.scrollTop ? v : { ...v, scrollTop: el.scrollTop }));
  }, []);
  // 切组：滚动位置归零。viewport 的 scrollTop 由程序化 scrollTop=0 触发的 scroll 事件自然更新
  // （lastScrollUpdateRef 归零 → 100ms 节流立即放行），无需在 effect 里 setState
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    lastScrollUpdateRef.current = 0;
  }, [activeCode]);
  // 窗口内格子：按网格行列计算可见区间（含上下各 2 屏缓冲）
  const renderedCells = useMemo(() => {
    const total = codeCells.length;
    if (total === 0) return [];
    const cols = gridCols(viewport.w);
    const startRow = Math.max(0, Math.floor(viewport.scrollTop / CELL_H) - WINDOW_BUFFER_SCREENS);
    const rows = Math.ceil(viewport.h / CELL_H) + 2 * WINDOW_BUFFER_SCREENS + 1;
    const start = Math.min(total, startRow * cols);
    const end = Math.min(total, start + rows * cols);
    return codeCells.slice(start, end);
  }, [codeCells, viewport]);
  // 全量行数（滚动条占位高度用）
  const totalRows = useMemo(() => {
    if (codeCells.length === 0) return 0;
    return Math.ceil(codeCells.length / gridCols(viewport.w));
  }, [codeCells, viewport.w]);
  // 窗口起始行（translateY 定位）
  const windowStartRow = useMemo(() => {
    const firstKey = renderedCells[0];
    if (!firstKey) return 0;
    const idx = codeCells.indexOf(firstKey);
    return idx < 0 ? 0 : Math.floor(idx / gridCols(viewport.w));
  }, [renderedCells, codeCells, viewport.w]);

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
  // 单格入口（CellThumb onEdit）：稳定引用，保证 memo 生效
  const openEditorForCell = useCallback((key: string) => openEditor([key]), [openEditor]);

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

  const exportAllCells = useCallback(async () => {
    if (!id) return;
    try {
      const res = await apiClient.get(`/blueprints/${id}/cells/export-all`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cells-all-${id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('已导出全部单元格 zip（格式同校正数据；BLANK 空位已跳过）', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }, [id, toast]);

  if (isLoading) return <p style={{ color: 'var(--color-text-muted)' }}>加载中…</p>;
  if (error) return <p style={{ color: 'var(--color-error)' }}>加载失败：{(error as Error).message}</p>;
  if (!blueprint) return null;

  const unmappedCount = blueprint.cells.filter((c) => c.status === 'UNMAPPED').length;
  const correctedCount = blueprint.cells.filter((c) => c.correctedCode != null).length;
  // 可导出的内容格 = 非 BLANK 状态（BLANK 空位在服务端导出时跳过）
  const contentCellCount = blueprint.cells.filter((c) => c.status !== 'BLANK').length;
  const selectedCount = selected.size;

  return (
    <div className="max-w-6xl mx-auto px-4 lg:px-6">
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-3">
        <motion.div variants={staggerItem} className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-2 sm:gap-3">
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 700, lineHeight: 1.2 }}>图纸校正</h1>
            <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', marginTop: 2 }}>
              {blueprint.rows} × {blueprint.cols} · {blueprint.cells.length.toLocaleString()} 格
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" className="!border !border-[var(--color-border-strong)]" onClick={() => navigate(`/blueprints/${id}`)}>← 返回详情</Button>
            <Button variant="secondary" size="sm" onClick={() => navigate(`/materials?blueprint=${id}`)} title="重新框选/识别并按需修改物料清单（复用物料清单录入界面），保存后回到此处对比">修改物料清单</Button>
            <Button
              variant="secondary"
              size="sm"
              className="!border !border-[var(--color-border-strong)]"
              onClick={exportAllCells}
              title="导出全部单元格（含未修正格，用当前识别码；BLANK 空位跳过）。zip 格式与导出校正数据一致"
            >
              导出全部数据（{contentCellCount.toLocaleString()}）
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={exportCorrections}
              disabled={correctedCount === 0}
              className={correctedCount > 0 ? '!bg-[var(--color-success)]' : ''}
              title="导出全部已校正格子（zip：manifest.csv + 格子裁剪图），供模型训练"
            >
              导出校正数据{correctedCount > 0 ? `（${correctedCount}）` : ''}
            </Button>
          </div>
        </motion.div>

        <motion.div variants={staggerItem} className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="按修正状态筛选" className="flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-border)', height: 32 }}>
            {([['all', '全部'], ['unfixed', '仅未修正'], ['fixed', '仅已修正']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={fixFilter === value}
                onClick={() => setFixFilter(value)}
                style={{
                  padding: '0 12px',
                  fontSize: 'var(--text-xs)',
                  background: fixFilter === value ? 'var(--color-accent)' : 'transparent',
                  color: fixFilter === value ? '#fff' : 'var(--color-text)',
                  cursor: 'pointer',
                  fontWeight: fixFilter === value ? 600 : 400,
                  whiteSpace: 'nowrap',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜坐标 1:23 或编码 A10"
            style={{ minWidth: 160, flex: '1 1 160px', maxWidth: 320, height: 32, padding: '0 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-surface)', color: 'var(--color-text)', fontFamily: 'var(--font-body)', fontSize: 'var(--text-sm)' }}
            aria-label="搜索格子"
          />

          {imageError && (
            <motion.p variants={staggerItem} className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--color-error-light)', border: '1px solid var(--color-error)', color: 'var(--color-error)' }}>
              ⚠ 原图加载失败（文件可能已被清理），缩略图无法显示，但修正功能不受影响
            </motion.p>
          )}

          {unmappedCount > 0 && (
            <span className="text-xs px-2 py-1 rounded" style={{ background: 'var(--color-warning-light)', color: 'var(--color-warning)' }}>
              ⚠ {unmappedCount} 格颜色库外
            </span>
          )}
        </motion.div>

        {codeList.length === 0 && (
          <motion.div variants={staggerItem} className="py-12 text-center" style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            没有匹配的格子
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
                  {codeList.map(({ code }) => {
                    const selected = activeCode === code;
                    const label = code === 'BLANK' ? '空白' : code;
                    // 实时差异：实际数（全部格子，非当前可见子集） vs 期望数（物料清单；空白由棋盘大小推算）
                    const actualCount = allCodeCounts.get(code) ?? 0;
                    const expected = hasLegend ? (expectedByCode.get(code) ?? 0) : undefined; // 清单没有的码 → 期望 0，照样显示差异
                    const diff = legendDiff(expected, actualCount);
                    const unknown = code !== 'BLANK' && !knownCodes.has(code);
                    const diffText = diff == null || diff === 0 ? null : `(${diff > 0 ? '+' : ''}${diff})`;
                    const diffColor = diff == null || diff === 0
                      ? undefined
                      : diff > 0 ? 'var(--color-error)' : 'var(--color-warning)';
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
                        title={diffText ? `${label} 实际 ${actualCount}，期望 ${expected}（${diff! > 0 ? '少' : '多'} ${Math.abs(diff!)}）` : (unknown ? '颜色库外编码' : undefined)}
                      >
                        <span className="truncate" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: selected ? 700 : 500, color: !selected && unknown ? 'var(--color-text-muted)' : undefined }}>
                          {label}
                        </span>
                        <span
                          className="rounded-full px-1.5 text-[10px] leading-4 shrink-0"
                          style={{
                            background: selected ? 'rgba(255,255,255,0.22)' : 'var(--color-bg-secondary)',
                            color: selected
                              ? '#fff'
                              : diffColor ?? 'var(--color-text-muted)',
                            fontWeight: diffText ? 700 : 400,
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {actualCount}{diffText}
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
                  {codeCells.length === 0 && activeCode != null && (
                    <span className="text-xs hidden sm:inline" style={{ color: 'var(--color-text-muted)' }}>
                      {(() => {
                        const boardCount = allCodeCounts.get(activeCode) ?? 0;
                        const want = expectedByCode.get(activeCode);
                        if (search.trim()) return '无匹配';
                        if (boardCount === 0 && want != null && want > 0) return `清单需要 ${want} 个，图纸中未找到`;
                        return '无匹配';
                      })()}
                    </span>
                  )}
                  <Button
                    type="button"
                    onClick={toggleCodeAll}
                    disabled={codeCells.length === 0}
                    variant="ghost"
                    size="sm"
                  >
                    {codeCells.length > 0 && codeCells.every((c) => selected.has(`${c.row}:${c.col}`)) ? '取消全选' : '全选'}
                  </Button>
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Shift+点击：连选/取下当前编码格子</span>
                </div>
                <div ref={listRef} className="max-h-[calc(70vh-53px)] overflow-y-auto p-3" style={{ scrollbarWidth: 'thin' }} onScroll={onRightScroll}>
                  {/* 占位高度 = 全量行数（保持滚动条长度与完整列表一致）；窗口行 translateY 定位到起始行 */}
                  <div style={{ height: Math.max(0, totalRows * CELL_H - 8) }}>
                    <div className="flex flex-wrap gap-2" style={{ transform: `translateY(${windowStartRow * CELL_H}px)` }}>
                      {renderedCells.map((cell) => (
                        <CellThumb
                          key={`${cell.row}:${cell.col}`}
                          cell={cell}
                          rows={blueprint.rows}
                          cols={blueprint.cols}
                          cropBox={drawSource?.cropBox ?? blueprint.cropBox}
                          image={drawSource?.source ?? image}
                          checked={selected.has(`${cell.row}:${cell.col}`)}
                          onToggle={toggleCell}
                          onShiftToggle={shiftSelect}
                          onContextMenu={handleCellContextMenu}
                          onEdit={openEditorForCell}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
        </div>
      </motion.div>

      {/* 底部操作条（surface 卡片，与全局一致） */}
      {selectedCount > 0 && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 sm:gap-3 px-3 sm:px-4 py-2.5 rounded-xl z-20 max-w-[calc(100vw-1.5rem)]"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-lg)' }}
        >
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>已选 <b>{selectedCount}</b> 格</span>
          {selectedBreakdown.length > 0 && (
            <span className="text-xs hidden sm:inline" style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
              {selectedBreakdown.slice(0, 3).map((b) => `${b.code}×${b.count}`).join(' ')}
            </span>
          )}
          <Button type="button" onClick={() => openEditor(selectedKeys)}>设为编码…</Button>
          <Button type="button" variant="danger" onClick={() => openEditor(selectedKeys)}>恢复原码</Button>
          <Button type="button" variant="ghost" onClick={() => setSelected(new Set())}>清除全部</Button>
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

/** 右栏网格每行格数：与 flex-wrap 实际排布一致（容器 clientWidth，p-3=12px×2 padding，56px 格 + 8px gap） */
function gridCols(containerWidth: number): number {
  return Math.max(1, Math.floor((containerWidth - 16) / 64));
}
