package com.beadapp.server.model

import jakarta.persistence.*
import org.hibernate.annotations.JdbcTypeCode
import org.hibernate.type.SqlTypes
import java.time.OffsetDateTime
import java.util.UUID

@Entity
@Table(name = "blueprint")
class Blueprint(
    @Id
    @Column(name = "id", columnDefinition = "uuid")
    var id: UUID = UUID.randomUUID(),

    @Column(name = "job_id", nullable = false, unique = true, columnDefinition = "uuid")
    var jobId: UUID,

    @Column(name = "rows", nullable = false)
    var rows: Int,

    @Column(name = "cols", nullable = false)
    var cols: Int,

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "valid_codes", columnDefinition = "jsonb")
    var validCodes: List<String>? = null,

    @Column(name = "created_at", nullable = false)
    var createdAt: OffsetDateTime = OffsetDateTime.now(),
)

@Entity
@IdClass(BlueprintCellId::class)
@Table(name = "blueprint_cell")
class BlueprintCell(
    @Id
    @Column(name = "blueprint_id", columnDefinition = "uuid")
    var blueprintId: UUID,

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
)
