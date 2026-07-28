"""Debug output helpers. No-op unless DEBUG_DUMP env is set."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from app.config import settings


def dump_debug(step: str, image: np.ndarray, metadata: dict | None = None) -> None:
    """Write <step>.png and <step>.json to <DEBUG_DUMP_DIR>/<timestamp>/.

    No-op when DEBUG_DUMP=False. Creates timestamped subdir.
    """
    if not settings.DEBUG_DUMP:
        return
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S-%fZ")
    out_dir = Path(settings.DEBUG_DUMP_DIR) / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_dir / f"{step}.png"), image)
    if metadata is not None:
        with open(out_dir / f"{step}.json", "w") as f:
            json.dump(metadata, f, indent=2)


def debug_enabled() -> bool:
    return bool(settings.DEBUG_DUMP)
