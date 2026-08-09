package com.beadapp.server.api

import com.beadapp.server.config.ApiException
import com.beadapp.server.model.*
import com.beadapp.server.repository.BlueprintCellRepository
import com.beadapp.server.repository.BlueprintRepository
import com.beadapp.server.repository.ColorLibraryRepository
import com.beadapp.server.repository.RecognitionJobRepository
import com.beadapp.server.schema.*
import com.beadapp.server.service.StorageService
import com.beadapp.server.service.toDto
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.core.io.ByteArrayResource
import org.springframework.core.io.PathResource
import org.springframework.core.io.Resource
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.*
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import javax.imageio.ImageIO

@RestController
@RequestMapping("/api/v1/blueprints")
class BlueprintController(
    private val blueprintRepo: BlueprintRepository,
    private val blueprintCellRepo: BlueprintCellRepository,
    private val jobRepo: RecognitionJobRepository,
    private val colorRepo: ColorLibraryRepository,
    private val storageService: StorageService,
) {

    /** 007：图纸列表（摘要，分页） */
    @GetMapping
    fun list(
        @RequestParam(value = "page", defaultValue = "1") @Min(1) page: Int,
        @RequestParam(value = "pageSize", defaultValue = "20") @Min(1) @Max(100) pageSize: Int,
    ): PageResponse<BlueprintSummary> {
        val p = blueprintRepo.findAll(PageRequest.of(page - 1, pageSize, Sort.by(Sort.Direction.DESC, "createdAt")))
        return PageResponse(
            items = p.content.map { BlueprintSummary(it.id, it.jobId, it.rows, it.cols, it.createdAt) },
            page = page,
            pageSize = pageSize,
            total = p.totalElements,
            totalPages = p.totalPages,
        )
    }

    /** 007：图纸详情（cells 内嵌；cropBox 供校正页裁取原图） */
    @GetMapping("/{id}")
    fun detail(@PathVariable("id") id: UUID): BlueprintDetail {
        val bp = blueprintRepo.findById(id).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "BLUEPRINT_NOT_FOUND", "图纸不存在: $id")
        }
        val job = jobRepo.findById(bp.jobId).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "JOB_NOT_FOUND", "任务不存在: ${bp.jobId}")
        }
        val cells = blueprintCellRepo.findAllByBlueprintIdOrderByRowAscColAsc(id).map { it.toDto() }
        return BlueprintDetail(bp.id, bp.jobId, bp.rows, bp.cols, bp.validCodes, cells, job.cropBox, bp.createdAt)
    }

    /** 低置信度校正：批量设置/恢复修正编码，多格原子提交。code=null 恢复原识别码 */
    @PatchMapping("/{id}/cells")
    @Transactional
    fun updateCells(
        @PathVariable("id") id: UUID,
        @RequestBody req: CellCorrectionRequest,
    ): CellCorrectionResponse {
        val bp = blueprintRepo.findById(id).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "BLUEPRINT_NOT_FOUND", "图纸不存在: $id")
        }
        if (req.updates.isEmpty()) {
            throw ApiException(HttpStatus.BAD_REQUEST, "EMPTY_UPDATES", "updates 不能为空")
        }
        val valid = (bp.validCodes ?: emptyList()).toSet()
        // 任务未指定 validCodes（老任务/未传 codes 参数）：回退到全颜色库，保证仍可修正
        val validCodes = if (valid.isEmpty()) colorRepo.findAll().map { it.code }.toSet() else valid
        var correctedCount = 0
        var revertedCount = 0
        val updated = req.updates.map { u ->
            if (u.row < 0 || u.row >= bp.rows || u.col < 0 || u.col >= bp.cols) {
                throw ApiException(HttpStatus.BAD_REQUEST, "CELL_OUT_OF_BOUNDS", "格子越界: (${u.row}, ${u.col})")
            }
            val cell = blueprintCellRepo.findById(BlueprintCellId(id, u.row, u.col)).orElseThrow {
                ApiException(HttpStatus.BAD_REQUEST, "CELL_NOT_FOUND", "格子不存在: (${u.row}, ${u.col})")
            }
            val newCode = u.code?.trim()?.uppercase()?.takeIf { it.isNotEmpty() }
            if (newCode != null) {
                if (newCode.length > 8) {
                    throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_CODE", "编码过长: $newCode")
                }
                if (newCode != "BLANK" && newCode !in validCodes) {
                    throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_CODE", "编码不在颜色库: $newCode")
                }
            }
            val effective = newCode ?: cell.code
            val isBlank = effective == "BLANK"
            val color = if (isBlank) null else colorRepo.findByCodeIgnoreCase(effective)
            cell.status = when {
                isBlank -> CellStatus.BLANK
                color != null -> CellStatus.MAPPED
                else -> CellStatus.UNMAPPED
            }
            cell.colorCode = color?.code
            cell.colorName = color?.name
            cell.colorHex = color?.hex
            if (newCode != null) {
                cell.correctedCode = newCode
                cell.correctedAt = OffsetDateTime.now()
                correctedCount += 1
            } else {
                if (cell.correctedCode != null) revertedCount += 1
                cell.correctedCode = null
                cell.correctedAt = null
            }
            blueprintCellRepo.save(cell)
            cell.toDto()
        }
        return CellCorrectionResponse(updated, correctedCount, revertedCount)
    }

    /** 007：原图（Spring 存储的原始上传） */
    @GetMapping("/{id}/image")
    fun image(@PathVariable("id") id: UUID): ResponseEntity<Resource> {
        val bp = blueprintRepo.findById(id).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "BLUEPRINT_NOT_FOUND", "图纸不存在: $id")
        }
        val job = jobRepo.findById(bp.jobId).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "JOB_NOT_FOUND", "任务不存在: ${bp.jobId}")
        }
        val path = storageService.loadImage(job.inputImagePath)
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_TYPE, MediaType.IMAGE_JPEG_VALUE)
            .body(PathResource(path))
    }

    /** 导出全部已校正格子：zip（manifest.csv + 每格 PNG），格式对齐标注工具 label.html */
    @GetMapping("/{id}/cells/export-corrections")
    fun exportCorrections(@PathVariable("id") id: UUID): ResponseEntity<ByteArrayResource> {
        val bp = blueprintRepo.findById(id).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "BLUEPRINT_NOT_FOUND", "图纸不存在: $id")
        }
        val job = jobRepo.findById(bp.jobId).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "JOB_NOT_FOUND", "任务不存在: ${bp.jobId}")
        }
        val corrected = blueprintCellRepo.findAllByBlueprintIdOrderByRowAscColAsc(id)
            .filter { it.correctedCode != null }
        if (corrected.isEmpty()) {
            throw ApiException(HttpStatus.BAD_REQUEST, "NO_CORRECTIONS", "没有已校正的格子")
        }
        val source = ImageIO.read(storageService.loadImage(job.inputImagePath).toFile())
            ?: throw ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "IMAGE_DECODE_FAILED", "原图解码失败")
        val box = job.cropBox

        val manifest = StringBuilder("\uFEFF编码,文件名,行,列,色相,亮度\n")
        val zipBytes = ByteArrayOutputStream()
        ZipOutputStream(zipBytes).use { zip ->
            for (cell in corrected) {
                val code = cell.correctedCode!!
                val crop = cropCell(source, box, bp.rows, bp.cols, cell.row, cell.col)
                val (r, g, b) = dominantColor(crop)
                val hue = hueOf(r, g, b)
                val bri = (r + g + b) / 3
                val fname = "${code}_r${cell.row + 1}_c${cell.col + 1}_h${hue}_v${bri}.png"
                val png = ByteArrayOutputStream()
                ImageIO.write(crop, "png", png)
                zip.putNextEntry(ZipEntry(fname))
                zip.write(png.toByteArray())
                zip.closeEntry()
                manifest.append("$code,$fname,${cell.row + 1},${cell.col + 1},$hue,$bri\n")
            }
            zip.putNextEntry(ZipEntry("manifest.csv"))
            zip.write(manifest.toString().toByteArray(Charsets.UTF_8))
            zip.closeEntry()
        }

        val stamp = DateTimeFormatter.ofPattern("yyyy-MM-dd").format(OffsetDateTime.now())
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_TYPE, "application/zip")
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=corrections-${id.toString().take(8)}-$stamp.zip")
            .body(ByteArrayResource(zipBytes.toByteArray()))
    }

    /** 与 ocr_core.inference 相同的格子裁剪（cropBox + 10% 内缩跳过网格线） */
    private fun cropCell(src: BufferedImage, box: CropBox, rows: Int, cols: Int, row: Int, col: Int): BufferedImage {
        val cellW = box.width.toDouble() / cols
        val cellH = box.height.toDouble() / rows
        val ix = maxOf(1, (cellW * 0.10).toInt())
        val iy = maxOf(1, (cellH * 0.10).toInt())
        val x0 = (box.x + col * cellW).toInt() + ix
        val y0 = (box.y + row * cellH).toInt() + iy
        val x1 = (box.x + (col + 1) * cellW).toInt() - ix
        val y1 = (box.y + (row + 1) * cellH).toInt() - iy
        val cx0 = x0.coerceIn(0, src.width)
        val cy0 = y0.coerceIn(0, src.height)
        val cx1 = x1.coerceIn(cx0, src.width)
        val cy1 = y1.coerceIn(cy0, src.height)
        return src.getSubimage(cx0, cy0, maxOf(1, cx1 - cx0), maxOf(1, cy1 - cy0))
    }

    /** 主色：缩到 32×32 后按 32 级量化取众数桶均值（同 board_generator 思路） */
    private fun dominantColor(img: BufferedImage): Triple<Int, Int, Int> {
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
    private fun hueOf(r: Int, g: Int, b: Int): Int {
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
