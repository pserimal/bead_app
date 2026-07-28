from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

import app.db as app_db
from app.db import get_db
from app.schemas.blueprint import (
    BlueprintDetailResponse,
    BlueprintResponse,
    CellResponse,
    CellUpdateBatch,
)
from app.schemas.common import PaginatedResponse
from app.services.storage import file_storage
import app.services.blueprint_service as svc

router = APIRouter(prefix="/api/blueprints", tags=["blueprints"])

ALLOWED_TYPES = {"image/jpeg", "image/png"}
_MAX_SIZE = 20 * 1024 * 1024


import asyncio
import functools


async def _run_parse(image_path: str, blueprint_id: int,
                     grid_rows: int | None = None,
                     grid_cols: int | None = None,
                     valid_codes: list[str] | None = None,
                     board_bbox: str | None = None) -> None:
    """Background: OCR bead board and save cells to DB."""
    loop = asyncio.get_event_loop()
    try:
        # Parse board_bbox: "x,y,w,h" → tuple
        if board_bbox:
            parts = [int(p.strip()) for p in board_bbox.split(",")]
            if len(parts) == 4:
                user_bbox = (parts[0], parts[1], parts[2], parts[3])
            else:
                user_bbox = None
        else:
            user_bbox = None

        from app.services.bead_parser import BeadPatternParser
        parser = BeadPatternParser()

        run_in_executor = functools.partial(
            loop.run_in_executor,
        )
        result = await loop.run_in_executor(
            None, lambda: parser.parse(
                image_path,
                user_rows=grid_rows,
                user_cols=grid_cols,
                user_bbox=user_bbox,
            )
        )
        async with app_db.async_session() as db:
            await svc.save_parsed_cells(db, blueprint_id, result)
    except Exception:
        import traceback
        traceback.print_exc()
        async with app_db.async_session() as db2:
            await svc.update_blueprint_status(db2, blueprint_id, "error")


@router.post("/upload", status_code=201)
async def upload_blueprint(
    image: UploadFile = File(...),
    name: str = Form(None),
    grid_rows: int = Form(None),
    grid_cols: int = Form(None),
    valid_codes: str = Form(None),
    board_bbox: str = Form(None),  # "x1,y1,x2,y2" for bead board
    card_bbox: str = Form(None),   # "x1,y1,x2,y2" for color card
    background_tasks: BackgroundTasks = None,
    db: AsyncSession = Depends(get_db),
):
    """Upload a blueprint image and start async parsing."""
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, "Only JPG/PNG images are supported")

    content = await image.read()
    if len(content) > _MAX_SIZE:
        raise HTTPException(413, f"File too large (max {_MAX_SIZE // 1024 // 1024}MB)")

    # Parse comma-separated valid codes into a list
    codes_list: list[str] | None = None
    if valid_codes:
        codes_list = [c.strip().upper() for c in valid_codes.split(",") if c.strip()]
        if not codes_list:
            codes_list = None

    # Store as comma-separated string for DB
    valid_codes_str = ",".join(codes_list) if codes_list else None

    # Pass content to avoid re-reading a consumed UploadFile
    rel_path = await file_storage.save_upload(image, content=content)
    abs_path = str(file_storage.get_path(rel_path))

    blueprint = await svc.create_blueprint(
        db, name=name or image.filename, filename=image.filename,
        image_path=rel_path, valid_codes=valid_codes_str,
    )

    background_tasks.add_task(_run_parse, abs_path, blueprint.id, grid_rows, grid_cols, codes_list, board_bbox)

    return {
        "id": blueprint.id,
        "status": "processing",
        "message": "Blueprint uploaded, parsing started",
    }


@router.get("/{blueprint_id}/status")
async def get_blueprint_status(
    blueprint_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Poll the parse status of a blueprint."""
    bp = await svc.get_blueprint(db, blueprint_id)
    if not bp:
        raise HTTPException(404, "Blueprint not found")
    return {"id": bp.id, "status": bp.status}


@router.get("", response_model=PaginatedResponse[BlueprintResponse])
async def list_blueprints(
    page: int = Query(1, ge=1),
    page_size: int = Query(12, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Return a paginated list of blueprints (newest first)."""
    items, total = await svc.get_blueprints(db, page, page_size)
    return PaginatedResponse(items=items, total=total, page=page, page_size=page_size)


@router.get("/{blueprint_id}", response_model=BlueprintDetailResponse)
async def get_blueprint_detail(
    blueprint_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Return a single blueprint with all its cells."""
    bp = await svc.get_blueprint(db, blueprint_id)
    if not bp:
        raise HTTPException(status_code=404, detail="Blueprint not found")
    return bp


@router.put("/{blueprint_id}/cells", response_model=list[CellResponse])
async def update_blueprint_cells(
    blueprint_id: int,
    batch: CellUpdateBatch,
    db: AsyncSession = Depends(get_db),
):
    """Batch-update bead codes for cells of a blueprint."""
    bp = await svc.get_blueprint(db, blueprint_id)
    if not bp:
        raise HTTPException(status_code=404, detail="Blueprint not found")
    cells = [c.model_dump() for c in batch.cells]
    updated = await svc.update_cells(db, blueprint_id, cells)
    return updated


@router.delete("/{blueprint_id}", status_code=204)
async def delete_blueprint(
    blueprint_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Delete a blueprint, its cells, and the uploaded image file."""
    deleted = await svc.delete_blueprint(db, blueprint_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Blueprint not found")


@router.post("/parse-legend", status_code=200)
async def parse_legend(
    image: UploadFile = File(...),
):
    """Upload a crop of the color legend. Returns detected bead codes."""
    raise HTTPException(501, "This endpoint has been removed (dead CV pipeline was deleted).")
