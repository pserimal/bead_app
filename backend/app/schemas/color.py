from pydantic import BaseModel, ConfigDict, Field
from typing import Optional
from datetime import datetime


class ColorEntryCreate(BaseModel):
    code: str = Field(
        ...,
        min_length=1,
        max_length=10,
        description="e.g., H2, F5, G7",
    )
    color_hex: str = Field(..., pattern=r"^#[0-9A-Fa-f]{6}$")
    color_name: Optional[str] = None
    sort_order: int = Field(default=0, ge=0)


class ColorEntryUpdate(BaseModel):
    code: Optional[str] = None
    color_hex: Optional[str] = None
    color_name: Optional[str] = None
    sort_order: Optional[int] = None


class ColorEntryResponse(BaseModel):
    id: int
    library_id: int
    code: str
    color_hex: str
    color_name: Optional[str] = None
    sort_order: int

    model_config = ConfigDict(from_attributes=True)


class ColorLibraryResponse(BaseModel):
    id: int
    name: str
    is_default: bool
    created_at: datetime
    entries: list[ColorEntryResponse] = []

    model_config = ConfigDict(from_attributes=True)


class ColorLibrarySummary(BaseModel):
    """Lightweight response without entries list"""

    id: int
    name: str
    is_default: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
