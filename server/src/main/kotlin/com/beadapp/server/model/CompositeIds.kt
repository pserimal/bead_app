package com.beadapp.server.model

import java.io.Serializable
import java.util.UUID

/** 复合主键：BlueprintCell (blueprint_id, row, col) */
data class BlueprintCellId(
    val blueprintId: UUID = UUID.randomUUID(),
    val row: Int = 0,
    val col: Int = 0,
) : Serializable

/** 复合主键：RecognitionJobCell (job_id, row, col) */
data class RecognitionJobCellId(
    val jobId: UUID = UUID.randomUUID(),
    val row: Int = 0,
    val col: Int = 0,
) : Serializable
