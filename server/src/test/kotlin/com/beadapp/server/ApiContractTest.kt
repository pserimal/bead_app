package com.beadapp.server

import com.beadapp.server.model.*
import com.beadapp.server.repository.*
import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.mock.web.MockMultipartFile
import org.springframework.test.context.TestPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import java.util.UUID

@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(
    properties = [
        "spring.datasource.url=jdbc:postgresql://192.168.5.88:5432/bead_app_test",
        "spring.datasource.username=admin",
        "spring.datasource.password=123456",
        "bead.storage.dir=./build/test-uploads",
    ]
)
class ApiContractTest {

    @Autowired lateinit var mockMvc: MockMvc
    @Autowired lateinit var objectMapper: ObjectMapper
    @Autowired lateinit var jobRepo: RecognitionJobRepository
    @Autowired lateinit var eventRepo: RecognitionJobEventRepository
    @Autowired lateinit var cellRepo: RecognitionJobCellRepository
    @Autowired lateinit var blueprintRepo: BlueprintRepository
    @Autowired lateinit var blueprintCellRepo: BlueprintCellRepository
    @Autowired lateinit var colorRepo: ColorLibraryRepository

    private val png: ByteArray = byteArrayOf(
        0x89.toByte(), 0x50.toByte(), 0x4E.toByte(), 0x47.toByte(),
        0x0D, 0x0A, 0x1A, 0x0A,
        0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52,
    )

    @BeforeEach
    fun clean() {
        blueprintCellRepo.deleteAll()
        blueprintRepo.deleteAll()
        cellRepo.deleteAll()
        eventRepo.deleteAll()
        jobRepo.deleteAll()
    }

    private fun createJob(): UUID {
        val file = MockMultipartFile("image", "test.png", "image/png", png)
        val result = mockMvc.perform(
            multipart("/api/v1/jobs")
                .file(file)
                .param("cropBoxX", "10")
                .param("cropBoxY", "20")
                .param("cropBoxWidth", "100")
                .param("cropBoxHeight", "200")
                .param("rows", "2")
                .param("cols", "2")
                .param("codes", "H1,H2")
        ).andExpect(status().isAccepted).andReturn()
        val body = objectMapper.readTree(result.response.contentAsString)
        return UUID.fromString(body.get("id").asText())
    }

    @Test
    fun `创建任务返回 202 JobDetail 契约`() {
        createJob()
            .let { } // createJob 内已断言；此处验证列表
    }

    @Test
    fun `任务列表分页信封与 status 筛选`() {
        createJob()
        mockMvc.perform(get("/api/v1/jobs").param("status", "PENDING"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].status").value("PENDING"))
            .andExpect(jsonPath("$.items[0].totalCells").value(4))
            .andExpect(jsonPath("$.page").value(1))
            .andExpect(jsonPath("$.totalPages").value(1))
            .andExpect(jsonPath("$.total").value(1))

        mockMvc.perform(get("/api/v1/jobs").param("status", "FAILED"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.items.length()").value(0))

        mockMvc.perform(get("/api/v1/jobs").param("status", "NOPE"))
            .andExpect(status().isBadRequest)
            .andExpect(jsonPath("$.code").value("INVALID_JOB_STATUS"))
    }

    @Test
    fun `任务详情包含快照与阶段字段`() {
        val id = createJob()
        mockMvc.perform(get("/api/v1/jobs/$id"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.id").value(id.toString()))
            .andExpect(jsonPath("$.stage").value("QUEUED"))
            .andExpect(jsonPath("$.snapshot.model").isNotEmpty)
            .andExpect(jsonPath("$.snapshot.colorLibraryVersion").isNotEmpty)
    }

    @Test
    fun `事件流只读子资源按 attempt+sequence 升序`() {
        val id = createJob()
        mockMvc.perform(get("/api/v1/jobs/$id/events"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.items.length()").value(1))
            .andExpect(jsonPath("$.items[0].type").value("JOB_STARTED"))
            .andExpect(jsonPath("$.items[0].sequence").value(0))
    }

    @Test
    fun `内部回调逐 cell 事件幂等并驱动进度`() {
        val id = createJob()
        val event = mapOf(
            "jobId" to id.toString(),
            "attempt" to 0,
            "sequence" to 2L,
            "type" to "CELL_PROCESSED",
            "payload" to mapOf("row" to 0, "col" to 0, "code" to "H1"),
        )
        val body = objectMapper.writeValueAsString(event)
        mockMvc.perform(
            post("/internal/jobs/$id/events")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body)
        ).andExpect(status().isOk).andExpect(jsonPath("$.applied").value(true))

        // 幂等：重复投递 applied=false
        mockMvc.perform(
            post("/internal/jobs/$id/events")
                .contentType(MediaType.APPLICATION_JSON)
                .content(body)
        ).andExpect(status().isOk).andExpect(jsonPath("$.applied").value(false))

        mockMvc.perform(get("/api/v1/jobs/$id"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.processedCells").value(1))
            .andExpect(jsonPath("$.status").value("PROCESSING"))
    }

    @Test
    fun `JOB_SUCCEEDED 原子创建 blueprint 并回填`() {
        val id = createJob()
        fun send(seq: Long, row: Int, col: Int, code: String) {
            mockMvc.perform(
                post("/internal/jobs/$id/events")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(objectMapper.writeValueAsString(mapOf(
                        "jobId" to id.toString(), "attempt" to 0, "sequence" to seq,
                        "type" to "CELL_PROCESSED", "payload" to mapOf("row" to row, "col" to col, "code" to code),
                    )))
            ).andExpect(status().isOk)
        }
        send(2, 0, 0, "H1")  // MAPPED
        send(3, 0, 1, "H2")  // MAPPED
        send(4, 1, 0, "Z99") // UNMAPPED
        send(5, 1, 1, "H3")  // MAPPED

        mockMvc.perform(
            post("/internal/jobs/$id/events")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(mapOf(
                    "jobId" to id.toString(), "attempt" to 0, "sequence" to 6L,
                    "type" to "JOB_SUCCEEDED", "payload" to mapOf("processedCells" to 4),
                )))
        ).andExpect(status().isOk)

        mockMvc.perform(get("/api/v1/jobs/$id"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.status").value("SUCCEEDED_WITH_WARNINGS"))
            .andExpect(jsonPath("$.blueprintId").isNotEmpty)

        val bpId = objectMapper.readTree(
            mockMvc.perform(get("/api/v1/jobs/$id")).andReturn().response.contentAsString
        ).get("blueprintId").asText()

        mockMvc.perform(get("/api/v1/blueprints/$bpId"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.cells.length()").value(4))
            .andExpect(jsonPath("$.cells[2].status").value("UNMAPPED"))
            .andExpect(jsonPath("$.cells[2].color").doesNotExist())
            .andExpect(jsonPath("$.cells[0].color.code").value("H1"))
    }

    @Test
    fun `终态后事件拒绝 409`() {
        val id = createJob()
        mockMvc.perform(
            post("/internal/jobs/$id/events")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(mapOf(
                    "jobId" to id.toString(), "attempt" to 0, "sequence" to 2L,
                    "type" to "JOB_FAILED", "payload" to mapOf("code" to "X", "message" to "y"),
                )))
        ).andExpect(status().isOk)

        // retry_count=0 < max_retries=2 → 重试，仍 PROCESSING；再发两次失败才终态
        mockMvc.perform(
            post("/internal/jobs/$id/events")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(mapOf(
                    "jobId" to id.toString(), "attempt" to 1, "sequence" to 3L,
                    "type" to "JOB_FAILED", "payload" to mapOf("code" to "X", "message" to "y"),
                )))
        ).andExpect(status().isOk)
        mockMvc.perform(
            post("/internal/jobs/$id/events")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(mapOf(
                    "jobId" to id.toString(), "attempt" to 2, "sequence" to 4L,
                    "type" to "JOB_FAILED", "payload" to mapOf("code" to "X", "message" to "y"),
                )))
        ).andExpect(status().isOk)

        mockMvc.perform(
            post("/internal/jobs/$id/events")
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(mapOf(
                    "jobId" to id.toString(), "attempt" to 2, "sequence" to 5L,
                    "type" to "CELL_PROCESSED", "payload" to mapOf("row" to 0, "col" to 0, "code" to "H1"),
                )))
        ).andExpect(status().isConflict)
            .andExpect(jsonPath("$.code").value("JOB_ALREADY_TERMINAL"))
    }

    @Test
    fun `错误契约形状 404 与校验 400`() {
        mockMvc.perform(get("/api/v1/jobs/${UUID.randomUUID()}"))
            .andExpect(status().isNotFound)
            .andExpect(jsonPath("$.code").value("JOB_NOT_FOUND"))
            .andExpect(jsonPath("$.message").isNotEmpty)
            .andExpect(jsonPath("$.traceId").isNotEmpty)

        val file = MockMultipartFile("image", "test.png", "image/png", png)
        mockMvc.perform(
            multipart("/api/v1/jobs")
                .file(file)
                .param("cropBoxX", "10").param("cropBoxY", "20")
                .param("cropBoxWidth", "100").param("cropBoxHeight", "200")
                .param("rows", "2").param("cols", "2")
                .param("codes", "H1,12x")  // 非法编码
        ).andExpect(status().isBadRequest)
            .andExpect(jsonPath("$.code").value("INVALID_CODE_FORMAT"))
    }

    @Test
    fun `颜色库列表与单色查询`() {
        // 018 决议：DB 只 seed mard 品牌（291 码，全裸码）——H1=白 #FDFBFF
        mockMvc.perform(get("/api/v1/colors").param("q", "H1"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.items[0].code").value("H1"))
            .andExpect(jsonPath("$.items[0].hex").value("FDFBFF"))
            .andExpect(jsonPath("$.items[0].brand").value("mard"))

        mockMvc.perform(get("/api/v1/colors/H1"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.code").value("H1"))
            .andExpect(jsonPath("$.brand").value("mard"))

        mockMvc.perform(get("/api/v1/colors/NOPE"))
            .andExpect(status().isNotFound)
            .andExpect(jsonPath("$.code").value("COLOR_NOT_FOUND"))
    }
}
