"""服务配置 — 全部来自环境变量（013 决议：Compose 注入）。"""

from __future__ import annotations

import os
from pathlib import Path

# 模型 artifact 目录（010 R3）：含 model.pt / charset.json / code_dict.json
MODEL_ARTIFACT_DIR = os.environ.get("MODEL_ARTIFACT_DIR", "artifacts/models/current")

# 颜色库快照（010 R3）
CODE_LIBRARY_PATH = os.environ.get("CODE_LIBRARY_PATH", "artifacts/colors/library.json")

# 置信度阈值（011 F1 修复后语义：平均每步 log-prob）
OCR_MIN_CONF = float(os.environ.get("OCR_MIN_CONF", "0.0"))

# 默认回调基址（Spring 内部；任务请求可覆盖）
DEFAULT_CALLBACK_BASE = os.environ.get("CALLBACK_BASE_URL", "http://localhost:8080")

# 心跳间隔（009：每 30s 无其他事件则发 HEARTBEAT）
HEARTBEAT_INTERVAL_S = float(os.environ.get("HEARTBEAT_INTERVAL_S", "30"))

# 回调重试（009：1s..16s 指数退避，最多 5 次）
CALLBACK_RETRIES = int(os.environ.get("CALLBACK_RETRIES", "5"))

# 临时文件目录
TMP_DIR = Path(os.environ.get("TMP_DIR", "image_service_tmp"))
