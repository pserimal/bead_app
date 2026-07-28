import apiClient from './client';
import type { ColorLibrary, ColorEntry, ColorEntryCreate, ColorEntryUpdate } from '../types';

export async function getLibraries(): Promise<ColorLibrary[]> {
  const { data } = await apiClient.get<ColorLibrary[]>('/color-libraries');
  return data;
}

export async function getLibrary(id: number): Promise<ColorLibrary> {
  const { data } = await apiClient.get<ColorLibrary>(`/color-libraries/${id}`);
  return data;
}

export async function addEntry(libraryId: number, entry: ColorEntryCreate): Promise<ColorEntry> {
  const { data } = await apiClient.post<ColorEntry>(`/color-libraries/${libraryId}/entries`, entry);
  return data;
}

export async function updateEntry(
  libraryId: number,
  entryId: number,
  entry: ColorEntryUpdate,
): Promise<ColorEntry> {
  const { data } = await apiClient.put<ColorEntry>(
    `/color-libraries/${libraryId}/entries/${entryId}`,
    entry,
  );
  return data;
}

export async function deleteEntry(libraryId: number, entryId: number): Promise<void> {
  await apiClient.delete(`/color-libraries/${libraryId}/entries/${entryId}`);
}
