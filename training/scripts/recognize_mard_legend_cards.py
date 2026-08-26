#!/usr/bin/env python3
"""Recognize user-cropped mard legend cards as ``code + quantity`` pairs.

Each input image must contain exactly one complete legend card, for example
``F2 (38)``.  The card is passed to EasyOCR as a whole so its text detector
can isolate the horizontal code and quantity from diagonal watermarks.  The
detected text boxes are routed by horizontal position: mard code on the left
and quantity on the right.

This is a training-side baseline.  It avoids making a full legend scan depend
on word-box pairing, records the raw OCR text needed to build a later
specialised CRNN dataset, and uses the known board grid total as a hard
validation gate rather than guessing a corrected number.

Usage::

    conda run -n bead-train python -m training.scripts.recognize_mard_legend_cards \
        .scratch/legend-card-crops/2 --rows 88 --cols 156 \
        --out .scratch/legend-card-crops/2/recognition.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2
import numpy as np

from training.scripts.extract_mard_legend import load_image, load_mard_codes, resolve_mard_code


CARD_NAME_RE = re.compile(r"r(\d+)_c(\d+)\.png$", re.IGNORECASE)

# The crop geometry is measured from the user-approved mard legend cards.
CODE_RIGHT_RATIO = 0.27


@dataclass(frozen=True)
class TextCandidate:
    text: str
    confidence: float
    x_center: float


@dataclass(frozen=True)
class CardResult:
    row: int
    column: int
    code: str
    code_confidence: float
    count: int
    count_confidence: float
    count_raw_text: str


def card_key(path: Path) -> tuple[int, int]:
    match = CARD_NAME_RE.match(path.name)
    if not match:
        raise ValueError(f"crop filename must match rNN_cNN.png: {path.name}")
    return int(match.group(1)), int(match.group(2))


def resolve_card_code(text: str, mard_codes: set[str]) -> str | None:
    """Resolve a mard code, tolerating watermark digits after a valid code."""
    direct = resolve_mard_code(text, mard_codes)
    if direct is not None:
        return direct
    raw = "".join(character for character in text.upper() if character.isalnum())
    prefixes = [code for code in mard_codes if raw.startswith(code)]
    # A longest valid prefix is safe here: mard codes themselves have a
    # letter-plus-digits form, while the discarded suffix came from the same
    # left-side OCR detection (e.g. B14 + a watermark stroke -> B146).
    return max(prefixes, key=len) if prefixes else None


def parse_quantity_text(text: str) -> int | None:
    """Prefer a balanced parenthesised quantity over neighbouring watermark text."""
    parenthesised = re.search(r"\((\d+)\)", text)
    digits = parenthesised.group(1) if parenthesised else "".join(
        character for character in text if character.isdigit()
    )
    return int(digits) if digits else None


def read_text(reader: object, card: np.ndarray) -> list[TextCandidate]:
    """Return all horizontal OCR detections in one complete card."""
    raw = reader.readtext(
        card,
        detail=1,
        paragraph=False,
        allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()",
    )
    return [
        TextCandidate(
            text=text.strip().upper(),
            confidence=float(confidence),
            x_center=float(np.asarray(bbox, dtype=float)[:, 0].mean()),
        )
        for bbox, text, confidence in raw
        if text.strip()
    ]


def read_region_text(reader: object, region: np.ndarray, allowlist: str) -> list[tuple[str, float]]:
    """Fallback OCR when the full-card detector misses one side entirely."""
    raw = reader.readtext(region, detail=1, paragraph=False, allowlist=allowlist)
    return [
        (text.strip().upper(), float(confidence))
        for _, text, confidence in raw
        if text.strip()
    ]


def recognize_card(
    path: Path,
    reader: object,
    mard_codes: set[str],
    expected_total: int,
) -> CardResult:
    image = load_image(path)
    _, width = image.shape[:2]
    detections = read_text(reader, image)
    code_text = [item for item in detections if item.x_center < width * CODE_RIGHT_RATIO]
    code_candidates = [
        (resolve_card_code(item.text, mard_codes), item.confidence)
        for item in code_text
    ]
    code_candidates = [(code, confidence) for code, confidence in code_candidates if code is not None]
    if not code_candidates:
        code_candidates = [
            (resolve_card_code(text, mard_codes), confidence)
            for text, confidence in read_region_text(
                reader, image[:, :int(round(width * CODE_RIGHT_RATIO))],
                "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            )
        ]
        code_candidates = [(code, confidence) for code, confidence in code_candidates if code is not None]
    if not code_candidates:
        raise ValueError(f"{path.name}: no valid mard code in {[item.text for item in code_text]}")
    code, code_confidence = max(code_candidates, key=lambda item: item[1])

    count_text = [item for item in detections if item.x_center >= width * CODE_RIGHT_RATIO]
    count_candidates = []
    for item in count_text:
        value = parse_quantity_text(item.text)
        if value is not None and 0 < value <= expected_total:
            count_candidates.append((value, item.confidence, item.text))
    if not count_candidates:
        for text, confidence in read_region_text(
            reader,
            image[:, int(round(width * CODE_RIGHT_RATIO)):],
            "0123456789()",
        ):
            value = parse_quantity_text(text)
            if value is not None and 0 < value <= expected_total:
                count_candidates.append((value, confidence, text))
    if not count_candidates:
        raise ValueError(f"{path.name}: no numeric quantity in {[item.text for item in count_text]}")
    count, count_confidence, count_raw_text = max(
        count_candidates, key=lambda item: item[1]
    )
    row, column = card_key(path)
    return CardResult(
        row, column, code, code_confidence,
        count, count_confidence, count_raw_text,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("crops_dir", type=Path, help="directory containing rNN_cNN.png card crops")
    parser.add_argument("--rows", type=int, required=True, help="board grid row count")
    parser.add_argument("--cols", type=int, required=True, help="board grid column count")
    parser.add_argument("--out", type=Path, required=True, help="JSON output path")
    parser.add_argument(
        "--allow-total-mismatch",
        action="store_true",
        help="write and return the raw result even when the grid-total check fails",
    )
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="write recognised cards and per-card errors instead of stopping at the first failure",
    )
    args = parser.parse_args()
    if args.rows <= 0 or args.cols <= 0:
        parser.error("--rows and --cols must be positive")
    if not args.crops_dir.is_dir():
        parser.error(f"crop directory does not exist: {args.crops_dir}")

    try:
        import easyocr
    except ImportError as exc:  # pragma: no cover - environment configuration
        raise RuntimeError("EasyOCR is required; use the bead-train conda environment") from exc

    crop_paths = sorted(args.crops_dir.glob("r*_c*.png"), key=card_key)
    if not crop_paths:
        parser.error(f"no rNN_cNN.png crops in {args.crops_dir}")
    expected_total = args.rows * args.cols
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    mard_codes = load_mard_codes()
    cards: list[CardResult] = []
    failures: list[dict[str, str]] = []
    for path in crop_paths:
        try:
            cards.append(recognize_card(path, reader, mard_codes, expected_total))
        except ValueError as exc:
            if not args.allow_partial:
                raise
            failures.append({"file": path.name, "reason": str(exc)})

    if not cards:
        raise ValueError("no card could be recognised")

    duplicate_codes = sorted({card.code for card in cards if sum(
        other.code == card.code for other in cards
    ) > 1})
    if duplicate_codes and not args.allow_partial:
        raise ValueError(f"duplicate mard codes: {', '.join(duplicate_codes)}")

    entries = []
    for card in cards:
        entries.append({
            "row": card.row,
            "column": card.column,
            "code": card.code,
            "count": card.count,
            "codeConfidence": round(card.code_confidence, 6),
            "countConfidence": round(card.count_confidence, 6),
            "countRawText": card.count_raw_text,
        })
    recognized_total = sum(item["count"] for item in entries)
    result = {
        "expectedTotal": expected_total,
        "recognizedTotal": recognized_total,
        "recognizedCards": len(entries),
        "failedCards": failures,
        "duplicateCodes": duplicate_codes,
        "validated": not failures and not duplicate_codes and recognized_total == expected_total,
        "entries": entries,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"recognized {len(entries)}/{len(crop_paths)} cards; "
        f"total={recognized_total}/{expected_total}"
    )
    for entry in entries:
        print(f"R{entry['row']}C{entry['column']}: {entry['code']} ({entry['count']})")
    if failures:
        for failure in failures:
            print(f"error: {failure['reason']}", file=sys.stderr)
        if not args.allow_partial:
            return 2
    if duplicate_codes:
        print(f"error: duplicate mard codes: {', '.join(duplicate_codes)}", file=sys.stderr)
        if not args.allow_partial:
            return 2
    if recognized_total != expected_total:
        print(
            "error: quantity total mismatch; review low-confidence cards before accepting",
            file=sys.stderr,
        )
        if not args.allow_total_mismatch:
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
