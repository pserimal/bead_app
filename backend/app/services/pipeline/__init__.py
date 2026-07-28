"""Pipeline interfaces for bead-board grid detection + code reading.

Export data contracts, behaviour protocols, and the orchestrator.
No concrete implementations in this package (see T7+).
"""
from app.services.pipeline.interfaces import (
    CodeReader,
    CodeResult,
    GridCell,
    GridDetector,
    GridResult,
    Pipeline,
    PipelineResult,
)

__all__ = [
    "CodeReader",
    "CodeResult",
    "GridCell",
    "GridDetector",
    "GridResult",
    "Pipeline",
    "PipelineResult",
]
