"""Tests for T10 — Data-driven code regex for _parse_code.

Verifies:
  1. _VALID_CODE_PATTERN accepts all 65 library codes
  2. Pattern rejects invalid shapes
  3. _ALLOWLIST includes all characters needed for library codes
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.bead_ocr import _ALLOWLIST, _VALID_CODE_PATTERN, _parse_code

# test_code_regex.py runs from backend/tests/, so go up to project root
# then down to backend/app/data/default_colors.json
_LIBRARY_PATH = Path(__file__).parent.parent / "app" / "data" / "default_colors.json"


# ── Pattern validation ──────────────────────────────────────────────────


def test_pattern_accepts_all_library_codes():
    with open(_LIBRARY_PATH) as f:
        codes = [e["code"] for e in json.load(f)]
    rejected = [c for c in codes if not _VALID_CODE_PATTERN.match(c)]
    assert rejected == [], f"Pattern rejected {len(rejected)} valid codes: {rejected[:10]}"


def test_pattern_rejects_invalid_shapes():
    """Shapes that don't match [letter][digit]{1,2}."""
    bad = ["XYZ", "12A", "Q-8", "", "H", "ABC"]
    for code in bad:
        assert not _VALID_CODE_PATTERN.match(code), f"Should reject: {code!r}"


def test_pattern_rejects_empty_string():
    assert _VALID_CODE_PATTERN.match("") is None


def test_pattern_accepts_h100_truncated():
    """H100 matches first 3 chars (H10) because regex is ^[letter][0-9]{1,2}."""
    m = _VALID_CODE_PATTERN.match("H100")
    assert m is not None
    assert m.group() == "H10"


# ── _parse_code function ─────────────────────────────────────────────────


def test_parse_code_accepts_valid_code():
    assert _parse_code("H7") == "H7"
    assert _parse_code("F1") == "F1"
    assert _parse_code("G5") == "G5"
    assert _parse_code("H52") == "H52"


def test_parse_code_normalizes_case():
    assert _parse_code("h7") == "H7"
    assert _parse_code("g5") == "G5"


def test_parse_code_strips_junk_characters():
    """EasyOCR sometimes includes stray punctuation."""
    assert _parse_code("H7!") == "H7"
    assert _parse_code("F1.") == "F1"


def test_parse_code_none_on_empty():
    assert _parse_code("") is None
    assert _parse_code(None) is None


def test_parse_code_none_on_junk_only():
    assert _parse_code("!!!") is None
    assert _parse_code("...") is None


# ── _ALLOWLIST coverage ─────────────────────────────────────────────────


def test_allowlist_covers_all_library_codes():
    """Every char in every library code must be in _ALLOWLIST."""
    with open(_LIBRARY_PATH) as f:
        codes = [e["code"] for e in json.load(f)]
    for code in codes:
        for ch in code:
            assert ch in _ALLOWLIST, f"char {ch!r} of {code!r} not in _ALLOWLIST"