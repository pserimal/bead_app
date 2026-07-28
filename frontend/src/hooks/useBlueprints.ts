import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/blueprints';
import type { CellUpdateBatch } from '../types';

export function useBlueprints(page = 1) {
  return useQuery({
    queryKey: ['blueprints', page],
    queryFn: () => api.getBlueprints(page),
  });
}

export function useBlueprint(id: number | null) {
  return useQuery({
    queryKey: ['blueprint', id],
    queryFn: () => api.getBlueprint(id!),
    enabled: id !== null && id > 0,
  });
}

export function useUploadBlueprint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, name, gridRows, gridCols, validCodes, boardBbox }: { file: File; name?: string; gridRows?: number; gridCols?: number; validCodes?: string; boardBbox?: string }) =>
      api.uploadBlueprint(file, name, gridRows, gridCols, validCodes, boardBbox),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['blueprints'] }),
  });
}

export function useUpdateCells() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cells }: { id: number; cells: CellUpdateBatch }) =>
      api.updateCells(id, cells),
    onSuccess: (_, variables) =>
      queryClient.invalidateQueries({ queryKey: ['blueprint', variables.id] }),
  });
}

export function useDeleteBlueprint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteBlueprint(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['blueprints'] }),
  });
}
