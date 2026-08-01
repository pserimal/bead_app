package com.beadapp.server.api

import com.beadapp.server.config.ApiException
import com.beadapp.server.schema.InboundEvent
import com.beadapp.server.service.JobService
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.util.UUID

/** 009 决议：Python → Spring 内部回调。与对外 /api/v1 隔离。 */
@RestController
@RequestMapping("/internal/jobs")
class InternalEventController(
    private val jobService: JobService,
) {

    /** 009：逐 Cell 事件回调。202 = 已应用/幂等去重；409 = 终态拒绝；400 = 事件非法 */
    @PostMapping("/{jobId}/events")
    fun receiveEvent(
        @PathVariable("jobId") jobId: UUID,
        @RequestBody event: InboundEvent,
    ): ResponseEntity<Map<String, Any>> {
        if (event.jobId != jobId) {
            throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_EVENT", "jobId 路径与体不一致")
        }
        val applied = jobService.applyEvent(event)
        return ResponseEntity.ok(mapOf("applied" to applied))
    }
}
