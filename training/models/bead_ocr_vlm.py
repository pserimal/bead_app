"""VLM-based per-cell OCR using Ollama multimodal models.

Strategy: Send 5x5 cell regions to the VLM at once (much faster and more
accurate than per-cell OCR). The VLM reads all codes in the region and
we map them back to individual cells.

Requires Ollama running with a vision model (default: qwen2.5vl:7b).
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import cv2
import numpy as np
import requests


# ── Library / pattern ─────────────────────────────────────────────────

# Color library lives in the backend service (single source of truth for the
# 65-entry Perler palette). Resolve relative to repo root regardless of cwd.
def _load_library_codes() -> list[str]:
    from ocr_core.code_library import load_codes

    return load_codes()


def _build_allowlist(codes: list[str]) -> str:
    letters = sorted({c[0] for c in codes})
    digits = sorted({ch for c in codes for ch in c[1:] if ch.isdigit()})
    return "".join(letters) + "".join(digits)


def _build_code_pattern(codes: list[str]) -> re.Pattern:
    letters = sorted({c[0] for c in codes})
    max_digits = max(len(c) - 1 for c in codes)
    return re.compile(rf"^[{''.join(letters)}][0-9]{{1,{max_digits}}}")


_LIB_CODES = _load_library_codes()
_ALLOWLIST = _build_allowlist(_LIB_CODES)
_VALID_CODE_PATTERN = _build_code_pattern(_LIB_CODES)


def _parse_code(text: str) -> str | None:
    if not text:
        return None
    text = text.strip().upper()
    for prefix in ["THE CODE IS ", "CODE: ", "CODE IS ", "ANSWER: ", "IT IS ", "THIS IS "]:
        if text.startswith(prefix):
            text = text[len(prefix):]
    text = text.split("\n")[0].strip()
    text = text.split(".")[0].strip()
    text = text.split(",")[0].strip()
    text = text.split(" ")[0].strip()
    cleaned = "".join(ch for ch in text if ch in _ALLOWLIST)
    if not cleaned:
        return None
    m = _VALID_CODE_PATTERN.match(cleaned)
    return m.group() if m else None


def _clamp(val: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, val))


# ── VLM client ───────────────────────────────────────────────────────

_DEFAULT_MODEL = "qwen2.5vl:7b"
_OLLAMA_URL = "http://192.168.5.156:11434/api/generate"


def _query_vlm(b64_image: str, model: str = _DEFAULT_MODEL, timeout: int = 120) -> str:
    try:
        response = requests.post(_OLLAMA_URL, json={
            "model": model,
            "prompt": (
                "This is a grid of cells from a perler bead pattern. "
                "Each cell contains an alphanumeric code (e.g. H7, F1, A23). "
                "List ALL codes you see, row by row, comma separated. "
                "Format: R0C0=XX, R0C1=XX, ... "
                "Use EMPTY for cells with no visible code."
            ),
            "images": [b64_image],
            "stream": False,
        }, timeout=timeout)
        return response.json().get("response", "")
    except Exception:
        return ""


def _parse_region_response(response: str, region_r0: int, region_c0: int) -> dict[tuple[int, int], str]:
    """Parse VLM response like 'R0C0=H7, R0C1=F1, ...' into {(row,col): code}."""
    result = {}
    # Match patterns like R0C0=H7 or R0C0=EMPTY
    for match in re.finditer(r"R(\d+)C(\d+)=(\w+)", response):
        r_local = int(match.group(1))
        c_local = int(match.group(2))
        code_raw = match.group(3)
        code = _parse_code(code_raw)
        if code is not None:
            result[(region_r0 + r_local, region_c0 + c_local)] = code
    return result


def _ocr_region(
    image_bgr: np.ndarray,
    r0: int, c0: int,
    region_size: int,
    cell_w: float, cell_h: float,
    h: int, w: int,
    model: str = _DEFAULT_MODEL,
    upscale: int = 5,
) -> dict[tuple[int, int], str]:
    """OCR a region of cells using VLM."""
    y0 = _clamp(int(round(r0 * cell_h)), 0, h)
    x0 = _clamp(int(round(c0 * cell_w)), 0, w)
    y1 = _clamp(int(round((r0 + region_size) * cell_h)), 0, h)
    x1 = _clamp(int(round((c0 + region_size) * cell_w)), 0, w)
    region = image_bgr[y0:y1, x0:x1]
    if region.size == 0:
        return {}

    big = cv2.resize(region, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_LANCZOS4)
    _, buf = cv2.imencode(".png", big)
    b64 = base64.b64encode(buf).decode("utf-8")

    response = _query_vlm(b64, model=model)
    return _parse_region_response(response, r0, c0)


def ocr_cells_from_crop_vlm(
    image_bgr: np.ndarray,
    user_rows: int,
    user_cols: int,
    crop_bbox: tuple[int, int, int, int],
    valid_codes: set[str] | None = None,
    min_conf: float = 0.5,
    model: str = _DEFAULT_MODEL,
    region_size: int = 5,
) -> dict[tuple[int, int], tuple[str, float]]:
    """OCR every cell using VLM region-based approach.

    Divides the image into overlapping regions of region_size x region_size,
    sends each region to the VLM, and maps results back to individual cells.
    """
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

    if valid_codes is None:
        valid_codes = set(_LIB_CODES)

    merged: dict[tuple[int, int], tuple[str, float]] = {}

    # Process in regions of region_size x region_size
    for r_start in range(0, user_rows, region_size):
        for c_start in range(0, user_cols, region_size):
            region_codes = _ocr_region(
                image_bgr, r_start, c_start, region_size,
                cell_w, cell_h, h, w, model=model,
            )
            for (r, c), code in region_codes.items():
                if 0 <= r < user_rows and 0 <= c < user_cols:
                    if code in valid_codes:
                        merged[(r, c)] = (code, 1.0)  # VLM confidence = 1.0

    return merged


def check_ollama_available(model: str = _DEFAULT_MODEL) -> bool:
    try:
        resp = requests.get("http://192.168.5.156:11434/api/tags", timeout=5)
        models = [m["name"] for m in resp.json().get("models", [])]
        return model in models
    except Exception:
        return False
