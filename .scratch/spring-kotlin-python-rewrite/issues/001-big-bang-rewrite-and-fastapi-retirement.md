---
id: 001
title: 一次性重写与旧 FastAPI 退役边界
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

本次重构是否采用一次性重写，以及旧 FastAPI backend 在重写完成后的处理方式？

## Resolution

采用一次性重写，不迁移旧业务数据，不保留旧 HTTP 契约或兼容层。Spring Boot + Kotlin 接管全部对外 API、业务和数据库职责；旧 FastAPI runtime、SQLAlchemy、Alembic、旧 API 和不再使用的处理流程在迁移完成后删除。训练数据、标注数据、模型 checkpoint、测试图片和基准数据保留。
