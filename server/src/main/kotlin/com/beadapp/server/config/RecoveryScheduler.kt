package com.beadapp.server.config

import com.beadapp.server.service.JobService
import jakarta.annotation.PostConstruct
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.EnableScheduling
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component

/** 008 决议：stale 心跳恢复。启动时全量扫描一次，之后周期扫描。 */
@Component
@EnableScheduling
class RecoveryScheduler(
    private val jobService: JobService,
) {

    private val log = LoggerFactory.getLogger(RecoveryScheduler::class.java)

    @PostConstruct
    fun initialSweep() {
        val n = jobService.recoverStale()
        log.info("startup recovery sweep: {} stale jobs handled", n)
    }

    @Scheduled(fixedDelayString = "\${bead.recovery.interval-ms:30000}")
    fun periodicSweep() {
        val n = jobService.recoverStale()
        if (n > 0) log.info("periodic recovery sweep: {} stale jobs handled", n)
    }
}
