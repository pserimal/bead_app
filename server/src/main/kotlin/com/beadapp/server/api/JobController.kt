package com.beadapp.server.api

import com.beadapp.server.config.ApiException
import com.beadapp.server.model.JobStage
import com.beadapp.server.model.RecognitionJob
import com.beadapp.server.model.CropBox
import com.beadapp.server.repository.ColorLibraryRepository
import com.beadapp.server.schema.*
import com.beadapp.server.service.JobService
import com.beadapp.server.service.StorageService
import com.beadapp.server.service.toDetail
import com.beadapp.server.service.toSummary
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import org.springframework.web.multipart.MultipartFile
import java.util.UUID

@RestController
@RequestMapping("/api/v1/jobs")
class JobController(
    private val jobService: JobService,
    private val storageService: StorageService,
    private val colorRepo: ColorLibraryRepository,
) {

    /** 实际部署的模型快照名（image_service 加载 artifacts/models/current）。 */
    @Value("\${bead.ocr.model-snapshot:crnn_color_v1}")
    private lateinit var modelSnapshot: String

    /** 018：从颜色库读取当前 seed 版本（不再硬编码，避免与 ColorSeedRunner 脱节）。 */
    private fun currentColorLibraryVersion(): String =
        colorRepo.findAll().firstOrNull()?.version ?: "seed-3"

    /** 007：创建任务。multipart: image + cropBoxX/Y/Width/Height + rows + cols + codes */
    @PostMapping(consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun create(
        @RequestPart("image") image: MultipartFile,
        @RequestParam("cropBoxX") @Min(0) cropBoxX: Int,
        @RequestParam("cropBoxY") @Min(0) cropBoxY: Int,
        @RequestParam("cropBoxWidth") @Min(1) cropBoxWidth: Int,
        @RequestParam("cropBoxHeight") @Min(1) cropBoxHeight: Int,
        @RequestParam("rows") @Min(1) @Max(500) rows: Int,
        @RequestParam("cols") @Min(1) @Max(500) cols: Int,
        @RequestParam(value = "codes", required = false) codes: String?,
        @RequestParam(value = "name", required = false) name: String?,
    ): ResponseEntity<JobDetail> {
        validateImage(image)
        val parsedCodes = parseCodes(codes)
        val path = storageService.saveImage(image)
        val job = jobService.createJob(
            rows = rows,
            cols = cols,
            cropBox = CropBox(cropBoxX, cropBoxY, cropBoxWidth, cropBoxHeight),
            validCodes = parsedCodes,
            inputImagePath = path,
            colorLibraryVersion = currentColorLibraryVersion(),
            modelSnapshot = modelSnapshot,
            name = name,
        )
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(job.toDetail())
    }

    /** 019：任务改名 */
    @PatchMapping("/{id}")
    fun rename(@PathVariable("id") id: UUID, @RequestBody @Valid request: RenameJobRequest): JobDetail {
        return jobService.renameJob(id, request.name).toDetail()
    }

    /** 019：批量真删任务（ids 逗号分隔；级联删除图纸与事件） */
    @DeleteMapping
    fun deleteBatch(@RequestParam("ids") ids: String): ResponseEntity<Map<String, Any>> {
        val parsed = ids.split(',').map { it.trim() }.filter { it.isNotEmpty() }.map { str ->
            try {
                UUID.fromString(str)
            } catch (e: IllegalArgumentException) {
                throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_ID", "无效的任务 ID：$str")
            }
        }
        if (parsed.isEmpty()) {
            throw ApiException(HttpStatus.BAD_REQUEST, "EMPTY_IDS", "未指定要删除的任务")
        }
        jobService.deleteJobs(parsed)
        return ResponseEntity.ok(mapOf("deleted" to parsed.size))
    }

    /** 007：任务历史列表（status 过滤 + 分页） */
    @GetMapping
    fun list(
        @RequestParam(value = "status", required = false) status: String?,
        @RequestParam(value = "page", defaultValue = "1") @Min(1) page: Int,
        @RequestParam(value = "pageSize", defaultValue = "20") @Min(1) @Max(100) pageSize: Int,
        @RequestParam(value = "sortBy", defaultValue = "createdAt") sortBy: String,
        @RequestParam(value = "sortDir", defaultValue = "desc") sortDir: String,
    ): PageResponse<JobSummary> {
        val p = jobService.listJobs(status, page - 1, pageSize, sortBy, sortDir)
        return PageResponse(
            items = p.content.map { it.toSummary() },
            page = page,
            pageSize = pageSize,
            total = p.totalElements,
            totalPages = p.totalPages,
        )
    }

    /** 007：任务详情 */
    @GetMapping("/{id}")
    fun detail(@PathVariable("id") id: UUID): JobDetail =
        jobService.getJob(id).toDetail()

    /** 007：只读事件流（分页，sortDir=desc 时最近事件在前） */
    @GetMapping("/{id}/events")
    fun events(
        @PathVariable("id") id: UUID,
        @RequestParam(value = "page", defaultValue = "1") @Min(1) page: Int,
        @RequestParam(value = "pageSize", defaultValue = "20") @Min(1) @Max(100) pageSize: Int,
        @RequestParam(value = "sortDir", defaultValue = "asc") sortDir: String,
    ): PageResponse<JobEventDto> {
        val p = jobService.listEvents(id, page - 1, pageSize, sortDir)
        return PageResponse(
            items = p.content.map { JobEventDto(it.attempt, it.sequence, it.type, it.createdAt, it.payload) },
            page = page,
            pageSize = pageSize,
            total = p.totalElements,
            totalPages = p.totalPages,
        )
    }

    private fun validateImage(image: MultipartFile) {
        val contentType = image.contentType?.lowercase()
        if (contentType != "image/jpeg" && contentType != "image/png") {
            throw ApiException(HttpStatus.UNSUPPORTED_MEDIA_TYPE, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JPEG/PNG 图片")
        }
        if (image.size > 30L * 1024 * 1024) {
            throw ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "FILE_TOO_LARGE", "文件超过 30MB 上限")
        }
    }

    /** 003 决议：编码格式 ^[A-Za-z][0-9]{1,3}$，统一大写 */
    private fun parseCodes(codes: String?): List<String>? {
        if (codes.isNullOrBlank()) return null
        val regex = Regex("^[A-Za-z][0-9]{1,3}$")
        val parsed = codes.split(",").map { it.trim().uppercase() }
        val invalid = parsed.filter { !regex.matches(it) }
        if (invalid.isNotEmpty()) {
            throw ApiException(
                HttpStatus.BAD_REQUEST, "INVALID_CODE_FORMAT",
                "非法编码格式: ${invalid.joinToString(", ")}",
                mapOf("invalidCodes" to invalid),
            )
        }
        return parsed
    }
}
