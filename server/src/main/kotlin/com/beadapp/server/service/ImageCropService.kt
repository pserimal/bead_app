package com.beadapp.server.service

import com.beadapp.server.model.CropBox
import org.springframework.stereotype.Service
import java.awt.image.BufferedImage

/** 格子裁剪矩形（与 ocr_core.inference 相同的数学：cropBox + 10% 内缩跳过网格线） */
data class CropRect(val x: Int, val y: Int, val width: Int, val height: Int)

/**
 * 校正数据导出的图像处理：格子裁剪 / 主色提取 / HSV 色相。
 * 裁剪数学契约 = ocr_core.inference（10% 内缩）：三处实现（Python 推理、
 * 前端 CellThumb 预览、此处导出）必须一致，改动需同时更新两端测试。
 */
@Service
class ImageCropService {

    fun cropRect(box: CropBox, rows: Int, cols: Int, row: Int, col: Int): CropRect {
        val cellW = box.width.toDouble() / cols
        val cellH = box.height.toDouble() / rows
        val ix = maxOf(1, (cellW * 0.10).toInt())
        val iy = maxOf(1, (cellH * 0.10).toInt())
        val x0 = (box.x + col * cellW).toInt() + ix
        val y0 = (box.y + row * cellH).toInt() + iy
        val x1 = (box.x + (col + 1) * cellW).toInt() - ix
        val y1 = (box.y + (row + 1) * cellH).toInt() - iy
        return CropRect(x0, y0, maxOf(1, x1 - x0), maxOf(1, y1 - y0))
    }

    /** 按 cropRect 从原图裁剪（坐标裁剪到图片边界内） */
    fun cropCell(src: BufferedImage, box: CropBox, rows: Int, cols: Int, row: Int, col: Int): BufferedImage {
        val r = cropRect(box, rows, cols, row, col)
        val cx0 = r.x.coerceIn(0, src.width)
        val cy0 = r.y.coerceIn(0, src.height)
        val cx1 = (r.x + r.width).coerceIn(cx0, src.width)
        val cy1 = (r.y + r.height).coerceIn(cy0, src.height)
        return src.getSubimage(cx0, cy0, maxOf(1, cx1 - cx0), maxOf(1, cy1 - cy0))
    }

    /** 主色：缩到 32×32 后按 32 级量化取众数桶均值（同 board_generator 思路） */
    fun dominantColor(img: BufferedImage): Triple<Int, Int, Int> {
        val small = BufferedImage(32, 32, BufferedImage.TYPE_INT_RGB)
        val g = small.createGraphics()
        g.drawImage(img, 0, 0, 32, 32, null)
        g.dispose()
        val buckets = HashMap<Int, LongArray>()
        for (y in 0 until 32) for (x in 0 until 32) {
            val rgb = small.getRGB(x, y)
            val r = (rgb shr 16) and 0xFF
            val gg = (rgb shr 8) and 0xFF
            val b = rgb and 0xFF
            val key = ((r shr 3) shl 10) or ((gg shr 3) shl 5) or (b shr 3)
            val acc = buckets.getOrPut(key) { LongArray(4) }
            acc[0]++; acc[1] += r; acc[2] += gg; acc[3] += b
        }
        val best = buckets.maxByOrNull { it.value[0] }!!.value
        return Triple((best[1] / best[0]).toInt(), (best[2] / best[0]).toInt(), (best[3] / best[0]).toInt())
    }

    /** 标准 HSV 色相（与标注工具 label.html 的 _hue 一致，负值归一） */
    fun hueOf(r: Int, g: Int, b: Int): Int {
        val rf = r / 255f; val gf = g / 255f; val bf = b / 255f
        val mx = maxOf(rf, gf, bf); val mn = minOf(rf, gf, bf)
        if (mx == mn) return 0
        val d = mx - mn
        var h = when (mx) {
            rf -> (gf - bf) / d % 6
            gf -> (bf - rf) / d + 2
            else -> (rf - gf) / d + 4
        }
        h *= 60
        if (h < 0) h += 360
        return Math.round(h)
    }
}
