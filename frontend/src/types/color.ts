export interface ColorEntry {
  id: number;
  library_id: number;
  code: string;
  color_hex: string;
  color_name: string | null;
  sort_order: number;
}

export interface ColorLibrary {
  id: number;
  name: string;
  is_default: boolean;
  created_at: string;
  entries: ColorEntry[];
}

export interface ColorLibrarySummary {
  id: number;
  name: string;
  is_default: boolean;
  created_at: string;
}

export interface ColorEntryCreate {
  code: string;
  color_hex: string;
  color_name?: string | null;
  sort_order?: number;
}

export interface ColorEntryUpdate {
  code?: string;
  color_hex?: string;
  color_name?: string | null;
  sort_order?: number;
}
