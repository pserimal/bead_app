import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as api from '../api/colors';
import type { ColorEntryCreate, ColorEntryUpdate } from '../types';

export function useColorLibraries() {
  return useQuery({ queryKey: ['colorLibraries'], queryFn: api.getLibraries });
}

export function useColorLibrary(id: number | null) {
  return useQuery({
    queryKey: ['colorLibrary', id],
    queryFn: () => api.getLibrary(id!),
    enabled: id !== null && id > 0,
  });
}

export function useAddColorEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ libraryId, entry }: { libraryId: number; entry: ColorEntryCreate }) =>
      api.addEntry(libraryId, entry),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['colorLibraries'] }),
  });
}

export function useUpdateColorEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      libraryId,
      entryId,
      entry,
    }: {
      libraryId: number;
      entryId: number;
      entry: ColorEntryUpdate;
    }) => api.updateEntry(libraryId, entryId, entry),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['colorLibraries'] }),
  });
}

export function useDeleteColorEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ libraryId, entryId }: { libraryId: number; entryId: number }) =>
      api.deleteEntry(libraryId, entryId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['colorLibraries'] }),
  });
}
