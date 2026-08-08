package com.beadapp.server.config

import org.flywaydb.core.Flyway
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.flyway.FlywayMigrationStrategy
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * 017 决议：开发期数据库初始化策略 —— 不保证兼容性，按配置每次启动重建。
 *
 * `bead.db.recreate-on-start=false`（默认）：
 *   保留既有数据，仅执行迁移（Spring Boot 默认行为）。
 *
 * `bead.db.recreate-on-start=true`：
 *   仅在显式开发/重置场景下，启动时先 flyway.clean()（drop 全部表）
 *   → flyway.migrate() → ColorSeedRunner 幂等 seed 官方颜色库。
 */
@Configuration
class DatabaseInitConfig {

    private val log = LoggerFactory.getLogger(DatabaseInitConfig::class.java)

    @Bean
    fun flywayMigrationStrategy(
        @Value("\${bead.db.recreate-on-start:false}") recreateOnStart: Boolean,
    ): FlywayMigrationStrategy {
        return FlywayMigrationStrategy { flyway: Flyway ->
            if (recreateOnStart) {
                log.warn("[db-init] bead.db.recreate-on-start=true — dropping ALL tables and rebuilding")
                flyway.clean()
            }
            flyway.migrate()
        }
    }
}
