package com.beadapp.server.api

import com.beadapp.server.config.ApiException
import com.beadapp.server.model.ColorLibrary
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

    /** 007：颜色库列表（q 前缀搜索 + 分页；编码按 A1→A2→…→A10→A11 数字序） */
    @GetMapping
    fun list(
        @RequestParam(value = "q", required = false) q: String?,
        @RequestParam(value = "page", defaultValue = "1") @Min(1) page: Int,
        @RequestParam(value = "pageSize", defaultValue = "100") @Min(1) @Max(100) pageSize: Int,
    ): PageResponse<ColorDto> {
        // 全量拉取后内存数字序排序（VARCHAR 字典序会把 A10 排在 A2 前）；291 条量级可接受
        val all = colorRepo.findAll()
        val filtered = if (q.isNullOrBlank()) all
        else all.filter { it.code.startsWith(q.trim().uppercase()) }
        val sorted = filtered.sortedWith(naturalCodeComparator())
        val start = ((page - 1) * pageSize).coerceAtMost(sorted.size)
        val items = sorted.subList(start, minOf(start + pageSize, sorted.size))
            .map { ColorDto(it.code, it.name, it.hex, it.brand) }
        return PageResponse(
            items = items,
            page = page,
            pageSize = pageSize,
            total = sorted.size.toLong(),
            totalPages = (sorted.size + pageSize - 1) / pageSize,
        )
    }

    /** 字母升序 + 数字部分按数值（A1 < A2 < A10 < A11）；无数字后缀的排同字母最后 */
    private fun naturalCodeComparator(): Comparator<ColorLibrary> = compareBy<ColorLibrary> { it.code.firstOrNull() }
        .thenBy { it.code.drop(1).takeWhile(Char::isDigit).toIntOrNull() ?: Int.MAX_VALUE }
        .thenBy { it.code }

    /** 007：单个颜色 */
    @GetMapping("/{code}")
    fun get(@PathVariable("code") code: String): ColorDto {
        val c = colorRepo.findByCodeIgnoreCase(code.trim().uppercase()) ?: throw ApiException(
            HttpStatus.NOT_FOUND, "COLOR_NOT_FOUND", "颜色不存在: $code"
        )
        return ColorDto(c.code, c.name, c.hex, c.brand)
    }
}
