"""Color-library codes loader — artifact snapshot based.

005/010 决议：颜色库快照随 artifact 交付，Python 服务不读 `backend/app/data/default_colors.json`。
加载顺序（010 R3）：
1. env `CODE_LIBRARY_PATH`（JSON 文件，`[{"code": ...}, ...]` 条目）；
2. `<repo_root>/artifacts/colors/library.json`（默认 artifact 快照）；
3. 兜底：报错并给出生成提示。
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent


def _resolve_path() -> Path:
    env = os.environ.get("CODE_LIBRARY_PATH")
    if env:
        return Path(env)
    default = _REPO_ROOT / "artifacts" / "colors" / "library.json"
    if default.exists():
        return default
    raise FileNotFoundError(
        f"颜色库快照不存在: {default}（可用 publish_checkpoint.py --colors 生成，"
        "或设置 CODE_LIBRARY_PATH 指向含 [{\"code\": ...}] 的 JSON）"
    )


@lru_cache(maxsize=1)
def load_library() -> list[dict]:
    path = _resolve_path()
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def load_codes() -> list[str]:
    codes = sorted({e.get("code") for e in load_library() if e.get("code")})
    return codes
