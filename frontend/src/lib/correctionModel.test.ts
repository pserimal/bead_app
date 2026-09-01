import { describe, it, expect } from 'vitest';
import {
  buildAllCodeCounts,
  computeVisibleCells,
  legendDiff,
  rangeKeys,
  toggleKeys,
} from './correctionModel';
import type { BlueprintCellDto } from '../types/api';

const cell = (code: string, opts: Partial<BlueprintCellDto> = {}): BlueprintCellDto => ({
  row: 0,
  col: 0,
  code,
  status: 'MAPPED',
  color: null,
  confidence: 1,
  correctedCode: null,
  correctedAt: null,
  ...opts,
});

/** 3×2 网格的 6 格，模拟按 (row,col) 排序的 codeCells */
const list = [
  { row: 0, col: 0 }, // 0:0
  { row: 0, col: 1 }, // 0:1
  { row: 0, col: 2 }, // 0:2
  { row: 1, col: 0 }, // 1:0
  { row: 1, col: 1 }, // 1:1
  { row: 1, col: 2 }, // 1:2
];

describe('buildAllCodeCounts（全量编码计数）', () => {
  it('按有效码（修正优先）统计全部格子，与筛选无关', () => {
    const cells = [
      cell('A1'),
      cell('A1'),
      cell('A1', { correctedCode: 'B1' }),
      cell('BLANK', { status: 'BLANK' }),
    ];
    const counts = buildAllCodeCounts(cells);
    expect(counts.get('A1')).toBe(2);
    expect(counts.get('B1')).toBe(1);
    expect(counts.get('BLANK')).toBe(1);
  });

  it('空列表 → 空 Map', () => {
    expect(buildAllCodeCounts([]).size).toBe(0);
  });
});

describe('legendDiff（清单-图纸差异）', () => {
  it('清单没有的码（期望 0）：A1 实际 20 → −20', () => {
    expect(legendDiff(0, 20)).toBe(-20);
  });

  it('实际少于期望：缺（正）', () => {
    expect(legendDiff(30, 25)).toBe(5);
  });

  it('实际多于期望：多（负）', () => {
    expect(legendDiff(20, 35)).toBe(-15);
  });

  it('相等 → 0', () => {
    expect(legendDiff(20, 20)).toBe(0);
  });

  it('未启用清单（expected 为 undefined/null）→ null，不显示差异', () => {
    expect(legendDiff(undefined, 20)).toBeNull();
    expect(legendDiff(null, 20)).toBeNull();
  });
});

describe('computeVisibleCells（搜索 + 修正筛选）', () => {
  const all = [
    cell('A1'),
    cell('B1'),
    cell('B1', { correctedCode: 'C1' }),
    cell('BLANK', { status: 'BLANK' }),
  ];

  it('无搜索无筛选：返回全部格子', () => {
    expect(computeVisibleCells(all, '', 'all')).toEqual(all);
  });

  it('搜索过滤：按编码/修正码匹配', () => {
    expect(computeVisibleCells(all, 'B1', 'all')).toEqual([all[1], all[2]]);
  });

  it('修正筛选：仅未修正 / 仅已修正，与搜索叠加', () => {
    expect(computeVisibleCells(all, '', 'unfixed')).toEqual([all[0], all[1], all[3]]);
    expect(computeVisibleCells(all, '', 'fixed')).toEqual([all[2]]);
    // 搜索 'B' 匹配 code 含 B：B1、BLANK（'BLANK'.includes('B')）；再筛未修正 → B1、BLANK
    expect(computeVisibleCells(all, 'B', 'unfixed')).toEqual([all[1], all[3]]);
  });
});

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
