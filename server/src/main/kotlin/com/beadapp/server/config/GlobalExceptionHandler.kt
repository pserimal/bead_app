package com.beadapp.server.config

import com.beadapp.server.schema.ApiError
import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.multipart.MaxUploadSizeExceededException
import org.springframework.web.multipart.support.MissingServletRequestPartException
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException
import java.util.UUID

/** 业务异常：携带 007 契约的错误码与 HTTP 状态 */
class ApiException(
    val status: HttpStatus,
    val code: String,
    override val message: String,
    val details: Map<String, Any?>? = null,
) : RuntimeException(message)

@RestControllerAdvice
class GlobalExceptionHandler {

    private val log = LoggerFactory.getLogger(GlobalExceptionHandler::class.java)

    @ExceptionHandler(ApiException::class)
    fun handleApi(e: ApiException): ResponseEntity<ApiError> {
        val err = ApiError(e.code, e.message, e.details, traceId())
        return ResponseEntity.status(e.status).body(err)
    }

    @ExceptionHandler(MethodArgumentNotValidException::class)
    fun handleValidation(e: MethodArgumentNotValidException): ResponseEntity<ApiError> {
        val fields = e.bindingResult.fieldErrors
            .groupBy({ it.field }, { it.defaultMessage ?: "invalid" })
        return ResponseEntity.badRequest().body(ApiError("VALIDATION_ERROR", "请求参数校验失败", fields, traceId()))
    }

    @ExceptionHandler(MissingServletRequestPartException::class)
    fun handleMissingPart(e: MissingServletRequestPartException): ResponseEntity<ApiError> =
        ResponseEntity.badRequest().body(ApiError("VALIDATION_ERROR", "缺少必填字段: ${e.requestPartName}", null, traceId()))

    @ExceptionHandler(MethodArgumentTypeMismatchException::class)
    fun handleTypeMismatch(e: MethodArgumentTypeMismatchException): ResponseEntity<ApiError> =
        ResponseEntity.badRequest().body(
            ApiError("VALIDATION_ERROR", "参数 ${e.name} 类型非法: ${e.value}", null, traceId())
        )

    @ExceptionHandler(MaxUploadSizeExceededException::class)
    fun handleMaxSize(e: MaxUploadSizeExceededException): ResponseEntity<ApiError> =
        ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE)
            .body(ApiError("FILE_TOO_LARGE", "文件超过 20MB 上限", null, traceId()))

    @ExceptionHandler(IllegalArgumentException::class)
    fun handleIllegalArgument(e: IllegalArgumentException): ResponseEntity<ApiError> =
        ResponseEntity.badRequest().body(ApiError("INVALID_REQUEST", e.message ?: "非法请求", null, traceId()))

    @ExceptionHandler(Exception::class)
    fun handleGeneric(e: Exception): ResponseEntity<ApiError> {
        log.error("unhandled exception", e)
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
            .body(ApiError("INTERNAL_ERROR", "服务器内部错误", null, traceId()))
    }

    private fun traceId(): String = UUID.randomUUID().toString()
}
