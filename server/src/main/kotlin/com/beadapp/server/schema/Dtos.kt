package com.beadapp.server.schema

import com.beadapp.server.model.*
import com.fasterxml.jackson.annotation.JsonProperty
import jakarta.validation.constraints.Size
import java.time.OffsetDateTime
import java.util.UUID

/** 007 决议：分页响应信封 */
data class PageResponse<T>(
    val items: List<T>,
    val page: Int,
    val pageSize: Int,
    val total: Long,
    val totalPages: Int,
)

/** 007 决议：错误契约 */
data class ApiError(
    val code: String,
    val message: String,
    val details: Map<String, Any?>? = null,
    val traceId: String? = null,
)

/** 007 决议：颜色 DTO */
data class ColorDto(
    val code: String,
    val name: String,
    val hex: String,
    val brand: String? = null,
)

/** 007 决议：JobDetail */
data class JobDetail(
    val id: UUID,
    val name: String? = null,
    val status: JobStatus,
    val stage: JobStage,
    val processedCells: Int,
    val totalCells: Int,
    val heartbeatAt: OffsetDateTime?,
    val attempt: Int,
    val maxRetries: Int,
    val retryCount: Int,
    val blueprintId: UUID?,
    val error: JobError?,
    val warnings: List<JobWarning> = emptyList(),
    val snapshot: SnapshotInfo,
    val createdAt: OffsetDateTime,
    val updatedAt: OffsetDateTime,
)

data class JobError(
    val code: String,
    val message: String,
)

data class JobWarning(
    val code: String,
    val row: Int,
    val col: Int,
    val detail: String? = null,
)

data class SnapshotInfo(
    val model: String,
    val colorLibraryVersion: String,
)

/** 007 决议：任务列表摘要（无 error/warnings/snapshot 细节） */
data class JobSummary(
    val id: UUID,
    val name: String? = null,
    val status: JobStatus,
    val stage: JobStage,
    val processedCells: Int,
    val totalCells: Int,
    val rows: Int,
    val cols: Int,
    val attempt: Int,
    val retryCount: Int,
    val blueprintId: UUID?,
    val createdAt: OffsetDateTime,
    val updatedAt: OffsetDateTime,
)

/** 019：任务改名请求 */
data class RenameJobRequest(
    @field:Size(min = 1, max = 128)
    val name: String,
)

/** 007 决议：事件流条目 */
data class JobEventDto(
    val attempt: Int,
    val sequence: Long,
    val type: EventType,
    val timestamp: OffsetDateTime,
    val payload: Map<String, Any?>,
)

/** 007 决议：Blueprint 摘要 */
data class BlueprintSummary(
    val id: UUID,
    val jobId: UUID,
    val rows: Int,
    val cols: Int,
    val createdAt: OffsetDateTime,
)

/** 007 决议：Blueprint 详情（cells 内嵌） */
data class BlueprintDetail(
    val id: UUID,
    val jobId: UUID,
    val rows: Int,
    val cols: Int,
    val validCodes: List<String>?,
    val cells: List<BlueprintCellDto>,
    /** 用户裁剪区域（校正页据此从原图裁取每格照片） */
    val cropBox: CropBox? = null,
    val createdAt: OffsetDateTime,
)

data class BlueprintCellDto(
    val row: Int,
    val col: Int,
    val code: String,
    val status: CellStatus,
    val color: ColorDto? = null,
    /** 识别置信度 exp(score/T)，0-1；旧任务为 null */
    val confidence: Double? = null,
    /** 用户修正后的编码（null = 未修正） */
    val correctedCode: String? = null,
    val correctedAt: OffsetDateTime? = null,
)

/** 低置信度校正：批量设置/恢复修正编码（多格原子提交） */
data class CellCorrectionRequest(
    val updates: List<CellCorrectionUpdate>,
)

data class CellCorrectionUpdate(
    val row: Int,
    val col: Int,
    /** null = 恢复原识别码；BLANK = 标记空白格 */
    val code: String? = null,
)

data class CellCorrectionResponse(
    val cells: List<BlueprintCellDto>,
    val correctedCount: Int,
    val revertedCount: Int,
)

/** 008 决议：内部回调入站事件 */
data class InboundEvent(
    val jobId: UUID,
    val attempt: Int,
    val sequence: Long,
    val type: EventType,
    val timestamp: OffsetDateTime? = null,
    val payload: Map<String, Any?> = emptyMap(),
)
