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

/** 待复核：UNMAPPED 无条件进列表，其余 conf < threshold */
export function computeReviewCells(cells: BlueprintCellDto[], threshold: number): BlueprintCellDto[] {
  return cells.filter((c) => c.status === 'UNMAPPED' || (c.confidence != null && c.confidence < threshold));
}

/** 可见格：模式（待复核/全部）+ 搜索（坐标/编码/修正码）+ 三态修正筛选 */
export function computeVisibleCells(
  allCells: BlueprintCellDto[],
  reviewCells: BlueprintCellDto[],
  mode: 'review' | 'all',
  search: string,
  fixFilter: 'all' | 'unfixed' | 'fixed',
): BlueprintCellDto[] {
  let list = mode === 'review' ? reviewCells : allCells;
  if (mode === 'all' && search.trim()) {
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

/** 左栏编码列表：按有效码分组 + 自然序（空白排最后） */
export function buildCodeList(cells: BlueprintCellDto[]): { code: string; count: number }[] {
  const map = new Map<string, number>();
  for (const cell of cells) {
    const eff = effectiveCode(cell);
    map.set(eff, (map.get(eff) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => naturalCompare(a.code, b.code));
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
