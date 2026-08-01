package com.beadapp.server.service

import com.beadapp.server.model.RecognitionJob
import com.beadapp.server.repository.RecognitionJobRepository
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.time.Duration
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * 009 反向：Spring → Python 任务调度器。
 * 创建/重试任务时，把原图 + 裁剪参数以 multipart 提交到 Python image-service
 * `POST /v1/tasks`，Python 处理后逐 cell 回调 `/internal/jobs/{id}/events`。
 * 实现：内部专用线程池异步派发（避免 Kotlin final 类 + @Async 代理的坑）。
 */
@Service
class PythonTaskDispatcher(
    private val jobRepo: RecognitionJobRepository,
    @Value("\${bead.python.base-url:http://localhost:8001}") private val pythonBaseUrl: String,
    @Value("\${bead.storage.dir:./uploads}") private val storageDir: String,
) {

    private val log = LoggerFactory.getLogger(PythonTaskDispatcher::class.java)
    private val http = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    private val threadSeq = AtomicInteger()
    private val executor = Executors.newFixedThreadPool(4) { r ->
        Thread(r, "bead-dispatch-" + threadSeq.incrementAndGet()).apply { isDaemon = true }
    }

    /** 派发任务（异步，不阻塞 API 响应）。 */
    fun dispatch(job: RecognitionJob) {
        executor.submit { doDispatch(job) }
    }

    private fun doDispatch(job: RecognitionJob) {
        log.info("dispatch ENTER job={} attempt={}", job.id, job.attempt)
        try {
            val imagePath = storageRoot().resolve(job.inputImagePath)
            if (!Files.exists(imagePath)) {
                log.warn("job {}: 原图不存在 {}", job.id, imagePath)
                return
            }
            val crop = job.cropBox
            val boundary = "----BeadBoundary" + UUID.randomUUID().toString().replace("-", "")
            val body = buildMultipart(
                boundary = boundary,
                jobId = job.id.toString(),
                attempt = job.attempt,
                imagePath = imagePath,
                cropBox = """{"x":${crop.x},"y":${crop.y},"width":${crop.width},"height":${crop.height}}""",
                rows = job.rows,
                cols = job.cols,
                validCodes = job.validCodes,
            )
            val request = HttpRequest.newBuilder()
                .uri(URI.create("$pythonBaseUrl/v1/tasks"))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "multipart/form-data; boundary=$boundary")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build()
            val resp = http.send(request, HttpResponse.BodyHandlers.ofString())
            if (resp.statusCode() in 200..299) {
                log.info("job {} dispatched to python (attempt {}) → {}", job.id, job.attempt, resp.body().take(120))
            } else {
                log.warn("job {} dispatch FAILED: HTTP {} {}", job.id, resp.statusCode(), resp.body().take(200))
            }
        } catch (e: Exception) {
            log.warn("job {} dispatch error: {}", job.id, e.message)
        }
    }

    private fun storageRoot() =
        java.nio.file.Paths.get(storageDir).toAbsolutePath().normalize()

    private fun buildMultipart(
        boundary: String,
        jobId: String,
        attempt: Int,
        imagePath: java.nio.file.Path,
        cropBox: String,
        rows: Int,
        cols: Int,
        validCodes: List<String>?,
    ): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun field(name: String, value: String) {
            out.write("--$boundary\r\n".toByteArray())
            out.write("Content-Disposition: form-data; name=\"$name\"\r\n\r\n".toByteArray())
            out.write("$value\r\n".toByteArray())
        }
        field("jobId", jobId)
        field("attempt", attempt.toString())
        field("cropBox", cropBox)
        field("rows", rows.toString())
        field("cols", cols.toString())
        if (validCodes != null) {
            field("validCodes", validCodes.joinToString(",", "[", "]") { "\"$it\"" })
        }
        field("callbackUrl", pythonCallbackBase())
        // image file part
        out.write("--$boundary\r\n".toByteArray())
        out.write("Content-Disposition: form-data; name=\"image\"; filename=\"${imagePath.fileName}\"\r\n".toByteArray())
        out.write("Content-Type: image/png\r\n\r\n".toByteArray())
        Files.newInputStream(imagePath).use { it.copyTo(out) }
        out.write("\r\n".toByteArray())
        out.write("--$boundary--\r\n".toByteArray())
        return out.toByteArray()
    }

    private fun pythonCallbackBase(): String =
        System.getenv("CALLBACK_BASE_URL") ?: "http://localhost:8080"
}
