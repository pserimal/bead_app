"""Tests for the new OCR-based bead pipeline.

These tests verify the grid detector, OCR module, and end-to-end parser
work correctly. They require an EasyOCR environment.
"""
import pytest


def test_grid_detect_synthetic_blank_returns_none():
    from app.services.bead_grid_detector import detect_grid
    import numpy as np
    img = np.full((500, 500, 3), 255, dtype=np.uint8)
    assert detect_grid(img) is None


def test_grid_detect_dou_example():
    from app.services.bead_grid_detector import detect_grid
    import cv2
    img = cv2.imread('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    assert img is not None
    grid = detect_grid(img)
    assert grid is not None
    assert grid.rows > 30
    assert grid.cols > 30
    assert 5 <= grid.cell_w <= 50
    assert 5 <= grid.cell_h <= 50
    assert grid.x0 >= 0
    assert grid.y0 >= 0


def test_cell_rect_inside_image():
    from app.services.bead_grid_detector import detect_grid
    import cv2
    img = cv2.imread('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    grid = detect_grid(img)
    h, w = img.shape[:2]
    x, y, cw, ch = grid.cell_rect(0, 0)
    assert 0 <= x < w
    assert 0 <= y < h
    assert cw > 0 and ch > 0
    assert x + cw <= w + 1
    assert y + ch <= h + 1


def test_parse_returns_grid_metadata():
    from app.services.bead_parser import parse
    result = parse('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    assert 'grid_rows' in result
    assert 'grid_cols' in result
    assert 'cells' in result
    assert result['grid_rows'] > 30
    assert result['grid_cols'] > 30
    assert len(result['cells']) == result['grid_rows'] * result['grid_cols']
    cell0 = result['cells'][0]
    assert 'row' in cell0
    assert 'col' in cell0
    assert 'bead_code' in cell0
    assert 'pixel_color' in cell0
    assert 'confidence' in cell0


def test_parse_detects_known_codes():
    from app.services.bead_parser import parse
    result = parse('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    codes = {c['bead_code'] for c in result['cells'] if c['bead_code']}
    valid_codes = {'H1', 'H2', 'H7', 'F1', 'F2', 'F7', 'E2', 'E11', 'A1', 'A7'}
    assert len(codes & valid_codes) >= 3, f"Expected at least 3 valid codes, got {codes}"


def test_parse_color_lookup():
    from app.services.bead_parser import parse
    result = parse('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    found_color = False
    for cell in result['cells']:
        if cell['bead_code'] and cell['pixel_color']:
            assert cell['pixel_color'].startswith('#')
            assert len(cell['pixel_color']) == 7
            found_color = True
            break
    assert found_color, "At least one cell should have a hex color from library"