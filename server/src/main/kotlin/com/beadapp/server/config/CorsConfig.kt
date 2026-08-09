package com.beadapp.server.config

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.UrlBasedCorsConfigurationSource
import org.springframework.web.filter.CorsFilter

/**
 * CORS 配置（013 决议）：前端独立 dev server（:5173）直连 :8080 时允许跨域。
 * 生产同源部署时可用 CORS_ALLOWED_ORIGINS 收紧。
 */
@Configuration
class CorsConfig {

    @Bean
    fun corsFilter(
        @Value("\${bead.cors.allowed-origins:http://localhost:5173}") allowedOrigins: String,
    ): CorsFilter {
        val config = CorsConfiguration()
        config.allowedOrigins = allowedOrigins.split(",").map { it.trim() }
        config.allowedMethods = listOf("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")
        config.allowedHeaders = listOf("*")
        config.maxAge = 3600L
        val source = UrlBasedCorsConfigurationSource()
        source.registerCorsConfiguration("/**", config)
        return CorsFilter(source)
    }
}
