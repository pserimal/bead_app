from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.models.blueprint import Blueprint
from app.models.blueprint_cell import BlueprintCell


async def get_blueprints(db: AsyncSession, page: int = 1, page_size: int = 12):
    """Get paginated list of blueprints ordered by creation date descending."""
    count_query = select(func.count(Blueprint.id))
    total = (await db.execute(count_query)).scalar()

    offset = (page - 1) * page_size
    query = (
        select(Blueprint)
        .order_by(Blueprint.created_at.desc())
        .offset(offset)
        .limit(page_size)
    )
    result = await db.execute(query)
    return result.scalars().all(), total


async def get_blueprint(db: AsyncSession, blueprint_id: int):
    result = await db.execute(
        select(Blueprint)
        .options(selectinload(Blueprint.cells))
        .where(Blueprint.id == blueprint_id)
    )
    return result.scalar_one_or_none()


async def update_cells(
    db: AsyncSession, blueprint_id: int, cells: list[dict]
):
    """Batch-update bead_code for cells belonging to a blueprint.

    ``cells`` should be a list of dicts with keys ``id`` and ``bead_code``.
    Only cells whose ``id`` matches an existing cell on this blueprint are
    updated; unknown ids are silently skipped.
    """
    updated = []
    for cell_data in cells:
        result = await db.execute(
            select(BlueprintCell).where(
                BlueprintCell.id == cell_data["id"],
                BlueprintCell.blueprint_id == blueprint_id,
            )
        )
        cell = result.scalar_one_or_none()
        if cell:
            cell.bead_code = cell_data["bead_code"]
            updated.append(cell)
    await db.commit()
    return updated


async def create_blueprint(
    db: AsyncSession, name: str, filename: str, image_path: str,
    valid_codes: str | None = None,
) -> Blueprint:
    """Create a new blueprint record with status='processing'."""
    bp = Blueprint(
        name=name,
        original_filename=filename,
        image_path=image_path,
        valid_codes=valid_codes,
        status="processing",
    )
    db.add(bp)
    await db.commit()
    await db.refresh(bp)
    return bp


async def update_blueprint_status(
    db: AsyncSession, blueprint_id: int, status: str
) -> None:
    bp = await get_blueprint(db, blueprint_id)
    if bp:
        bp.status = status
        await db.commit()


async def save_parsed_cells(
    db: AsyncSession, blueprint_id: int, parse_result: dict
) -> None:
    """Save parsed cells and update blueprint dimensions.

    ``parse_result`` should have keys ``grid_rows``, ``grid_cols``, and
    ``cells`` where each cell dict has ``row``, ``col``, and ``bead_code``.
    """
    bp = await get_blueprint(db, blueprint_id)
    if not bp:
        return

    bp.grid_rows = parse_result["grid_rows"]
    bp.grid_cols = parse_result["grid_cols"]
    bp.status = "ready"

    for cell_data in parse_result["cells"]:
        cell = BlueprintCell(
            blueprint_id=blueprint_id,
            row_idx=cell_data["row"],
            col_idx=cell_data["col"],
            bead_code=cell_data["bead_code"],
            pixel_color=cell_data.get("pixel_color"),
        )
        db.add(cell)

    await db.commit()


async def update_cell_codes(
    db: AsyncSession, blueprint_id: int, cells: list[dict]
) -> None:
    """Update bead codes and pixel colors from OCR results."""
    for cell_data in cells:
        code = cell_data.get("bead_code")
        color = cell_data.get("pixel_color")
        if not code and not color:
            continue
        result = await db.execute(
            select(BlueprintCell).where(
                BlueprintCell.blueprint_id == blueprint_id,
                BlueprintCell.row_idx == cell_data["row"],
                BlueprintCell.col_idx == cell_data["col"],
            )
        )
        db_cell = result.scalar_one_or_none()
        if db_cell:
            if code:
                db_cell.bead_code = code
            if color:
                db_cell.pixel_color = color
    await db.commit()


async def delete_blueprint(db: AsyncSession, blueprint_id: int):
    """Delete a blueprint, its cells (via cascade), and the image file."""
    bp = await get_blueprint(db, blueprint_id)
    if bp:
        from app.services.storage import file_storage

        if bp.image_path:
            file_storage.delete(bp.image_path)
        await db.delete(bp)
        await db.commit()
        return True
    return False
