import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import apiClient from '../api/client';
import {
  getBlueprintLegend,
  recognizeLegendBox,
  recognizeLegendGrid,
  type LegendBoxResult,
  type LegendEntry,
} from '../api/materials';
import {
  loadPendingUpload,
  readPendingWizard,
  type PendingWizardState,
} from '../lib/pendingUpload';
import { cacheImageFile, getCachedImageFile, getCachedImageUrl } from '../lib/imageCache';
import { readLastSelection, saveLastSelection } from '../lib/selectionMemory';

export type Box = { x: number; y: number; w: number; h: number };
export type Material = {
  code: string;
  count: number;
  confirmed: boolean;
  row?: number;
  col?: number;
  bbox?: Box;
  sourceId?: string;
};
export type CaptureInput = {
  imageUrl: string;
  imageW: number;
  imageH: number;
  imageFile?: File;
  crop?: Box | null;
  materialsBox?: Box | null;
  rows?: number;
  cols?: number;
  materialsRows?: number;
  materialsCols?: number;
  codes?: string;
  jobName?: string;
  skipLegendPrompt?: boolean;
  legendInventory?: Material[];
};
export type GridCell = {
  row: number;
  col: number;
  bbox: Box;
  result: LegendBoxResult | null;
  code: string;
  count: string;
  loading: boolean;
  sourceId?: string;
  manual?: boolean;
  excluded?: boolean;
  confirmed?: boolean;
};
export type View = { scale: number; x: number; y: number };
export type CaptureState = {
  input: CaptureInput | null;
  box: Box;
  view: View;
  result: LegendBoxResult | null;
  code: string;
  count: string;
  inventory: Material[];
  grid: GridCell[];
  rows: number;
  cols: number;
  error: string | null;
  loading: boolean;
  gridLoading: boolean;
  progress: number;
};

type Action =
  | { type: 'input'; input: CaptureInput }
  | { type: 'box'; box: Box }
  | { type: 'view'; view: View }
  | { type: 'result'; result: LegendBoxResult | null; code?: string; count?: string }
  | { type: 'inventory'; inventory: Material[] }
  | { type: 'grid'; grid: GridCell[] }
  | { type: 'gridCell'; index: number; cell: GridCell }
  | { type: 'error'; error: string | null }
  | { type: 'loading'; loading: boolean }
  | { type: 'gridLoading'; value: boolean }
  | { type: 'progress'; value: number }
  | { type: 'gridSize'; rows: number; cols: number };

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export const clampGrid = (n: number) => clamp(Number.isFinite(n) ? Math.round(n) : 1, 1, 20);

export function normalizeMaterialCode(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase();
}

/** Sort material codes alphabetically, then numerically within the same letter. */
export function compareMaterialCodes(a: string | null | undefined, b: string | null | undefined): number {
  const codeA = normalizeMaterialCode(a);
  const codeB = normalizeMaterialCode(b);
  const matchA = codeA.match(/^([A-Z]+)(\d+)$/);
  const matchB = codeB.match(/^([A-Z]+)(\d+)$/);

  if (!matchA || !matchB) {
    if (matchA) return -1;
    if (matchB) return 1;
    return codeA.localeCompare(codeB);
  }

  const letterOrder = matchA[1].localeCompare(matchB[1]);
  if (letterOrder !== 0) return letterOrder;
  return Number(matchA[2]) - Number(matchB[2]);
}

/** 行优先（网格）顺序：先按行从上到下，行内按列从左到右；
 *  手工录入项（无 row/col）排在网格项之后。 */
export function sortMaterials(items: Material[]): Material[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rowA = a.item.row ?? Number.MAX_SAFE_INTEGER;
      const rowB = b.item.row ?? Number.MAX_SAFE_INTEGER;
      if (rowA !== rowB) return rowA - rowB;
      const colA = a.item.col ?? Number.MAX_SAFE_INTEGER;
      const colB = b.item.col ?? Number.MAX_SAFE_INTEGER;
      return colA - colB || a.index - b.index;
    })
    .map(({ item }) => item);
}

/** 把库存条目转为服务端清单 payload：排序 + 过滤无效条目（缺编码/数量不落库）。
 *  自动保存与手动保存共用此入口。 */
export function toEntries(items: Material[]): LegendEntry[] {
  return sortMaterials(items)
    .map((item, index) => ({
      ordinal: index,
      rowIndex: item.row ?? 0,
      colIndex: item.col ?? index,
      code: normalizeMaterialCode(item.code),
      count: Math.round(item.count),
      status: item.confirmed ? 'accepted' : 'needs_confirmation',
      source: 'manual',
      confirmed: item.confirmed,
      bbox: { x: item.bbox?.x ?? 0, y: item.bbox?.y ?? 0, width: item.bbox?.w ?? 0, height: item.bbox?.h ?? 0 },
    }))
    .filter((entry) => entry.code.length > 0 && entry.count > 0);
}

export function isGridFailure(result: LegendBoxResult | null): boolean {
  return result?.status === 'invalid'
    || result?.status === 'recognition_failed'
    || result?.status === 'model_unavailable';
}

export function defaultBox(input: CaptureInput): Box {
  return input.materialsBox
    ?? readLastSelection('materials', input.imageW, input.imageH)
    ?? {
      x: input.imageW * 0.02,
      y: input.imageH * 0.72,
      w: input.imageW * 0.96,
      h: input.imageH * 0.24,
    };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialState(input: CaptureInput | null): CaptureState {
  return {
    input,
    box: input ? defaultBox(input) : { x: 0, y: 0, w: 100, h: 100 },
    view: { scale: 1, x: 0, y: 0 },
    result: null,
    code: '',
    count: '',
    inventory: input?.legendInventory ?? [],
    grid: gridFromInventory(input?.legendInventory ?? []),
    rows: clampGrid(input?.materialsRows ?? 3),
    cols: clampGrid(input?.materialsCols ?? 8),
    error: null,
    loading: false,
    gridLoading: false,
    progress: 0,
  };
}

function cellMaterial(cell: GridCell): Material | null {
  const code = normalizeMaterialCode(cell.code);
  const count = Number.parseInt(cell.count, 10);
  if (cell.excluded || !code || !Number.isFinite(count) || count <= 0) return null;
  return {
    code,
    count,
    confirmed: cell.confirmed ?? cell.result?.status === 'accepted',
    row: cell.manual ? undefined : cell.row,
    col: cell.manual ? undefined : cell.col,
    bbox: cell.manual ? undefined : cell.bbox,
    sourceId: cell.sourceId,
  };
}

function gridFromInventory(items: Material[]): GridCell[] {
  return items.map((item, index) => ({
    row: item.row ?? Number.MAX_SAFE_INTEGER,
    col: item.col ?? index,
    bbox: item.bbox ?? { x: 0, y: 0, w: 0, h: 0 },
    result: item.confirmed ? { code: item.code, count: item.count, rawCode: item.code, rawCount: String(item.count), codeConfidence: null, countConfidence: null, overallConfidence: 1, status: 'accepted', candidates: {}, bbox: null, expandedBbox: null } : null,
    code: item.code,
    count: String(item.count),
    loading: false,
    sourceId: item.sourceId ?? `saved-${index}`,
    manual: item.row == null && item.col == null,
    confirmed: item.confirmed,
  }));
}

function syncInventoryFromGrid(grid: GridCell[]): Material[] {
  return grid.map(cellMaterial).filter((item): item is Material => item !== null);
}

const reducer = (state: CaptureState, action: Action): CaptureState => {
  switch (action.type) {
    case 'input': {
      const input = { ...state.input, ...action.input } as CaptureInput;
      return {
        ...state,
        input,
        box: action.input.materialsBox ?? state.box ?? defaultBox(input),
        inventory: action.input.legendInventory ?? state.inventory,
        rows: clampGrid(action.input.materialsRows ?? state.rows),
        cols: clampGrid(action.input.materialsCols ?? state.cols),
      };
    }
    case 'box':
      return { ...state, box: action.box };
    case 'view':
      return { ...state, view: action.view };
    case 'result':
      return { ...state, result: action.result, code: action.code ?? '', count: action.count ?? '' };
    case 'inventory':
      return { ...state, inventory: action.inventory, grid: state.grid.length ? state.grid : gridFromInventory(action.inventory) };
    case 'grid':
      return { ...state, grid: action.grid, inventory: syncInventoryFromGrid(action.grid) };
    case 'gridCell': {
      const grid = state.grid.map((cell, index) => (index === action.index ? action.cell : cell));
      return { ...state, grid, inventory: syncInventoryFromGrid(grid) };
    }
    case 'error':
      return { ...state, error: action.error };
    case 'loading':
      return { ...state, loading: action.loading };
    case 'gridLoading':
      return { ...state, gridLoading: action.value };
    case 'progress':
      return { ...state, progress: action.value };
    case 'gridSize':
      return { ...state, rows: action.rows, cols: action.cols };
    default:
      return state;
  }
};

function apiBox(box: Box) {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.max(1, Math.round(box.w)),
    height: Math.max(1, Math.round(box.h)),
  };
}

function failedResult(box: Box, error: unknown): LegendBoxResult {
  return {
    code: null,
    count: null,
    rawCode: null,
    rawCount: null,
    codeConfidence: null,
    countConfidence: null,
    overallConfidence: 0,
    status: 'recognition_failed',
    candidates: {},
    bbox: apiBox(box),
    expandedBbox: null,
    diagnostics: errorText(error),
  };
}

export function useMaterialsCapture(blueprintId: string | null) {
  const location = useLocation();
  const [restoredWizard] = useState<PendingWizardState | null>(() => (!blueprintId ? readPendingWizard() : null));
  const locationInput = (location.state as CaptureInput | null) ?? null;
  const restoredInput = restoredWizard?.step === 'materials' ? {
    imageUrl: restoredWizard.imageUrl ?? '',
    imageW: restoredWizard.imageW ?? 0,
    imageH: restoredWizard.imageH ?? 0,
    crop: restoredWizard.crop ?? null,
    materialsBox: restoredWizard.materialsBox ?? null,
    rows: restoredWizard.rows,
    cols: restoredWizard.cols,
    materialsRows: restoredWizard.materialsRows,
    materialsCols: restoredWizard.materialsCols,
    codes: restoredWizard.codes,
    jobName: restoredWizard.jobName,
    skipLegendPrompt: restoredWizard.skipLegendPrompt,
    legendInventory: restoredWizard.legendInventory,
  } satisfies CaptureInput : null;
  const initialInput: CaptureInput | null = locationInput
    ? restoredInput ? { ...locationInput, ...restoredInput, imageUrl: '', imageFile: locationInput.imageFile } : locationInput
    : restoredInput;
  const effectiveInitialInput = initialInput && !initialInput.imageFile
    ? { ...initialInput, imageUrl: '' }
    : initialInput;
  const [state, dispatch] = useReducer(reducer, effectiveInitialInput, initialState);
  const stageRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef(state.box);
  const viewRef = useRef(state.view);
  const fitRef = useRef(1);

  useEffect(() => {
    boxRef.current = state.box;
  }, [state.box]);
  useEffect(() => {
    viewRef.current = state.view;
  }, [state.view]);
  useEffect(() => {
    if (!state.input?.imageW || !state.input.imageH) return;
    const { imageW, imageH } = state.input;
    // 拖框/平移期间 box 变化频繁：防抖写入（200ms），避免每帧同步写 localStorage
    const timer = window.setTimeout(() => {
      saveLastSelection('materials', state.box, imageW, imageH);
    }, 200);
    return () => {
      window.clearTimeout(timer);
      saveLastSelection('materials', state.box, imageW, imageH);
    };
  }, [state.box, state.input]);

  // Supplement a restored location/session snapshot with the File kept in IndexedDB.
  useEffect(() => {
    if (blueprintId || !state.input || state.input.imageUrl) return;
    if (!state.input.imageFile && !restoredWizard) return;
    let active = true;
    const filePromise: Promise<File | null> = state.input.imageFile
      ? Promise.resolve(state.input.imageFile)
      : getCachedImageFile('upload')
        ? Promise.resolve(getCachedImageFile('upload')!)
        : loadPendingUpload();
    void filePromise.then((file) => {
      if (!active || !file) return;
      // 稳定 blob URL：同一张工作图跨页复用，命中浏览器已解码缓存，不再重新解码
      const url = cacheImageFile('upload', file);
      const image = new Image();
      image.onload = () => {
        if (!active) return;
        dispatch({
          type: 'input',
          input: {
            ...(state.input ?? {}),
            imageUrl: url,
            imageW: image.naturalWidth,
            imageH: image.naturalHeight,
            imageFile: file,
          } as CaptureInput,
        });
      };
      image.src = url;
    });
    return () => {
      active = false;
    };
  }, [blueprintId, restoredWizard, state.input]);

  //补录模式从服务端读取原图与已保存清单；清单不存在时仍允许手工录入。
  // 图片加载与清单加载解耦：清单加载只依赖 blueprintId（不随 state.input 变化
  // 重跑/取消）——否则图片 onload dispatch input 会触发 effect 清理，把
  // 尚未返回的清单 fetch 标记 inactive，导致保存过的清单“有概率”不展示。
  useEffect(() => {
    if (!blueprintId) return;
    let active = true;
    void (async () => {
      try {
        const saved = await getBlueprintLegend(blueprintId);
        if (!active) return;
        dispatch({
          type: 'inventory',
          inventory: saved.map((entry) => ({
            code: entry.code,
            count: entry.count,
            confirmed: entry.confirmed,
            row: entry.rowIndex,
            col: entry.colIndex,
            bbox: { x: entry.bbox.x, y: entry.bbox.y, w: entry.bbox.width, h: entry.bbox.height },
          })),
        });
        // 恢复图例区域框：已保存格子（有真实坐标）的外接矩形 = 之前的框选位置。
        // 仅当画布框仍是初始占位（用户尚未拖动/重画）时应用，避免覆盖用户操作。
        const boxes = saved
          .map((entry) => ({ x: entry.bbox.x, y: entry.bbox.y, w: entry.bbox.width, h: entry.bbox.height }))
          .filter((b) => b.w > 0 && b.h > 0);
        const current = boxRef.current;
        const isPlaceholder = !current || (current.x <= 0 && current.y <= 0 && current.w <= 100 && current.h <= 100);
        if (boxes.length > 0 && isPlaceholder) {
          const minX = Math.min(...boxes.map((b) => b.x));
          const minY = Math.min(...boxes.map((b) => b.y));
          const maxX = Math.max(...boxes.map((b) => b.x + b.w));
          const maxY = Math.max(...boxes.map((b) => b.y + b.h));
          dispatch({ type: 'box', box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } });
        }
      } catch {
        // An absent saved list is a valid补录 starting point.
      }
    })();
    return () => {
      active = false;
    };
  }, [blueprintId]);

  // 补录模式加载原图（独立于清单加载；清单在挂载即拉取，不受图片时序影响）
  useEffect(() => {
    if (!blueprintId || state.input) return;
    let active = true;
    void (async () => {
      try {
        // 命中缓存：跳过网络拉取 + 重新解码，切页瞬时恢复
        const cacheKey = `bp-${blueprintId}`;
        const cachedFile = getCachedImageFile(cacheKey);
        const cachedUrl = getCachedImageUrl(cacheKey);
        let file: File;
        let url: string;
        if (cachedFile && cachedUrl) {
          file = cachedFile;
          url = cachedUrl;
        } else {
          const response = await apiClient.get(`/blueprints/${blueprintId}/image`, { responseType: 'blob' });
          file = new File([response.data], `blueprint-${blueprintId}.jpg`, { type: response.data.type || 'image/jpeg' });
          url = cacheImageFile(cacheKey, file);
        }
        const image = new Image();
        image.onload = () => {
          if (!active) return;
          dispatch({
            type: 'input',
            input: { imageUrl: url, imageW: image.naturalWidth, imageH: image.naturalHeight, imageFile: file },
          });
        };
        image.src = url;
      } catch (error) {
        if (active) dispatch({ type: 'error', error: errorText(error) || '原图加载失败（权限或网络）' });
      }
    })();
    return () => {
      active = false;
    };
  }, [blueprintId, state.input]);

  const fit = useCallback(() => {
    const input = state.input;
    const stage = stageRef.current;
    if (!input || !stage || !input.imageW || !input.imageH) return;
    const scale = Math.min(stage.clientWidth / input.imageW, stage.clientHeight / input.imageH, 1.5);
    const view = {
      scale,
      x: (stage.clientWidth - input.imageW * scale) / 2,
      y: (stage.clientHeight - input.imageH * scale) / 2,
    };
    fitRef.current = scale;
    viewRef.current = view;
    dispatch({ type: 'view', view });
  }, [state.input]);

  useEffect(() => {
    fit();
    const stage = stageRef.current;
    if (!stage || !state.input) return;
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fit, state.input]);

  const recognize = useCallback(async () => {
    const input = state.input;
    if (!input?.imageFile) {
      dispatch({ type: 'error', error: '缺少原图文件，请从上传页进入' });
      return;
    }
    dispatch({ type: 'loading', loading: true });
    dispatch({ type: 'error', error: null });
    try {
      const result = await recognizeLegendBox(input.imageFile, apiBox(state.box));
      const code = result.code ?? result.rawCode ?? '';
      const count = result.count != null ? String(result.count) : result.rawCount ?? '';
      dispatch({ type: 'result', result, code, count });
      dispatch({
        type: 'grid',
        grid: [
          ...state.grid,
          {
            row: Number.MAX_SAFE_INTEGER,
            col: state.grid.length,
            bbox: state.box,
            result,
            code,
            count,
            loading: false,
            manual: true,
            confirmed: result.status === 'accepted',
            sourceId: `manual-${Date.now()}`,
          },
        ],
      });
      if (result.status === 'invalid') dispatch({ type: 'error', error: result.diagnostics ?? '选区无效' });
    } catch (error) {
      const result = failedResult(state.box, error);
      dispatch({ type: 'result', result });
      dispatch({ type: 'error', error: errorText(error) });
    } finally {
      dispatch({ type: 'loading', loading: false });
    }
  }, [state.box, state.grid, state.input]);

  const recognizeGrid = useCallback(async () => {
    const input = state.input;
    if (!input?.imageFile) {
      dispatch({ type: 'error', error: '缺少原图文件' });
      return;
    }
    const rows = clampGrid(state.rows);
    const cols = clampGrid(state.cols);
    const cellWidth = state.box.w / cols;
    const cellHeight = state.box.h / rows;
    const cells: GridCell[] = Array.from({ length: rows * cols }, (_, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      return {
        row,
        col,
        bbox: { x: state.box.x + col * cellWidth, y: state.box.y + row * cellHeight, w: cellWidth, h: cellHeight },
        result: null,
        code: '',
        count: '',
        loading: true,
        sourceId: `grid-${row}-${col}`,
      };
    });
    dispatch({ type: 'grid', grid: cells });
    dispatch({ type: 'gridLoading', value: true });
    dispatch({ type: 'progress', value: 0 });
    dispatch({ type: 'error', error: null });
    try {
      const response = await recognizeLegendGrid(input.imageFile, apiBox(state.box), rows, cols);
      const mapped = response.cells.map((cell) => ({
        row: cell.row,
        col: cell.col,
        bbox: { x: cell.bbox.x, y: cell.bbox.y, w: cell.bbox.width, h: cell.bbox.height },
        result: cell,
        code: cell.code ?? cell.rawCode ?? '',
        count: cell.count != null ? String(cell.count) : cell.rawCount ?? '',
        loading: false,
        sourceId: `grid-${cell.row}-${cell.col}`,
      }));
      dispatch({ type: 'grid', grid: mapped });
      dispatch({ type: 'progress', value: mapped.length });
    } catch (error) {
      const failed = cells.map((cell) => ({ ...cell, loading: false, result: failedResult(cell.bbox, error) }));
      dispatch({ type: 'grid', grid: failed });
      dispatch({ type: 'error', error: errorText(error) });
    } finally {
      dispatch({ type: 'gridLoading', value: false });
    }
  }, [state.box, state.cols, state.input, state.rows]);

  const retryGridCell = useCallback(async (index: number) => {
    const input = state.input;
    const cell = state.grid[index];
    if (!input?.imageFile || !cell) return;
    dispatch({ type: 'gridCell', index, cell: { ...cell, loading: true } });
    dispatch({ type: 'error', error: null });
    try {
      const result = await recognizeLegendBox(input.imageFile, apiBox(cell.bbox));
      dispatch({
        type: 'gridCell',
        index,
        cell: {
          ...cell,
          loading: false,
          result,
          code: result.code ?? result.rawCode ?? '',
          count: result.count != null ? String(result.count) : result.rawCount ?? '',
          confirmed: result.status === 'accepted',
        },
      });
    } catch (error) {
      dispatch({ type: 'gridCell', index, cell: { ...cell, loading: false, result: failedResult(cell.bbox, error), code: '', count: '' } });
      dispatch({ type: 'error', error: errorText(error) });
    }
  }, [state.grid, state.input]);

  const add = useCallback((material: Material, replace = false): { ok: boolean; duplicate?: Material } => {
    const code = normalizeMaterialCode(material.code);
    if (!code || !Number.isFinite(material.count) || material.count <= 0) {
      dispatch({ type: 'error', error: '请填写有效的编码和数量' });
      return { ok: false };
    }
    const normalized = { ...material, code, count: Math.round(material.count) };
    const index = state.inventory.findIndex((item) => normalizeMaterialCode(item.code) === code);
    if (index >= 0 && !replace) return { ok: false, duplicate: state.inventory[index] };
    const inventory = index >= 0
      ? state.inventory.map((item, itemIndex) => (itemIndex === index ? normalized : item))
      : [...state.inventory, normalized];
    dispatch({ type: 'inventory', inventory });
    dispatch({ type: 'error', error: null });
    return { ok: true, ...(index >= 0 ? { duplicate: state.inventory[index] } : {}) };
  }, [state.inventory]);

  return {
    state,
    dispatch,
    stageRef,
    boxRef,
    viewRef,
    fit,
    recognize,
    recognizeGrid,
    retryGridCell,
    add,
    fitRef,
  };
}
