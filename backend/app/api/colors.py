from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.color import (
    ColorEntryCreate,
    ColorEntryResponse,
    ColorEntryUpdate,
    ColorLibraryResponse,
    ColorLibrarySummary,
)
import app.services.color_library_service as svc

router = APIRouter(prefix="/api/color-libraries", tags=["colors"])


@router.get("", response_model=list[ColorLibrarySummary])
async def list_libraries(db: AsyncSession = Depends(get_db)):
    return await svc.get_libraries(db)


@router.get("/{library_id}", response_model=ColorLibraryResponse)
async def get_library(library_id: int, db: AsyncSession = Depends(get_db)):
    lib = await svc.get_library(db, library_id)
    if not lib:
        raise HTTPException(status_code=404, detail="Library not found")
    return lib


@router.post("/{library_id}/entries", response_model=ColorEntryResponse, status_code=201)
async def add_entry(
    library_id: int, data: ColorEntryCreate, db: AsyncSession = Depends(get_db)
):
    entry = await svc.add_entry(db, library_id, data)
    if entry is None:
        raise HTTPException(status_code=409, detail="Color code already exists in this library")
    return entry


@router.put("/{library_id}/entries/{entry_id}", response_model=ColorEntryResponse)
async def update_entry(
    library_id: int,
    entry_id: int,
    data: ColorEntryUpdate,
    db: AsyncSession = Depends(get_db),
):
    entry = await svc.update_entry(db, entry_id, data)
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry


@router.delete("/{library_id}/entries/{entry_id}", status_code=204)
async def delete_entry(
    library_id: int, entry_id: int, db: AsyncSession = Depends(get_db)
):
    deleted = await svc.delete_entry(db, entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Entry not found")
