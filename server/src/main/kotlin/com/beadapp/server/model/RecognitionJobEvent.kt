package com.beadapp.server.model

import jakarta.persistence.*
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.type.SqlTypes
import java.time.OffsetDateTime
import java.util.UUID

@Entity
@Table(name = "recognition_job_event")
class RecognitionJobEvent(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "id")
    var id: Long = 0,

    @Column(name = "job_id", nullable = false, columnDefinition = "uuid")
    var jobId: UUID,

    @Column(name = "attempt", nullable = false)
    var attempt: Int,

    @Column(name = "sequence", nullable = false)
    var sequence: Long,

    @Enumerated(EnumType.STRING)
    @Column(name = "type", nullable = false)
    var type: EventType,

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "payload", nullable = false, columnDefinition = "jsonb")
    var payload: Map<String, Any?> = emptyMap(),

    @Column(name = "created_at", nullable = false)
    var createdAt: OffsetDateTime = OffsetDateTime.now(),
)
