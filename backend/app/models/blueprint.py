import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class Blueprint(Base):
    """A bead blueprint generated from an uploaded image."""

    __tablename__ = "blueprints"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    image_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    grid_rows: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    grid_cols: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    valid_codes: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), default="processing", nullable=False
    )
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    cells: Mapped[list["BlueprintCell"]] = relationship(
        "BlueprintCell",
        back_populates="blueprint",
        cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:
        return f"<Blueprint id={self.id} name={self.name!r}>"
