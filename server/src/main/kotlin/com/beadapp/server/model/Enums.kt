package com.beadapp.server.model

enum class JobStatus {
    PENDING, PROCESSING, SUCCEEDED, SUCCEEDED_WITH_WARNINGS, FAILED
}

enum class JobStage {
    QUEUED, OCR
}

enum class CellStatus {
    MAPPED, UNMAPPED, BLANK
}

enum class EventType {
    JOB_STARTED, CELL_PROCESSED, CELL_FAILED, HEARTBEAT, RETRY_SCHEDULED, JOB_SUCCEEDED, JOB_FAILED
}
