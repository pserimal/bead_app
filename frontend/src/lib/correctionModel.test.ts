import { describe, expect, it } from 'vitest';
import {
  buildCodeList,
  computeBreakdown,
  computeReviewCells,
  computeVisibleCells,
  effectiveCode,
  naturalCompare,
} from './correctionModel';
import type { BlueprintCellDto } from '../types/api';

function cell(row: number, col: number, code: string, conf: number | null = 1, status: BlueprintCellDto['status'] = 'MAPPED', correctedCode: string | null = null): BlueprintCellDto {
  return { row, col, code, status, color: null, confidence: conf, correctedCode, correctedAt: correctedCode ? '2026-08-09T00:00:00Z' : null };
}

describe('correctionModel 纯逻辑', () => {
  it('effectiveCode：修正优先，否则识别码', () => {
    expect(effectiveCode(cell(0, 0, 'T3', 1, 'MAPPED', 'T1'))).toBe('T1');
    expect(effectiveCode(cell(0, 0, 'T3'))).toBe('T3');
    expect(effectiveCode(cell(0, 0, 'BLANK', null, 'BLANK'))).toBe('BLANK');
  });

  it('naturalCompare：A2 < A10，空白最后', () => {
    expect(naturalCompare('A2', 'A10')).toBeLessThan(0);
    expect(naturalCompare('A10', 'A2')).toBeGreaterThan(0);
    expect(naturalCompare('A12', 'A3')).toBeGreaterThan(0);
    expect(naturalCompare('BLANK', 'A1')).toBeGreaterThan(0);
    expect(naturalCompare('A1', 'BLANK')).toBeLessThan(0);
    expect(naturalCompare('BLANK', 'BLANK')).toBe(0);
  });

  it('computeReviewCells：UNMAPPED 无条件进入，MAPPED 按置信度', () => {
    const cells = [
      cell(0, 0, 'A1', 0.95),
      cell(0, 1, 'A2', 0.8),
      cell(0, 2, 'X9', 0.99, 'UNMAPPED'),
      cell(0, 3, 'BLANK', 0.5, 'BLANK'),
    ];
    const review = computeReviewCells(cells, 0.9);
    expect(review.map((c) => c.code).sort()).toEqual(['A2', 'BLANK', 'X9']);
  });

  it('computeVisibleCells：搜索（坐标/编码/修正码）+ 三态筛选', () => {
    const cells = [
      cell(0, 0, 'T3', 1, 'MAPPED', 'T1'),
      cell(5, 22, 'T2', 0.8),
      cell(1, 2, 'T3', 0.9),
    ];
    // 全部 + 搜索坐标（1-based：row 5 → 6, col 22 → 23）
    expect(computeVisibleCells(cells, [], 'all', '6:23', 'all').map((c) => c.code)).toEqual(['T2']);
    // 全部 + 搜索修正码 T1
    expect(computeVisibleCells(cells, [], 'all', 'T1', 'all').map((c) => c.code)).toEqual(['T3']);
    // 全部 + 仅已修正
    expect(computeVisibleCells(cells, [], 'all', '', 'fixed').map((c) => c.code)).toEqual(['T3']);
    // 全部 + 仅未修正
    expect(computeVisibleCells(cells, [], 'all', '', 'unfixed').map((c) => c.code)).toEqual(['T2', 'T3']);
  });

  it('buildCodeList：按有效码分组、自然序、空白最后', () => {
    const cells = [
      cell(0, 0, 'A10'),
      cell(0, 1, 'A2'),
      cell(0, 2, 'A2'),
      cell(0, 3, 'BLANK', null, 'BLANK'),
      cell(0, 4, 'T3', 1, 'MAPPED', 'A2'),
    ];
    const list = buildCodeList(cells);
    expect(list).toEqual([
      { code: 'A2', count: 3 },
      { code: 'A10', count: 1 },
      { code: 'BLANK', count: 1 },
    ]);
  });

  it('computeBreakdown：多选格编码构成（修正归入新组）', () => {
    const map = new Map<string, BlueprintCellDto>([
      ['0:0', cell(0, 0, 'T3', 1, 'MAPPED', 'T1')],
      ['0:1', cell(0, 1, 'T2')],
      ['0:2', cell(0, 2, 'T1')],
    ]);
    const breakdown = computeBreakdown(['0:0', '0:1', '0:2'], map);
    expect(breakdown).toEqual([
      { code: 'T1', count: 2 },
      { code: 'T2', count: 1 },
    ]);
  });
});
