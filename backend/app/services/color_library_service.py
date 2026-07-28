from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.color_library import ColorLibrary
from app.models.color_entry import ColorEntry
from app.schemas.color import ColorEntryCreate, ColorEntryUpdate


async def get_libraries(db: AsyncSession):
    result = await db.execute(select(ColorLibrary))
    return result.scalars().all()


async def get_library(db: AsyncSession, library_id: int):
    result = await db.execute(
        select(ColorLibrary)
        .where(ColorLibrary.id == library_id)
        .options(selectinload(ColorLibrary.entries))
    )
    return result.scalar_one_or_none()


async def add_entry(db: AsyncSession, library_id: int, data: ColorEntryCreate):
    existing = await db.execute(
        select(ColorEntry).where(
            ColorEntry.library_id == library_id,
            ColorEntry.code == data.code,
        )
    )
    if existing.scalar_one_or_none():
        return None

    entry = ColorEntry(
        library_id=library_id,
        code=data.code,
        color_hex=data.color_hex,
        color_name=data.color_name,
        sort_order=data.sort_order,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    return entry


async def update_entry(db: AsyncSession, entry_id: int, data: ColorEntryUpdate):
    result = await db.execute(select(ColorEntry).where(ColorEntry.id == entry_id))
    entry = result.scalar_one_or_none()
    if not entry:
        return None
    if data.code is not None:
        entry.code = data.code
    if data.color_hex is not None:
        entry.color_hex = data.color_hex
    if data.color_name is not None:
        entry.color_name = data.color_name
    if data.sort_order is not None:
        entry.sort_order = data.sort_order
    await db.commit()
    await db.refresh(entry)
    return entry


async def delete_entry(db: AsyncSession, entry_id: int):
    result = await db.execute(select(ColorEntry).where(ColorEntry.id == entry_id))
    entry = result.scalar_one_or_none()
    if entry:
        await db.delete(entry)
        await db.commit()
        return True
    return False
