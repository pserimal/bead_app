import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models import Base, Blueprint, ColorEntry, ColorLibrary
from app.models.blueprint_cell import BlueprintCell


@pytest_asyncio.fixture
async def engine():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def session(engine):
    session_factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with session_factory() as session:
        yield session


# --- ColorLibrary ---

@pytest.mark.asyncio
async def test_color_library_creation(session: AsyncSession):
    lib = ColorLibrary(name="Default Palette", is_default=True)
    session.add(lib)
    await session.commit()

    result = await session.get(ColorLibrary, lib.id)
    assert result is not None
    assert result.name == "Default Palette"
    assert result.is_default is True
    assert result.created_at is not None


@pytest.mark.asyncio
async def test_color_library_defaults(session: AsyncSession):
    lib = ColorLibrary(name="User Colors")
    session.add(lib)
    await session.commit()

    result = await session.get(ColorLibrary, lib.id)
    assert result.is_default is False


# --- ColorEntry ---

@pytest.mark.asyncio
async def test_color_entry_creation(session: AsyncSession):
    lib = ColorLibrary(name="DMC Threads")
    session.add(lib)
    await session.commit()

    entry = ColorEntry(
        library_id=lib.id,
        code="310",
        color_hex="#000000",
        color_name="Black",
    )
    session.add(entry)
    await session.commit()

    result = await session.get(ColorEntry, entry.id)
    assert result is not None
    assert result.code == "310"
    assert result.color_hex == "#000000"
    assert result.color_name == "Black"
    assert result.library_id == lib.id


@pytest.mark.asyncio
async def test_color_entry_unique_constraint(session: AsyncSession):
    lib = ColorLibrary(name="Test")
    session.add(lib)
    await session.commit()

    e1 = ColorEntry(library_id=lib.id, code="BLK", color_hex="#111111")
    e2 = ColorEntry(library_id=lib.id, code="BLK", color_hex="#222222")
    session.add_all([e1, e2])

    with pytest.raises(Exception):
        await session.commit()
    await session.rollback()


@pytest.mark.asyncio
async def test_color_entry_cascade_on_library_delete(session: AsyncSession):
    lib = ColorLibrary(name="Temp")
    session.add(lib)
    await session.commit()

    e1 = ColorEntry(library_id=lib.id, code="R01", color_hex="#FF0000")
    e2 = ColorEntry(library_id=lib.id, code="G01", color_hex="#00FF00")
    session.add_all([e1, e2])
    await session.commit()

    await session.delete(lib)
    await session.commit()

    entries = await session.execute(
        sa.select(ColorEntry).where(ColorEntry.library_id == lib.id)
    )
    assert entries.scalars().all() == []


# --- Blueprint ---

@pytest.mark.asyncio
async def test_blueprint_creation(session: AsyncSession):
    bp = Blueprint(
        name="My Design",
        original_filename="photo.jpg",
        image_path="/uploads/photo.jpg",
        grid_rows=16,
        grid_cols=16,
        status="completed",
    )
    session.add(bp)
    await session.commit()

    result = await session.get(Blueprint, bp.id)
    assert result is not None
    assert result.name == "My Design"
    assert result.grid_rows == 16
    assert result.grid_cols == 16
    assert result.status == "completed"


@pytest.mark.asyncio
async def test_blueprint_default_status(session: AsyncSession):
    bp = Blueprint(name="New Design")
    session.add(bp)
    await session.commit()

    result = await session.get(Blueprint, bp.id)
    assert result.status == "processing"


# --- BlueprintCell ---

@pytest.mark.asyncio
async def test_blueprint_cell_creation(session: AsyncSession):
    bp = Blueprint(name="Grid Test", grid_rows=2, grid_cols=2)
    session.add(bp)
    await session.commit()

    cell = BlueprintCell(
        blueprint_id=bp.id,
        row_idx=0,
        col_idx=1,
        bead_code="310",
    )
    session.add(cell)
    await session.commit()

    result = await session.get(BlueprintCell, cell.id)
    assert result is not None
    assert result.row_idx == 0
    assert result.col_idx == 1
    assert result.bead_code == "310"


@pytest.mark.asyncio
async def test_cell_cascade_delete(session: AsyncSession):
    bp = Blueprint(name="Cascade Test")
    session.add(bp)
    await session.commit()

    c1 = BlueprintCell(blueprint_id=bp.id, row_idx=0, col_idx=0, bead_code="A1")
    c2 = BlueprintCell(blueprint_id=bp.id, row_idx=0, col_idx=1, bead_code="A2")
    session.add_all([c1, c2])
    await session.commit()

    await session.delete(bp)
    await session.commit()

    cells = await session.execute(
        sa.select(BlueprintCell).where(BlueprintCell.blueprint_id == bp.id)
    )
    assert cells.scalars().all() == []


@pytest.mark.asyncio
async def test_blueprint_cell_position_unique(session: AsyncSession):
    bp = Blueprint(name="Unique Test")
    session.add(bp)
    await session.commit()

    c1 = BlueprintCell(blueprint_id=bp.id, row_idx=1, col_idx=2, bead_code="X")
    c2 = BlueprintCell(blueprint_id=bp.id, row_idx=1, col_idx=2, bead_code="Y")
    session.add_all([c1, c2])

    with pytest.raises(Exception):
        await session.commit()
    await session.rollback()


# --- Relationships ---

@pytest.mark.asyncio
async def test_library_entries_relationship(session: AsyncSession):
    lib = ColorLibrary(name="Relationship Test")
    session.add(lib)
    await session.commit()

    e1 = ColorEntry(library_id=lib.id, code="100", color_hex="#AAAAAA")
    e2 = ColorEntry(library_id=lib.id, code="200", color_hex="#BBBBBB")
    session.add_all([e1, e2])
    await session.commit()

    count = await session.scalar(
        sa.select(sa.func.count()).where(ColorEntry.library_id == lib.id)
    )
    assert count == 2


@pytest.mark.asyncio
async def test_blueprint_cells_relationship(session: AsyncSession):
    bp = Blueprint(name="Cell Rel Test", grid_rows=1, grid_cols=3)
    session.add(bp)
    await session.commit()

    for col in range(3):
        session.add(
            BlueprintCell(blueprint_id=bp.id, row_idx=0, col_idx=col, bead_code=f"C{col}")
        )
    await session.commit()

    count = await session.scalar(
        sa.select(sa.func.count()).where(BlueprintCell.blueprint_id == bp.id)
    )
    assert count == 3
