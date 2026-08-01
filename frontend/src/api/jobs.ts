import apiClient from './client';
import type { JobDetail, JobEventDto, JobSummary, PageResponse } from '../types/api';

/** 007：创建任务（multipart：image + cropBox + rows/cols + codes） */
export async function createJob(params: {
  image: File;
  cropBoxX: number;
  cropBoxY: number;
  cropBoxWidth: number;
  cropBoxHeight: number;
  rows: number;
  cols: number;
  codes?: string;
}): Promise<JobDetail> {
  const formData = new FormData();
  formData.append('image', params.image);
  formData.append('cropBoxX', String(params.cropBoxX));
  formData.append('cropBoxY', String(params.cropBoxY));
  formData.append('cropBoxWidth', String(params.cropBoxWidth));
  formData.append('cropBoxHeight', String(params.cropBoxHeight));
  formData.append('rows', String(params.rows));
  formData.append('cols', String(params.cols));
  if (params.codes) formData.append('codes', params.codes);
  const { data } = await apiClient.post<JobDetail>('/jobs', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}

/** 007：任务历史（分页 + status 筛选） */
export async function getJobs(params: {
  status?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<PageResponse<JobSummary>> {
  const { data } = await apiClient.get('/jobs', { params });
  return data;
}

/** 007：任务详情 */
export async function getJob(id: string): Promise<JobDetail> {
  const { data } = await apiClient.get(`/jobs/${id}`);
  return data;
}

/** 007：只读事件流（sortDir=desc 返回最近事件） */
export async function getJobEvents(id: string, pageSize = 50, sortDir: 'asc' | 'desc' = 'desc'): Promise<PageResponse<JobEventDto>> {
  const { data } = await apiClient.get(`/jobs/${id}/events`, { params: { pageSize, sortDir } });
  return data;
}
