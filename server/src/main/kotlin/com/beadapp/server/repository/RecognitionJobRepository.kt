package com.beadapp.server.repository

import com.beadapp.server.model.JobStatus
import com.beadapp.server.model.RecognitionJob
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.time.OffsetDateTime
import java.util.UUID

interface RecognitionJobRepository : JpaRepository<RecognitionJob, UUID> {

    fun findByStatusIn(statuses: List<JobStatus>, pageable: Pageable): Page<RecognitionJob>

    fun findByStatus(status: JobStatus, pageable: Pageable): Page<RecognitionJob>

    @Query("SELECT j FROM RecognitionJob j WHERE (:status IS NULL OR j.status = :status)")
    fun findAllFiltered(@Param("status") status: JobStatus?, pageable: Pageable): Page<RecognitionJob>

    @Query(
        "SELECT j FROM RecognitionJob j WHERE j.status = :status AND (j.heartbeatAt IS NULL OR j.heartbeatAt < :threshold)"
    )
    fun findStale(@Param("status") status: JobStatus, @Param("threshold") threshold: OffsetDateTime): List<RecognitionJob>
}
