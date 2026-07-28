import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import async_session as production_session
from app.models.base import Base
from app.models.color_library import ColorLibrary
from app.models.color_entry import ColorEntry
from app.seed import seed_default_colors


@pytest_asyncio.fixture
async def test_db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    test_session_factory = async_sessionmaker(
        engine, expire_on_commit=False
    )

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    monkeypatch.setattr(
        "app.db.async_session",
        test_session_factory,
    )

    yield test_session_factory

    await engine.dispose()


@pytest.mark.asyncio
async def test_seed_creates_default_library(test_db):
    await seed_default_colors()

    async with test_db() as session:
        result = await session.execute(
            select(ColorLibrary).where(ColorLibrary.is_default == True)
        )
        lib = result.scalar_one_or_none()
        assert lib is not None
        assert lib.name == "Hama Default"
        assert lib.is_default is True


@pytest.mark.asyncio
async def test_seed_is_idempotent(test_db):
    await seed_default_colors()
    await seed_default_colors()

    async with test_db() as session:
        result = await session.execute(
            select(ColorLibrary).where(ColorLibrary.is_default == True)
        )
        libraries = result.scalars().all()
        assert len(libraries) == 1


@pytest.mark.asyncio
async def test_seed_has_30_plus_entries(test_db):
    await seed_default_colors()

    async with test_db() as session:
        result = await session.execute(
            select(ColorLibrary).where(ColorLibrary.is_default == True)
        )
        lib = result.scalar_one_or_none()
        assert lib is not None

        result = await session.execute(
            select(ColorEntry).where(ColorEntry.library_id == lib.id)
        )
        entries = result.scalars().all()
        assert len(entries) >= 30
