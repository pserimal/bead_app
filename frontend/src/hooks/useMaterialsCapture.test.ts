import { beforeEach, describe, expect, it } from 'vitest';
import { saveLastSelection } from '../lib/selectionMemory';
import { defaultBox, isGridFailure, normalizeMaterialCode, sortMaterials } from './useMaterialsCapture';

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
});
