---
id: 004
title: RecognitionJob 异步进度与追踪生命周期
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

识别任务、进度、部分 Cell 失败、追踪和 Blueprint 的生命周期如何建模？

## Resolution

RecognitionJob 与 Blueprint 分开建模。Spring Boot 创建和编排异步任务，Python 每处理一个 Cell 通过固定回调地址发送至少一次事件；Spring 以 `jobId + attempt + sequence` 幂等处理。任务保存阶段、`processedCells/totalCells`、事件、单元格级结果、模型/输入快照、心跳和重试信息。状态为 `PENDING`、`PROCESSING`、`SUCCEEDED`、`SUCCEEDED_WITH_WARNINGS`、`FAILED`；只有任务完成后才创建 Blueprint。处理中不展示半成品棋盘，但历史页展示任务和只读追踪信息。首版支持 stale 心跳恢复和最多两次自动重试，不支持用户取消。
