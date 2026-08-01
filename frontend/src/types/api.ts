// 007 决议：/api/v1 契约类型（与 backend server/schema/Dtos.kt 对应）

export interface PageResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown> | null;
  traceId?: string | null;
}

export type JobStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'SUCCEEDED_WITH_WARNINGS' | 'FAILED';
export type JobStage = 'QUEUED' | 'OCR';
export type CellStatus = 'MAPPED' | 'UNMAPPED';
export type EventType =
  | 'JOB_STARTED'
  | 'CELL_PROCESSED'
  | 'CELL_FAILED'
  | 'HEARTBEAT'
  | 'RETRY_SCHEDULED'
  | 'JOB_SUCCEEDED'
  | 'JOB_FAILED';

export interface ColorDto {
  code: string;
  name: string;
  hex: string;
}

export interface JobDetail {
  id: string;
  status: JobStatus;
  stage: JobStage;
  processedCells: number;
  totalCells: number;
  heartbeatAt: string | null;
  attempt: number;
  maxRetries: number;
  retryCount: number;
  blueprintId: string | null;
  error: { code: string; message: string } | null;
  warnings: { code: string; row: number; col: number; detail?: string | null }[];
  snapshot: { model: string; colorLibraryVersion: string };
  createdAt: string;
  updatedAt: string;
}

export interface JobSummary {
  id: string;
  status: JobStatus;
  stage: JobStage;
  processedCells: number;
  totalCells: number;
  rows: number;
  cols: number;
  attempt: number;
  retryCount: number;
  blueprintId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobEventDto {
  attempt: number;
  sequence: number;
  type: EventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface BlueprintSummary {
  id: string;
  jobId: string;
  rows: number;
  cols: number;
  createdAt: string;
}

export interface BlueprintCellDto {
  row: number;
  col: number;
  code: string;
  status: CellStatus;
  color: ColorDto | null;
}

export interface BlueprintDetail {
  id: string;
  jobId: string;
  rows: number;
  cols: number;
  validCodes: string[] | null;
  cells: BlueprintCellDto[];
  createdAt: string;
}
