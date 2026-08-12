package com.beadapp.server.model

import jakarta.persistence.*
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.type.SqlTypes
import java.time.OffsetDateTime
import java.util.UUID

@Entity
@Table(name = "recognition_job")
class RecognitionJob(
    @Id
    @Column(name = "id", columnDefinition = "uuid")
    var id: UUID = UUID.randomUUID(),

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false)
    var status: JobStatus = JobStatus.PENDING,

    @Enumerated(EnumType.STRING)
    @Column(name = "stage", nullable = false)
    var stage: JobStage = JobStage.QUEUED,

    @Column(name = "rows", nullable = false)
    var rows: Int,

    @Column(name = "cols", nullable = false)
    var cols: Int,

    /** 自定义任务名称（019：上传可选、历史可改）；null = 未命名，前端显示回退 */
    @Column(name = "name")
    var name: String? = null,

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "crop_box", nullable = false, columnDefinition = "jsonb")
    var cropBox: CropBox,

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "valid_codes", columnDefinition = "jsonb")
    var validCodes: List<String>? = null,

    @Column(name = "input_image_path", nullable = false)
    var inputImagePath: String,

    @Column(name = "color_library_version", nullable = false)
    var colorLibraryVersion: String,

    @Column(name = "model_snapshot", nullable = false)
    var modelSnapshot: String,

    @Column(name = "attempt", nullable = false)
    var attempt: Int = 0,

    @Column(name = "retry_count", nullable = false)
    var retryCount: Int = 0,

    @Column(name = "max_retries", nullable = false)
    var maxRetries: Int = 2,

    @Column(name = "processed_cells", nullable = false)
    var processedCells: Int = 0,

    @Column(name = "total_cells", nullable = false)
    var totalCells: Int,

    @Column(name = "heartbeat_at")
    var heartbeatAt: OffsetDateTime? = null,

    @Column(name = "error_code")
    var errorCode: String? = null,

    @Column(name = "error_message")
    var errorMessage: String? = null,

    @Column(name = "blueprint_id", columnDefinition = "uuid")
    var blueprintId: UUID? = null,

    @Column(name = "created_at", nullable = false)
    var createdAt: OffsetDateTime = OffsetDateTime.now(),

    @Column(name = "updated_at", nullable = false)
    var updatedAt: OffsetDateTime = OffsetDateTime.now(),
)

data class CropBox(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int,
)
