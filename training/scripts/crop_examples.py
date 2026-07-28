"""裁减 training/data/real/raw/ 下的真实拼豆图纸，输出到 training/crops/cut/.

每张图只保留「网格主体」（不含顶部标题、列号行号标尺、底部图例）。
输出的每张图都是「纯网格」，方便 ocr_cells_from_crop 按用户给的 m×n 切分。
"""
from __future__ import annotations

import json
from pathlib import Path

import cv2

# Project root: training/scripts/crop_examples.py → ../../.. → repo root
ROOT = Path(__file__).resolve().parent.parent.parent
EXAMPLES = ROOT / "training" / "data" / "real" / "raw"
OUT_DIR = ROOT / "training" / "crops" / "cut"
OUT_DIR.mkdir(parents=True, exist_ok=True)


# (源文件名, 输出文件名, 网格区域 (x1, y1, x2, y2), 行数, 列数)
# 这些坐标来自人工目测精修过，必须保证裁出来的图只包含「纯网格」：
#   - 不含顶部标题（豆画 xxx）
#   - 不含顶部列号标尺（1-N 蓝色数字）
#   - 不含左侧行号标尺（1-N 蓝色数字）
#   - 不含底部图例
#   - 不含水印文字
# bbox 紧贴网格最外侧格子的红色粗线外侧。
CROPS: list[tuple[str, str, tuple[int, int, int, int], int, int]] = [
    # 猫猫图：89列 × 97行
    # 原图 1280×1852，标题在 y=0-30，列号在 y=33-48，网格 y=55-1230，图例 y=1255+
    (
        "超可爱的猫猫拼豆大图！爽拼一天！_科大讯飞AI学习机六合龙湖天街店_来自小红书网页版.jpg",
        "cat_89x97.png",
        (40, 55, 1265, 1230),
        97,
        89,
    ),
    # 海星图：56列 × 72行
    # 原图 1080×1813，标题在 y=0-28，列号 y=28-50，行号 x=18-40，网格 40-1070 × 50-1374
    (
        "拼豆日记54📔骑派大星（附图纸）_3_08e-_来自小红书网页版.jpg",
        "starfish_56x72.png",
        (40, 50, 1070, 1374),
        72,
        56,
    ),
    # 大芬图：40行 × 37列
    # 原图 1080×1530，列号 y=0-38，行号 x=0-38，网格 38-1080 × 38-1180，图例 y=1190+
    (
        "拼豆图纸｜最美大芬你pick哪个？！_5_幸运大王（接🥚中_来自小红书网页版.jpg",
        "dafen_40x37.png",
        (38, 38, 1080, 1180),
        40,
        37,
    ),
]


def crop_one(src_name: str, dst_name: str, bbox: tuple[int, int, int, int], rows: int, cols: int) -> dict:
    src_path = EXAMPLES / src_name
    img = cv2.imread(str(src_path))
    if img is None:
        raise FileNotFoundError(f"cannot read: {src_path}")
    h, w = img.shape[:2]
    x1, y1, x2, y2 = bbox
    # 钳到图像边界
    x1 = max(0, min(w, x1))
    x2 = max(0, min(w, x2))
    y1 = max(0, min(h, y1))
    y2 = max(0, min(h, y2))
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        raise ValueError(f"empty crop for {src_name}: bbox={bbox}")
    dst_path = OUT_DIR / dst_name
    cv2.imwrite(str(dst_path), crop)
    crop_h, crop_w = crop.shape[:2]
    print(f"✓ {dst_name}")
    print(f"    源: {src_name}")
    print(f"    源尺寸: {w}x{h}")
    print(f"    bbox: (x1={x1}, y1={y1}, x2={x2}, y2={y2})")
    print(f"    裁后尺寸: {crop_w}x{crop_h}")
    print(f"    行列: {rows}x{cols}  → 每格约 {crop_w/cols:.1f}×{crop_h/rows:.1f} px")
    return {
        "file": dst_name,
        "source": src_name,
        "bbox": [x1, y1, x2, y2],
        "rows": rows,
        "cols": cols,
        "crop_size": [crop_w, crop_h],
    }


def main() -> None:
    manifest: list[dict] = []
    for src, dst, bbox, rows, cols in CROPS:
        manifest.append(crop_one(src, dst, bbox, rows, cols))

    # 写 manifest
    manifest_path = OUT_DIR / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "description": "examples/ 下真实图纸裁减后的「纯网格」主体。每张图按用户给的 m×n 均分后给 ocr_cells_from_crop。",
                "crops": manifest,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
    print(f"\n✓ manifest.json 写入 {manifest_path}")
    print(f"\n所有裁减文件在: {OUT_DIR}")


if __name__ == "__main__":
    main()
