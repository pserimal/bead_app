import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useBlueprint } from '../hooks/useBlueprints';
import { updateBlueprintCells } from '../api/blueprints';
import { getColors } from '../api/colors';
import apiClient from '../api/client';
import { useToast } from '../components/ToastContext';
import { staggerContainer, staggerItem } from '../lib/animations';
import type { BlueprintCellDto, CellCorrectionUpdate, ColorDto, CropBoxDto } from '../types/api';

// 置信度档位：标记 conf < 档位的 MAPPED/BLANK 格（UNMAPPED 无条件进列表）
const THRESHOLDS = [0.9, 0.8, 0.7] as const;
const DEFAULT_THRESHOLD: (typeof THRESHOLDS)[number] = 0.9;
const PAGE_SIZE = 100;
const THUMB = 56;

/** 与 ocr_core.inference 相同的格子裁剪数学（含 10% 内缩跳过网格线） */
function cellCropRect(cropBox: CropBoxDto, rows: number, cols: number, row: number, col: number) {
  const cellW = cropBox.width / cols;
  const cellH = cropBox.height / rows;
  const ix = Math.max(1, Math.round(cellW * 0.1));
  const iy = Math.max(1, Math.round(cellH * 0.1));
  return {
    sx: cropBox.x + col * cellW + ix,
    sy: cropBox.y + row * cellH + iy,
    sw: Math.max(1, cellW - 2 * ix),
    sh: Math.max(1, cellH - 2 * iy),
  };
}

function normalizeHex(hex: string | null | undefined): string | null {
  const value = (hex ?? '').replace(/^#/, '').trim();
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null;
}

function CellThumb({
  cell,
  rows,
  cols,
  cropBox,
  image,
  checked,
  onToggle,
  onEdit,
}: {
  cell: BlueprintCellDto;
  rows: number;
  cols: number;
  cropBox: CropBoxDto | null;
  image: HTMLImageElement | null;
  checked: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!image || !cropBox) return;
    const canvas = document.createElement('canvas');
    canvas.width = THUMB;
    canvas.height = THUMB;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = cellCropRect(cropBox, rows, cols, cell.row, cell.col);
    try {
      ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, THUMB, THUMB);
    } catch {
      return;
    }
    setSrc(canvas.toDataURL('image/jpeg', 0.72));
  }, [image, cropBox, rows, cols, cell]);

  const corrected = cell.correctedCode != null;
  const confPct = cell.confidence != null ? Math.round(cell.confidence * 100) : null;

  return (
    <div className="flex flex-col items-center gap-0.5 select-none" title={`行 ${cell.row + 1} · 列 ${cell.col + 1} · 识别 ${cell.code}${corrected ? ` → 修正 ${cell.correctedCode}` : ''}`}>
      <div className="relative block cursor-pointer" onClick={onEdit} role="button" aria-label={`修改格子 ${cell.row + 1},${cell.col + 1}`}>
        <span
          className="block rounded border overflow-hidden"
          style={{
            width: THUMB,
            height: THUMB,
            borderColor: checked ? 'var(--color-accent)' : 'var(--color-border)',
            boxShadow: checked ? '0 0 0 2px var(--color-accent)' : undefined,
          }}
        >
          {src ? (
            <img src={src} alt="" width={THUMB} height={THUMB} className="block" draggable={false} />
          ) : (
            <span className="block" style={{ width: THUMB, height: THUMB, background: '#eee8de' }} />
          )}
        </span>
        {corrected && (
          <span
            className="absolute rounded-full text-white text-[9px] leading-none flex items-center justify-center"
            style={{ top: -3, right: -3, width: 15, height: 15, background: '#2f9e6e' }}
          >
            ✓
          </span>
        )}
        <span
          className="absolute left-0 bottom-0 px-0.5 text-[9px] leading-tight text-white rounded-tr"
          style={{ background: 'rgba(38,33,29,0.78)', fontFamily: 'var(--font-mono)' }}
        >
          {confPct != null ? `${confPct}%` : ''}
        </span>
        <label
          className="absolute flex items-center justify-center rounded cursor-pointer"
          style={{ top: -3, left: -3, width: 17, height: 17, background: checked ? 'var(--color-accent)' : 'rgba(255,255,255,0.9)', border: '1px solid var(--color-border)' }}
          title="勾选（可跨组批量）"
        >
          <input type="checkbox" className="sr-only" checked={checked} onChange={onToggle} aria-label={`勾选格子 ${cell.row + 1},${cell.col + 1}`} />
          {checked && <span className="text-white text-[10px] leading-none">✓</span>}
        </label>
      </div>
      <span className="text-[10px] leading-none" style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>
        {cell.row + 1}:{cell.col + 1}
      </span>
    </div>
  );
}

function useBreakdown(keys: readonly string[], cellsByPos: Map<string, BlueprintCellDto>) {
  return useMemo(() => {
    const map = new Map<string, number>();
    for (const key of keys) {
      const cell = cellsByPos.get(key);
      if (!cell) continue;
      const code = cell.correctedCode ?? cell.code;
      map.set(code, (map.get(code) ?? 0) + 1);
    }
    return [...map.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
  }, [keys, cellsByPos]);
}

function EditorModal({
  editor,
  cellsByPos,
  swatches,
  validCodes,
  onClose,
  onConfirmSet,
  onConfirmRevert,
}: {
  editor: { keys: string[] };
  cellsByPos: Map<string, BlueprintCellDto>;
  swatches: ColorDto[];
  validCodes: string[];
  onClose: () => void;
  onConfirmSet: (code: string) => void;
  onConfirmRevert: () => void;
}) {
  const [code, setCode] = useState('');
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const breakdown = useBreakdown(editor.keys, cellsByPos);

  const upper = code.trim().toUpperCase();
  const valid = validCodes.includes(upper) || upper === 'BLANK';
  const shownSwatches = filter
    ? swatches.filter((c) => c.code.includes(filter.toUpperCase()) || c.name.toLowerCase().includes(filter.toLowerCase()))
    : swatches;

  const handleSet = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onConfirmSet(upper);
    } finally {
      setBusy(false);
    }
  };

  const handleRevert = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirmRevert();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-30"
      style={{ background: 'rgba(38,33,29,0.45)' }}
      onClick={onClose}
    >
      <div
        className="rounded-2xl p-5 w-[min(560px,92vw)] max-h-[80vh] overflow-y-auto"
        style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-lg)' }}>
            修正 {editor.keys.length} 格
          </h2>
          <button type="button" onClick={onClose} style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-lg)' }}>×</button>
        </div>

        {breakdown.length > 0 && (
          <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
            当前识别：
            <span style={{ fontFamily: 'var(--font-mono)' }}>{breakdown.map((b) => `${b.code}×${b.count}`).join('、')}</span>
          </p>
        )}

        <div className="flex gap-2 mb-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="输入编码（如 A10），或从下方色板选择"
            autoFocus
            list="correction-codes"
            style={{
              ...controlStyle(),
              flex: 1,
              height: 38,
              borderColor: code && !valid ? 'var(--color-error)' : undefined,
            }}
            aria-label="修正编码"
          />
          <datalist id="correction-codes">
            {validCodes.map((c) => <option key={c} value={c} />)}
          </datalist>
          {code && !valid && (
            <span className="text-xs self-center" style={{ color: 'var(--color-error)', whiteSpace: 'nowrap' }}>
              编码不在颜色库
            </span>
          )}
        </div>

        <div className="flex gap-2 mb-3">
          <button type="button" onClick={handleSet} disabled={!valid || busy} style={actionBtn('#3D72D8', !valid || busy)}>
            设为 {valid ? upper : '…'}（{editor.keys.length} 格）
          </button>
          <button type="button" onClick={handleRevert} disabled={busy} style={actionBtn('#2f9e6e', busy)}>
            恢复原码
          </button>
          <button type="button" onClick={() => setCode('BLANK')} style={actionBtn('#8a8177')}>空白格 BLANK</button>
        </div>

        <div className="flex gap-2 items-center mb-2">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>色板</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按编码或名称筛选"
            style={{ ...controlStyle(), height: 30, flex: 1 }}
            aria-label="筛选色板"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {shownSwatches.map((c) => (
            <button
              key={c.code}
              type="button"
              title={`${c.code} · ${c.name}`}
              onClick={() => setCode(c.code)}
              style={{
                width: 26,
                height: 26,
                borderRadius: 6,
                background: normalizeHex(c.hex) ?? '#eee',
                border: upper === c.code ? '2px solid var(--color-accent)' : '1px solid rgba(0,0,0,0.12)',
                cursor: 'pointer',
              }}
              aria-label={c.code}
            />
          ))}
          {shownSwatches.length === 0 && (
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>没有匹配的颜色</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CorrectionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: blueprint, isLoading, error } = useBlueprint(id ?? null);

  const [threshold, setThreshold] = useState<(typeof THRESHOLDS)[number]>(DEFAULT_THRESHOLD);
  const [mode, setMode] = useState<'review' | 'all'>('review');
  const [onlyUnfixed, setOnlyUnfixed] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ keys: string[] } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [pageOf, setPageOf] = useState<Record<string, number>>({});

  // 原图加载一次（校正页所有缩略图共用）
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!cancelled) setImage(img);
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
    return blueprint.cells.filter(
      (c) => c.status === 'UNMAPPED' || (c.confidence != null && c.confidence < threshold),
    );
  }, [blueprint, threshold]);

  const visibleCells = useMemo(() => {
    if (!blueprint) return [];
    let list = mode === 'review' ? reviewCells : blueprint.cells;
    if (mode === 'all' && search.trim()) {
      const q = search.trim().toUpperCase();
      list = list.filter((c) => {
        const coord = `${c.row + 1}:${c.col + 1}`;
        return coord.includes(q) || c.code.includes(q) || (c.correctedCode ?? '').includes(q);
      });
    }
    if (onlyUnfixed) list = list.filter((c) => c.correctedCode == null);
    return list;
  }, [blueprint, mode, reviewCells, search, onlyUnfixed]);

  // 分组：按当前识别码（cell.code 原始码），组内按 row,col 排序
  const groups = useMemo(() => {
    const map = new Map<string, BlueprintCellDto[]>();
    for (const cell of visibleCells) {
      const list = map.get(cell.code) ?? [];
      list.push(cell);
      map.set(cell.code, list);
    }
    return [...map.entries()]
      .map(([code, cells]) => ({ code, cells: cells.sort((a, b) => a.row - b.row || a.col - b.col) }))
      .sort((a, b) => b.cells.length - a.cells.length);
  }, [visibleCells]);

  const selectedKeys = useMemo(() => [...selected], [selected]);
  const selectedBreakdown = useBreakdown(selectedKeys, cellsByPos);

  const toggleCell = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((code: string) => {
    setSelected((prev) => {
      const group = groups.find((g) => g.code === code);
      if (!group) return prev;
      const next = new Set(prev);
      const allSelected = group.cells.every((c) => next.has(`${c.row}:${c.col}`));
      for (const c of group.cells) {
        const key = `${c.row}:${c.col}`;
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }, [groups]);

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
    <div className="max-w-6xl mx-auto">
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
            style={{ ...controlStyle(), fontWeight: 600, color: '#fff', background: correctedCount > 0 ? '#2f9e6e' : undefined, borderColor: correctedCount > 0 ? '#2f9e6e' : undefined, opacity: correctedCount === 0 ? 0.45 : 1, cursor: correctedCount === 0 ? 'not-allowed' : 'pointer' }}
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

          <label className="flex items-center gap-1.5 text-sm cursor-pointer" style={{ color: 'var(--color-text)' }}>
            <input type="checkbox" checked={onlyUnfixed} onChange={(e) => setOnlyUnfixed(e.target.checked)} />
            仅看未修正
          </label>

          {mode === 'all' && (
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜坐标 1:23 或编码 A10"
              style={{ ...controlStyle(), minWidth: 180 }}
              aria-label="搜索格子"
            />
          )}

          {unmappedCount > 0 && (
            <span className="text-xs px-2 py-1 rounded" style={{ background: '#FDF4EA', color: '#D4802B' }}>
              ⚠ {unmappedCount} 格颜色库外（已全部列入待复核）
            </span>
          )}
        </motion.div>

        {groups.length === 0 && (
          <motion.p variants={staggerItem} style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-sm)' }}>
            {mode === 'review' ? '没有需要复核的格子 🎉' : '没有匹配的格子'}
          </motion.p>
        )}

        <div className="space-y-4">
          {groups.map((group) => {
            const page = pageOf[group.code] ?? 0;
            const pageCells = group.cells.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
            const totalPages = Math.max(1, Math.ceil(group.cells.length / PAGE_SIZE));
            const groupAllSelected = group.cells.every((c) => selected.has(`${c.row}:${c.col}`));
            const correctedInGroup = group.cells.filter((c) => c.correctedCode != null).length;
            return (
              <motion.div
                key={group.code}
                variants={staggerItem}
                className="rounded-xl p-3"
                style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)' }}
              >
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  <span
                    className="inline-block w-4 h-4 rounded"
                    style={{ background: normalizeHex(group.cells[0]?.color?.hex) ?? '#e6e0d7' }}
                  />
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 'var(--text-sm)' }}>
                    {group.code}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {group.cells.length} 格{correctedInGroup > 0 ? ` · 已修正 ${correctedInGroup}` : ''}
                  </span>
                  <label className="flex items-center gap-1 text-xs cursor-pointer" style={{ color: 'var(--color-text-muted)' }}>
                    <input type="checkbox" checked={groupAllSelected} onChange={() => toggleGroup(group.code)} />
                    全选
                  </label>
                  <div className="ml-auto flex items-center gap-1">
                    <button type="button" onClick={() => openEditor(group.cells.map((c) => `${c.row}:${c.col}`))} style={smallBtn()}>
                      整组设为…
                    </button>
                    {totalPages > 1 && (
                      <span className="text-xs flex items-center gap-1" style={{ color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>
                        {page + 1}/{totalPages}
                        <button type="button" disabled={page === 0} onClick={() => setPageOf((p) => ({ ...p, [group.code]: page - 1 }))} style={smallBtn()}>‹</button>
                        <button type="button" disabled={page >= totalPages - 1} onClick={() => setPageOf((p) => ({ ...p, [group.code]: page + 1 }))} style={smallBtn()}>›</button>
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {pageCells.map((cell) => (
                    <CellThumb
                      key={`${cell.row}:${cell.col}`}
                      cell={cell}
                      rows={blueprint.rows}
                      cols={blueprint.cols}
                      cropBox={blueprint.cropBox}
                      image={image}
                      checked={selected.has(`${cell.row}:${cell.col}`)}
                      onToggle={() => toggleCell(`${cell.row}:${cell.col}`)}
                      onEdit={() => openEditor([`${cell.row}:${cell.col}`])}
                    />
                  ))}
                </div>
              </motion.div>
            );
          })}
        </div>
      </motion.div>

      {/* 底部操作条 */}
      {selectedCount > 0 && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-xl shadow-lg"
          style={{ background: 'rgba(38,33,29,0.94)', color: '#fffaf0', zIndex: 20 }}
        >
          <span className="text-sm">已选 <b>{selectedCount}</b> 格</span>
          {selectedBreakdown.length > 0 && (
            <span className="text-xs opacity-80 hidden sm:inline" style={{ fontFamily: 'var(--font-mono)' }}>
              {selectedBreakdown.slice(0, 3).map((b) => `${b.code}×${b.count}`).join(' ')}
            </span>
          )}
          <button type="button" onClick={() => openEditor(selectedKeys)} style={actionBtn('#3D72D8')}>设为编码…</button>
          <button type="button" onClick={() => openEditor(selectedKeys)} style={actionBtn('#2f9e6e')}>恢复原码</button>
        </div>
      )}

      {/* 编辑弹窗 */}
      {editor && (
        <EditorModal
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
    borderRadius: 8,
    background: 'var(--color-card)',
    color: 'var(--color-text)',
    fontFamily: 'var(--font-body)',
    fontSize: 'var(--text-sm)',
  };
}

function smallBtn(): React.CSSProperties {
  return {
    padding: '2px 8px',
    border: '1px solid var(--color-border)',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--color-text-muted)',
    fontSize: 'var(--text-xs)',
    cursor: 'pointer',
  };
}

function actionBtn(color: string, disabled = false): React.CSSProperties {
  return {
    padding: '8px 16px',
    borderRadius: 8,
    border: 'none',
    background: color,
    color: '#fff',
    fontSize: 'var(--text-sm)',
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
