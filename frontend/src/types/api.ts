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
export type CellStatus = 'MAPPED' | 'UNMAPPED' | 'BLANK';
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
  brand?: string | null;
}

export interface JobDetail {
  id: string;
  name: string | null;
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
  name: string | null;
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
  confidence: number | null;
  correctedCode: string | null;
  correctedAt: string | null;
}

export interface CropBoxDto {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlueprintDetail {
  id: string;
  jobId: string;
  rows: number;
  cols: number;
  validCodes: string[] | null;
  cells: BlueprintCellDto[];
  cropBox: CropBoxDto | null;
  /** 03：物料拆分配置（框选位置 + 行列数，服务端持久化；旧数据为 null） */
  materialsBox: CropBoxDto | null;
  materialsRows: number | null;
  materialsCols: number | null;
  createdAt: string;
}

/** 03：保存物料的拆分配置（归一化框 0..1 + 网格行列 0..20） */
export interface BlueprintMaterialsConfig {
  materialsBox?: { x: number; y: number; w: number; h: number } | null;
  materialsRows?: number | null;
  materialsCols?: number | null;
}

/** 低置信度校正：单格更新（code = null 恢复原识别码；BLANK 标记空白格） */
export interface CellCorrectionUpdate {
  row: number;
  col: number;
  code: string | null;
}

export interface CellCorrectionResponse {
  cells: BlueprintCellDto[];
  correctedCount: number;
  revertedCount: number;
}
