#!/usr/bin/env python3
"""Extract mard bead codes and quantities from a board image's bottom legend.

The legend is read separately from the board cells.  EasyOCR detects the
large labels in the lower part of the image; detected words are grouped into
rows and paired as ``code, (quantity)``.  Codes are constrained to the mard
entries in ``artifacts/colors/library.json``.  This lets us correct narrowly
ambiguous glyphs such as ``614`` to ``G14`` without accepting a code from a
different bead brand.

Usage::

    conda run -n bead-train python -m training.scripts.extract_mard_legend \
        training/samples/2.jpg --json .scratch/2-mard-legend.json
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

from ocr_core.code_library import load_library


OCR_ALLOWLIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()"
CODE_RE = re.compile(r"[A-Z0-9]+")
COUNT_RE = re.compile(r"\d+")

# EasyOCR commonly confuses these glyphs in the white legend text.  The cost
# is intentionally much lower than a general substitution, but non-zero so a
# literal valid code always wins.
CONFUSABLE_PAIRS = {
    ("0", "O"), ("O", "0"),
    ("1", "I"), ("I", "1"),
    ("5", "S"), ("S", "5"),
    ("6", "G"), ("G", "6"),
    ("8", "B"), ("B", "8"),
}


@dataclass(frozen=True)
class OcrWord:
    text: str
    confidence: float
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def x_center(self) -> float:
        return (self.x0 + self.x1) / 2.0

    @property
    def y_center(self) -> float:
        return (self.y0 + self.y1) / 2.0

    @property
    def height(self) -> float:
        return self.y1 - self.y0


@dataclass(frozen=True)
class LegendEntry:
    code: str
    count: int


def load_mard_codes() -> set[str]:
    """Return the closed vocabulary supported by this extractor."""
    return {
        item["code"].upper()
        for item in load_library()
        if item.get("brand") == "mard" and item.get("code")
    }


def load_image(path: Path) -> np.ndarray:
    """Read Unicode paths reliably on Windows."""
    image = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"cannot read image: {path}")
    return image


def read_words(
    image: np.ndarray,
    bottom_ratio: float,
    min_confidence: float,
) -> list[OcrWord]:
    """Run OCR on the lower image portion and discard grid-sized text."""
    try:
        import easyocr
    except ImportError as exc:  # pragma: no cover - environment configuration
        raise RuntimeError(
            "EasyOCR is required. Run this script with the bead-train conda environment."
        ) from exc

    height, _ = image.shape[:2]
    top = int(round(height * (1.0 - bottom_ratio)))
    legend = image[top:]
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    raw = reader.readtext(
        legend,
        detail=1,
        paragraph=False,
        allowlist=OCR_ALLOWLIST,
    )

    # The card labels are much taller than the code printed in grid cells.
    # The floor keeps small but legitimate legends usable on phone screenshots.
    min_word_height = max(24.0, height * 0.012)
    words: list[OcrWord] = []
    for bbox, text, confidence in raw:
        points = np.asarray(bbox, dtype=float)
        x0, y0 = points.min(axis=0)
        x1, y1 = points.max(axis=0)
        word = OcrWord(
            text=text.strip().upper(),
            confidence=float(confidence),
            x0=float(x0),
            y0=float(y0 + top),
            x1=float(x1),
            y1=float(y1 + top),
        )
        if word.confidence >= min_confidence and word.height >= min_word_height:
            words.append(word)
    return words


def group_rows(words: list[OcrWord]) -> list[list[OcrWord]]:
    """Cluster horizontal legend labels by their centre-line."""
    if not words:
        return []
    tolerance = float(np.median([word.height for word in words])) * 0.55
    rows: list[list[OcrWord]] = []
    for word in sorted(words, key=lambda item: item.y_center):
        if not rows:
            rows.append([word])
            continue
        center = float(np.mean([item.y_center for item in rows[-1]]))
        if abs(word.y_center - center) <= tolerance:
            rows[-1].append(word)
        else:
            rows.append([word])
    return [sorted(row, key=lambda item: item.x_center) for row in rows]


def normalise_code(text: str) -> str:
    return "".join(CODE_RE.findall(text.upper()))


def weighted_edit_distance(source: str, candidate: str) -> float:
    """Levenshtein distance that treats known OCR glyph swaps as near-equal."""
    table = np.zeros((len(source) + 1, len(candidate) + 1), dtype=float)
    table[:, 0] = np.arange(len(source) + 1, dtype=float)
    table[0, :] = np.arange(len(candidate) + 1, dtype=float)
    for i, source_char in enumerate(source, 1):
        for j, candidate_char in enumerate(candidate, 1):
            if source_char == candidate_char:
                replace = 0.0
            elif (source_char, candidate_char) in CONFUSABLE_PAIRS:
                replace = 0.15
            else:
                replace = 1.0
            table[i, j] = min(
                table[i - 1, j] + 1.0,
                table[i, j - 1] + 1.0,
                table[i - 1, j - 1] + replace,
            )
    return float(table[-1, -1])


def resolve_mard_code(text: str, mard_codes: set[str]) -> str | None:
    """Return a valid mard code, or ``None`` when OCR cannot be trusted."""
    raw = normalise_code(text)
    if raw in mard_codes:
        return raw
    if not raw:
        return None

    ranked = sorted(
        (weighted_edit_distance(raw, code), code)
        for code in mard_codes
    )
    best_distance, best_code = ranked[0]
    second_distance = ranked[1][0] if len(ranked) > 1 else float("inf")
    # Only repair one visually-confusable glyph, and reject ties.  A broad
    # fuzzy match would turn an OCR failure into a plausible but wrong colour.
    if best_distance <= 0.2 and best_distance + 0.1 < second_distance:
        return best_code
    return None


def parse_count(text: str) -> int | None:
    digits = "".join(COUNT_RE.findall(text))
    return int(digits) if digits else None


def legend_rows(words: list[OcrWord], mard_codes: set[str]) -> list[list[OcrWord]]:
    """Return rows that have the geometry and vocabulary of a mard legend."""
    selected: list[list[OcrWord]] = []
    for row in group_rows(words):
        # A real legend row has multiple colour cards.  One or two isolated
        # words in the lower region are normally diagonal watermark text;
        # ignore those before validating the actual alternating pairs.
        if len(row) < 4:
            continue
        code_words = row[::2]
        resolved_codes = [resolve_mard_code(code.text, mard_codes) for code in code_words]
        # Require at least two plausible mard codes before considering the
        # row a legend row.  This removes watermark lines that happen to be
        # split into an even number of horizontal OCR words.
        if sum(code is not None for code in resolved_codes) < 2:
            continue
        selected.append(row)
    return selected


def parse_entries(words: list[OcrWord], mard_codes: set[str]) -> tuple[list[LegendEntry], list[str]]:
    """Pair each row's alternating code/count OCR words into legend entries."""
    entries: list[LegendEntry] = []
    problems: list[str] = []
    for row_index, row in enumerate(legend_rows(words, mard_codes), 1):
        if len(row) % 2:
            problems.append(f"row {row_index}: expected code/count pairs, found {len(row)} OCR words")
            continue
        pairs = [tuple(row[index:index + 2]) for index in range(0, len(row), 2)]
        resolved_codes = [resolve_mard_code(code.text, mard_codes) for code, _ in pairs]
        for pair_index, ((raw_code, raw_count), code) in enumerate(zip(pairs, resolved_codes)):
            count = parse_count(raw_count.text)
            label = f"row {row_index}, item {pair_index + 1}"
            if code is None:
                problems.append(f"{label}: invalid mard code {raw_code.text!r}")
                continue
            if count is None or count <= 0:
                problems.append(f"{label}: invalid quantity {raw_count.text!r}")
                continue
            entries.append(LegendEntry(code=code, count=count))

    duplicated = sorted({entry.code for entry in entries if sum(
        candidate.code == entry.code for candidate in entries
    ) > 1})
    if duplicated:
        problems.append(f"duplicate codes: {', '.join(duplicated)}")
    return entries, problems


def _write_image(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, encoded = cv2.imencode(path.suffix or ".png", image)
    if not ok:
        raise ValueError(f"cannot encode image: {path}")
    encoded.tofile(str(path))


def export_legend_crops(
    image: np.ndarray,
    rows: list[list[OcrWord]],
    out_dir: Path,
    crops_per_row: int = 4,
) -> list[dict]:
    """Export complete legend-card crops and a numbered visual contact sheet."""
    height, width = image.shape[:2]
    manifests: list[dict] = []
    crops: list[tuple[str, np.ndarray]] = []

    for row_index, row in enumerate(rows, 1):
        code_words = row[::2]
        code_x = [word.x0 for word in code_words]
        if len(code_x) < 2:
            continue
        # The code starts at a stable left padding inside every card.  Using
        # adjacent code positions derives card boundaries without relying on
        # the card colour (which may be pure white).
        step = float(np.median(np.diff(code_x)))
        # 15 px keeps the rounded card edge without reaching across the
        # inter-card gutter into the preceding colour card.
        left_edges = [max(0, int(round(x - 15.0))) for x in code_x]
        right_edges = left_edges[1:] + [min(width, int(round(left_edges[-1] + step)))]

        # The colour-card border sits close to its text.  Deriving vertical
        # bounds from this row alone avoids taking the board coordinate bar
        # above the first legend row into the crop.
        top = max(0, int(round(min(word.y0 for word in row) - 14.0)))
        bottom = min(height, int(round(max(word.y1 for word in row) + 6.0)))

        for column_index, (left, right) in enumerate(zip(left_edges, right_edges), 1):
            crop = image[top:bottom, left:right]
            if crop.size == 0:
                continue
            label = f"R{row_index}C{column_index}"
            filename = f"r{row_index:02d}_c{column_index:02d}.png"
            _write_image(out_dir / filename, crop)
            crops.append((label, crop))
            manifests.append({
                "row": row_index,
                "column": column_index,
                "file": filename,
                "bbox": [left, top, right, bottom],
            })

    if not crops:
        return manifests

    tile_width, tile_height = 560, 140
    sheet_rows = (len(crops) + crops_per_row - 1) // crops_per_row
    sheet = np.full((sheet_rows * tile_height, crops_per_row * tile_width, 3), 255, dtype=np.uint8)
    for index, (label, crop) in enumerate(crops):
        sheet_row, sheet_column = divmod(index, crops_per_row)
        origin_x = sheet_column * tile_width
        origin_y = sheet_row * tile_height
        scale = min(520.0 / crop.shape[1], 92.0 / crop.shape[0])
        preview = cv2.resize(
            crop,
            (max(1, int(round(crop.shape[1] * scale))), max(1, int(round(crop.shape[0] * scale)))),
            interpolation=cv2.INTER_AREA,
        )
        x = origin_x + 20
        y = origin_y + 38
        sheet[y:y + preview.shape[0], x:x + preview.shape[1]] = preview
        cv2.putText(sheet, label, (origin_x + 20, origin_y + 27),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.75, (20, 20, 20), 2, cv2.LINE_AA)
    _write_image(out_dir / "contact-sheet.png", sheet)
    (out_dir / "manifest.json").write_text(
        json.dumps(manifests, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifests


def write_debug_image(image: np.ndarray, words: list[OcrWord], path: Path) -> None:
    """Write an OCR-box overlay for inspecting a failed extraction."""
    overlay = image.copy()
    for word in words:
        p0 = (int(round(word.x0)), int(round(word.y0)))
        p1 = (int(round(word.x1)), int(round(word.y1)))
        cv2.rectangle(overlay, p0, p1, (0, 220, 0), 4)
        cv2.putText(
            overlay,
            f"{word.text} {word.confidence:.2f}",
            (p0[0], max(25, p0[1] - 8)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 220, 0),
            2,
            cv2.LINE_AA,
        )
    _write_image(path, overlay)


def render(entries: list[LegendEntry], output_format: str) -> str:
    if output_format == "json":
        return json.dumps(
            [{"code": entry.code, "count": entry.count} for entry in entries],
            ensure_ascii=False,
            indent=2,
        )
    code_width = max(len(entry.code) for entry in entries)
    return "\n".join(f"{entry.code:<{code_width}}  {entry.count}" for entry in entries)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path, help="source board image")
    parser.add_argument(
        "--bottom-ratio",
        type=float,
        default=0.25,
        help="fraction of the image, measured from the bottom, that contains the legend (default: 0.25)",
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=0.35,
        help="minimum EasyOCR confidence before pairing a word (default: 0.35)",
    )
    parser.add_argument("--format", choices=("json", "table"), default="json")
    parser.add_argument("--json", type=Path, help="optional path for the JSON result")
    parser.add_argument("--debug-image", type=Path, help="optional OCR-box overlay image")
    parser.add_argument(
        "--export-crops",
        type=Path,
        help="optional directory for numbered, complete legend-card crops and a contact sheet",
    )
    args = parser.parse_args()

    if not 0.05 <= args.bottom_ratio <= 0.8:
        parser.error("--bottom-ratio must be between 0.05 and 0.8")
    if not 0.0 <= args.min_confidence <= 1.0:
        parser.error("--min-confidence must be between 0 and 1")
    if not args.image.is_file():
        parser.error(f"image does not exist: {args.image}")

    image = load_image(args.image)
    words = read_words(image, args.bottom_ratio, args.min_confidence)
    mard_codes = load_mard_codes()
    entries, problems = parse_entries(words, mard_codes)
    if args.debug_image:
        write_debug_image(image, words, args.debug_image)
    if args.export_crops:
        export_legend_crops(image, legend_rows(words, mard_codes), args.export_crops)
    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        return 2
    if not entries:
        print("error: no legend entries found", file=sys.stderr)
        return 2

    result = render(entries, args.format)
    print(result)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(render(entries, "json") + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
