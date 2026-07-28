"""Per-cell adaptive preprocessing for OCR engines.

Produces multiple binarization variants so the OCR engine can pick the
highest-confidence result. Handles two regimes:

  - Bright background (mean luminance > 180): black text on light ground
    → direct OTSU + Adaptive Gaussian.
  - Dark background: white text on colored ground
    → CLAHE + OTSU with inversion.

Each variant is `(name, grayscale_image)`. The OCR engine runs on every
variant and keeps the highest-confidence detection.
"""
from __future__ import annotations

import cv2
import numpy as np

# Background luminance threshold for picking the text-color branch.
BRIGHT_BG_THRESHOLD = 180


def _upscale_factor(cell_side: int) -> int:
    """Pick upscale multiplier based on cell pixel size.

    Smaller cells need more upscaling so the OCR engine can resolve
    2-character glyphs at 8pt. Tuned empirically.
    """
    if cell_side < 16:
        return 6
    if cell_side < 24:
        return 5
    if cell_side < 32:
        return 4
    return 3


def _gray_otsu(gray: np.ndarray) -> np.ndarray:
    _, b = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return b


def _gray_adaptive(gray: np.ndarray) -> np.ndarray:
    return cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2,
    )


def _clahe_otsu_inverted(bgr: np.ndarray) -> np.ndarray:
    """CLAHE + OTSU + bitwise NOT — for white text on dark/colored bg."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(2, 2))
    enhanced = clahe.apply(gray)
    _, b = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.bitwise_not(b)


def _clahe_adaptive_inverted(bgr: np.ndarray) -> np.ndarray:
    """CLAHE + Adaptive Gaussian + bitwise NOT — for low-contrast white text."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(2, 2))
    enhanced = clahe.apply(gray)
    b = cv2.adaptiveThreshold(
        enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 11, 2,
    )
    return b


def preprocess_cell(cell_bgr: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """Return multiple OCR-ready variants for one cell crop.

    Each variant is `(name, grayscale_image)`. The caller runs the OCR
    engine on every variant and keeps the highest-confidence detection.
    """
    if cell_bgr.size == 0:
        return []

    h, w = cell_bgr.shape[:2]
    side = max(1, min(h, w))
    factor = _upscale_factor(side)

    big = cv2.resize(
        cell_bgr, None, fx=factor, fy=factor,
        interpolation=cv2.INTER_LANCZOS4,
    )

    # Background brightness determines the text-color branch.
    mean_lum = float(cv2.cvtColor(big, cv2.COLOR_BGR2GRAY).mean())

    gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)

    if mean_lum > BRIGHT_BG_THRESHOLD:
        # Bright background — black text. Direct binarization works.
        return [
            ("otsu", _gray_otsu(gray)),
            ("adaptive", _gray_adaptive(gray)),
        ]
    else:
        # Dark background — white text. Invert after binarization.
        return [
            ("clahe_otsu_inv", _clahe_otsu_inverted(big)),
            ("clahe_adaptive_inv", _clahe_adaptive_inverted(big)),
            ("otsu_inv", cv2.bitwise_not(_gray_otsu(gray))),
        ]
