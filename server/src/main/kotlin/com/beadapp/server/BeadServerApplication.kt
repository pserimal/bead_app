package com.beadapp.server

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableAsync

@SpringBootApplication
@EnableAsync
class BeadServerApplication

fun main(args: Array<String>) {
    runApplication<BeadServerApplication>(*args)
}
