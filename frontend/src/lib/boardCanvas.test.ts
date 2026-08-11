import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AXIS_GUTTER, drawBoard } from './boardCanvas';
import type { BlueprintCellDto } from '../types/api';

/**
 * drawBoard 分层缓存（静态层 + 文字层）回归测试。
 * jsdom 无 canvas 2d context：用 fake context 记录调用序列，
 * 断言行为（跳过不可读文字、静态层复用、描边阈值）而不依赖像素。
 */

type Op = { op: string; args: unknown[]; canvas: HTMLCanvasElement };

interface FakeCtx extends Record<string, unknown> {
  ops: Op[];
  fillStyle: string;
  strokeStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  lineWidth: number;
  lineJoin: string;
  globalAlpha: number;
}

function cell(
  row: number,
  col: number,
  code: string,
  status: BlueprintCellDto['status'] = 'MAPPED',
  correctedCode: string | null = null,
  colorHex: string | null = '#FF0000',
): BlueprintCellDto {
  return {
    row,
    col,
    code,
    status,
    color: colorHex ? { code, name: code, hex: colorHex, brand: 'mard' } : null,
    confidence: 0.99,
    correctedCode,
    correctedAt: correctedCode ? '2026-08-09T00:00:00Z' : null,
  };
}

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas') as HTMLCanvasElement & { _fakeCtx?: FakeCtx };
  return canvas;
}

/** 注入 fake 2d context：记录所有操作；measureText 返回固定宽度；返回 WeakMap 记录各 canvas 的 ctx */
function installFakeGetContext(): WeakMap<HTMLCanvasElement, FakeCtx> {
  const ctxFor = new WeakMap<HTMLCanvasElement, FakeCtx>();
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    let ctx = ctxFor.get(this);
    if (ctx) return ctx;
    ctx = {
      ops: [],
      fillStyle: '',
      strokeStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      lineWidth: 1,
      lineJoin: '',
      globalAlpha: 1,
    } as FakeCtx;
    for (const op of [
      'fillRect', 'fillText', 'strokeText', 'strokeRect', 'arc', 'fill', 'stroke',
      'beginPath', 'moveTo', 'lineTo', 'save', 'restore', 'clip', 'clearRect',
      'setTransform', 'drawImage', 'setLineDash', 'rect',
    ]) {
      (ctx as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
        ctx!.ops.push({ op, args, canvas: this });
      };
    }
    ctx.measureText = (text: string) => ({ width: text.length * 6 });
    ctxFor.set(this, ctx);
    return ctx;
  };
  return ctxFor;
}

function opsOf(canvas: HTMLCanvasElement, ctxFor: WeakMap<HTMLCanvasElement, FakeCtx>): Op[] {
  return ctxFor.get(canvas)?.ops ?? [];
}

describe('drawBoard 分层缓存（性能回归锁）', () => {
  let ctxFor: WeakMap<HTMLCanvasElement, FakeCtx>;
  const cells = new Map<string, BlueprintCellDto>();
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 10; c += 1) {
      cells.set(`${r}:${c}`, cell(r, c, c % 2 === 0 ? 'A1' : 'BLANK', c % 2 === 0 ? 'MAPPED' : 'BLANK'));
    }
  }

  beforeEach(() => {
    ctxFor = installFakeGetContext();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('低缩放（scale < 0.35）不绘制格内编码文字：fit 视图下文字不可读，省 ~200ms/帧', () => {
    const canvas = makeCanvas();
    drawBoard(canvas, 8, 10, 12, 0.2, cells, 'A1', null);
    const ops = opsOf(canvas, ctxFor);
    const texts = ops.filter((o) => o.op === 'fillText' || o.op === 'strokeText');
    // 只允许坐标轴刻度文字（2×cols + 2×rows = 36 次 fillText），格内编码文字必须为 0
    expect(texts.length).toBeGreaterThan(0);
    const codeTexts = texts.filter(
      (o) => typeof o.args[0] === 'string' && /^[A-Z][0-9]+$/.test(o.args[0] as string),
    );
    expect(codeTexts).toHaveLength(0);
  });

  it('缩放 ≥ 0.35 时绘制格内编码文字（可读时才有成本）', () => {
    const canvas = makeCanvas();
    drawBoard(canvas, 8, 10, 12, 1, cells, 'A1', null);
    const ops = opsOf(canvas, ctxFor);
    const codeTexts = ops.filter(
      (o) => o.op === 'fillText' && typeof o.args[0] === 'string' && /^[A-Z][0-9]+$/.test(o.args[0] as string),
    );
    // 40 个非 BLANK 格 → 40 次 fillText；BLANK 格无文字
    expect(codeTexts).toHaveLength(40);
  });

  it('静态层缓存：同参数二次绘制不重建色块层（drawImage 铺底复用同一源）', () => {
    const canvas = makeCanvas();
    drawBoard(canvas, 8, 10, 12, 0.5, cells, 'A1', null);
    const draws = opsOf(canvas, ctxFor).filter((o) => o.op === 'drawImage');
    expect(draws.length).toBeGreaterThanOrEqual(1);
    const layer1 = draws[0].args[0] as HTMLCanvasElement;

    // 第二次同参数绘制：静态层复用（drawImage 同一源），主层不新增任何色块绘制
    drawBoard(canvas, 8, 10, 12, 0.5, cells, 'A1', null);
    const draws2 = opsOf(canvas, ctxFor).filter((o) => o.op === 'drawImage');
    const layer2 = draws2[draws2.length - 1].args[0] as HTMLCanvasElement;
    expect(layer2).toBe(layer1);
    const secondFillRects = opsOf(canvas, ctxFor).filter((o) => o.op === 'fillRect').length;
    // 主层无新增 fillRect（色块全在静态层里）
    expect(secondFillRects).toBe(0);
  });

  it('描边阈值：小字号才有 strokeText，足够大后仅 fillText（省一半文字调用）', () => {
    const small = makeCanvas();
    drawBoard(small, 8, 10, 12, 0.5, cells, 'A1', null);
    const smallStrokes = opsOf(small, ctxFor).filter((o) => o.op === 'strokeText').length;
    // 0.5 缩放 + 12px 格：fontSize*scale 小 → 描边
    expect(smallStrokes).toBeGreaterThan(0);

    const big = makeCanvas();
    drawBoard(big, 8, 10, 12, 6, cells, 'A1', null);
    const bigStrokes = opsOf(big, ctxFor).filter((o) => o.op === 'strokeText').length;
    // 6× 缩放：字号足够大 → 无描边（0 或仅轴无关）
    expect(bigStrokes).toBe(0);
  });

  it('渲染结构完整：BLANK 虚线框、UNMAPPED 斜线、网格线、坐标轴刻度都在', () => {
    const mixed = new Map<string, BlueprintCellDto>();
    mixed.set('0:0', cell(0, 0, 'X9', 'UNMAPPED', null, null)); // 未映射 → 斜线
    mixed.set('0:1', cell(0, 1, 'BLANK', 'BLANK')); // 空白 → 虚线框
    mixed.set('1:0', cell(1, 0, 'A1', 'MAPPED', 'T1')); // 已修正 → 绿点
    const canvas = makeCanvas();
    drawBoard(canvas, 2, 2, 12, 1, mixed, 'X9', null);
    const ops = opsOf(canvas, ctxFor);
    // 静态层（drawImage 源）：BLANK 虚线框 / 修正绿点 / UNMAPPED 斜线
    const layer = ops.find((o) => o.op === 'drawImage')?.args[0] as HTMLCanvasElement;
    expect(layer).toBeTruthy();
    const layerOps = opsOf(layer, ctxFor);
    expect(layerOps.some((o) => o.op === 'strokeRect')).toBe(true); // BLANK 虚线框
    expect(layerOps.some((o) => o.op === 'arc')).toBe(true); // 修正绿点
    // 主层：网格线（moveTo）+ 坐标轴刻度（上下左右 = 2×(rows+cols) 次数字 fillText）
    expect(ops.some((o) => o.op === 'moveTo')).toBe(true);
    const axis = ops.filter(
      (o) => o.op === 'fillText' && typeof o.args[0] === 'string' && /^\d+$/.test(o.args[0] as string),
    );
    expect(axis.length).toBe(2 * (2 + 2));
  });
});
