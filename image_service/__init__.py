"""Python image-service — 内部 CRNN 识别服务（002/009 决议）。

仅供 Spring Boot 调用：接收 multipart 任务 → ocr_core 推理 → 逐 cell 回调。
不依赖旧 backend，不暴露宿主机端口。
"""

__version__ = "0.1.0"
