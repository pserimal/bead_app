import apiClient from './client';

export interface LegendBoxBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LegendBoxResult {
  code: string | null;
  count: number | null;
  rawCode: string | null;
  rawCount: string | null;
  codeConfidence: number | null;
  countConfidence: number | null;
  overallConfidence: number;
  status: 'accepted' | 'needs_confirmation' | 'invalid' | 'recognition_failed' | 'model_unavailable';
  candidates: Record<string, string[]>;
  bbox: LegendBoxBbox | null;
  expandedBbox: LegendBoxBbox | null;
  diagnostics?: string | null;
}

export async function recognizeLegendBox(image: File, bbox: LegendBoxBbox, brand: string = 'mard'): Promise<LegendBoxResult> {
  const form = new FormData();
  form.append('image', image);
  form.append('x', String(bbox.x));
  form.append('y', String(bbox.y));
  form.append('width', String(bbox.width));
  form.append('height', String(bbox.height));
  if (brand) form.append('brand', brand);
  const { data } = await apiClient.post<LegendBoxResult>('/legend/box', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

export interface LegendGridResponse {
  rows: number;
  cols: number;
  bbox: LegendBoxBbox;
  cells: Array<LegendBoxResult & { row: number; col: number; bbox: LegendBoxBbox }>;
}

export async function recognizeLegendGrid(image: File, bbox: LegendBoxBbox, rows: number, cols: number): Promise<LegendGridResponse> {
  const form = new FormData();
  form.append('image', image);
  form.append('x', String(bbox.x));
  form.append('y', String(bbox.y));
  form.append('width', String(bbox.width));
  form.append('height', String(bbox.height));
  form.append('rows', String(rows));
  form.append('cols', String(cols));
  const { data } = await apiClient.post<LegendGridResponse>('/legend/grid', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

// Test hook: send pre-OCRed words for contract verification
export async function recognizeLegendBoxWithWords(
  image: File,
  bbox: LegendBoxBbox,
  words: Array<{ text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }>,
): Promise<LegendBoxResult> {
  const form = new FormData();
  form.append('image', image);
  form.append('x', String(bbox.x));
  form.append('y', String(bbox.y));
  form.append('width', String(bbox.width));
  form.append('height', String(bbox.height));
  form.append('words', JSON.stringify(words));
  const { data } = await apiClient.post<LegendBoxResult>('/legend/box', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

// ── Legend persistence (021 物料清单记录与对比) ────────────────────────────

export interface LegendBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LegendEntry {
  ordinal: number;
  rowIndex: number;
  colIndex: number;
  code: string;
  count: number;
  status: string;
  source: string;
  confirmed: boolean;
  bbox: LegendBbox;
}

/** 蓝图已存物料清单（未设置时为空数组） */
export async function getBlueprintLegend(id: string): Promise<LegendEntry[]> {
  const { data } = await apiClient.get<LegendEntry[]>(`/blueprints/${id}/legend`);
  return data;
}

/** 整体替换蓝图物料清单（补录 / 后续修改，幂等保存） */
export async function saveBlueprintLegend(id: string, entries: LegendEntry[]): Promise<{ count: number }> {
  const { data } = await apiClient.post<{ count: number }>(`/blueprints/${id}/legend`, entries);
  return data;
}

/** 导出已确认图例单元格样本 zip（攒训练标注用），触发浏览器下载 */
export async function exportLegendSamples(id: string): Promise<void> {
  const res = await apiClient.get(`/blueprints/${id}/legend/export`, { responseType: 'blob' });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement('a');
  a.href = url;
  const disp: string = res.headers?.['content-disposition'] ?? '';
  const m = disp.match(/filename=(\S+)/);
  a.download = m ? m[1] : `legend-samples-${id.slice(0, 8)}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
