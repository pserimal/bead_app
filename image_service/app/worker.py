"""任务 worker — 009 协议：处理 multipart 任务，逐 cell 回调。

流程：
1. 接收任务（jobId / attempt / image / cropBox / rows / cols / validCodes / callbackUrl）；
2. ocr_core 推理（include_all=True：所有 cell 都返回，UNMAPPED 判定在 Spring）；
3. 逐 cell 发 CELL_PROCESSED（sequence 从 1 递增，09 协议）；
4. 处理期间每 HEARTBEAT_INTERVAL_S 发 HEARTBEAT；
5. 全部完成 → JOB_SUCCEEDED；异常 → JOB_FAILED；
6. 删除临时文件（005：Python 只保留临时副本）。
"""

from __future__ import annotations

import json
import logging
import tempfile
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from image_service.app import config
from image_service.app.event_sender import send_event

log = logging.getLogger(__name__)

_ACTIVE: set[str] = set()
_ACTIVE_LOCK = threading.Lock()

_MODEL = None
_MODEL_CHARS: list[str] = []


def load_model() -> tuple[object, list[str]]:
    """懒加载模型（010 R3：MODEL_ARTIFACT_DIR 指向 artifact 目录）。"""
    global _MODEL, _MODEL_CHARS
    if _MODEL is not None:
        return _MODEL, _MODEL_CHARS
    from ocr_core.bead_ocr_crnn import load_checkpoint

    artifact = Path(config.MODEL_ARTIFACT_DIR)
    model_pt = artifact if artifact.is_file() else artifact / "model.pt"
    if not model_pt.exists():
        raise FileNotFoundError(f"model artifact not found: {model_pt}（检查 MODEL_ARTIFACT_DIR）")
    _MODEL, _MODEL_CHARS = load_checkpoint(model_pt, device="cpu")
    log.info("[model] loaded %s (%d chars)", model_pt, len(_MODEL_CHARS))
    return _MODEL, _MODEL_CHARS


def health() -> dict:
    try:
        load_model()
        return {"status": "UP", "model_ready": True, "model_chars": len(_MODEL_CHARS)}
    except Exception as e:  # noqa: BLE001
        return {"status": "DOWN", "model_ready": False, "error": str(e)}


def submit_task(
    job_id: str,
    attempt: int,
    image_bytes: bytes,
    crop_box: dict,
    rows: int,
    cols: int,
    valid_codes: list[str] | None,
    callback_base: str,
) -> str:
    """异步处理任务（后台线程）。返回 taskId。"""
    task_id = f"{job_id}-a{attempt}"
    with _ACTIVE_LOCK:
        if task_id in _ACTIVE:
            return task_id  # 幂等：同任务重复提交直接返回
        _ACTIVE.add(task_id)

    def run() -> None:
        try:
            _process(job_id, attempt, image_bytes, crop_box, rows, cols, valid_codes, callback_base)
        finally:
            with _ACTIVE_LOCK:
                _ACTIVE.discard(task_id)

    threading.Thread(target=run, daemon=True, name=f"task-{task_id[:8]}").start()
    return task_id


def _process(
    job_id: str,
    attempt: int,
    image_bytes: bytes,
    crop_box: dict,
    rows: int,
    cols: int,
    valid_codes: list[str] | None,
    callback_base: str,
) -> None:
    tmp_path: Path | None = None
    try:
        model, chars = load_model()
        from ocr_core.inference import ocr_cells_from_crop

        # 005：临时副本，处理完删除
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            f.write(image_bytes)
            tmp_path = Path(f.name)
        img = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            send_event(callback_base, job_id, attempt, None, "JOB_FAILED",
                       {"code": "IMAGE_DECODE_FAILED", "message": "无法解码图片"})
            return

        bbox = (crop_box.get("x", 0), crop_box.get("y", 0),
                crop_box.get("width", 0), crop_box.get("height", 0))
        log.info("[task] %s attempt=%d %dx%d bbox=%s cells=%d", job_id, attempt, rows, cols, bbox, rows * cols)

        # include_all=True：所有 cell 都回传（含低置信度/OOD），UNMAPPED 判定在 Spring
        results = ocr_cells_from_crop(
            img, rows, cols, bbox,
            valid_codes=set(valid_codes) if valid_codes else None,
            min_conf=config.OCR_MIN_CONF,
            include_all=True,
        )
        log.info("[task] %s decoded %d/%d cells", job_id, len(results), rows * cols)

        # 逐 cell 回调（sequence 自动递增）+ 周期心跳
        sent = 0
        last_beat = time.monotonic()
        for r in range(rows):
            for c in range(cols):
                code, conf = results.get((r, c), ("", 0.0))
                ok = send_event(callback_base, job_id, attempt, None, "CELL_PROCESSED",
                                {"row": r, "col": c, "code": code.upper() if code else "",
                                 "confidence": round(float(conf), 4)})
                if not ok:
                    log.warning("[task] %s cell(%d,%d) 回调失败，中止", job_id, r, c)
                    return
                sent += 1
                if time.monotonic() - last_beat >= config.HEARTBEAT_INTERVAL_S:
                    send_event(callback_base, job_id, attempt, None, "HEARTBEAT",
                               {"processedCells": sent})
                    last_beat = time.monotonic()

        send_event(callback_base, job_id, attempt, None, "JOB_SUCCEEDED",
                   {"processedCells": sent, "totalCells": rows * cols})
        log.info("[task] %s done, %d cells", job_id, sent)
    except Exception as e:  # noqa: BLE001
        log.exception("[task] %s failed", job_id)
        send_event(callback_base, job_id, attempt, None, "JOB_FAILED",
                   {"code": "OCR_ERROR", "message": str(e)[:500]})
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
