from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, List
from datetime import datetime


class CellResponse(BaseModel):
    id: int
    blueprint_id: int
    row_idx: int
    col_idx: int
    bead_code: Optional[str] = None
    pixel_color: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class CellUpdateRequest(BaseModel):
    id: int
    bead_code: str = Field(..., min_length=1, max_length=10)


class CellUpdateBatch(BaseModel):
    cells: List[CellUpdateRequest]


class BlueprintCreate(BaseModel):
    name: Optional[str] = None


class BlueprintResponse(BaseModel):
    id: int
    name: Optional[str] = None
    original_filename: Optional[str] = None
    grid_rows: int
    grid_cols: int
    valid_codes: Optional[str] = None
    status: str
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class BlueprintDetailResponse(BlueprintResponse):
    cells: List[CellResponse] = []


class UploadResponse(BaseModel):
    id: int
    status: str
    message: str = "Blueprint uploaded and queued for parsing"


class StatusResponse(BaseModel):
    id: int
    status: str
    progress: Optional[str] = None
