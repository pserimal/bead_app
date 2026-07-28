import uuid
from pathlib import Path

import aiofiles
from fastapi import UploadFile

from app.config import settings


class FileStorage:
    """Manages file storage for uploaded blueprint images.

    Files are stored under the configured upload_dir with UUID-based names
    to prevent collisions. Paths are stored as relative paths in the database.
    """

    def __init__(self) -> None:
        self.base_dir = Path(settings.upload_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _generate_path(self, filename: str) -> Path:
        ext = Path(filename).suffix if "." in filename else ".jpg"
        unique_name = f"{uuid.uuid4().hex}{ext}"
        return self.base_dir / unique_name

    async def save_upload(self, file: UploadFile, content: bytes | None = None) -> str:
        """Save an uploaded file and return its relative path.

        The relative path is relative to the upload_dir's parent directory,
        so it can be stored in the database and reconstructed later.
        If content is provided (e.g., already read for validation), use it
        instead of reading from the UploadFile again.
        """
        dest = self._generate_path(file.filename or "upload.jpg")
        if content is None:
            content = await file.read()
        async with aiofiles.open(dest, "wb") as f:
            await f.write(content)
        return str(dest.relative_to(self.base_dir.parent))

    def get_path(self, relative_path: str) -> Path:
        """Get the absolute path from a relative path.

        The relative path should be one returned by save_upload().
        """
        return (self.base_dir.parent / relative_path).resolve()

    def delete(self, relative_path: str) -> bool:
        """Delete the file at the given relative path.

        Returns True if the file was deleted, False if it didn't exist.
        """
        path = self.get_path(relative_path)
        if path.exists() and path.is_file():
            path.unlink()
            return True
        return False


# Singleton instance used across the application
file_storage = FileStorage()
