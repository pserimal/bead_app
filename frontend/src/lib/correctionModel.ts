import type { BlueprintCellDto, CropBoxDto } from '../types/api';

/** hex 规范化：接受带/不带 #，返回 #rrggbb 或 null */
export function normalizeHex(hex: string | null | undefined): string | null {
  const value = (hex ?? '').replace(/^#/, '').trim();
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null;
}

/**
 * 校正页纯逻辑（无 React/UI 依赖，可直接单测）。
 * 曾出过 bug 的地方（归组/自然序/置信度筛选）都在这。
 */

/** 有效码：修正优先，否则识别码（BLANK 保持原值） */
export function effectiveCode(cell: BlueprintCellDto): string {
  return cell.correctedCode ?? cell.code;
}

/** 与 ocr_core.inference 相同的格子裁剪数学（含 10% 内缩跳过网格线） */
export function cellCropRect(cropBox: CropBoxDto, rows: number, cols: number, row: number, col: number) {
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

/** 自然序：A2 < A10；BLANK（空白）固定排最后 */
export function naturalCompare(a: string, b: string): number {
  if (a === 'BLANK' && b === 'BLANK') return 0;
  if (a === 'BLANK') return 1;
  if (b === 'BLANK') return -1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** 可见格：搜索（坐标/编码）+ 三态修正筛选（全部/仅未修正/仅已修正） */
export function computeVisibleCells(
  allCells: BlueprintCellDto[],
  search: string,
  fixFilter: 'all' | 'unfixed' | 'fixed',
): BlueprintCellDto[] {
  let list = allCells;
  if (search.trim()) {
    const q = search.trim().toUpperCase();
    list = list.filter((c) => {
      const coord = `${c.row + 1}:${c.col + 1}`;
      return coord.includes(q) || c.code.includes(q) || (c.correctedCode ?? '').includes(q);
    });
  }
  if (fixFilter === 'unfixed') list = list.filter((c) => c.correctedCode == null);
  if (fixFilter === 'fixed') list = list.filter((c) => c.correctedCode != null);
  return list;
}

/** 全量编码计数：按有效码统计全部格子（对比结果显示始终基于全量格子，而非当前筛选子集） */
export function buildAllCodeCounts(cells: BlueprintCellDto[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const cell of cells) {
    const eff = effectiveCode(cell);
    map.set(eff, (map.get(eff) ?? 0) + 1);
  }
  return map;
}

/** 左栏编码列表：按有效码分组 + 自然序（空白排最后） */
export function buildCodeList(cells: BlueprintCellDto[]): { code: string; count: number }[] {
  return [...buildAllCodeCounts(cells).entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => naturalCompare(a.code, b.code));
}

/**
 * 清单-图纸差异：期望 − 实际（全量格子计数）。
 * 正 = 图纸缺（清单有而图纸少）；负 = 图纸多（清单没有/次数更少，如 A1 实际 20 → −20）。
 * expected 为 null/undefined（未启用清单）→ 返回 null（不显示差异）。
 */
export function legendDiff(expected: number | null | undefined, actual: number): number | null {
  return expected == null ? null : expected - actual;
}

/** 多选格的编码构成（批量操作条展示：最多前 3 组） */
export function computeBreakdown(
  keys: readonly string[],
  cellsByPos: Map<string, BlueprintCellDto>,
): { code: string; count: number }[] {
  const map = new Map<string, number>();
  for (const key of keys) {
    const cell = cellsByPos.get(key);
    if (!cell) continue;
    const code = effectiveCode(cell);
    map.set(code, (map.get(code) ?? 0) + 1);
  }
  return [...map.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
}

/**
 * Shift 连选：返回当前编码组列表（codeCells 顺序）中锚点 → 目标之间的连续 key 列表（含两端）。
 * 锚点缺失或不在当前组（跨组）→ 返回 null（调用方应重置锚点、仅选目标格）。
 */
export function rangeKeys(
  list: { row: number; col: number }[],
  anchorKey: string | null,
  targetKey: string,
): string[] | null {
  const targetIdx = list.findIndex((c) => `${c.row}:${c.col}` === targetKey);
  if (targetIdx < 0) return null;
  const anchorIdx = anchorKey == null ? -1 : list.findIndex((c) => `${c.row}:${c.col}` === anchorKey);
  if (anchorIdx < 0) return null;
  const lo = Math.min(anchorIdx, targetIdx);
  const hi = Math.max(anchorIdx, targetIdx);
  return list.slice(lo, hi + 1).map((c) => `${c.row}:${c.col}`);
}

/** 对一组 key 整体 toggle：全部已选 → 移除（取下）；否则 → 加入 */
export function toggleKeys(prev: ReadonlySet<string>, keys: readonly string[]): Set<string> {
  const next = new Set(prev);
  if (keys.every((k) => next.has(k))) {
    for (const k of keys) next.delete(k);
  } else {
    for (const k of keys) next.add(k);
  }
  return next;
}
