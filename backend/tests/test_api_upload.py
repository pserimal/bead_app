import asyncio
import io
import os
import tempfile

from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.db as app_db
from app.main import app
from app.db import get_db
from app.models.base import Base

# Use a file-based SQLite so the background task's session (which uses
# the same engine) shares the same database — :memory: creates a fresh
# DB per connection, which breaks background tasks.
_db_fd, _db_path = tempfile.mkstemp(suffix=".db")
_db_url = f"sqlite+aiosqlite:///{_db_path}"

_test_engine = create_async_engine(_db_url, echo=False)


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
# Redirect the module-level session factory so background tasks
# in _run_parse use the same database.
app_db.async_session = _TestSession

client = TestClient(app)


def teardown_module():
    asyncio.run(_test_engine.dispose())
    app.dependency_overrides.clear()
    os.close(_db_fd)
    os.unlink(_db_path)


def _make_test_jpg() -> io.BytesIO:
    buf = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(buf, format="JPEG")
    buf.seek(0)
    return buf


def _make_test_png() -> io.BytesIO:
    buf = io.BytesIO()
    Image.new("RGB", (50, 50), "red").save(buf, format="PNG")
    buf.seek(0)
    return buf


def test_upload_jpg():
    """Upload a valid JPG image returns 201 with processing status."""
    buf = _make_test_jpg()
    response = client.post(
        "/api/blueprints/upload",
        files={"image": ("test.jpg", buf, "image/jpeg")},
        data={"name": "Test Blueprint"},
    )
    assert response.status_code == 201
    data = response.json()
    assert "id" in data
    assert data["status"] == "processing"
    assert data["message"] == "Blueprint uploaded, parsing started"


def test_upload_png():
    """Upload a valid PNG image returns 201."""
    buf = _make_test_png()
    response = client.post(
        "/api/blueprints/upload",
        files={"image": ("test.png", buf, "image/png")},
    )
    assert response.status_code == 201
    assert response.json()["status"] == "processing"


def test_upload_no_name_falls_back_to_filename():
    """When name is omitted, the filename is used as the blueprint name."""
    buf = _make_test_jpg()
    response = client.post(
        "/api/blueprints/upload",
        files={"image": ("my_photo.jpg", buf, "image/jpeg")},
    )
    assert response.status_code == 201
    bp_id = response.json()["id"]
    status_resp = client.get(f"/api/blueprints/{bp_id}/status")
    assert status_resp.status_code == 200


def test_reject_non_image():
    """Non-image files should be rejected with 400."""
    response = client.post(
        "/api/blueprints/upload",
        files={"image": ("test.txt", b"not an image", "text/plain")},
    )
    assert response.status_code == 400
    assert "JPG/PNG" in response.json()["detail"]


def test_get_status_after_upload():
    """Status endpoint returns the blueprint status after upload."""
    buf = _make_test_jpg()
    upload_resp = client.post(
        "/api/blueprints/upload",
        files={"image": ("test.jpg", buf, "image/jpeg")},
    )
    bp_id = upload_resp.json()["id"]

    response = client.get(f"/api/blueprints/{bp_id}/status")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == bp_id
    assert data["status"] in ("processing", "error", "ready")


def test_get_status_not_found():
    """Status for a non-existent blueprint returns 404."""
    response = client.get("/api/blueprints/99999/status")
    assert response.status_code == 404
    assert response.json()["detail"] == "Blueprint not found"
