import apiClient from './client';
import type { ColorDto, PageResponse } from '../types/api';

/** 007：颜色库（q 前缀搜索 + 分页） */
export async function getColors(params: { q?: string; page?: number; pageSize?: number } = {}): Promise<PageResponse<ColorDto>> {
  const { data } = await apiClient.get('/colors', { params });
  return data;
}

export async function getColor(code: string): Promise<ColorDto> {
  const { data } = await apiClient.get(`/colors/${code}`);
  return data;
}
