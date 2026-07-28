"""CRNN inference entrypoint — drop-in for the OCR_ENGINE switch.

Mirrors the API of ``bead_ocr_easy.ocr_cells_from_crop_easy``: takes a user
crop and a (rows, cols) grid, returns ``{(row, col): (code, confidence)}``.

Model weights are loaded lazily on first call. The confidence score is the
average CTC log-probability along the emitted path, mapped back to a 0-1
range via ``exp``.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from app.config import settings


_MODEL = None


def _load_model():
    global _MODEL
    if _MODEL is None:
        from training.models.bead_ocr_crnn import load_checkpoint

        ckpt_path = Path(settings.CRNN_MODEL_PATH)
        if not ckpt_path.exists():
            raise FileNotFoundError(
                f"CRNN checkpoint not found at {ckpt_path}. "
                "Train one with: python -m training.scripts.train_crnn --out "
                "<path>"
            )
        _MODEL = load_checkpoint(ckpt_path, device="cpu")
    return _MODEL


def _crop_cell(image_bgr, x0, y0, x1, y1) -> np.ndarray:
    crop = image_bgr[y0:y1, x0:x1]
    if crop.size == 0:
        return np.zeros((48, 48), dtype=np.uint8)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    # Letterbox to (48, 48) preserving aspect ratio.
    h, w = gray.shape
    scale = min(48 / h, 48 / w) if h > 0 and w > 0 else 1.0
    new_h = max(1, int(round(h * scale)))
    new_w = max(1, int(round(w * scale)))
    resized = cv2.resize(gray, (new_w, new_h), interpolation=cv2.INTER_AREA)
    canvas = np.full((48, 48), 255, dtype=np.uint8)  # white background
    yoff = (48 - new_h) // 2
    xoff = (48 - new_w) // 2
    canvas[yoff : yoff + new_h, xoff : xoff + new_w] = resized
    return canvas


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def ocr_cells_from_crop_crnn(
    image_bgr: np.ndarray,
    user_rows: int,
    user_cols: int,
    crop_bbox: tuple[int, int, int, int],
    valid_codes: set[str] | None = None,
    min_conf: float = 0.5,
    max_workers: int = 1,
) -> dict[tuple[int, int], tuple[str, float]]:
    model, chars = _load_model()
    import torch
    from training.models.bead_ocr_crnn import (
        build_code_trie,
        constrained_decode,
        set_char_index,
    )
    from training.models.synth_generator import (
        CHAR_TO_IDX,
        CODES,
    )

    set_char_index(CHAR_TO_IDX)
    trie = build_code_trie(CODES if valid_codes is None else list(valid_codes))

    h, w = image_bgr.shape[:2]
    x, y, cw, ch = crop_bbox
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(w, x + cw)
    y1 = min(h, y + ch)
    if x0 >= x1 or y0 >= y1:
        return {}

    cell_w = (x1 - x0) / user_cols
    cell_h = (y1 - y0) / user_rows

    # Build batch of all cells.
    cell_imgs: list[np.ndarray] = []
    coords: list[tuple[int, int]] = []
    for r in range(user_rows):
        for c in range(user_cols):
            cy0 = _clamp(int(round(y0 + r * cell_h)), 0, h)
            cx0 = _clamp(int(round(x0 + c * cell_w)), 0, w)
            cy1 = _clamp(int(round(y0 + (r + 1) * cell_h)), 0, h)
            cx1 = _clamp(int(round(x0 + (c + 1) * cell_w)), 0, w)
            # Inset slightly to skip blue grid lines.
            iy = max(1, int(round((cy1 - cy0) * 0.10)))
            ix = max(1, int(round((cx1 - cx0) * 0.10)))
            cell_imgs.append(_crop_cell(image_bgr, cx0 + ix, cy0 + iy, cx1 - ix, cy1 - iy))
            coords.append((r, c))

    # Run in batches to avoid OOM.
    batch_size = 128
    merged: dict[tuple[int, int], tuple[str, float]] = {}
    codes_set = set(CODES if valid_codes is None else valid_codes)
    with torch.no_grad():
        for i in range(0, len(cell_imgs), batch_size):
            batch_imgs = np.stack(cell_imgs[i : i + batch_size])
            tensor = torch.from_numpy(batch_imgs).float().unsqueeze(1) / 255.0
            logits = model(tensor)  # (T, B, C)
            decoded = constrained_decode(logits, trie, blank=0)
            for j, (code, score) in enumerate(decoded):
                r, c = coords[i + j]
                # Normalize log-prob to a 0-1 confidence (length-dependent).
                norm_conf = float(np.exp(score / max(1, len(code))))
                if code not in codes_set:
                    continue
                if norm_conf < min_conf:
                    continue
                prev = merged.get((r, c))
                if prev is None or norm_conf > prev[1]:
                    merged[(r, c)] = (code, norm_conf)
    return merged