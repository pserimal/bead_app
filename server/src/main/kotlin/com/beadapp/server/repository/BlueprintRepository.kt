package com.beadapp.server.repository

import com.beadapp.server.model.Blueprint
import com.beadapp.server.model.BlueprintCell
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository
import java.util.UUID

interface BlueprintRepository : JpaRepository<Blueprint, UUID> {
    fun findByJobId(jobId: UUID): Blueprint?
    override fun findAll(pageable: Pageable): Page<Blueprint>
}

interface BlueprintCellRepository : JpaRepository<BlueprintCell, UUID> {
    fun findAllByBlueprintIdOrderByRowAscColAsc(blueprintId: UUID): List<BlueprintCell>
}
