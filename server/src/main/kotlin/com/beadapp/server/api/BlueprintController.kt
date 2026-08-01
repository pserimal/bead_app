package com.beadapp.server.api

import com.beadapp.server.config.ApiException
import com.beadapp.server.repository.BlueprintCellRepository
import com.beadapp.server.repository.BlueprintRepository
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
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1/blueprints")
class BlueprintController(
    private val blueprintRepo: BlueprintRepository,
    private val blueprintCellRepo: BlueprintCellRepository,
    private val jobRepo: RecognitionJobRepository,
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

    /** 007：图纸详情（cells 内嵌） */
    @GetMapping("/{id}")
    fun detail(@PathVariable("id") id: UUID): BlueprintDetail {
        val bp = blueprintRepo.findById(id).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "BLUEPRINT_NOT_FOUND", "图纸不存在: $id")
        }
        val cells = blueprintCellRepo.findAllByBlueprintIdOrderByRowAscColAsc(id).map { it.toDto() }
        return BlueprintDetail(bp.id, bp.jobId, bp.rows, bp.cols, bp.validCodes, cells, bp.createdAt)
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
