export interface CellResponse {
  id: number;
  blueprint_id: number;
  row_idx: number;
  col_idx: number;
  bead_code: string | null;
  pixel_color: string | null;
}

export interface CellUpdateRequest {
  id: number;
  bead_code: string;
}

export interface CellUpdateBatch {
  cells: CellUpdateRequest[];
}

export interface Blueprint {
  id: number;
  name: string | null;
  original_filename: string | null;
  grid_rows: number;
  grid_cols: number;
  status: BlueprintStatus;
  created_at: string;
}

export interface BlueprintDetail extends Blueprint {
  cells: CellResponse[];
}

export interface UploadResponse {
  id: number;
  status: BlueprintStatus;
  message: string;
}

export interface StatusResponse {
  id: number;
  status: BlueprintStatus;
  progress: string | null;
}

export type BlueprintStatus = 'processing' | 'ready' | 'error';

export type { CellResponse as Cell };
