import apiClient from './client';

export interface ModelMeta {
  id: string;
  arch?: string | null;
  numClasses?: number | null;
}

export interface ModelsResponse {
  items: ModelMeta[];
  current: string | null;
}

export async function getModels(): Promise<ModelsResponse> {
  const { data } = await apiClient.get<ModelsResponse>('/models');
  return data;
}

export async function activateModel(id: string): Promise<{ current: string; switched: boolean }> {
  const { data } = await apiClient.post(`/models/${id}/activate`);
  return data;
}
