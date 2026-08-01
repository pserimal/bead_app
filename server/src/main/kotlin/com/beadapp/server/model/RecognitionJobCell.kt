package com.beadapp.server.model

import jakarta.persistence.*
import java.time.OffsetDateTime
import java.util.UUID

@Entity
@IdClass(RecognitionJobCellId::class)
@Table(name = "recognition_job_cell")
class RecognitionJobCell(
    @Id
    @Column(name = "job_id", columnDefinition = "uuid")
    var jobId: UUID,

    @Id
    @Column(name = "row")
    var row: Int,

    @Id
    @Column(name = "col")
    var col: Int,

    @Column(name = "code", nullable = false)
    var code: String,

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false)
    var status: CellStatus,

    @Column(name = "color_code")
    var colorCode: String? = null,

    @Column(name = "color_name")
    var colorName: String? = null,

    @Column(name = "color_hex")
    var colorHex: String? = null,

    @Column(name = "updated_at", nullable = false)
    var updatedAt: OffsetDateTime = OffsetDateTime.now(),
)
