# ── Python image-service（内部 CRNN 推理，002/009/013）──
# 构建上下文 = 仓库根（compose 中 context: . dockerfile: image_service/Dockerfile），
# 以便复制顶层 ocr_core 共享核心。
FROM python:3.11-slim

WORKDIR /app

# 系统依赖：OpenCV 需要 libgl 等
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Python 依赖（torch CPU 版，镜像较小）
COPY image_service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

# 服务代码（image_service 包）
COPY image_service/__init__.py ./image_service/__init__.py
COPY image_service/app ./image_service/app

# ocr_core 共享核心（010：推理服务依赖的共享模块）
COPY ocr_core ./ocr_core

# 颜色库快照（010 R3）
COPY artifacts/colors/library.json ./artifacts/colors/library.json

# 模型 artifact 只读挂载点（010 R3 / 013：compose 从宿主机挂载 :ro）
ENV MODEL_ARTIFACT_DIR=/models \
    CODE_LIBRARY_PATH=/app/artifacts/colors/library.json \
    CALLBACK_BASE_URL=http://spring-boot:8080 \
    TMP_DIR=/tmp/image_service

EXPOSE 8001
CMD ["uvicorn", "image_service.app.main:app", "--host", "0.0.0.0", "--port", "8001"]
