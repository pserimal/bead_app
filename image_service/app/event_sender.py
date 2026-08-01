"""事件发送器 — 009 协议：至少一次投递 + 指数退避重试。

- sequence 在发送前分配，重传复用同一 sequence（幂等键）；
- 非 2xx/超时按 1s,2s,4s,8s,16s 退避（最多 CALLBACK_RETRIES 次）；
- 409（终态拒绝）视为已送达，停止重传；
- 400 视为事件非法，停止重传（交由 Spring 恢复循环）。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import requests

from image_service.app import config

log = logging.getLogger(__name__)

_LOCK = threading.Lock()
# (job_id, attempt) → 下一可用 sequence（009：从 1 单调递增）
_SEQUENCES: dict[tuple[str, int], int] = {}


def _next_sequence(job_id: str, attempt: int) -> int:
    key = (job_id, attempt)
    with _LOCK:
        seq = _SEQUENCES.get(key, 1)
        _SEQUENCES[key] = seq + 1
        return seq


def send_event(
    callback_base: str,
    job_id: str,
    attempt: int,
    seq: int | None,
    event_type: str,
    payload: dict[str, Any],
) -> bool:
    """发送一个事件，带退避重试。返回是否成功送达（或视为已送达）。"""
    url = f"{callback_base.rstrip('/')}/internal/jobs/{job_id}/events"
    body = {
        "jobId": job_id,
        "attempt": attempt,
        "sequence": seq if seq is not None else _next_sequence(job_id, attempt),
        "type": event_type,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "payload": payload,
    }
    delay = 1.0
    for attempt_no in range(config.CALLBACK_RETRIES + 1):
        try:
            resp = requests.post(url, json=body, timeout=10)
            if resp.status_code < 300:
                return True
            if resp.status_code == 409:
                log.info("[event] %s seq=%s → 409 终态，视为已送达", event_type, body["sequence"])
                return True
            if resp.status_code == 400:
                log.warning("[event] %s seq=%s → 400 非法事件，放弃重传", event_type, body["sequence"])
                return False
            log.warning("[event] %s seq=%s → HTTP %s，退避 %.1fs", event_type, body["sequence"], resp.status_code, delay)
        except requests.RequestException as e:
            log.warning("[event] %s seq=%s → %s，退避 %.1fs", event_type, body["sequence"], e, delay)
        if attempt_no < config.CALLBACK_RETRIES:
            time.sleep(delay)
            delay = min(delay * 2, 16.0)
    log.error("[event] %s seq=%s 重试耗尽，放弃（交由 Spring 恢复）", event_type, body["sequence"])
    return False
