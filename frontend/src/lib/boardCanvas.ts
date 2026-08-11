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

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr * renderScale, 0, 0, dpr * renderScale, 0, 0);
  context.clearRect(0, 0, width, height);

  const fontFamily = monoFontFamily();
  // 编码填满单元格 ≈85% 宽度：最长编码宽度（mono 字符宽 ≈ 0.62em）≈ 0.85 × cellSize，
  // 用 measureText 实测最长编码在 100px 字号下的宽度反推 fontSize（不同字体/字距都精确）。
  // 下限 2 字符：避免全 1 字符编码时字号超过格高被裁切。
  const maxCodeLen = Math.max(2, longestCode.length);
  context.font = `700 100px ${fontFamily}`;
  const probe = Math.max(0.1, context.measureText(longestCode || 'MM').width) / 100;
  const fontSize = Math.min((0.85 * cellSize) / probe, cellSize / (0.62 * maxCodeLen));
  // 小字号才需要描边加强对比；放大到字号足够大后省掉 strokeText（每格一次调用）
  const useStroke = fontSize * scale < STROKE_FONT_SCALE;
  // 低缩放（fit 视图）时格内编码仅 1-3px 不可读：整层跳过，省 ~200ms/帧（移动端主瓶颈）
  const drawCodes = scale >= CODE_MIN_SCALE;
  // 坐标刻度：≈60% 单元格大小；实测最长刻度（行/列数）宽度，
  // 保证不溢出固定 56px 轴边距（小图 2 位数 43px、大图 3 位数 28px 封顶）。
  const longestAxisLabel = String(Math.max(rows, cols));
  context.font = `600 100px ${fontFamily}`;
  const axisProbe = Math.max(0.1, context.measureText(longestAxisLabel).width) / 100;
  const axisFontSize = Math.min(0.6 * cellSize, (AXIS_GUTTER * 0.9) / axisProbe);
  const left = AXIS_GUTTER;
  const top = AXIS_GUTTER;

  // 静态层铺底：色块/BLANK 虚线/UNMAPPED 斜线/修正绿点缓存一次，重绘仅 drawImage（~5ms）
  const staticLayer = getStaticLayer(canvas, rows, cols, cellSize, cellsByPosition, highlightCode);
  if (staticLayer) {
    context.drawImage(staticLayer, 0, 0, width, height);
  }

  // ── 编码文字层（可读时才有成本；高亮时非目标格 35% 淡出）──
  if (drawCodes) {
    context.font = `700 ${fontSize}px ${fontFamily}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cell = cellsByPosition.get(`${row}:${col}`);
        const isBlank = cell?.status === 'BLANK' || (cell?.correctedCode ?? cell?.code) === 'BLANK';
        if (isBlank) continue;
        const isTarget = highlightCode !== null && (cell?.correctedCode ?? cell?.code) === highlightCode;
        context.globalAlpha = highlightCode !== null && !isTarget ? 0.35 : 1;
        const code = cell?.correctedCode ?? cell?.code ?? '';
        if (!code) continue;
        const x = left + col * cellSize;
        const y = top + row * cellSize;
        const hex = normalizeHex(cell?.color?.hex);
        const textColor = readableTextColor(hex);
        // 编码按 85% 格宽布局，任意长度都不溢出，无需逐格裁切（省 save/clip/restore × 14k）
        if (useStroke) {
          context.lineWidth = Math.max(0.4, fontSize / 8);
          context.strokeStyle = textColor === '#fffaf0'
            ? 'rgba(0, 0, 0, 0.32)'
            : 'rgba(255, 250, 240, 0.55)';
          context.strokeText(code, x + cellSize / 2, y + cellSize / 2);
        }
        context.fillStyle = textColor;
        context.fillText(code, x + cellSize / 2, y + cellSize / 2);
      }
    }
    context.globalAlpha = 1;
  }

  // ── 锁定高亮（编码文字之上、网格线之下）──
  if (highlightCode !== null) {
    // 非目标格已在格子绘制时以 35% 全局透明淡出（露出背景，画面保持明亮）
    // 目标格：accent 1px 细边框（不透明 fillRect 四边，整数坐标绝对锐利；柔和标注）
    context.fillStyle = accentColor();
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const cell = cellsByPosition.get(`${row}:${col}`);
        if ((cell?.correctedCode ?? cell?.code) === highlightCode) {
          const x0 = Math.round(left + col * cellSize);
          const y0 = Math.round(top + row * cellSize);
          context.fillRect(x0, y0, cellSize, 1);
          context.fillRect(x0, y0 + cellSize - 1, cellSize, 1);
          context.fillRect(x0, y0, 1, cellSize);
          context.fillRect(x0 + cellSize - 1, y0, 1, cellSize);
        }
      }
    }
  }

  // 网格线：默认浅灰；每 5 格加一条更粗的蓝色参考线。
  // 延伸贯穿轴边距，框住坐标数字（半像素偏移随 renderScale 缩放避免高分辨率错位）。
  const halfDevicePx = 0.5 / (renderScale * dpr);
  context.beginPath();
  context.strokeStyle = '#d6d1c5';
  context.lineWidth = Math.max(0.5, 0.5 / dpr);
  for (let col = 1; col < cols; col += 1) {
    if (col % 5 === 0) continue;
    const x = left + col * cellSize + halfDevicePx;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let row = 1; row < rows; row += 1) {
    if (row % 5 === 0) continue;
    const y = top + row * cellSize + halfDevicePx;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();

  context.beginPath();
  context.strokeStyle = '#3D72D8';
  context.lineWidth = Math.max(1.4, 1.4 / dpr);
  for (let col = 5; col < cols; col += 5) {
    const x = left + col * cellSize + halfDevicePx;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let row = 5; row < rows; row += 5) {
    const y = top + row * cellSize + halfDevicePx;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();

  // Column labels above and below; row labels on both sides. All are 1-based.
  context.fillStyle = 'rgba(101, 92, 83, 0.55)';
  context.font = `600 ${axisFontSize}px ${fontFamily}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (let col = 0; col < cols; col += 1) {
    const x = left + (col + 0.5) * cellSize;
    const label = String(col + 1);
    // 上/下刻度贴近棋盘：中心距棋盘边 0.26×56px（原 0.52，减半）
    context.fillText(label, x, top * 0.74);
    context.fillText(label, x, top + boardHeight + top * 0.26);
  }
  context.textAlign = 'center';
  for (let row = 0; row < rows; row += 1) {
    const y = top + (row + 0.5) * cellSize;
    const label = String(row + 1);
    // 左/右刻度同样贴近棋盘
    context.fillText(label, left * 0.74, y);
    context.fillText(label, left + boardWidth + left * 0.26, y);
  }
}
