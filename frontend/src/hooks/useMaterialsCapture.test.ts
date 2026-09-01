import { beforeEach, describe, expect, it } from 'vitest';
import { saveLastSelection } from '../lib/selectionMemory';
import { defaultBox, isGridFailure, normalizeMaterialCode, sortMaterials, toEntries } from './useMaterialsCapture';

describe('materials capture helpers', () => {
  beforeEach(() => localStorage.clear());

  it('uses the previous material rectangle when no current rectangle is supplied', () => {
    saveLastSelection('materials', { x: 100, y: 900, w: 700, h: 400 }, 1000, 2000);

    expect(defaultBox({ imageUrl: 'blob:test', imageW: 2000, imageH: 1000 })).toEqual({
      x: 200,
      y: 450,
      w: 1400,
      h: 200,
    });
  });

  it('normalizes codes for deduplication', () => {
    expect(normalizeMaterialCode('  a01 ')).toBe('A01');
    expect(normalizeMaterialCode(null)).toBe('');
  });

  it('sorts by grid position (row-major, row then col), manual entries last', () => {
    const sorted = sortMaterials([
      { code: 'B10', count: 1, confirmed: false, row: 1, col: 0 },
      { code: 'A10', count: 1, confirmed: false, row: 0, col: 2 },
      { code: 'A2', count: 1, confirmed: false, row: 0, col: 1 },
      { code: 'B2', count: 1, confirmed: false, row: 0, col: 0 },
      { code: 'A1', count: 1, confirmed: false },
    ]);

    expect(sorted.map((item) => item.code)).toEqual(['B2', 'A2', 'A10', 'B10', 'A1']);
  });

  it('only treats OCR failure statuses as retryable failures', () => {
    expect(isGridFailure(null)).toBe(false);
    expect(isGridFailure({ status: 'needs_confirmation' } as never)).toBe(false);
    expect(isGridFailure({ status: 'recognition_failed' } as never)).toBe(true);
    expect(isGridFailure({ status: 'model_unavailable' } as never)).toBe(true);
  });

  it('toEntries: 过滤无效条目（缺编码/数量不落库），排序且保留确认状态', () => {
    const entries = toEntries([
      { code: 'b2', count: 3, confirmed: true, row: 0, col: 1 },
      { code: 'A10', count: 12, confirmed: false, row: 0, col: 2 },
      { code: '', count: 5, confirmed: false }, // 缺编码 → 过滤
      { code: 'C1', count: 0, confirmed: false, row: 1, col: 0 }, // 数量 0 → 过滤
    ]);
    expect(entries.map((e) => e.code)).toEqual(['B2', 'A10']); // 自然序排序 + 过滤
    expect(entries[0].confirmed).toBe(true);
    expect(entries[0].status).toBe('accepted');
    expect(entries[1].count).toBe(12);
    expect(entries[1].status).toBe('needs_confirmation');
  });

  it('toEntries: 空清单返回空数组（自动保存不发请求）', () => {
    expect(toEntries([])).toEqual([]);
  });
});
