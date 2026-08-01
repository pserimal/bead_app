package com.beadapp.server.repository

import com.beadapp.server.model.RecognitionJobCell
import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface RecognitionJobCellRepository : JpaRepository<RecognitionJobCell, UUID> {

    fun findAllByJobIdOrderByRowAscColAsc(jobId: UUID): List<RecognitionJobCell>

    fun countByJobId(jobId: UUID): Long

    fun deleteAllByJobId(jobId: UUID)
}
