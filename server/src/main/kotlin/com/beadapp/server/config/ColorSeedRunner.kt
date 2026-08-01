package com.beadapp.server.config

import com.beadapp.server.model.ColorLibrary
import com.beadapp.server.repository.ColorLibraryRepository
import com.fasterxml.jackson.databind.ObjectMapper
import org.slf4j.LoggerFactory
import org.springframework.boot.CommandLineRunner
import org.springframework.core.io.ClassPathResource
import org.springframework.stereotype.Component

/**
 * 005 决议：默认颜色库是 Spring Boot 的 seed 资源，幂等。
 * 数据源：`default_colors.json`（由旧 backend/app/data/default_colors.json 复制，65 码，H/F/G）。
 * 任务创建时快照 colorLibraryVersion="seed-1"。
 */
@Component
class ColorSeedRunner(
    private val colorRepo: ColorLibraryRepository,
    private val objectMapper: ObjectMapper,
) : CommandLineRunner {

    private val log = LoggerFactory.getLogger(ColorSeedRunner::class.java)

    override fun run(vararg args: String?) {
        if (colorRepo.count() > 0) {
            log.info("color library already seeded ({} entries)", colorRepo.count())
            return
        }
        val version = "seed-1"
        val colors = loadColors()
        colorRepo.saveAll(colors.map { ColorLibrary(it.code, it.name, it.hex, version) })
        log.info("seeded {} colors (version {})", colors.size, version)
    }

    private fun loadColors(): List<SeedColor> {
        val resource = ClassPathResource("default_colors.json")
        val bytes = resource.inputStream.use { it.readAllBytes() }
        return objectMapper.readValue(bytes, Array<SeedColor>::class.java).toList()
    }

    data class SeedColor(
        val code: String,
        @com.fasterxml.jackson.annotation.JsonProperty("color_name") val name: String,
        @com.fasterxml.jackson.annotation.JsonProperty("color_hex") val colorHex: String,
        @com.fasterxml.jackson.annotation.JsonProperty("sort_order") val sortOrder: Int = 0,
    ) {
        val hex: String get() = colorHex.removePrefix("#")
    }
}
