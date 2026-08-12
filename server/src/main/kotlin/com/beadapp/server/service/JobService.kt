package com.beadapp.server.service

import com.beadapp.server.config.ApiException
import com.beadapp.server.model.*
import com.beadapp.server.repository.*
import com.beadapp.server.schema.*
import org.slf4j.LoggerFactory
import org.springframework.data.domain.Page
import org.springframework.data.domain.PageRequest
import org.springframework.data.domain.Sort
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.OffsetDateTime
import java.util.UUID

@Service
class JobService(
    private val jobRepo: RecognitionJobRepository,
    private val eventRepo: RecognitionJobEventRepository,
    private val cellRepo: RecognitionJobCellRepository,
    private val blueprintRepo: BlueprintRepository,
    private val blueprintCellRepo: BlueprintCellRepository,
    private val colorRepo: ColorLibraryRepository,
    private val dispatcher: PythonTaskDispatcher,
) {

    private val log = LoggerFactory.getLogger(JobService::class.java)

    /** 008：创建任务 = job + JOB_STARTED 事件，单事务 */
    @Transactional
    fun createJob(
        rows: Int,
        cols: Int,
        cropBox: CropBox,
        validCodes: List<String>?,
        inputImagePath: String,
        colorLibraryVersion: String,
        modelSnapshot: String,
        name: String? = null,
    ): RecognitionJob {
        val job = RecognitionJob(
            rows = rows,
            cols = cols,
            cropBox = cropBox,
            validCodes = validCodes?.sorted(),
            inputImagePath = inputImagePath,
            colorLibraryVersion = colorLibraryVersion,
            modelSnapshot = modelSnapshot,
            totalCells = rows * cols,
            status = JobStatus.PENDING,
            name = name?.trim()?.takeIf { it.isNotEmpty() },
        )
        jobRepo.save(job)
        // 009：Python 事件序列从 1 开始，JOB_STARTED 用 sequence=0 避免撞幂等键
        appendEvent(job.id, job.attempt, 0L, EventType.JOB_STARTED, mapOf("rows" to rows, "cols" to cols))
        // 009 反向：创建后立即派发给 Python
        dispatcher.dispatch(job)
        return job
    }

    /** 019：任务改名（trim 后非空才保存；null/空 = 清空名称） */
    @Transactional
    fun renameJob(id: UUID, name: String?): RecognitionJob {
        val job = jobRepo.findById(id).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "JOB_NOT_FOUND", "任务不存在")
        }
        job.name = name?.trim()?.takeIf { it.isNotEmpty() }
        return jobRepo.save(job)
    }

    /** 019：批量真删任务（级联删除 job_cell/job_event/blueprint_cell/blueprint） */
    @Transactional
    fun deleteJobs(ids: List<UUID>) {
        for (id in ids.distinct()) {
            val blueprint = blueprintRepo.findByJobId(id)
            if (blueprint != null) {
                blueprintCellRepo.deleteAllByBlueprintId(blueprint.id)
                blueprintRepo.delete(blueprint)
            }
            cellRepo.deleteAllByJobId(id)
            eventRepo.deleteAllByJobId(id)
            jobRepo.deleteById(id)
        }
    }

    /** 008：幂等应用入站事件。返回是否为新事件。 */
    @Transactional
    fun applyEvent(e: InboundEvent): Boolean {
        val job = jobRepo.findById(e.jobId).orElseThrow {
            ApiException(HttpStatus.NOT_FOUND, "JOB_NOT_FOUND", "识别任务不存在: ${e.jobId}")
        }
        // 过期 attempt：202 no-op（008）
        if (e.attempt < job.attempt) return false
        // 终态拒绝非幂等事件（008；幂等重放由唯一键去重）
        if (job.status in TERMINAL) {
            // 重复的终态事件本身按唯一键去重；这里只挡新事件
        }
        if (eventRepo.existsByJobIdAndAttemptAndSequence(e.jobId, e.attempt, e.sequence)) {
            return false // 已应用（幂等）
        }
        if (job.status in TERMINAL) {
            throw ApiException(HttpStatus.CONFLICT, "JOB_ALREADY_TERMINAL", "任务已处于终态")
        }
        // 未冲突：插入事件 + 应用副作用
        appendEvent(e.jobId, e.attempt, e.sequence, e.type, e.payload)
        when (e.type) {
            EventType.CELL_PROCESSED -> applyCellProcessed(job, e.payload)
            EventType.CELL_FAILED -> applyCellFailed(job, e.payload)
            EventType.HEARTBEAT -> job.heartbeatAt = now()
            EventType.JOB_SUCCEEDED -> completeJob(job, e.payload)
            EventType.JOB_FAILED -> failOrRetry(job, e.payload)
            EventType.JOB_STARTED, EventType.RETRY_SCHEDULED -> {
                job.heartbeatAt = now()
            }
        }
        job.updatedAt = now()
        return true
    }

    private fun applyCellProcessed(job: RecognitionJob, payload: Map<String, Any?>) {
        val row = (payload["row"] as? Number)?.toInt() ?: throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_EVENT", "CELL_PROCESSED 缺少 row")
        val col = (payload["col"] as? Number)?.toInt() ?: throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_EVENT", "CELL_PROCESSED 缺少 col")
        val code = (payload["code"] as? String)?.uppercase() ?: throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_EVENT", "CELL_PROCESSED 缺少 code")
        val confidence = (payload["confidence"] as? Number)?.toDouble()
        val isBlank = code == "BLANK"
        val color = if (isBlank) null else colorRepo.findByCodeIgnoreCase(code)
        val status = when {
            isBlank -> CellStatus.BLANK
            color != null -> CellStatus.MAPPED
            else -> CellStatus.UNMAPPED
        }
        cellRepo.save(
            RecognitionJobCell(
                jobId = job.id, row = row, col = col, code = code, status = status,
                colorCode = color?.code, colorName = color?.name, colorHex = color?.hex,
                confidence = confidence,
            )
        )
        // processed_cells 统计非空格数（与已存 cell 数一致即可）
        job.processedCells = cellRepo.countByJobId(job.id).toInt()
        job.status = JobStatus.PROCESSING
        job.heartbeatAt = now()
    }

    private fun applyCellFailed(job: RecognitionJob, payload: Map<String, Any?>) {
        job.status = JobStatus.PROCESSING
        job.heartbeatAt = now()
    }

    /** 008：JOB_SUCCEEDED → 校验 processed == total，原子创建 Blueprint */
    private fun completeJob(job: RecognitionJob, payload: Map<String, Any?>) {
        if (job.processedCells < job.totalCells) {
            throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_EVENT", "JOB_SUCCEEDED 时 processed(${job.processedCells}) != total(${job.totalCells})")
        }
        val cells = cellRepo.findAllByJobIdOrderByRowAscColAsc(job.id)
        val hasUnmapped = cells.any { it.status == CellStatus.UNMAPPED }
        val bp = Blueprint(
            jobId = job.id,
            rows = job.rows,
            cols = job.cols,
            validCodes = job.validCodes,
        )
        blueprintRepo.save(bp)
        blueprintCellRepo.saveAll(
            cells.map {
                BlueprintCell(
                    blueprintId = bp.id, row = it.row, col = it.col, code = it.code, status = it.status,
                    colorCode = it.colorCode, colorName = it.colorName, colorHex = it.colorHex,
                    confidence = it.confidence,
                )
            }
        )
        job.blueprintId = bp.id
        // 018：不再区分 SUCCEEDED_WITH_WARNINGS（历史状态保留兼容，新任务一律成功；未映射信息仍入 warnings）
        job.status = JobStatus.SUCCEEDED
        job.heartbeatAt = now()
        log.info("job {} completed with blueprint {}", job.id, bp.id)
    }

    /** 008：JOB_FAILED → 未达上限重试（attempt+1），否则终态 */
    private fun failOrRetry(job: RecognitionJob, payload: Map<String, Any?>) {
        job.errorCode = (payload["code"] as? String) ?: "RECOGNITION_FAILED"
        job.errorMessage = payload["message"] as? String
        if (job.retryCount < job.maxRetries) {
            job.retryCount += 1
            job.attempt += 1
            job.status = JobStatus.PROCESSING
            job.heartbeatAt = now()
            appendInternalEvent(job, EventType.RETRY_SCHEDULED, mapOf("nextAttempt" to job.attempt))
            dispatcher.dispatch(job)  // 009 反向：重试重派
        } else {
            job.status = JobStatus.FAILED
            job.heartbeatAt = now()
        }
    }

    /** 008：stale 心跳恢复扫描 */
    @Transactional
    fun recoverStale(thresholdSeconds: Long = 90): Int {
        val threshold = now().minusSeconds(thresholdSeconds)
        val stale = jobRepo.findStale(JobStatus.PROCESSING, threshold)
        for (job in stale) {
            if (job.retryCount < job.maxRetries) {
                job.retryCount += 1
                job.attempt += 1
                job.heartbeatAt = now()
                appendInternalEvent(job, EventType.RETRY_SCHEDULED, mapOf("reason" to "stale_heartbeat", "nextAttempt" to job.attempt))
                dispatcher.dispatch(job)  // 009 反向：stale 恢复重派
                log.warn("job {} stale, retry attempt {}", job.id, job.attempt)
            } else {
                job.status = JobStatus.FAILED
                job.errorCode = "STALE_HEARTBEAT"
                job.errorMessage = "任务心跳超时且重试耗尽"
                appendInternalEvent(job, EventType.JOB_FAILED, mapOf("code" to "STALE_HEARTBEAT", "message" to "任务心跳超时且重试耗尽"))
                log.warn("job {} stale, FAILED", job.id)
            }
        }
        return stale.size
    }

    fun getJob(id: UUID): RecognitionJob = jobRepo.findById(id).orElseThrow {
        ApiException(HttpStatus.NOT_FOUND, "JOB_NOT_FOUND", "识别任务不存在: $id")
    }

    fun listJobs(status: String?, page: Int, pageSize: Int, sortBy: String, sortDir: String): Page<RecognitionJob> {
        val statusEnum = status?.let {
            runCatching { JobStatus.valueOf(it) }.getOrElse {
                throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_JOB_STATUS", "非法状态: $it")
            }
        }
        val pageable = PageRequest.of(page, pageSize, sortDirFor(sortDir), sortByFor(sortBy))
        return if (statusEnum != null) jobRepo.findByStatus(statusEnum, pageable)
        else jobRepo.findAll(pageable)
    }

    fun listEvents(jobId: UUID, page: Int, pageSize: Int, sortDir: String = "asc"): Page<RecognitionJobEvent> {
        getJob(jobId) // 404 检查
        val order = if (sortDir.equals("desc", true)) Sort.Direction.DESC else Sort.Direction.ASC
        return eventRepo.findByJobId(jobId, PageRequest.of(page, pageSize, Sort.by(Sort.Order(order, "attempt"), Sort.Order(order, "sequence"))))
    }

    private fun appendEvent(jobId: UUID, attempt: Int, sequence: Long, type: EventType, payload: Map<String, Any?>) {
        eventRepo.save(RecognitionJobEvent(jobId = jobId, attempt = attempt, sequence = sequence, type = type, payload = payload))
    }

    /** 内部系统事件（RETRY_SCHEDULED 等）：在当前 attempt 下取下一个空闲序列，避免撞幂等键 */
    private fun appendInternalEvent(job: RecognitionJob, type: EventType, payload: Map<String, Any?>) {
        // 取该 job 全部事件（内存过滤 attempt），避免分页只取 1 条导致的错误 max
        val maxSeq = eventRepo.findByJobId(job.id, PageRequest.of(0, 10000, Sort.by(Sort.Order.asc("sequence")))).content
            .filter { it.attempt == job.attempt }
            .maxOfOrNull { it.sequence } ?: 0L
        appendEvent(job.id, job.attempt, maxSeq + 1, type, payload)
    }

    private fun now(): OffsetDateTime = OffsetDateTime.now()

    private fun sortByFor(sortBy: String): String = when (sortBy) {
        "createdAt", "updatedAt", "status", "processedCells" -> sortBy
        else -> "createdAt"
    }

    private fun sortDirFor(sortDir: String): Sort.Direction =
        if (sortDir.equals("asc", true)) Sort.Direction.ASC else Sort.Direction.DESC

    companion object {
        val TERMINAL = setOf(JobStatus.SUCCEEDED, JobStatus.SUCCEEDED_WITH_WARNINGS, JobStatus.FAILED)
    }
}
