import { describe, it, expect } from 'vitest';
import { clampPan } from './useBoardViewer';

// 视口 800×600，板子 1000×400
const VW = 800;
const VH = 600;
const BW = 1000;
const BH = 400;

describe('clampPan（pan 边界约束）', () => {
  it('大板（板宽 > 视口）：拖出边界被 clamp 到贴边', () => {
    // scale 1：板 1000>800 → panX 界 ±(1000-800)/2 = ±100；板 400<600 → panY 界 ±(600-400)/2 = ±100
    const r = clampPan(-9999, 9999, VW, VH, BW, BH, 1);
    expect(r.panX).toBe(-100);
    expect(r.panY).toBe(100);
  });

  it('大板：放大后（scale 2，板 2000×800）横向贴边、纵向仍可滑移', () => {
    // panX 界 ±(2000-800)/2 = ±600；panY 界 ±(800-600)/2 = ±100
    const r = clampPan(-9999, 9999, VW, VH, BW, BH, 2);
    expect(r.panX).toBe(-600);
    expect(r.panY).toBe(100);
  });

  it('界内值保持不变', () => {
    const r = clampPan(50, -50, VW, VH, BW, BH, 1);
    expect(r.panX).toBe(50);
    expect(r.panY).toBe(-50);
  });

  it('小板（板 < 视口）：完全可见滑移，不会拖出留白', () => {
    // 板 400×300，scale 1：panX 界 ±(800-400)/2 = ±200；panY 界 ±(600-300)/2 = ±150
    const r = clampPan(-9999, 9999, VW, VH, 400, 300, 1);
    expect(r.panX).toBe(-200);
    expect(r.panY).toBe(150);
  });

  it('缩放归零 pan（板居中小于视口）仍在界内', () => {
    const r = clampPan(0, 0, VW, VH, 400, 300, 1);
    expect(r).toEqual({ panX: 0, panY: 0 });
  });

  it('整图放大到极大（scale 8）：边界 = ±(板×8 − 视口)/2', () => {
    const r = clampPan(-100000, 100000, VW, VH, BW, BH, 8);
    expect(r.panX).toBe(-(8000 - 800) / 2);
    expect(r.panY).toBe((3200 - 600) / 2);
  });
});
