# 格子裁剪数学契约（Cell Crop Math）

拼豆图纸的"单元格裁剪"在三处独立实现，数学必须保持一致。
改动任何一处，必须同步更新其余两处 + 对应测试，否则缩略图/导出/推理结果漂移。

## 公式

```
输入：cropBox (x, y, width, height)、rows、cols、目标 (row, col)
cellW = cropBox.width / cols
cellH = cropBox.height / rows
ix = max(1, round(cellW * 0.10))     # 10% 内缩，跳过网格线
iy = max(1, round(cellH * 0.10))
x0 = cropBox.x + col * cellW + ix
y0 = cropBox.y + row * cellH + iy
x1 = cropBox.x + (col+1) * cellW - ix
y1 = cropBox.y + (row+1) * cellH - iy
crop = (x0, y0, max(1, x1-x0), max(1, y1-y0))   # 再裁剪到图片边界内
```

## 三处实现

| 位置 | 文件 | 用途 |
|------|------|------|
| Python 推理 | `ocr_core/inference.py` | 识别时逐格裁剪 |
| Kotlin 导出 | `server/.../service/ImageCropService.kt` → `cropRect()` | 校正数据导出 zip |
| 前端预览 | `frontend/src/lib/correctionModel.ts` → `cellCropRect()` | 校正页缩略图 |

## 测试护栏

- Kotlin：`server/src/test/.../ImageCropServiceTest.kt`（6 例：10% 内缩边界、非整数取整、最小 1px、纯色主色、HSV 色相）
- 前端：`frontend/src/lib/correctionModel.test.ts`（cellCropRect 同数学）
- Python：无独立单测（推理路径由 eval 基准间接覆盖）
