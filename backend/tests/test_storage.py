from io import BytesIO
from pathlib import Path

import pytest
from fastapi import UploadFile

from app.services.storage import FileStorage


@pytest.fixture
def temp_storage(tmp_path: Path) -> FileStorage:
    """Create a FileStorage backed by a temporary directory."""
    import app.config

    app.config.settings.upload_dir = str(tmp_path / "uploads")
    return FileStorage()


@pytest.mark.asyncio
async def test_save_and_retrieve(temp_storage: FileStorage) -> None:
    """Saved file should exist at the resolved path with identical content."""
    content = b"fake_image_data"
    file = UploadFile(filename="test.jpg", file=BytesIO(content))

    rel_path = await temp_storage.save_upload(file)
    assert rel_path is not None

    abs_path = temp_storage.get_path(rel_path)
    assert abs_path.exists()
    assert abs_path.read_bytes() == content


@pytest.mark.asyncio
async def test_delete_removes_file(temp_storage: FileStorage) -> None:
    """After deletion the file should no longer exist."""
    file = UploadFile(filename="test.jpg", file=BytesIO(b"data"))
    rel_path = await temp_storage.save_upload(file)

    assert temp_storage.delete(rel_path) is True
    assert not temp_storage.get_path(rel_path).exists()


@pytest.mark.asyncio
async def test_filename_uniqueness(temp_storage: FileStorage) -> None:
    """Two files with the same name must get different storage paths."""
    f1 = UploadFile(filename="same.jpg", file=BytesIO(b"data1"))
    f2 = UploadFile(filename="same.jpg", file=BytesIO(b"data2"))

    p1 = await temp_storage.save_upload(f1)
    p2 = await temp_storage.save_upload(f2)

    assert p1 != p2


def test_delete_nonexistent_returns_false(temp_storage: FileStorage) -> None:
    """Deleting a non-existent file should return False."""
    assert temp_storage.delete("nonexistent/file.jpg") is False
