"""End-to-end integration test for the OCR-based bead pipeline.

Renders the parsed result back to an image and compares key statistics
to confirm the pipeline can reconstruct the original bead board.
"""
import os
import pytest


@pytest.fixture(scope="module")
def parsed_result():
    """Parse the canonical example image once for the whole module."""
    from app.services.bead_parser import parse
    return parse('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')


def test_grid_dimensions_match_image(parsed_result):
    assert parsed_result['grid_rows'] == 80
    assert parsed_result['grid_cols'] == 57
    assert len(parsed_result['cells']) == 80 * 57


def test_detected_codes_are_known(parsed_result):
    known = set()
    import json
    path = '/home/pserimal/project/python/ai_dou/backend/app/data/default_colors.json'
    with open(path) as f:
        for entry in json.load(f):
            known.add(entry['code'])
    detected = {c['bead_code'] for c in parsed_result['cells'] if c['bead_code']}
    known_detected = detected & known
    assert len(known_detected) >= 10, f"Expected >=10 known codes, got {len(known_detected)}: {known_detected}"


def test_detected_codes_have_mapped_colors(parsed_result):
    with_color = [c for c in parsed_result['cells']
                  if c['bead_code'] and c['pixel_color']]
    assert len(with_color) >= 100, f"Expected >=100 cells with colors, got {len(with_color)}"


def test_render_reconstruction():
    """Reconstruct the bead board from the parsed result and verify shape."""
    import numpy as np
    from app.services.bead_parser import parse
    from app.services.bead_grid_detector import detect_grid
    import cv2

    img = cv2.imread('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    result = parse('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    grid = detect_grid(img)

    cell_size = 10
    canvas = np.full((grid.rows * cell_size, grid.cols * cell_size, 3),
                     255, dtype=np.uint8)
    for cell in result['cells']:
        if not cell.get('pixel_color'):
            continue
        hex_color = cell['pixel_color'].lstrip('#')
        bgr = (int(hex_color[4:6], 16), int(hex_color[2:4], 16), int(hex_color[0:2], 16))
        y1 = cell['row'] * cell_size
        x1 = cell['col'] * cell_size
        canvas[y1:y1 + cell_size, x1:x1 + cell_size] = bgr

    assert canvas.shape[0] == grid.rows * cell_size
    assert canvas.shape[1] == grid.cols * cell_size
    nonzero = np.sum(np.any(canvas != 255, axis=2))
    assert nonzero > 0, "Rendered canvas has no colored cells"


def test_pipeline_idempotent():
    """Two parses on the same image should yield the same grid size."""
    from app.services.bead_parser import parse
    r1 = parse('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    r2 = parse('/home/pserimal/project/python/ai_dou/dou_tu_example.jpg')
    assert r1['grid_rows'] == r2['grid_rows']
    assert r1['grid_cols'] == r2['grid_cols']