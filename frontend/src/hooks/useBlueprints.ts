import { useQuery } from '@tanstack/react-query';
import * as blueprintsApi from '../api/blueprints';

export function useBlueprints(page = 1) {
  return useQuery({
    queryKey: ['blueprints', page],
    queryFn: () => blueprintsApi.getBlueprints(page),
  });
}

export function useBlueprint(id: string | null) {
  return useQuery({
    queryKey: ['blueprint', id],
    queryFn: () => blueprintsApi.getBlueprint(id!),
    enabled: !!id,
  });
}
