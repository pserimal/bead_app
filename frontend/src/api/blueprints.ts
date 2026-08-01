import apiClient from './client';
import type { BlueprintDetail, BlueprintSummary, PageResponse } from '../types/api';

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
