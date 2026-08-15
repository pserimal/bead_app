import { describe, it, expect } from 'vitest';
import { rangeKeys, toggleKeys } from './correctionModel';

/** 3×2 网格的 6 格，模拟按 (row,col) 排序的 codeCells */
const list = [
  { row: 0, col: 0 }, // 0:0
  { row: 0, col: 1 }, // 0:1
  { row: 0, col: 2 }, // 0:2
  { row: 1, col: 0 }, // 1:0
  { row: 1, col: 1 }, // 1:1
  { row: 1, col: 2 }, // 1:2
];

describe('rangeKeys（Shift 连选范围）', () => {
  it('锚点在前、目标在后：返回两者之间的连续 key（含两端）', () => {
    expect(rangeKeys(list, '0:0', '1:1')).toEqual(['0:0', '0:1', '0:2', '1:0', '1:1']);
  });

  it('目标在前、锚点在后：范围与方向无关', () => {
    expect(rangeKeys(list, '1:1', '0:0')).toEqual(['0:0', '0:1', '0:2', '1:0', '1:1']);
  });

  it('相邻两格：只含两个', () => {
    expect(rangeKeys(list, '0:2', '1:0')).toEqual(['0:2', '1:0']);
  });

  it('锚点缺失（首次 Shift）：返回 null', () => {
    expect(rangeKeys(list, null, '0:1')).toBeNull();
  });

  it('锚点不在当前组（跨组）：返回 null', () => {
    expect(rangeKeys(list, '5:5', '0:1')).toBeNull();
  });

  it('目标不在列表：返回 null', () => {
    expect(rangeKeys(list, '0:0', '9:9')).toBeNull();
  });

  it('锚点等于目标：只含该格', () => {
    expect(rangeKeys(list, '1:2', '1:2')).toEqual(['1:2']);
  });
});

describe('toggleKeys（连选整体 toggle）', () => {
  it('全部未选 → 全部加入', () => {
    const next = toggleKeys(new Set(['9:9']), ['0:0', '0:1']);
    expect([...next].sort()).toEqual(['0:0', '0:1', '9:9']);
  });

  it('全部已选 → 全部移除（取下）', () => {
    const next = toggleKeys(new Set(['0:0', '0:1', '1:1']), ['0:0', '0:1']);
    expect([...next].sort()).toEqual(['1:1']);
  });

  it('部分已选 → 补齐加入（不取消已有的）', () => {
    const next = toggleKeys(new Set(['0:0']), ['0:0', '0:1', '0:2']);
    expect([...next].sort()).toEqual(['0:0', '0:1', '0:2']);
  });

  it('空 keys：集合不变', () => {
    const prev = new Set(['0:0']);
    const next = toggleKeys(prev, []);
    expect([...next]).toEqual(['0:0']);
  });
});
