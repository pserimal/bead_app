import apiClient from './client';
import type { BlueprintDetail, BlueprintMaterialsConfig, BlueprintSummary, CellCorrectionResponse, CellCorrectionUpdate, PageResponse } from '../types/api';

/** 007：图纸列表（摘要） */
export async function getBlueprints(page = 1, pageSize = 12): Promise<PageResponse<BlueprintSummary>> {
  const { data } = await apiClient.get('/blueprints', { params: { page, pageSize } });
  return data;
}

/** 007：图纸详情（cells 内嵌） */
export async function getBlueprint(id: string): Promise<BlueprintDetail> {
  const { data } = await apiClient.get(`/blueprints/${id}`);
  return data;
}

/** 低置信度校正：批量设置/恢复修正编码（多格原子提交） */
export async function updateBlueprintCells(
  id: string,
  updates: CellCorrectionUpdate[],
): Promise<CellCorrectionResponse> {
  const { data } = await apiClient.patch(`/blueprints/${id}/cells`, { updates });
  return data;
}

/** 03：保存物料拆分配置（归一化框 + 行列），PATCH 幂等整体重写 */
export async function saveBlueprintMaterialsConfig(
  id: string,
  config: BlueprintMaterialsConfig,
): Promise<BlueprintDetail> {
  const { data } = await apiClient.patch<BlueprintDetail>(`/blueprints/${id}`, config);
  return data;
}
