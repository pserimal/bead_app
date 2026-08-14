"""Model naming convention (2026-08-15 unified).

All models use ``bean-mard-v<N>`` format, numbered chronologically by event
order (oldest = v1, newest = vN).

- training/checkpoints/:  bean-mard-v1.pt .. bean-mard-v45.pt
- artifacts/models/:     bean-mard-v1-<version> .. bean-mard-v11-<version>

New models are published with the next available N via publish_checkpoint.py;
train_crnn.py auto-names checkpoints the same way when --out is omitted.
"""
from __future__ import annotations

import re
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
CHECKPOINTS = _REPO_ROOT / "training" / "checkpoints"
ARTIFACTS = _REPO_ROOT / "artifacts" / "models"

_NAME_RE = re.compile(r"^bean-mard-v(\d+)$")  # bare name (checkpoint/CLI)
_ART_DIR_RE = re.compile(r"^bean-mard-v(\d+)-\d{4}-\d{2}-\d{2}T")  # artifact dir
_PT_RE = re.compile(r"^bean-mard-v(\d+)\.pt$")


def validate_name(name: str) -> bool:
    """Return True if name matches the bean-mard-v<N> convention."""
    return bool(_NAME_RE.match(name))


def _max_existing(patterns: list[tuple[Path, re.Pattern]], recurse: bool = False) -> int:
    """Scan dirs with regex patterns, return the max N found (0 if none)."""
    max_n = 0
    for base, pat in patterns:
        if not base.is_dir():
            continue
        it = base.rglob("*") if recurse else base.iterdir()
        for p in it:
            m = pat.match(p.name)
            if m:
                max_n = max(max_n, int(m.group(1)))
    return max_n


def next_checkpoint_name() -> str:
    """Return the next checkpoint filename, e.g. bean-mard-v46.pt."""
    n = _max_existing([(CHECKPOINTS, _PT_RE)])
    return f"bean-mard-v{n + 1}.pt"


def next_artifact_name() -> str:
    """Return the next artifact name (no version suffix), e.g. bean-mard-v12."""
    n = _max_existing([(ARTIFACTS, _ART_DIR_RE)], recurse=False)
    return f"bean-mard-v{n + 1}"
