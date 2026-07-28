import pytest
from pydantic import ValidationError
from app.schemas.color import ColorEntryCreate, ColorEntryResponse
from app.schemas.blueprint import CellResponse, CellUpdateRequest, BlueprintDetailResponse


class TestColorEntryCreate:
    def test_valid_color_entry(self):
        entry = ColorEntryCreate(
            code="H2", color_hex="#FF0000", color_name="Red", sort_order=1
        )
        assert entry.code == "H2"
        assert entry.color_hex == "#FF0000"
        assert entry.color_name == "Red"
        assert entry.sort_order == 1

    def test_invalid_hex_rejected(self):
        with pytest.raises(ValidationError):
            ColorEntryCreate(code="H2", color_hex="FF0000")  # missing #

    def test_empty_code_rejected(self):
        with pytest.raises(ValidationError):
            ColorEntryCreate(code="", color_hex="#FF0000")

    def test_invalid_hex_format(self):
        with pytest.raises(ValidationError):
            ColorEntryCreate(code="H2", color_hex="#GGGGGG")

    def test_default_sort_order_zero(self):
        entry = ColorEntryCreate(code="F5", color_hex="#00FF00")
        assert entry.sort_order == 0

    def test_negative_sort_order_rejected(self):
        with pytest.raises(ValidationError):
            ColorEntryCreate(code="H2", color_hex="#FF0000", sort_order=-1)

    def test_nullable_color_name(self):
        entry = ColorEntryCreate(code="G7", color_hex="#0000FF")
        assert entry.color_name is None

    def test_long_code_rejected(self):
        with pytest.raises(ValidationError):
            ColorEntryCreate(code="ABCDEFGHIJK", color_hex="#FF0000")


class TestColorEntryResponse:
    def test_from_orm(self):
        cell = ColorEntryResponse.model_validate(
            {
                "id": 1,
                "library_id": 1,
                "code": "H2",
                "color_hex": "#FF0000",
                "color_name": "Red",
                "sort_order": 1,
            }
        )
        assert cell.id == 1
        assert cell.code == "H2"


class TestCell:
    def test_cell_from_orm(self):
        cell = CellResponse.model_validate(
            {
                "id": 1,
                "blueprint_id": 1,
                "row_idx": 0,
                "col_idx": 0,
                "bead_code": "H2",
            }
        )
        assert cell.row_idx == 0
        assert cell.col_idx == 0

    def test_cell_update_validation(self):
        req = CellUpdateRequest(id=1, bead_code="H99")
        assert req.bead_code == "H99"

    def test_cell_update_empty_bead_code_rejected(self):
        with pytest.raises(ValidationError):
            CellUpdateRequest(id=1, bead_code="")


class TestBlueprintDetail:
    def test_blueprint_detail_includes_cells(self):
        data = {
            "id": 1,
            "name": "test",
            "original_filename": "test.jpg",
            "grid_rows": 10,
            "grid_cols": 10,
            "status": "ready",
            "created_at": "2026-01-01T00:00:00",
            "cells": [
                {
                    "id": 1,
                    "blueprint_id": 1,
                    "row_idx": 0,
                    "col_idx": 0,
                    "bead_code": "H2",
                }
            ],
        }
        bp = BlueprintDetailResponse.model_validate(data)
        assert len(bp.cells) == 1
        assert bp.cells[0].bead_code == "H2"

    def test_blueprint_detail_default_empty_cells(self):
        data = {
            "id": 2,
            "name": "empty",
            "original_filename": "empty.jpg",
            "grid_rows": 5,
            "grid_cols": 5,
            "status": "pending",
            "created_at": "2026-01-01T00:00:00",
        }
        bp = BlueprintDetailResponse.model_validate(data)
        assert bp.cells == []
