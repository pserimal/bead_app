package com.beadapp.server.repository

import com.beadapp.server.model.ColorLibrary
import org.springframework.data.domain.Page
import org.springframework.data.domain.Pageable
import org.springframework.data.jpa.repository.JpaRepository

interface ColorLibraryRepository : JpaRepository<ColorLibrary, String> {

    fun findByCodeStartsWithIgnoreCase(prefix: String, pageable: Pageable): Page<ColorLibrary>

    fun findByCodeIgnoreCase(code: String): ColorLibrary?
}
