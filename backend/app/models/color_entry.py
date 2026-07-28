from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class ColorEntry(Base):
    __tablename__ = "color_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    library_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("color_libraries.id", ondelete="CASCADE"),
        nullable=False,
    )
    code: Mapped[str] = mapped_column(String(10), nullable=False)
    color_hex: Mapped[str] = mapped_column(String(7), nullable=False)
    color_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "library_id", "code", name="uq_color_entries_library_code"
        ),
    )

    library: Mapped["ColorLibrary"] = relationship(
        "ColorLibrary",
        back_populates="entries",
    )
