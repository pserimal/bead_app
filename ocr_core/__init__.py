"""Shared OCR core — one copy consumed by training and the Python image-service.

010 决议：训练与推理共享一个独立 OCR 核心模块；推理服务不依赖旧 backend 或训练脚本。
"""

__version__ = "0.1.0"

from ocr_core.charset import (
    CHARS,
    CHAR_TO_IDX,
    IDX_TO_CHAR,
    LETTERS,
    DIGITS,
    charset_hash,
    CHARSET_VERSION,
)
from ocr_core.code_library import load_codes, load_library
from ocr_core.bead_ocr_crnn import (
    CRNN,
    CheckpointFormatError,
    ctc_greedy_decode,
    constrained_decode,
    build_code_trie,
    load_checkpoint,
    save_checkpoint,
)
from ocr_core.inference import ocr_cells_from_crop, load_runtime_model

__all__ = [
    "__version__",
    "CHARS",
    "CHAR_TO_IDX",
    "IDX_TO_CHAR",
    "LETTERS",
    "DIGITS",
    "charset_hash",
    "CHARSET_VERSION",
    "load_codes",
    "load_library",
    "CRNN",
    "CheckpointFormatError",
    "ctc_greedy_decode",
    "constrained_decode",
    "build_code_trie",
    "load_checkpoint",
    "save_checkpoint",
    "ocr_cells_from_crop",
    "load_runtime_model",
]
