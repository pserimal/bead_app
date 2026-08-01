"""FastAPI 入口 — 009 协议：`POST /v1/tasks` 接收任务，`/health` 就绪检查。

仅监听 Docker 内部网络（013 决议），不暴露宿主机端口。
"""

from __future__ import annotations

import json
import logging
import uuid

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from image_service.app import config, worker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("image_service")

app = FastAPI(title="bead image-service", version="0.1.0")


@app.get("/health")
def health() -> dict:
    h = worker.health()
    return JSONResponse(status_code=200 if h["model_ready"] else 503, content=h)


@app.get("/health/model")
def health_model() -> dict:
    h = worker.health()
    return JSONResponse(status_code=200 if h["model_ready"] else 503, content=h)


@app.post("/v1/tasks", status_code=202)
async def create_task(
    jobId: str = Form(...),
    attempt: int = Form(0),
    image: UploadFile = File(...),
    cropBox: str = Form(...),
    rows: int = Form(...),
    cols: int = Form(...),
    validCodes: str | None = Form(None),
    callbackUrl: str = Form(config.DEFAULT_CALLBACK_BASE),
) -> dict:
    """009：Spring → Python 任务提交（multipart）。返回 202 {taskId}。"""
    try:
        crop = json.loads(cropBox)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="cropBox 非法 JSON")  # noqa: B904
    codes: list[str] | None = None
    if validCodes:
        try:
            parsed = json.loads(validCodes)
            codes = [str(c).upper() for c in parsed] if isinstance(parsed, list) else None
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="validCodes 非法 JSON")  # noqa: B904

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="image 为空")

    task_id = worker.submit_task(
        job_id=jobId,
        attempt=attempt,
        image_bytes=image_bytes,
        crop_box=crop,
        rows=rows,
        cols=cols,
        valid_codes=codes,
        callback_base=callbackUrl,
    )
    log.info("[api] accepted task %s (%d bytes)", task_id, len(image_bytes))
    return {"taskId": task_id}
