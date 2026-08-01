package com.beadapp.server.service

import com.beadapp.server.config.ApiException
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.web.multipart.MultipartFile
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.util.UUID

/** 005 决议：Spring 独占原图存储（本地文件系统，首版） */
@Service
class StorageService(
    @Value("\${bead.storage.dir:./uploads}") private val storageDir: String,
) {

    private val root: Path = Paths.get(storageDir).toAbsolutePath().normalize()

    init {
        Files.createDirectories(root)
    }

    fun saveImage(image: MultipartFile): String {
        val id = UUID.randomUUID().toString()
        val filename = "$id-${sanitize(image.originalFilename ?: "image.jpg")}"
        val target = root.resolve(filename).normalize()
        if (!target.startsWith(root)) {
            throw ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "非法文件名")
        }
        Files.copy(image.inputStream, target, StandardCopyOption.REPLACE_EXISTING)
        return filename
    }

    fun loadImage(filename: String): Path {
        val target = root.resolve(filename).normalize()
        if (!target.startsWith(root) || !Files.exists(target)) {
            throw ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "图片不存在: $filename")
        }
        return target
    }

    private fun sanitize(name: String): String =
        name.replace(Regex("[^A-Za-z0-9._-]"), "_").takeLast(100)
}
