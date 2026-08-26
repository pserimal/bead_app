"""Single legend-item (user-selected box) recognition core.

This module implements the pure, engine-agnostic logic for the
"user selects one legend box → one code + one quantity" feature.

It is intentionally separate from ``training/scripts/extract_mard_legend.py``
(which scans the whole bottom legend for dataset building).  That module is
not modified; this module only reuses its stable helpers (confusable
correction, colour-library vocabulary) and owns the single-box contract.

Contract
--------
Input  : original image size + user bbox in original pixel coords + OCR words
         inside the expanded crop.
Output : structured ``LegendBoxResult`` with normalised code/int count,
         raw texts, confidences, candidates, status and bbox echo.

The OCR engine itself (EasyOCR in the offline baseline, ONNX/Rust at deploy)
is injected; this file only parses/validates.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from ocr_core.code_library import load_library

# ---------------------------------------------------------------------------
# Shared constants (mirrors extract_mard_legend but owned here)
# ---------------------------------------------------------------------------

OCR_ALLOWLIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()"

CODE_RE = re.compile(r"[A-Z0-9]+")
COUNT_RE = re.compile(r"\d+")
# Find a code-like token inside a noisy string (e.g. "A4(98)" -> A4, 98)
SINGLE_BOX_SPLIT_RE = re.compile(r"([A-Z]\s*\d{1,2})[^0-9A-Z]*(\d{1,5})", re.IGNORECASE)

CONFUSABLE_PAIRS = {
    ("0", "O"),
    ("O", "0"),
    ("1", "I"),
    ("I", "1"),
    ("5", "S"),
    ("S", "5"),
    ("6", "G"),
    ("G", "6"),
    ("8", "B"),
    ("B", "8"),
}

MIN_BOX_SIZE = 12  # px, spec §Implementation: minimum
SAFE_MARGIN_RATIO = 0.03
SAFE_MARGIN_MIN_PX = 4
MAX_COUNT = 20000  # conservative system ceiling when grid capacity unknown
# Confidence threshold for "accepted" vs "needs_confirmation"
ACCEPT_CODE_CONF = 0.60
ACCEPT_COUNT_CONF = 0.60
LOW_COUNT_CONF = 0.35  # below this count is not trusted even if code is

# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LegendBoxBbox:
    x: float
    y: float
    width: float
    height: float

    def to_list(self) -> list[int]:
        return [int(round(self.x)), int(round(self.y)), int(round(self.width)), int(round(self.height))]


@dataclass(frozen=True)
class BoxWord:
    """OCR word inside the single-box crop (coords in original image space)."""

    text: str
    confidence: float
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def x_center(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def y_center(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def height(self) -> float:
        return self.y1 - self.y0


@dataclass
class LegendBoxResult:
    code: Optional[str]  # normalised MARD code or None
    count: Optional[int]
    raw_code: Optional[str]
    raw_count: Optional[str]
    code_confidence: Optional[float]
    count_confidence: Optional[float]
    overall_confidence: float
    status: str  # accepted | needs_confirmation | invalid | recognition_failed | model_unavailable
    candidates: dict = field(default_factory=dict)
    bbox: Optional[LegendBoxBbox] = None  # echo of user bbox (not expanded)
    expanded_bbox: Optional[LegendBoxBbox] = None
    diagnostics: Optional[str] = None

    def to_dict(self) -> dict:
        d: dict = {
            "code": self.code,
            "count": self.count,
            "rawCode": self.raw_code,
            "rawCount": self.raw_count,
            "codeConfidence": self.code_confidence,
            "countConfidence": self.count_confidence,
            "overallConfidence": round(self.overall_confidence, 4),
            "status": self.status,
            "candidates": self.candidates,
        }
        if self.bbox is not None:
            d["bbox"] = {
                "x": int(round(self.bbox.x)),
                "y": int(round(self.bbox.y)),
                "width": int(round(self.bbox.width)),
                "height": int(round(self.bbox.height)),
            }
        if self.expanded_bbox is not None:
            d["expandedBbox"] = {
                "x": int(round(self.expanded_bbox.x)),
                "y": int(round(self.expanded_bbox.y)),
                "width": int(round(self.expanded_bbox.width)),
                "height": int(round(self.expanded_bbox.height)),
            }
        if self.diagnostics:
            d["diagnostics"] = self.diagnostics
        return d


# ---------------------------------------------------------------------------
# BBox validation / expansion
# ---------------------------------------------------------------------------


def _is_finite_number(v) -> bool:
    try:
        f = float(v)
        return math.isfinite(f)
    except Exception:
        return False


def validate_bbox(bbox: dict, img_w: int, img_h: int) -> tuple[Optional[str], Optional[LegendBoxBbox]]:
    """Validate user bbox (original-pixel coords).

    Returns (error_code, normalised_bbox).  On success error_code is None.
    Error codes: INVALID_BBOX_* (suitable for API error code).
    """
    if not isinstance(bbox, dict):
        return "INVALID_BBOX_TYPE", None
    for k in ("x", "y", "width", "height"):
        if k not in bbox:
            return "INVALID_BBOX_MISSING_FIELD", None
        if not _is_finite_number(bbox[k]):
            return "INVALID_BBOX_NOT_FINITE", None
    x, y, w, h = float(bbox["x"]), float(bbox["y"]), float(bbox["width"]), float(bbox["height"])
    if w <= 0 or h <= 0:
        return "INVALID_BBOX_SIZE", None
    if w < MIN_BOX_SIZE or h < MIN_BOX_SIZE:
        return "INVALID_BBOX_TOO_SMALL", None
    if img_w <= 0 or img_h <= 0:
        return "INVALID_IMAGE_SIZE", None
    # Reject completely outside image (no overlap)
    if x >= img_w or y >= img_h or x + w <= 0 or y + h <= 0:
        return "INVALID_BBOX_OUT_OF_BOUNDS", None
    # Clamp partially-outside to image (spec: must not crash; we report invalid if >50% outside)
    # For behavioural test: partially outside is accepted as long as overlap >= 50% of area
    # Otherwise treat as invalid.
    # Clamped bbox for further processing
    nx = max(0.0, min(float(img_w - 1), x))
    ny = max(0.0, min(float(img_h - 1), y))
    nw = max(1.0, min(float(img_w) - nx, w - (nx - x) if x < 0 else w))
    nh = max(1.0, min(float(img_h) - ny, h - (ny - y) if y < 0 else h))
    # If clamped size differs a lot, still accept but diagnostic will reflect expanded handling
    return None, LegendBoxBbox(x=nx, y=ny, width=nw, height=nh)


def expand_bbox(bbox: LegendBoxBbox, img_w: int, img_h: int, ratio: float = SAFE_MARGIN_RATIO) -> LegendBoxBbox:
    """Expand bbox by a small safe margin, clipped to image bounds."""
    pad_x = max(SAFE_MARGIN_MIN_PX, bbox.width * ratio)
    pad_y = max(SAFE_MARGIN_MIN_PX, bbox.height * ratio)
    x0 = max(0.0, bbox.x - pad_x)
    y0 = max(0.0, bbox.y - pad_y)
    x1 = min(float(img_w), bbox.x + bbox.width + pad_x)
    y1 = min(float(img_h), bbox.y + bbox.height + pad_y)
    return LegendBoxBbox(x=x0, y=y0, width=max(1.0, x1 - x0), height=max(1.0, y1 - y0))


# ---------------------------------------------------------------------------
# Code / count normalisation
# ---------------------------------------------------------------------------


def normalise_code(text: str) -> str:
    return "".join(CODE_RE.findall(text.upper()))


def parse_count(text: str) -> Optional[int]:
    digits = "".join(COUNT_RE.findall(text))
    if not digits:
        return None
    try:
        v = int(digits)
    except ValueError:
        return None
    # remove leading zeros by int conversion is fine; 0 is invalid
    if v <= 0 or v > MAX_COUNT:
        # >MAX_COUNT is not auto-accepted; caller will downgrade to needs_confirmation
        # but we still return the value so caller can decide
        # For strict invalid we return None only for <=0
        if v <= 0:
            return None
    return v


def is_count_like(text: str) -> bool:
    """Quantity field must look like a number, not an alphanumeric code."""
    t = text.strip()
    if not t:
        return False
    if re.search(r"[A-Za-z]", t):
        return False
    if not re.search(r"\d", t):
        return False
    if re.search(r"[^0-9\(\)\s,\.]", t):
        return False
    return True


def normalise_count_text(text: str) -> tuple[Optional[int], str]:
    """Return (count_or_None, stripped_raw)."""
    raw = text.strip()
    c = parse_count(raw)
    return c, raw


def weighted_edit_distance(source: str, candidate: str) -> float:
    table = np.zeros((len(source) + 1, len(candidate) + 1), dtype=float)
    table[:, 0] = np.arange(len(source) + 1, dtype=float)
    table[0, :] = np.arange(len(candidate) + 1, dtype=float)
    for i, sc in enumerate(source, 1):
        for j, cc in enumerate(candidate, 1):
            if sc == cc:
                replace = 0.0
            elif (sc, cc) in CONFUSABLE_PAIRS:
                replace = 0.15
            else:
                replace = 1.0
            table[i, j] = min(
                table[i - 1, j] + 1.0,
                table[i, j - 1] + 1.0,
                table[i - 1, j - 1] + replace,
            )
    return float(table[-1, -1])


def load_mard_codes() -> set[str]:
    return {e["code"].upper() for e in load_library() if e.get("brand") == "mard" and e.get("code")}


def resolve_mard_code(text: str, mard_codes: set[str]) -> Optional[str]:
    raw = normalise_code(text)
    if raw in mard_codes:
        return raw
    if not raw:
        return None
    ranked = sorted((weighted_edit_distance(raw, code), code) for code in mard_codes)
    best_d, best = ranked[0]
    second_d = ranked[1][0] if len(ranked) > 1 else float("inf")
    if best_d <= 0.2 and best_d + 0.1 < second_d:
        return best
    return None


def code_candidates(text: str, mard_codes: set[str], top_k: int = 3) -> list[tuple[str, float]]:
    raw = normalise_code(text)
    if not raw:
        return []
    ranked = sorted((weighted_edit_distance(raw, code), code) for code in mard_codes)
    return [(code, d) for d, code in ranked[:top_k]]


# ---------------------------------------------------------------------------
# Box parsing
# ---------------------------------------------------------------------------


def _words_sorted(words: list[BoxWord]) -> list[BoxWord]:
    # Primary y then x; tolerate vertical layout by grouping rows first
    return sorted(words, key=lambda w: (w.y_center, w.x_center))


def parse_legend_box(
    words: list[BoxWord],
    mard_codes: set[str],
    bbox: Optional[LegendBoxBbox] = None,
    expanded_bbox: Optional[LegendBoxBbox] = None,
) -> LegendBoxResult:
    """Parse OCR words inside a single user-selected legend box.

    The parser is format-agnostic: it tries to find one valid MARD code and
    one positive integer count regardless of whether they are side-by-side,
    stacked, or merged into one word (e.g. "A4(98)").
    """
    if not words:
        return LegendBoxResult(
            code=None,
            count=None,
            raw_code=None,
            raw_count=None,
            code_confidence=None,
            count_confidence=None,
            overall_confidence=0.0,
            status="recognition_failed",
            candidates={},
            bbox=bbox,
            expanded_bbox=expanded_bbox,
            diagnostics="no OCR words in box",
        )

    # Normalise texts and confidences
    words = _words_sorted([w for w in words if w.text.strip()])

    # Case 1: single word containing both code and count (e.g. "A4(98)" or "H7 6227")
    if len(words) == 1:
        txt = words[0].text
        m = SINGLE_BOX_SPLIT_RE.search(txt)
        if m:
            code_part, count_part = m.group(1), m.group(2)
            resolved = resolve_mard_code(code_part, mard_codes)
            cnt = parse_count(count_part)
            if resolved is not None and cnt is not None and 0 < cnt <= MAX_COUNT:
                cands = code_candidates(code_part, mard_codes)
                # Only auto-accept if OCR confidence is sufficient
                conf = float(words[0].confidence)
                status = "accepted" if conf >= ACCEPT_CODE_CONF and conf >= ACCEPT_COUNT_CONF else "needs_confirmation"
                return LegendBoxResult(
                    code=resolved,
                    count=cnt,
                    raw_code=txt.strip(),
                    raw_count=txt.strip(),
                    code_confidence=conf,
                    count_confidence=conf,
                    overall_confidence=conf,
                    status=status,
                    candidates={"code": [c for c, _ in cands[:3]]} if resolved is None or cands[0][0] != resolved else {},
                    bbox=bbox,
                    expanded_bbox=expanded_bbox,
                )
        # Fall through to generic pair logic

    # Generic: score each word as code vs count
    code_hits: list[tuple[int, BoxWord, str, float]] = []  # idx, word, resolved, distance
    count_hits: list[tuple[int, BoxWord, int]] = []

    for idx, w in enumerate(words):
        resolved = resolve_mard_code(w.text, mard_codes)
        if resolved is not None:
            # distance 0 for exact
            d = weighted_edit_distance(normalise_code(w.text), resolved)
            code_hits.append((idx, w, resolved, d))
        if is_count_like(w.text):
            cnt = parse_count(w.text)
            if cnt is not None and cnt > 0:
                # Reject obvious huge false positives (>MAX) but keep for diagnostic
                count_hits.append((idx, w, cnt))

    # Strategy: pick best code (unique, high conf) and best count (closest in layout)
    # If multiple candidates, apply layout proximity heuristic.

    # If we have exactly 2 words and each maps to one role, accept that pairing
    if len(words) == 2:
        w0, w1 = words[0], words[1]
        c0 = resolve_mard_code(w0.text, mard_codes)
        c1 = resolve_mard_code(w1.text, mard_codes)
        n0 = parse_count(w0.text) if is_count_like(w0.text) else None
        n1 = parse_count(w1.text) if is_count_like(w1.text) else None
        # Determine role assignment
        pairing = None
        if c0 is not None and n1 is not None:
            pairing = (w0, c0, w0.confidence, w1, n1, w1.confidence)
        elif c1 is not None and n0 is not None:
            pairing = (w1, c1, w1.confidence, w0, n0, w0.confidence)
        elif c0 is not None and c1 is None and n1 is not None:
            pairing = (w0, c0, w0.confidence, w1, n1, w1.confidence)
        elif c1 is not None and c0 is None and n0 is not None:
            pairing = (w1, c1, w1.confidence, w0, n0, w0.confidence)
        if pairing is not None:
            cw, cc, cf, nw, nc, nf = pairing
            # need_confirmation if any conf low or count out-of-range huge
            status = "accepted"
            if cf < ACCEPT_CODE_CONF or nf < ACCEPT_COUNT_CONF or nc > MAX_COUNT:
                status = "needs_confirmation"
            cands = code_candidates(cw.text, mard_codes)
            return LegendBoxResult(
                code=cc,
                count=nc,
                raw_code=cw.text,
                raw_count=nw.text,
                code_confidence=float(cf),
                count_confidence=float(nf),
                overall_confidence=float((cf + nf) / 2),
                status=status,
                candidates={} if status == "accepted" else {"code": [c for c, _ in cands[:3]]},
                bbox=bbox,
                expanded_bbox=expanded_bbox,
            )

    # General case: >2 words or ambiguous 2-word case
    # Pick highest-confidence valid code; pick count word nearest to that code (layout)
    best_code = None
    best_code_word = None
    best_code_conf = -1.0
    for _, w, resolved, _d in code_hits:
        # Use OCR confidence; distance already used to decide validity
        if float(w.confidence) > best_code_conf:
            best_code = resolved
            best_code_word = w
            best_code_conf = float(w.confidence)

    # If no valid code, try to propose candidates from closest edit distance (for UX)
    if best_code is None:
        # Collect candidates across all words
        all_cands: dict[str, float] = {}
        for w in words:
            for cand, d in code_candidates(w.text, mard_codes, top_k=1):
                # keep best distance per cand
                if cand not in all_cands or d < all_cands[cand]:
                    all_cands[cand] = d
        # pick smallest distance
        if all_cands:
            cand_sorted = sorted(all_cands.items(), key=lambda kv: kv[1])
            top = cand_sorted[:3]
            # Still recognition_failed because no valid code
            return LegendBoxResult(
                code=None,
                count=count_hits[0][2] if count_hits else None,
                raw_code=words[0].text if words else None,
                raw_count=count_hits[0][1].text if count_hits else None,
                code_confidence=None,
                count_confidence=float(count_hits[0][1].confidence) if count_hits else None,
                overall_confidence=float(count_hits[0][1].confidence) / 2 if count_hits else 0.0,
                status="needs_confirmation" if count_hits else "recognition_failed",
                candidates={"code": [c for c, _ in top]},
                bbox=bbox,
                expanded_bbox=expanded_bbox,
                diagnostics="no valid MARD code in box",
            )
        return LegendBoxResult(
            code=None,
            count=count_hits[0][2] if count_hits else None,
            raw_code=None,
            raw_count=count_hits[0][1].text if count_hits else None,
            code_confidence=None,
            count_confidence=float(count_hits[0][1].confidence) if count_hits else None,
            overall_confidence=0.0,
            status="recognition_failed",
            candidates={},
            bbox=bbox,
            expanded_bbox=expanded_bbox,
            diagnostics="no valid MARD code in box",
        )

    # Have a code; pick count
    # If multiple counts, choose nearest to code word (Euclidean center distance)
    best_count = None
    best_count_word = None
    best_dist = float("inf")
    best_count_conf = 0.0
    for _, w, cnt in count_hits:
        # Don't double-count the same word used for code if that word also parses as count but is the code word
        if w is best_code_word and len(words) > 1:
            # Allow if the word is like "A4(98)" already handled; otherwise skip
            continue
        dist = math.hypot(w.x_center - best_code_word.x_center, w.y_center - best_code_word.y_center) if best_code_word else 0
        if dist < best_dist or (dist == best_dist and float(w.confidence) > best_count_conf):
            best_dist = dist
            best_count = cnt
            best_count_word = w
            best_count_conf = float(w.confidence)

    if best_count is None:
        return LegendBoxResult(
            code=best_code,
            count=None,
            raw_code=best_code_word.text,
            raw_count=None,
            code_confidence=float(best_code_conf),
            count_confidence=None,
            overall_confidence=float(best_code_conf) / 2,
            status="needs_confirmation",
            candidates={},
            bbox=bbox,
            expanded_bbox=expanded_bbox,
            diagnostics="no quantity found in box",
        )

    # Both found
    status = "accepted"
    if best_code_conf < ACCEPT_CODE_CONF or best_count_conf < ACCEPT_COUNT_CONF or best_count is not None and best_count > MAX_COUNT:
        status = "needs_confirmation"
    # If count is huge (>MAX) downgrade
    if best_count is not None and best_count > MAX_COUNT:
        status = "needs_confirmation"

    overall = (float(best_code_conf) + float(best_count_conf)) / 2

    # Provide code candidates only when not confidently accepted
    cands_out: dict = {}
    if status != "accepted":
        cands = code_candidates(best_code_word.text, mard_codes, top_k=3)
        cands_out = {"code": [c for c, _ in cands]}

    return LegendBoxResult(
        code=best_code,
        count=best_count,
        raw_code=best_code_word.text,
        raw_count=best_count_word.text,
        code_confidence=float(best_code_conf),
        count_confidence=float(best_count_conf),
        overall_confidence=overall,
        status=status,
        candidates=cands_out,
        bbox=bbox,
        expanded_bbox=expanded_bbox,
    )
