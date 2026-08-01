package com.beadapp.server.model

import jakarta.persistence.*

@Entity
@Table(name = "color_library")
class ColorLibrary(
    @Id
    @Column(name = "code", length = 8)
    var code: String,

    @Column(name = "name", nullable = false)
    var name: String,

    @Column(name = "hex", nullable = false, length = 6)
    var hex: String,

    @Column(name = "brand", nullable = false, length = 32)
    var brand: String,

    @Column(name = "version", nullable = false)
    var version: String,
)
