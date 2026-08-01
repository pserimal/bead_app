package com.beadapp.server.service

import com.beadapp.server.model.*
import com.beadapp.server.schema.*

/** 007 契约 DTO 映射 */
fun RecognitionJob.toDetail(): JobDetail {
    val error = if (status == JobStatus.FAILED && errorCode != null) JobError(errorCode!!, errorMessage ?: "") else null
    return JobDetail(
        id = id,
        status = status,
        stage = stage,
        processedCells = processedCells,
        totalCells = totalCells,
        heartbeatAt = heartbeatAt,
        attempt = attempt,
        maxRetries = maxRetries,
        retryCount = retryCount,
        blueprintId = blueprintId,
        error = error,
        snapshot = SnapshotInfo(modelSnapshot, colorLibraryVersion),
        createdAt = createdAt,
        updatedAt = updatedAt,
    )
}

fun RecognitionJob.toSummary(): JobSummary = JobSummary(
    id = id,
    status = status,
    stage = stage,
    processedCells = processedCells,
    totalCells = totalCells,
    rows = rows,
    cols = cols,
    attempt = attempt,
    retryCount = retryCount,
    blueprintId = blueprintId,
    createdAt = createdAt,
    updatedAt = updatedAt,
)

fun BlueprintCell.toDto(): BlueprintCellDto = BlueprintCellDto(
    row = row,
    col = col,
    code = code,
    status = status,
    color = if (colorCode != null) ColorDto(colorCode!!, colorName ?: "", colorHex ?: "") else null,
)
