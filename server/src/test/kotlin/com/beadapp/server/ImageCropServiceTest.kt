package com.beadapp.server.service

import com.beadapp.server.model.CropBox
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.awt.image.BufferedImage

/**
 * 裁剪数学契约测试：cropRect 必须与 ocr_core.inference 相同
 * （cropBox + 每边 10% 内缩跳过网格线；内缩量 = max(1, round(cell*0.1))）。
 * 改动此处数学 = 必须同步改 ocr_core/inference.py 与前端 CellThumb。
 */
class ImageCropServiceTest {

    private val service = ImageCropService()

    @Test
    fun `cropRect 10% 内缩与边界`() {
        // 100×100 图，10×10 网格 → 每格 10px，内缩 1px → 8×8
        val r = service.cropRect(CropBox(x = 0, y = 0, width = 100, height = 100), rows = 10, cols = 10, row = 2, col = 3)
        assertEquals(CropRect(31, 21, 8, 8), r)
    }

    @Test
    fun `cropRect 非整数单元格取整`() {
        // 50×30 图，7×9 网格 → 每格 7.14×3.33，内缩 max(1, round(0.714))=1
        val r = service.cropRect(CropBox(x = 10, y = 5, width = 50, height = 30), rows = 9, cols = 7, row = 1, col = 2)
        // x0 = 10 + 2*7.14 = 24.28 → 24 + 1 = 25；x1 = 10 + 3*7.14 = 31.4 → 31 - 1 = 30
        // y0 = 5 + 1*3.33 = 8.33 → 8 + 1 = 9；y1 = 5 + 2*3.33 = 11.67 → 11 - 1 = 10
        assertEquals(CropRect(25, 9, 5, 1), r)
    }

    @Test
    fun `cropRect 小格保证至少 1px`() {
        // 10×10 图 100×100 网格 → 每格 0.1px，内缩 1px → 宽 1
        val r = service.cropRect(CropBox(x = 0, y = 0, width = 10, height = 10), rows = 100, cols = 100, row = 0, col = 0)
        assertEquals(1, r.width)
        assertEquals(1, r.height)
    }

    @Test
    fun `cropCell 从原图裁剪且坐标不越界`() {
        val img = BufferedImage(50, 50, BufferedImage.TYPE_INT_RGB)
        val crop = service.cropCell(img, CropBox(x = 0, y = 0, width = 50, height = 50), rows = 5, cols = 5, row = 4, col = 4)
        assertEquals(8, crop.width)
        assertEquals(8, crop.height)
    }

    @Test
    fun `dominantColor 纯色图取到原色`() {
        val img = BufferedImage(8, 8, BufferedImage.TYPE_INT_RGB)
        val g = img.createGraphics()
        g.color = java.awt.Color(200, 30, 40)
        g.fillRect(0, 0, 8, 8)
        g.dispose()
        val (r, gg, b) = service.dominantColor(img)
        assertEquals(200, r)
        assertEquals(30, gg)
        assertEquals(40, b)
    }

    @Test
    fun `hueOf 与标注工具 label html 一致`() {
        // 红 = 0，绿 = 120，蓝 = 240
        assertEquals(0, service.hueOf(255, 0, 0))
        assertEquals(120, service.hueOf(0, 255, 0))
        assertEquals(240, service.hueOf(0, 0, 255))
        // 灰 = 0
        assertEquals(0, service.hueOf(128, 128, 128))
    }
}
