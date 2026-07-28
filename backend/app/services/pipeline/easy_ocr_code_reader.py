"""EasyOCR-based CodeReader implementation (T14)."""
from __future__ import annotations

import numpy as np

from app.services import bead_grid_detector
from app.services import bead_ocr
from app.services.pipeline.interfaces import CodeReader, CodeResult, GridCell


class EasyOcrCodeReader(CodeReader):
    """Adapter: delegates to `bead_ocr.ocr_board`.

    Reconstructs the minimal `BeadGrid` view that `ocr_board` needs from the
    list of `GridCell` instances passed by the orchestrator.
    """

    def read(
        self,
        cells: list[GridCell],
        image: np.ndarray,
    ) -> list[CodeResult]:
        if not cells:
            return []

        rows = max(c.row for c in cells) + 1
        cols = max(c.col for c in cells) + 1
        x0 = min(c.x for c in cells)
        y0 = min(c.y for c in cells)
        cell_w = cells[0].w
        cell_h = cells[0].h
        bead_grid = bead_grid_detector.BeadGrid(
            x0=x0, y0=y0, rows=rows, cols=cols,
            cell_w=cell_w, cell_h=cell_h,
        )

        detections = bead_ocr.ocr_board(image, bead_grid)

        results: list[CodeResult] = []
        for cell in cells:
            det = detections.get((cell.row, cell.col))
            if det is None:
                results.append(CodeResult(
                    row=cell.row, col=cell.col,
                    code=None, confidence=0.0, raw_text=None,
                ))
            else:
                code, conf = det
                results.append(CodeResult(
                    row=cell.row, col=cell.col,
                    code=code, confidence=float(conf),
                    raw_text=code,
                ))
        return results
