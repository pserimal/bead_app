import apiClient from './client';
import type {
  Blueprint,
  BlueprintDetail,
  UploadResponse,
  PaginatedResponse,
  CellUpdateBatch,
  CellResponse,
} from '../types';

export async function uploadBlueprint(file: File, name?: string, gridRows?: number, gridCols?: number, validCodes?: string, boardBbox?: string): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('image', file);
  if (name) formData.append('name', name);
  if (gridRows) formData.append('grid_rows', String(gridRows));
  if (gridCols) formData.append('grid_cols', String(gridCols));
  if (validCodes) formData.append('valid_codes', validCodes);
  if (boardBbox) formData.append('board_bbox', boardBbox);
  const { data } = await apiClient.post<UploadResponse>('/blueprints/upload', formData);
  return data;
}

export async function getBlueprints(page = 1, pageSize = 12): Promise<PaginatedResponse<Blueprint>> {
  const { data } = await apiClient.get('/blueprints', { params: { page, page_size: pageSize } });
  return data;
}

export async function getBlueprint(id: number): Promise<BlueprintDetail> {
  const { data } = await apiClient.get(`/blueprints/${id}`);
  return data;
}

export async function updateCells(id: number, cells: CellUpdateBatch): Promise<CellResponse[]> {
  const { data } = await apiClient.put(`/blueprints/${id}/cells`, cells);
  return data;
}

export async function deleteBlueprint(id: number): Promise<void> {
  await apiClient.delete(`/blueprints/${id}`);
}
