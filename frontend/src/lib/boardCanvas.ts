import type { BlueprintCellDto } from '../types/api';

/**
 * 拼豆图纸画布渲染（详情页 + 沉浸拼豆模式共用）
 * 单一绘制源：drawBoard 是纯函数，由调用方决定何时重绘。
 */

export const AXIS_GUTTER = 56;
export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 8;

export interface ViewState {
  scale: number;
  panX: number;
  panY: number;
}

export interface HoverCell {
  row: number;
  col: number;
  code: string;
  conf: number | null;
  corrected: string | null;
  /** 有效码（correctedCode ?? code，含 'BLANK' 原始值）——锁定/高亮用 */
  effective: string;
  x: number;
  y: number;
}

export function normalizeHex(hex: string | null | undefined): string | null {
  const value = (hex ?? '').replace(/^#/, '').trim();
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : null;
}

export function monoFontFamily(): string {
  if (typeof document !== 'undefined') {
    const resolved = getComputedStyle(document.body).getPropertyValue('--font-mono').trim();
    if (resolved) return resolved;
  }
  return "ui-monospace, 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace";
}

/** canvas 不支持 CSS 变量：把 --color-accent 解析成字面量（兜底陶土色） */
export function accentColor(): string {
  if (typeof document !== 'undefined') {
    const resolved = getComputedStyle(document.body).getPropertyValue('--color-accent').trim();
    if (resolved) return resolved;
  }
  return '#c75b39';
}

export function readableTextColor(hex: string | null): string {
  if (!hex) return '#3e3832';
  const value = hex.slice(1);
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? '#2f2924' : '#fffaf0';
}

export function clampZoom(scale: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
}

/**
 * ── 性能分层（2026-08-11，移动端卡顿修复）──
 *
 * 移动端实测：一次全量重绘 = 5.2 万 draw calls / 446ms（4× CPU 节流），
 * INP 884ms。瓶颈 = 每格 fillRect + fillText + strokeText（文字 ~200ms）。
 *
 * 分层策略：
 * 1. 静态层（色块/BLANK 虚线/UNMAPPED 斜线/修正绿点）与缩放无关，渲染一次
 *    到 offscreen canvas 并缓存（WeakMap keyed by 主 canvas；校正后 cells 引用
 *    变化 → 重建）。重绘时 drawImage 铺底（~5ms），替代 1.9 万次 fillRect。
 * 2. 编码文字在 scale < CODE_MIN_SCALE 时不绘制——fit 视图（移动端 19-45%）
 *    下文字仅 1-3px 不可读，省 ~200ms/帧。信息条已展示编码，画布无需文字。
 * 3. 描边阈值从 28 收紧到 STROKE_FONT_SCALE=12：只有小字号才需要描边对比。
 */
export const CODE_MIN_SCALE = 0.35;
const STROKE_FONT_SCALE = 12; // 原 28：fontSize×scale 低于此才 strokeText

interface StaticLayerEntry {
  rows: number;
  cols: number;
  cellSize: number;
  dpr: number;
  highlightCode: string | null;
  /** cells 引用比对：blueprint 数据变化（校正等）时 Map 重建 → 引用变 → 重建静态层 */
  cellsRef: Map<string, BlueprintCellDto>;
  layer: HTMLCanvasElement | null;
}

/** 主 canvas → 静态层缓存（同一主 canvas 复用；卸载后随 GC 释放） */
const staticLayerCache = new WeakMap<HTMLCanvasElement, StaticLayerEntry>();

/**
 * 渲染/复用静态层（色块 + BLANK 虚线框 + UNMAPPED 斜线 + 修正绿点，含高亮淡出）。
 * 分辨率 = css 尺寸 × dpr（无 renderScale）：纯色块随 CSS 放大轻微模糊可接受，
 * 换来重绘时仅 drawImage。返回 null 时调用方需自行兜底。
 */
function getStaticLayer(
  canvas: HTMLCanvasElement,
  rows: number,
  cols: number,
  cellSize: number,
  cellsByPosition: Map<string, BlueprintCellDto>,
  highlightCode: string | null,
): HTMLCanvasElement | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cached = staticLayerCache.get(canvas);
  if (
    cached &&
    cached.rows === rows &&
    cached.cols === cols &&
    cached.cellSize === cellSize &&
    cached.dpr === dpr &&
    cached.highlightCode === highlightCode &&
    cached.cellsRef === cellsByPosition
  ) {
    return cached.layer;
  }

  const boardWidth = cols * cellSize;
  const boardHeight = rows * cellSize;
  const width = boardWidth + AXIS_GUTTER * 2;
  const height = boardHeight + AXIS_GUTTER * 2;
  const layer = document.createElement('canvas');
  layer.width = Math.ceil(width * dpr);
  layer.height = Math.ceil(height * dpr);
  const context = layer.getContext('2d');
  if (!context) {
    staticLayerCache.set(canvas, { rows, cols, cellSize, dpr, highlightCode, cellsRef: cellsByPosition, layer: null });
    return null;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const left = AXIS_GUTTER;
  const top = AXIS_GUTTER;

  context.fillStyle = '#f8f4ed';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#eee8de';
  context.fillRect(left, top, boardWidth, boardHeight);

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = cellsByPosition.get(`${row}:${col}`);
      const x = left + col * cellSize;
      const y = top + row * cellSize;
      const hex = normalizeHex(cell?.color?.hex);
      const isBlank = cell?.status === 'BLANK' || (cell?.correctedCode ?? cell?.code) === 'BLANK';
      const isTarget = highlightCode !== null && (cell?.correctedCode ?? cell?.code) === highlightCode;
      context.globalAlpha = highlightCode !== null && !isTarget ? 0.35 : 1;

      if (isBlank) {
        context.fillStyle = '#faf9f5';
        context.fillRect(x, y, cellSize, cellSize);
        context.save();
        context.setLineDash([2, 2]);
        context.strokeStyle = 'rgba(112, 103, 92, 0.42)';
        context.lineWidth = Math.max(0.7, cellSize / 32);
        context.strokeRect(x + cellSize * 0.18, y + cellSize * 0.18,
          cellSize * 0.64, cellSize * 0.64);
        context.restore();
      } else {
        context.fillStyle = hex ?? '#e6e0d7';
        context.fillRect(x, y, cellSize, cellSize);
      }

      if (!isBlank && (!hex || cell?.status === 'UNMAPPED')) {
        context.save();
        context.beginPath();
        context.rect(x, y, cellSize, cellSize);
        context.clip();
        context.strokeStyle = 'rgba(92, 84, 75, 0.28)';
        context.lineWidth = Math.max(0.6, cellSize / 36);
        const step = Math.max(5, cellSize / 3);
        for (let line = -cellSize; line < cellSize * 2; line += step) {
          context.beginPath();
          context.moveTo(x + line, y);
          context.lineTo(x + line + cellSize, y + cellSize);
          context.stroke();
        }
        context.restore();
      }

      // 已修正标记：右上角绿点（静态，不随缩放重绘）
      if (cell?.correctedCode != null) {
        const r = Math.max(1.2, cellSize * 0.09);
        context.fillStyle = '#2f9e6e';
        context.beginPath();
        context.arc(x + cellSize - r, y + r, r, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    }
  }

  staticLayerCache.set(canvas, { rows, cols, cellSize, dpr, highlightCode, cellsRef: cellsByPosition, layer });
  return layer;
}

/** 可见格子范围（视口裁剪用；整图模式传全量） */
interface CellRange {
  row0: number;
  row1: number;
  col0: number;
  col1: number;
}

function fullRange(rows: number, cols: number): CellRange {
  return { row0: 0, row1: rows, col0: 0, col1: cols };
}

/** 格子层：色块 + BLANK 虚线框 + UNMAPPED 斜线 + 修正绿点（含高亮淡出）。board 坐标，可限可见范围。 */
function renderCells(
  ctx: CanvasRenderingContext2D,
  rows: number,
  cols: number,
  cellSize: number,
  cellsByPosition: Map<string, BlueprintCellDto>,
  highlightCode: string | null,
  range: CellRange = fullRange(rows, cols),
) {
  const left = AXIS_GUTTER;
  const top = AXIS_GUTTER;
  for (let row = range.row0; row < range.row1; row += 1) {
    for (let col = range.col0; col < range.col1; col += 1) {
      const cell = cellsByPosition.get(`${row}:${col}`);
      const x = left + col * cellSize;
      const y = top + row * cellSize;
      const hex = normalizeHex(cell?.color?.hex);
      const isBlank = cell?.status === 'BLANK' || (cell?.correctedCode ?? cell?.code) === 'BLANK';
      const isTarget = highlightCode !== null && (cell?.correctedCode ?? cell?.code) === highlightCode;
      ctx.globalAlpha = highlightCode !== null && !isTarget ? 0.35 : 1;

      if (isBlank) {
        ctx.fillStyle = '#faf9f5';
        ctx.fillRect(x, y, cellSize, cellSize);
        ctx.save();
        ctx.setLineDash([2, 2]);
        ctx.strokeStyle = 'rgba(112, 103, 92, 0.42)';
        ctx.lineWidth = Math.max(0.7, cellSize / 32);
        ctx.strokeRect(x + cellSize * 0.18, y + cellSize * 0.18,
          cellSize * 0.64, cellSize * 0.64);
        ctx.restore();
      } else {
        ctx.fillStyle = hex ?? '#e6e0d7';
        ctx.fillRect(x, y, cellSize, cellSize);
      }

      if (!isBlank && (!hex || cell?.status === 'UNMAPPED')) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cellSize, cellSize);
        ctx.clip();
        ctx.strokeStyle = 'rgba(92, 84, 75, 0.28)';
        ctx.lineWidth = Math.max(0.6, cellSize / 36);
        const step = Math.max(5, cellSize / 3);
        for (let line = -cellSize; line < cellSize * 2; line += step) {
          ctx.beginPath();
          ctx.moveTo(x + line, y);
          ctx.lineTo(x + line + cellSize, y + cellSize);
          ctx.stroke();
        }
        ctx.restore();
      }

      // 已修正标记：右上角绿点
      if (cell?.correctedCode != null) {
        const r = Math.max(1.2, cellSize * 0.09);
        ctx.fillStyle = '#2f9e6e';
        ctx.beginPath();
        ctx.arc(x + cellSize - r, y + r, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}

/** 编码文字层（高亮时非目标格 35% 淡出）。board 坐标，可限可见范围。 */
function renderCodes(
  ctx: CanvasRenderingContext2D,
  rows: number,
  cols: number,
  cellSize: number,
  cellsByPosition: Map<string, BlueprintCellDto>,
  highlightCode: string | null,
  fontSize: number,
  fontFamily: string,
  useStroke: boolean,
  range: CellRange = fullRange(rows, cols),
) {
  const left = AXIS_GUTTER;
  const top = AXIS_GUTTER;
  ctx.font = `700 ${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (let row = range.row0; row < range.row1; row += 1) {
    for (let col = range.col0; col < range.col1; col += 1) {
      const cell = cellsByPosition.get(`${row}:${col}`);
      const isBlank = cell?.status === 'BLANK' || (cell?.correctedCode ?? cell?.code) === 'BLANK';
      if (isBlank) continue;
      const isTarget = highlightCode !== null && (cell?.correctedCode ?? cell?.code) === highlightCode;
      ctx.globalAlpha = highlightCode !== null && !isTarget ? 0.35 : 1;
      const code = cell?.correctedCode ?? cell?.code ?? '';
      if (!code) continue;
      const x = left + col * cellSize;
      const y = top + row * cellSize;
      const hex = normalizeHex(cell?.color?.hex);
      const textColor = readableTextColor(hex);
      // 编码按 85% 格宽布局，任意长度都不溢出，无需逐格裁切（省 save/clip/restore × 14k）
      if (useStroke) {
        ctx.lineWidth = Math.max(0.4, fontSize / 8);
        ctx.strokeStyle = textColor === '#fffaf0'
          ? 'rgba(0, 0, 0, 0.32)'
          : 'rgba(255, 250, 240, 0.55)';
        ctx.strokeText(code, x + cellSize / 2, y + cellSize / 2);
      }
      ctx.fillStyle = textColor;
      ctx.fillText(code, x + cellSize / 2, y + cellSize / 2);
    }
  }
  ctx.globalAlpha = 1;
}

/** 锁定高亮：目标格 accent 细边框（整数坐标锐利）。board 坐标，可限可见范围。 */
function renderHighlightFrame(
  ctx: CanvasRenderingContext2D,
  rows: number,
  cols: number,
  cellSize: number,
  cellsByPosition: Map<string, BlueprintCellDto>,
  highlightCode: string,
  range: CellRange = fullRange(rows, cols),
) {
  const left = AXIS_GUTTER;
  const top = AXIS_GUTTER;
  ctx.fillStyle = accentColor();
  for (let row = range.row0; row < range.row1; row += 1) {
    for (let col = range.col0; col < range.col1; col += 1) {
      const cell = cellsByPosition.get(`${row}:${col}`);
      if ((cell?.correctedCode ?? cell?.code) === highlightCode) {
        const x0 = Math.round(left + col * cellSize);
        const y0 = Math.round(top + row * cellSize);
        ctx.fillRect(x0, y0, cellSize, 1);
        ctx.fillRect(x0, y0 + cellSize - 1, cellSize, 1);
        ctx.fillRect(x0, y0, 1, cellSize);
        ctx.fillRect(x0 + cellSize - 1, y0, 1, cellSize);
      }
    }
  }
}

/** 网格线（默认浅灰；每 5 格一条更粗的蓝色参考线），可限可见范围。deviceScale = 变换的缩放因子。 */
function renderGrid(
  ctx: CanvasRenderingContext2D,
  rows: number,
  cols: number,
  cellSize: number,
  deviceScale: number,
  dpr: number,
  range: CellRange = fullRange(rows, cols),
) {
  const left = AXIS_GUTTER;
  const top = AXIS_GUTTER;
  const width = cols * cellSize + AXIS_GUTTER * 2;
  const height = rows * cellSize + AXIS_GUTTER * 2;
  const halfDevicePx = 0.5 / deviceScale;
  const colLast = Math.min(range.col1, cols - 1);
  const rowLast = Math.min(range.row1, rows - 1);
  ctx.beginPath();
  ctx.strokeStyle = '#d6d1c5';
  ctx.lineWidth = Math.max(0.5, 0.5 / dpr);
  for (let col = range.col0; col <= colLast; col += 1) {
    if (col % 5 === 0 || col === 0) continue;
    const x = left + col * cellSize + halfDevicePx;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let row = range.row0; row <= rowLast; row += 1) {
    if (row % 5 === 0 || row === 0) continue;
    const y = top + row * cellSize + halfDevicePx;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = '#3D72D8';
  ctx.lineWidth = Math.max(1.4, 1.4 / dpr);
  for (let col = Math.max(5, Math.ceil(range.col0 / 5) * 5); col <= colLast; col += 5) {
    const x = left + col * cellSize + halfDevicePx;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let row = Math.max(5, Math.ceil(range.row0 / 5) * 5); row <= rowLast; row += 5) {
    const y = top + row * cellSize + halfDevicePx;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
}

/** 坐标轴刻度（上/下/左/右），可限可见行列。board 坐标。 */
function renderAxes(
  ctx: CanvasRenderingContext2D,
  rows: number,
  cols: number,
  cellSize: number,
  axisFontSize: number,
  fontFamily: string,
  range: CellRange = fullRange(rows, cols),
) {
  const left = AXIS_GUTTER;
  const top = AXIS_GUTTER;
  const boardWidth = cols * cellSize;
  const boardHeight = rows * cellSize;
  ctx.fillStyle = 'rgba(101, 92, 83, 0.55)';
  ctx.font = `600 ${axisFontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let col = range.col0; col < range.col1; col += 1) {
    const x = left + (col + 0.5) * cellSize;
    const label = String(col + 1);
    ctx.fillText(label, x, top * 0.74);
    ctx.fillText(label, x, top + boardHeight + top * 0.26);
  }
  for (let row = range.row0; row < range.row1; row += 1) {
    const y = top + (row + 0.5) * cellSize;
    const label = String(row + 1);
    ctx.fillText(label, left * 0.74, y);
    ctx.fillText(label, left + boardWidth + left * 0.26, y);
  }
}

/** 字体度量（整图/视口模式共用）：编码字号按最长编码实测宽度反推，刻度字号按最长刻度。 */
function computeFonts(
  context: CanvasRenderingContext2D,
  cellSize: number,
  longestCode: string,
  rows: number,
  cols: number,
): { fontFamily: string; fontSize: number; axisFontSize: number } {
  const fontFamily = monoFontFamily();
  const maxCodeLen = Math.max(2, longestCode.length);
  context.font = `700 100px ${fontFamily}`;
  const probe = Math.max(0.1, context.measureText(longestCode || 'MM').width) / 100;
  const fontSize = Math.min((0.85 * cellSize) / probe, cellSize / (0.62 * maxCodeLen));
  const longestAxisLabel = String(Math.max(rows, cols));
  context.font = `600 100px ${fontFamily}`;
  const axisProbe = Math.max(0.1, context.measureText(longestAxisLabel).width) / 100;
  const axisFontSize = Math.min(0.6 * cellSize, (AXIS_GUTTER * 0.9) / axisProbe);
  return { fontFamily, fontSize, axisFontSize };
}

/**
 * 绘制整张图纸（含坐标轴 + 网格线 + 编码 + 修正标记）。
 * highlightCode 非空 = 锁定高亮：该编码的格子保持原色 + accent 描边，
 * 其余格子覆盖 45% 米白（温和变淡，仍可读图）；网格线/坐标轴始终最上。
 */
export function drawBoard(
  canvas: HTMLCanvasElement,
  rows: number,
  cols: number,
  cellSize: number,
  scale: number,
  cellsByPosition: Map<string, BlueprintCellDto>,
  longestCode: string,
  highlightCode: string | null = null,
) {
  // dpr 上限 2：移动设备 dpr 2-3 时位图面积翻 4-9 倍，视觉差异小、性能代价大
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const boardWidth = cols * cellSize;
  const boardHeight = rows * cellSize;
  const width = boardWidth + AXIS_GUTTER * 2;
  const height = boardHeight + AXIS_GUTTER * 2;
  // 清晰渲染：位图分辨率随缩放提升（renderScale = max(1, scale)），放大不模糊。
  // 但分辨率无需 1:1 追到极限：MAX_RENDER_SCALE=3 封顶（最大位图 ≈34M px），
  // 兼顾拖动流畅（巨纹理合成卡顿）与可读性，超过后由 CSS 放大（轻微变糊可接受）。
  // 画布尺寸/面积上限（Chrome 2D ≈ 32767 边 / 268M 面积）作为硬性兜底。
  const MAX_RENDER_SCALE = 3;
  const MAX_CANVAS_DIM = 32767;
  const MAX_CANVAS_AREA = 268_000_000;
  const dimCap = MAX_CANVAS_DIM / (Math.max(width, height) * dpr);
  const areaCap = Math.sqrt(MAX_CANVAS_AREA / (width * height * dpr * dpr));
  const renderScale = Math.max(1, Math.min(scale, MAX_RENDER_SCALE, dimCap, areaCap));
  canvas.width = Math.ceil(width * renderScale * dpr);
  canvas.height = Math.ceil(height * renderScale * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  // 复位为流式定位（视口模式切回整图模式时）
  canvas.style.position = '';
  canvas.style.left = '';
  canvas.style.top = '';
  canvas.style.transform = '';

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr * renderScale, 0, 0, dpr * renderScale, 0, 0);
  context.clearRect(0, 0, width, height);

  const { fontFamily, fontSize, axisFontSize } = computeFonts(context, cellSize, longestCode, rows, cols);
  // 小字号才需要描边加强对比；放大到字号足够大后省掉 strokeText（每格一次调用）
  const useStroke = fontSize * scale < STROKE_FONT_SCALE;
  // 低缩放（fit 视图）时格内编码仅 1-3px 不可读：整层跳过，省 ~200ms/帧（移动端主瓶颈）
  const drawCodes = scale >= CODE_MIN_SCALE;

  // 静态层铺底：色块/BLANK 虚线/UNMAPPED 斜线/修正绿点缓存一次，重绘仅 drawImage（~5ms）
  const staticLayer = getStaticLayer(canvas, rows, cols, cellSize, cellsByPosition, highlightCode);
  if (staticLayer) {
    context.drawImage(staticLayer, 0, 0, width, height);
  }

  // ── 编码文字层（可读时才有成本；高亮时非目标格 35% 淡出）──
  if (drawCodes) {
    renderCodes(context, rows, cols, cellSize, cellsByPosition, highlightCode, fontSize, fontFamily, useStroke);
  }
  // ── 锁定高亮（编码文字之上、网格线之下）──
  if (highlightCode !== null) {
    renderHighlightFrame(context, rows, cols, cellSize, cellsByPosition, highlightCode);
  }
  // 网格线 + 坐标轴刻度
  renderGrid(context, rows, cols, cellSize, renderScale * dpr, dpr);
  renderAxes(context, rows, cols, cellSize, axisFontSize, fontFamily);
}

/**
 * 视口裁剪模式（大缩放专用）：位图固定为视口尺寸（≤ ~2MP），只绘制可见格子。
 *
 * 为什么需要：整图模式在 scale 大时位图 = board × renderScale × dpr 可达 86MP
 * （300% 时 12048×7152），远超移动端 GPU 硬件纹理上限（4096×4096）→ 软件合成
 * → 拖拽卡顿。视口模式下位图永远 ≤ 视口 × dpr，拖拽每帧重绘仅可见格子
 * （300% 时 ~2k calls / ~10ms），任意比例拖拽流畅，放大文字按屏幕像素渲染保持清晰。
 *
 * 坐标：与 drawBoard 相同（board 坐标 + setTransform），变换含 scale 与可见区偏移，
 * 格子/网格/轴全部限可见范围（视口裁剪）。
 */
export function drawBoardViewport(
  canvas: HTMLCanvasElement,
  rows: number,
  cols: number,
  cellSize: number,
  scale: number,
  panX: number,
  panY: number,
  viewportW: number,
  viewportH: number,
  cellsByPosition: Map<string, BlueprintCellDto>,
  longestCode: string,
  highlightCode: string | null = null,
) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.ceil(viewportW * dpr));
  canvas.height = Math.max(1, Math.ceil(viewportH * dpr));
  canvas.style.width = `${viewportW}px`;
  canvas.style.height = `${viewportH}px`;
  // 绝对定位居中覆盖视口（wrapper 在视口模式下 transform=none；绘制内容已含 pan/scale 偏移）
  canvas.style.position = 'absolute';
  canvas.style.left = '50%';
  canvas.style.top = '50%';
  canvas.style.transform = 'translate(-50%, -50%)';

  const context = canvas.getContext('2d');
  if (!context) return;
  const boardW = cols * cellSize + AXIS_GUTTER * 2;
  const boardH = rows * cellSize + AXIS_GUTTER * 2;
  // wrapper transform: translate(calc(-50% + panX), calc(-50% + panY)) scale(scale)
  // → canvas 左上角相对 viewport 的位置；反推视口在 canvas 本地坐标的可见区 [ox0,ox1]×[oy0,oy1]
  const canvasLeft = viewportW / 2 + panX - (boardW * scale) / 2;
  const canvasTop = viewportH / 2 + panY - (boardH * scale) / 2;
  const ox0 = Math.max(0, -canvasLeft);
  const oy0 = Math.max(0, -canvasTop);
  const ox1 = Math.min(boardW * scale, viewportW - canvasLeft);
  const oy1 = Math.min(boardH * scale, viewportH - canvasTop);

  // 背景：先填整个视口（canvas.width 赋值已清空画布；即使板子不可见也要米白底而非透明）
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = '#f8f4ed';
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (ox1 <= ox0 || oy1 <= oy0) return; // 板子完全在视口外（视口已显米白底）

  // 变换：board 坐标 → 设备像素（含可见区偏移）；板外内容自动裁剪
  context.setTransform(dpr * scale, 0, 0, dpr * scale, -dpr * ox0, -dpr * oy0);

  // 可见格子范围（board 坐标）
  const col0 = Math.max(0, Math.floor((ox0 / scale - AXIS_GUTTER) / cellSize));
  const col1 = Math.min(cols, Math.ceil((ox1 / scale - AXIS_GUTTER) / cellSize));
  const row0 = Math.max(0, Math.floor((oy0 / scale - AXIS_GUTTER) / cellSize));
  const row1 = Math.min(rows, Math.ceil((oy1 / scale - AXIS_GUTTER) / cellSize));
  const range: CellRange = { row0, row1, col0, col1 };

  const { fontFamily, fontSize, axisFontSize } = computeFonts(context, cellSize, longestCode, rows, cols);
  const useStroke = fontSize * scale < STROKE_FONT_SCALE;
  const drawCodes = scale >= CODE_MIN_SCALE;

  renderCells(context, rows, cols, cellSize, cellsByPosition, highlightCode, range);
  if (drawCodes) {
    renderCodes(context, rows, cols, cellSize, cellsByPosition, highlightCode, fontSize, fontFamily, useStroke, range);
  }
  if (highlightCode !== null) {
    renderHighlightFrame(context, rows, cols, cellSize, cellsByPosition, highlightCode, range);
  }
  renderGrid(context, rows, cols, cellSize, scale * dpr, dpr, range);
  renderAxes(context, rows, cols, cellSize, axisFontSize, fontFamily, range);
}
