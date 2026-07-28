"""Synthetic Perler bead template generator.

Generates synthetic bead board images with known ground-truth codes
for testing the OCR pipeline.

Usage:
    python -m backend.tests.fixtures.synthetic_template --generate

Output:
    backend/tests/fixtures/templates/
        template_{rows}x{cols}_s{seed}.png  — bead board image
        template_{rows}x{cols}_s{seed}.json — ground truth mapping code→positions
"""

import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PALETTE_PATH = Path(__file__).resolve().parents[2] / "app" / "data" / "default_colors.json"

# DejaVu Sans is available on most Linux systems.  Fall back to default if absent.
_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
FONT_PATH: str | None = None
for _p in _FONT_CANDIDATES:
    if Path(_p).exists():
        FONT_PATH = _p
        break

CELL_SIZE = 32  # pixels per cell

OUTPUT_DIR = Path(__file__).resolve().parent / "templates"

# 4 board sizes × 5 seeds = 20 templates
STANDARD_SIZES: list[tuple[int, int]] = [
    (29, 29),
    (49, 39),
    (69, 49),
    (79, 57),
]

SEEDS = [0, 1, 2, 3, 4]

# ---------------------------------------------------------------------------
# Palette
# ---------------------------------------------------------------------------

def load_palette() -> list[dict]:
    """Return the full color palette from ``default_colors.json``."""
    with open(PALETTE_PATH) as f:
        return json.load(f)


def _is_blue_detected(hex_color: str) -> bool:
    """Check whether a hex colour would be detected as 'blue' by the acceptance-criteria
    HSV filter ``cv2.inRange(hsv, (100, 50, 50), (130, 255, 255))``.

    We pre-compute this so that templates *without* blue guide lines can avoid
    palette colours that would falsely register as grid-line pixels.
    """
    import cv2
    import numpy as np

    rgb = tuple(int(hex_color[i : i + 2], 16) for i in (1, 3, 5))
    img = np.zeros((1, 1, 3), dtype=np.uint8)
    img[0, 0] = rgb
    h, s, v = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)[0, 0]
    return 100 <= h <= 130 and s >= 50 and v >= 50


# ---------------------------------------------------------------------------
# Font helpers
# ---------------------------------------------------------------------------

def _get_font(size: int = 11) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    if FONT_PATH is not None:
        return ImageFont.truetype(FONT_PATH, size)
    return ImageFont.load_default()


# ---------------------------------------------------------------------------
# Core generator
# ---------------------------------------------------------------------------

def make_template(
    rows: int,
    cols: int,
    *,
    n_codes_seed: int = 0,
    with_blue_lines: bool = True,
    with_text: bool = True,
) -> tuple[Image.Image, dict[tuple[int, int], str]]:
    """Generate a synthetic Perler bead template with known ground-truth codes.

    When ``with_blue_lines=False``, palette colours that would register as
    blue under the acceptance-criteria HSV filter are excluded so that the
    absence of grid lines can be verified automatically.

    Parameters
    ----------
    rows, cols:
        Grid dimensions in cells.
    n_codes_seed:
        Seed for reproducible pseudo-random code selection.
    with_blue_lines:
        Whether to draw 1 px blue grid lines at cell boundaries.
    with_text:
        Whether to render the code string centred in each cell.

    Returns
    -------
    (PIL image, ground-truth dict) where the dict maps ``(row, col)`` → ``code``.
    """
    palette = load_palette()
    # When no blue guide lines are drawn, exclude palette entries that would
    # trigger the acceptance-criteria blue-pixel detector.
    if not with_blue_lines:
        palette = [e for e in palette if not _is_blue_detected(e["color_hex"])]
    all_codes = [entry["code"] for entry in palette]
    code_to_rgb = {
        entry["code"]: tuple(int(entry["color_hex"][i : i + 2], 16) for i in (1, 3, 5))
        for entry in palette
    }

    rng = random.Random(n_codes_seed)

    # --- Build the code grid deterministically ---
    grid: dict[tuple[int, int], str] = {}
    for r in range(rows):
        for c in range(cols):
            grid[(r, c)] = rng.choice(all_codes)

    # --- Render the image ---
    img_w = cols * CELL_SIZE
    img_h = rows * CELL_SIZE
    img = Image.new("RGB", (img_w, img_h), (0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Choose a font size that fits the longest code (e.g. "H10" = 3 chars)
    max_len = max(len(c) for c in all_codes)
    font_size = 11 if max_len <= 3 else 10
    font = _get_font(font_size)

    for r in range(rows):
        for c in range(cols):
            code = grid[(r, c)]
            rgb = code_to_rgb[code]

            x1, y1 = c * CELL_SIZE, r * CELL_SIZE
            x2, y2 = x1 + CELL_SIZE, y1 + CELL_SIZE

            # Fill cell with its palette colour
            draw.rectangle([x1, y1, x2, y2], fill=rgb)

            # Centred text with contrasting colour
            if with_text:
                luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
                text_colour = (0, 0, 0) if luminance > 128 else (255, 255, 255)
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                draw.text((cx, cy), code, fill=text_colour, font=font, anchor="mm")

    # --- Blue guide lines (1 px at every cell boundary) ---
    if with_blue_lines:
        blue = (0, 0, 255)
        for i in range(rows + 1):
            y = i * CELL_SIZE
            draw.line([(0, y), (img_w, y)], fill=blue, width=1)
        for i in range(cols + 1):
            x = i * CELL_SIZE
            draw.line([(x, 0), (x, img_h)], fill=blue, width=1)

    return img, grid


# ---------------------------------------------------------------------------
# Batch generation
# ---------------------------------------------------------------------------

def _has_blue_lines(size_index: int, seed: int) -> bool:
    """Decide whether a given (size, seed) pair gets blue guide lines.

    We need **exactly 10 of the 20 templates** with lines.
    Strategy:
        - Even size_index (0, 2): seeds 0, 2, 4 → with lines (3 per size)
        - Odd  size_index (1, 3): seeds 1, 3     → with lines (2 per size)
    Total: 3 + 2 + 3 + 2 = 10 with lines ✓
    """
    if size_index % 2 == 0:
        return seed in (0, 2, 4)
    else:
        return seed in (1, 3)


def save_template(
    rows: int,
    cols: int,
    seed: int,
    output_dir: Path,
) -> str:
    """Generate one template, write its PNG and JSON, return the basename."""
    size_index = STANDARD_SIZES.index((rows, cols))
    with_blue = _has_blue_lines(size_index, seed)

    img, grid = make_template(rows, cols, n_codes_seed=seed, with_blue_lines=with_blue)

    size_label = f"{rows}x{cols}"
    stem = output_dir / f"template_{size_label}_s{seed}"

    # --- PNG ---
    img.save(stem.with_suffix(".png"))

    # --- JSON:  code -> list of [row, col] positions ---
    json_data: dict[str, list[list[int]]] = {}
    for (r, c), code in sorted(grid.items()):
        json_data.setdefault(code, []).append([r, c])

    with open(stem.with_suffix(".json"), "w") as f:
        json.dump(json_data, f, indent=2)

    return stem.name


def generate_all(output_dir: Path | None = None) -> None:
    """Generate all 20 template pairs (4 sizes × 5 seeds)."""
    if output_dir is None:
        output_dir = OUTPUT_DIR
    output_dir.mkdir(parents=True, exist_ok=True)

    for rows, cols in STANDARD_SIZES:
        for seed in SEEDS:
            name = save_template(rows, cols, seed, output_dir)
            print(f"  ✓  {name}.png  +  {name}.json")

    print(f"\nDone — 20 template pairs written to {output_dir}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Synthetic Perler bead template generator"
    )
    parser.add_argument(
        "--generate",
        action="store_true",
        help="Generate all 20 template pairs (PNG + JSON)",
    )
    args = parser.parse_args()

    if args.generate:
        generate_all()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
