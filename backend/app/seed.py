import json
from pathlib import Path

from sqlalchemy import select

import app.db
from app.models.color_library import ColorLibrary
from app.models.color_entry import ColorEntry

DEFAULT_COLORS_PATH = Path(__file__).parent / "data" / "default_colors.json"


async def seed_default_colors():
    """Seed default color library if none exists."""
    async with app.db.async_session() as session:
        result = await session.execute(
            select(ColorLibrary).where(ColorLibrary.is_default == True)
        )
        existing = result.scalar_one_or_none()
        if existing:
            return

        lib = ColorLibrary(name="Hama Default", is_default=True)
        session.add(lib)
        await session.flush()

        with open(DEFAULT_COLORS_PATH) as f:
            colors_data = json.load(f)

        for item in colors_data:
            entry = ColorEntry(
                library_id=lib.id,
                code=item["code"],
                color_hex=item["color_hex"],
                color_name=item["color_name"],
                sort_order=item.get("sort_order", 0),
            )
            session.add(entry)

        await session.commit()
