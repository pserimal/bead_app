"""VLM-based per-cell OCR using DeepSeek-OCR via Ollama.

Strategy: Send 5x5 cell regions to the VLM at once (much faster and more
accurate than per-cell OCR). The VLM reads all codes in the region and
we map them back to individual cells.

Requires Ollama running with deepseek-ocr:latest model.
Uses /api/generate (not /api/chat) — DeepSeek-OCR is a generate-style model.
"""
from __future__ import annotations

import base64
import json
import re
from pathlib import Path

import cv2
import numpy as np
import requests

from app.services.code_match import build_valid_letters, clean_token, fuzzy_correct


# ── Library / pattern ─────────────────────────────────────────────────

_LIBRARY_PATH = Path(__file__).parent.parent / "data" / "default_colors.json"


def _load_library_codes() -> list[str]:
    with open(_LIBRARY_PATH) as f:
        entries = json.load(f)
    return [e["code"] for e in entries]


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
_VALID_LETTERS = build_valid_letters(_LIB_CODES)


def _parse_code(text: str) -> str | None:
    """Extract a bead-code candidate from raw VLM text.

    Strips common VLM preambles, then normalizes confusable letter forms
    (I/1, O/0, S/5) via ``clean_token`` so the regex sees real digits.
    Dictionary fuzzy correction runs later, at the membership check.
    """
    if not text:
        return None
    text = text.strip().upper()
    # Strip common VLM preamble phrases
    for prefix in [
        "THE CODE IS ", "CODE: ", "CODE IS ", "ANSWER: ",
        "IT IS ", "THIS IS ", "THE TEXT IS ",
    ]:
        if text.startswith(prefix):
            text = text[len(prefix):]
    text = text.split("\n")[0].strip()
    text = text.split(".")[0].strip()
    text = text.split(",")[0].strip()
    text = text.split(" ")[0].strip()
    token = clean_token(text, _VALID_LETTERS)
    if token is None:
        return None
    m = _VALID_CODE_PATTERN.match(token)
    return m.group() if m else None


def _clamp(val: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, val))


# ── DeepSeek-OCR client ──────────────────────────────────────────────

_DEFAULT_MODEL = "deepseek-ocr:latest"
_OLLAMA_URL = "http://192.168.5.156:11434/api/generate"


def _query_deepseek(b64_image: str, model: str = _DEFAULT_MODEL, timeout: int = 300) -> str:
    """Send an image to DeepSeek-OCR via Ollama /api/generate."""
    try:
        response = requests.post(_OLLAMA_URL, json={
            "model": model,
            "prompt": (
                "This is a grid of cells from a perler bead pattern. "
                "Each cell contains an alphanumeric code (e.g. H7, F1, A23). "
                "Read all codes row by row, comma separated. "
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
    """Parse VLM response. Supports multiple formats:
    1. Structured: 'R0C0=H7, R0C1=F1, ...'
    2. Concatenated: '<table>H7H7F8F8...</table>' or 'H7.H7.H8' (row-major)
    3. Quoted list: 'The first row contains: "H7", "F8", ...'
    """
    if not response:
        return {}

    # Strategy 1: structured R0C0=XX format
    structured = {}
    for match in re.finditer(r"R(\d+)C(\d+)=(\w+)", response):
        r_local = int(match.group(1))
        c_local = int(match.group(2))
        code = _parse_code(match.group(3))
        if code is not None:
            structured[(r_local, c_local)] = code
    if structured:
        return {(region_r0 + r, region_c0 + c): code for (r, c), code in structured.items()}

    # Strategy 2: natural-language row descriptions
    nat_rows = _parse_natural_response(response)
    if nat_rows and len(nat_rows) > 1:
        result = {}
        for r_idx, row_codes in enumerate(nat_rows):
            for c_idx, raw in enumerate(row_codes):
                code = _parse_code(raw)
                if code is not None:
                    result[(r_idx, c_idx)] = code
        return {(region_r0 + r, region_c0 + c): code for (r, c), code in result.items()}

    # Strategy 3: concatenated codes - split into chunks of 2-3 chars, fill row-major
    text = response.strip()
    text = re.sub(r"</?table>", "", text, flags=re.IGNORECASE)
    text = text.replace('"', '').replace("'", "").replace(" ", "")
    codes: list[str] = []
    # Try to find all valid codes in order
    i = 0
    while i < len(text):
        m = _VALID_CODE_PATTERN.match(text, i)
        if m:
            codes.append(m.group())
            i = m.end()
        else:
            i += 1
    return {}


def _parse_natural_response(response: str) -> list[list[str]]:
    """Parse natural-language row descriptions from DeepSeek-OCR.

    Example input:
        "The first row contains the following codes: \"B25\", \"F7\", ...
         The second row contains..."

    Returns: list of rows, each row is a list of raw code strings.
    """
    rows: list[list[str]] = []
    # Match: "The Nth row contains the following codes: ..."
    # or "Row N: ..."
    for m in re.finditer(
        r"(?:the\s+\w+\s+row\s+contains\s+the\s+following\s+codes[:\s]*|row\s*\d*[:\s]*)"
        r"(.+?)(?=the\s+\w+\s+row|row\s*\d|\Z)",
        response, re.IGNORECASE | re.DOTALL,
    ):
        row_text = m.group(1)
        codes = re.findall(r'"([^"]+)"', row_text)
        if not codes:
            # Fallback: split by comma
            codes = [c.strip() for c in row_text.split(",") if c.strip()]
        rows.append(codes)
    return rows


def _ocr_region(
    image_bgr: np.ndarray,
    r0: int, c0: int,
    region_size: int,
    cell_w: float, cell_h: float,
    h: int, w: int,
    model: str = _DEFAULT_MODEL,
    upscale: int = 2,
) -> dict[tuple[int, int], str]:
    """OCR a region of cells using DeepSeek-OCR."""
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

    response = _query_deepseek(b64, model=model)
    result = _parse_codes_from_response(response, region_size)
    return {(r0 + r, c0 + c): code for (r, c), code in result.items()
            if 0 <= r < region_size and 0 <= c < region_size}


def _parse_codes_from_response(response: str, region_size: int) -> dict[tuple[int, int], str]:
    """Parse DeepSeek-OCR response into a region-local (row, col) -> code map.

    Tries strategies in order:
    1. Structured R0C0=XX format
    2. Natural-language row descriptions
    3. Flat concatenated codes - fill row-major (5x5 = 25 cells)
    """
    if not response:
        return {}

    # Strategy 1: R0C0=XX, R0C1=YY, ...
    result: dict[tuple[int, int], str] = {}
    for match in re.finditer(r"R(\d+)C(\d+)=(\w+)", response):
        r_local = int(match.group(1))
        c_local = int(match.group(2))
        code = _parse_code(match.group(3))
        if code is not None and 0 <= r_local < region_size and 0 <= c_local < region_size:
            result[(r_local, c_local)] = code
    if result:
        return result

    # Strategy 2: natural language "first row contains: ..."
    nat_rows = _parse_natural_response(response)
    if nat_rows and sum(len(r) for r in nat_rows) > 1:
        for r_idx, row_codes in enumerate(nat_rows):
            if r_idx >= region_size:
                break
            for c_idx, raw in enumerate(row_codes):
                if c_idx >= region_size:
                    break
                code = _parse_code(raw)
                if code is not None:
                    result[(r_idx, c_idx)] = code
        if result:
            return result

    # Strategy 3: flat concatenated string like "<table>H7H7F8F8...</table>"
    # Strip wrapping tags and extract valid codes greedily from the whole text.
    text = response.strip()
    text = re.sub(r"</?table>", "", text, flags=re.IGNORECASE)
    text = text.replace('"', "").replace("'", "")
    # Greedy scan for valid code tokens anywhere in the flattened text.
    # Non-code chars act as implicit separators (commas, dots, spaces, letters
    # that don't start a valid code). We scan left-to-right.
    codes: list[str] = []
    i = 0
    while i < len(text):
        m = _VALID_CODE_PATTERN.match(text, i)
        if m:
            codes.append(m.group())
            i = m.end()
        else:
            i += 1

    if codes:
        expected = region_size * region_size
        # Accept if we got a reasonable count (at least half, allow missing cells)
        if len(codes) >= expected // 2:
            for idx, code in enumerate(codes[:expected]):
                r, c = divmod(idx, region_size)
                result[(r, c)] = code
            return result

    return result


def ocr_cells_from_crop_deepseek(
    image_bgr: np.ndarray,
    user_rows: int,
    user_cols: int,
    crop_bbox: tuple[int, int, int, int],
    valid_codes: set[str] | None = None,
    min_conf: float = 0.5,
    model: str = _DEFAULT_MODEL,
    region_size: int = 5,
) -> dict[tuple[int, int], tuple[str, float]]:
    """OCR every cell using DeepSeek-OCR region-based approach.

    Divides the image into overlapping regions of region_size x region_size,
    sends each region to DeepSeek-OCR via Ollama, and maps results back to
    individual cells.

    Returns:
        ``{(row, col): (bead_code, confidence)}``  — one entry per cell
        for which the OCR returned a valid Perler bead code.
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

    for r_start in range(0, user_rows, region_size):
        for c_start in range(0, user_cols, region_size):
            region_codes = _ocr_region(
                image_bgr, r_start, c_start, region_size,
                cell_w, cell_h, h, w, model=model,
            )
            for (r, c), code in region_codes.items():
                if 0 <= r < user_rows and 0 <= c < user_cols:
                    if code in valid_codes:
                        merged[(r, c)] = (code, 1.0)
                        continue
                    # Recover single-char OCR slips via dictionary fuzzy match.
                    corrected = fuzzy_correct(code, valid_codes)
                    if corrected is not None:
                        merged[(r, c)] = (corrected, 0.85)

    return merged


def check_deepseek_available(model: str = _DEFAULT_MODEL) -> bool:
    """Check if DeepSeek-OCR model is available on Ollama."""
    try:
        resp = requests.get("http://192.168.5.156:11434/api/tags", timeout=5)
        models = [m["name"] for m in resp.json().get("models", [])]
        return model in models
    except Exception:
        return False
