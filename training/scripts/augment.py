"""
Data augmentation script for Perler bead pattern images.
Produces augmented variants to increase training data diversity for YOLO fine-tuning.

Usage:
    python scripts/augment.py <input_dir> <output_dir>

Classes:
    0 = bead_board (拼豆图)
    1 = color_card (色卡)
"""
import cv2
import numpy as np
import os
import glob
from pathlib import Path


def augment_image(image_path: str, output_dir: str, prefix: str = ""):
    """Apply augmentations to a single image and save variants."""
    img = cv2.imread(image_path)
    if img is None:
        return []
    h, w = img.shape[:2]
    base = Path(image_path).stem
    saved = []

    out_path = os.path.join(output_dir, f"{prefix}{base}_orig.jpg")
    cv2.imwrite(out_path, img)
    saved.append(out_path)

    for angle in [-10, 10]:
        M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        rotated = cv2.warpAffine(img, M, (w, h), borderMode=cv2.BORDER_REPLICATE)
        out_path = os.path.join(output_dir, f"{prefix}{base}_rot{angle}.jpg")
        cv2.imwrite(out_path, rotated)
        saved.append(out_path)

    for alpha in [0.8, 1.2]:
        adjusted = cv2.convertScaleAbs(img, alpha=alpha, beta=0)
        out_path = os.path.join(output_dir, f"{prefix}{base}_bright{int(alpha * 100)}.jpg")
        cv2.imwrite(out_path, adjusted)
        saved.append(out_path)

    flipped = cv2.flip(img, 1)
    out_path = os.path.join(output_dir, f"{prefix}{base}_flip.jpg")
    cv2.imwrite(out_path, flipped)
    saved.append(out_path)

    blurred = cv2.GaussianBlur(img, (3, 3), 0.5)
    out_path = os.path.join(output_dir, f"{prefix}{base}_blur.jpg")
    cv2.imwrite(out_path, blurred)
    saved.append(out_path)

    return saved


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("Usage: python scripts/augment.py <input_dir> <output_dir>")
        sys.exit(1)

    input_dir = sys.argv[1]
    output_dir = sys.argv[2]
    os.makedirs(output_dir, exist_ok=True)
    images = glob.glob(os.path.join(input_dir, "*.jpg")) + glob.glob(
        os.path.join(input_dir, "*.png")
    )
    if not images:
        print(f"No images found in {input_dir}")
        sys.exit(1)

    for img_path in images:
        augment_image(img_path, output_dir)

    print(f"Augmented {len(images)} images -> {output_dir}")
