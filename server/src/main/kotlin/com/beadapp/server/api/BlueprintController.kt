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
import java.time.OffsetDateTime
import java.util.UUID

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
                if (newCode != "BLANK" && newCode !in valid) {
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
}
