"""Character table — single source of truth for the CRNN charset.

010 决议 R1：CHARS/CHAR_TO_IDX/IDX_TO_CHAR 从 `training/models/synth_generator.py`
迁移至此，训练与推理共用一份，删除副本。
"""

from __future__ import annotations

import hashlib

LETTERS: list[str] = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
DIGITS: list[str] = list("0123456789")
# <blank> at index 0 (CTC requirement), then A‑Z, then 0‑9.
CHARS: list[str] = ["<blank>"] + LETTERS + DIGITS
CHAR_TO_IDX: dict[str, int] = {ch: i for i, ch in enumerate(CHARS)}
IDX_TO_CHAR: dict[int, str] = {i: ch for i, ch in enumerate(CHARS)}

CHARSET_VERSION = "v1"


def charset_hash() -> str:
    """Deterministic hash of the charset — used for checkpoint compatibility (010 R2)."""
    return hashlib.sha256("|".join(CHARS).encode("utf-8")).hexdigest()
