from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class BlueprintCell(Base):
    """An individual cell in the bead blueprint grid."""

    __tablename__ = "blueprint_cells"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    blueprint_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("blueprints.id", ondelete="CASCADE"),
        nullable=False,
    )
    row_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    col_idx: Mapped[int] = mapped_column(Integer, nullable=False)
    bead_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    pixel_color: Mapped[str | None] = mapped_column(String(7), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "blueprint_id", "row_idx", "col_idx",
            name="uq_blueprint_cells_position",
        ),
    )

    blueprint: Mapped["Blueprint"] = relationship(
        "Blueprint",
        back_populates="cells",
    )

    def __repr__(self) -> str:
        return (
            f"<BlueprintCell id={self.id} "
            f"bp={self.blueprint_id} "
            f"pos=({self.row_idx},{self.col_idx}) "
            f"bead={self.bead_code!r}>"
        )
