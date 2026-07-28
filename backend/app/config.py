from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://admin:123456@localhost:5432/bead_app"
    upload_dir: str = "./uploads"
    max_upload_size_mb: int = 20
    DEBUG_DUMP: bool = False
    DEBUG_DUMP_DIR: str = "backend/uploads/debug"
    # Minimum confidence (0.0–1.0) for an OCR detection to be retained.
    # Below this threshold, detections are dropped before per-cell merge.
    # Tunable per environment — lowering increases recall at the cost of
    # more false positives.
    OCR_MIN_CONF: float = 0.5
    # Selected OCR engine for cell recognition:
    #   "easy"     → EasyOCR with adaptive preprocessing (default)
    #   "paddle"   → PaddleOCR with same preprocessing (may have API issues)
    #   "template" → Plan B: zero-training glyph template matching (NCC).
    #                Cheapest baseline; ~100% on synthetic fixtures, brittle
    #                on real photos. Use to validate the matching machinery.
    #   "deepseek" → DeepSeek-OCR via Ollama VLM (requires Ollama with deepseek-ocr)
    #   "crnn"     → Custom-trained CRNN on synthetic cell crops (requires a
    #                trained checkpoint at CRNN_MODEL_PATH). Pure-text recognition,
    #                no color signal — best fit for printed bead diagrams.
    # Set via OCR_ENGINE env var. Benchmark with tests/benchmark_real.py to pick.
    OCR_ENGINE: str = "easy"
    # Path to the trained CRNN checkpoint (.pt). Used when OCR_ENGINE=crnn.
    # Default points to the trained checkpoint bundled with the repo.
    # Override via the CRNN_MODEL_PATH env var if you train a new one
    # (the trained checkpoint lives in training/checkpoints/).
    CRNN_MODEL_PATH: str = "../training/checkpoints/crnn_v2.pt"
    # When True (default), grid detection falls back to projection / Hough /
    # standard-size clamp if blue-line FFT fails. Set to False to disable
    # the fallback chain and revert to FFT-only detection.
    BACKEND_FALLBACK_ENABLED: bool = True

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
