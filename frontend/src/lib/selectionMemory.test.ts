import { beforeEach, describe, expect, it } from 'vitest';
import { readLastSelection, saveLastSelection } from './selectionMemory';

describe('selection memory', () => {
  beforeEach(() => localStorage.clear());

  it('remembers crop and material rectangles independently', () => {
    expect(saveLastSelection('crop', { x: 100, y: 200, w: 400, h: 600 }, 1000, 2000)).toBe(true);
    expect(saveLastSelection('materials', { x: 50, y: 1200, w: 900, h: 500 }, 1000, 2000)).toBe(true);

    expect(readLastSelection('crop', 1000, 2000)).toEqual({ x: 100, y: 200, w: 400, h: 600 });
    expect(readLastSelection('materials', 1000, 2000)).toEqual({ x: 50, y: 1200, w: 900, h: 500 });
  });

  it('scales the remembered rectangle to a new image size', () => {
    saveLastSelection('crop', { x: 100, y: 200, w: 400, h: 600 }, 1000, 2000);

    expect(readLastSelection('crop', 2000, 1000)).toEqual({ x: 200, y: 100, w: 800, h: 300 });
  });

  it('clamps a remembered rectangle that exceeds the new image bounds', () => {
    saveLastSelection('materials', { x: 800, y: 1600, w: 400, h: 800 }, 1000, 2000);

    expect(readLastSelection('materials', 500, 500)).toEqual({ x: 300, y: 300, w: 200, h: 200 });
  });
});
