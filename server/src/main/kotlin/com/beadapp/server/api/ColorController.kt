package com.beadapp.server.api

import com.beadapp.server.config.ApiException
import com.beadapp.server.repository.ColorLibraryRepository
import com.beadapp.server.schema.ColorDto
import com.beadapp.server.schema.PageResponse
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/v1/colors")
class ColorController(
    private val colorRepo: ColorLibraryRepository,
) {

    /** 007：颜色库列表（q 前缀搜索 + 分页） */
    @GetMapping
    fun list(
        @RequestParam(value = "q", required = false) q: String?,
        @RequestParam(value = "page", defaultValue = "1") @Min(1) page: Int,
        @RequestParam(value = "pageSize", defaultValue = "100") @Min(1) @Max(100) pageSize: Int,
    ): PageResponse<ColorDto> {
        val pageable = PageRequest.of(page - 1, pageSize, Sort.by(Sort.Direction.ASC, "code"))
        val p = if (q.isNullOrBlank()) colorRepo.findAll(pageable)
        else colorRepo.findByCodeStartsWithIgnoreCase(q.trim().uppercase(), pageable)
        return PageResponse(
            items = p.content.map { ColorDto(it.code, it.name, it.hex, it.brand) },
            page = page,
            pageSize = pageSize,
            total = p.totalElements,
            totalPages = p.totalPages,
        )
    }

    /** 007：单个颜色 */
    @GetMapping("/{code}")
    fun get(@PathVariable("code") code: String): ColorDto {
        val c = colorRepo.findByCodeIgnoreCase(code.trim().uppercase()) ?: throw ApiException(
            HttpStatus.NOT_FOUND, "COLOR_NOT_FOUND", "颜色不存在: $code"
        )
        return ColorDto(c.code, c.name, c.hex, c.brand)
    }
}
