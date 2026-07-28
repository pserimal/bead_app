import asyncio

from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.main import app
from app.db import get_db
from app.models.base import Base

_test_engine = create_async_engine("sqlite+aiosqlite:///:memory:", echo=False)


async def _init_db():
    async with _test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_db())

_TestSession = async_sessionmaker(
    _test_engine, class_=AsyncSession, expire_on_commit=False
)


async def _override_get_db():
    async with _TestSession() as session:
        yield session


app.dependency_overrides[get_db] = _override_get_db

client = TestClient(app)


def teardown_module():
    asyncio.run(_test_engine.dispose())
    app.dependency_overrides.clear()


def test_list_blueprints_empty():
    """Listing blueprints when none exist returns an empty paginated response."""
    response = client.get("/api/blueprints")
    assert response.status_code == 200
    data = response.json()
    assert "items" in data
    assert "total" in data
    assert "page" in data
    assert data["items"] == []
    assert data["total"] == 0
    assert data["page"] == 1
    assert data["page_size"] == 12


def test_list_blueprints_with_page_param():
    """Page and page_size query parameters are respected."""
    response = client.get("/api/blueprints?page=2&page_size=5")
    assert response.status_code == 200
    data = response.json()
    assert data["page"] == 2
    assert data["page_size"] == 5


def test_get_nonexistent_blueprint():
    """Fetching a non-existent blueprint returns 404."""
    response = client.get("/api/blueprints/99999")
    assert response.status_code == 404
    assert response.json()["detail"] == "Blueprint not found"


def test_delete_nonexistent_blueprint():
    """Deleting a non-existent blueprint returns 404."""
    response = client.delete("/api/blueprints/99999")
    assert response.status_code == 404
    assert response.json()["detail"] == "Blueprint not found"


def test_put_cells_nonexistent_blueprint():
    """Updating cells on a non-existent blueprint returns 404."""
    response = client.put(
        "/api/blueprints/99999/cells",
        json={"cells": [{"id": 1, "bead_code": "H7"}]},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Blueprint not found"
