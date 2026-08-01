package com.beadapp.server.repository

import com.beadapp.server.model.EventType
import com.beadapp.server.model.RecognitionJobEvent
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface RecognitionJobEventRepository : JpaRepository<RecognitionJobEvent, Long> {

    fun findByJobId(jobId: UUID, pageable: Pageable): Page<RecognitionJobEvent>

    fun existsByJobIdAndAttemptAndSequence(jobId: UUID, attempt: Int, sequence: Long): Boolean

    fun countByJobId(jobId: UUID): Long

    fun findByJobIdAndType(jobId: UUID, type: EventType): List<RecognitionJobEvent>
}
