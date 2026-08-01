import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as jobsApi from '../api/jobs';
import type { JobDetail } from '../types/api';

export function useJobs(status?: string, page = 1) {
  return useQuery({
    queryKey: ['jobs', status, page],
    queryFn: () => jobsApi.getJobs({ status, page, pageSize: 12 }),
  });
}

export function useJob(id: string | null) {
  return useQuery({
    queryKey: ['job', id],
    queryFn: () => jobsApi.getJob(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = (query.state.data as JobDetail | undefined)?.status;
      // 012 决议：处理中固定 2s 轮询；终态停止
      return status === 'PENDING' || status === 'PROCESSING' ? 2000 : false;
    },
  });
}

export function useJobEvents(id: string | null, status?: JobDetail['status']) {
  return useQuery({
    queryKey: ['job-events', id],
    queryFn: () => jobsApi.getJobEvents(id!),
    enabled: !!id,
    // 012：终态后事件不再增长，停止轮询
    refetchInterval: status === 'PENDING' || status === 'PROCESSING' ? 2000 : false,
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: Parameters<typeof jobsApi.createJob>[0]) => jobsApi.createJob(params),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });
}
