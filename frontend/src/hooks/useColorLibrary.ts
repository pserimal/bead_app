import { useQuery } from '@tanstack/react-query';
import * as colorsApi from '../api/colors';

export function useColors(q?: string, page = 1) {
  return useQuery({
    queryKey: ['colors', q, page],
    queryFn: () => colorsApi.getColors({ q, page, pageSize: 100 }),
  });
}

export function useColor(code: string | null) {
  return useQuery({
    queryKey: ['color', code],
    queryFn: () => colorsApi.getColor(code!),
    enabled: !!code,
  });
}
