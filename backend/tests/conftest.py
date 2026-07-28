import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite://"

import asyncio
import pytest
import pytest_asyncio
from app.db import engine, async_session
from app.models.base import Base
from app.seed import seed_default_colors


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: skip by default — run with --slow")


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def setup_database():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await seed_default_colors()
    yield
    await engine.dispose()
