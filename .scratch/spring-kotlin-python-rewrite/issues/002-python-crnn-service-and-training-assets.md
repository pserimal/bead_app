---
id: 002
title: Python CRNN 内部服务与训练资产边界
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

Python 图像处理、CRNN 推理和训练资产在新系统中的服务边界是什么？

## Resolution

Python 保留为只供 Spring Boot 调用的内部 FastAPI 服务，只保留 CRNN 推理。训练数据、标注、训练脚本和 checkpoint 继续作为独立 Python 离线能力保留；训练和推理共享一个独立 OCR 核心模块，但推理服务不依赖旧 backend 或训练脚本。EasyOCR、PaddleOCR、模板匹配和 DeepSeek-OCR 删除。
