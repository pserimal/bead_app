---
id: 009
title: Python CRNN 内部任务与逐 Cell 事件契约
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: [007, 008]
assignee: assistant
---

## Question

定义 Spring Boot 提交到 Python 的 multipart 任务请求、Python 返回的 accepted 响应、固定回调地址、逐 Cell 进度事件、heartbeat、完成/失败事件、ACK、sequence、attempt 和至少一次投递的精确协议。

## Resolution

（基于 002 服务边界、004 生命周期、005 数据归属、007 外部契约、008 持久化规则）

### 传输与端点

- Spring → Python：`POST {python}/v1/tasks`（multipart/form-data），Python 仅监听 Docker 内部网络，不暴露宿主机。
- Python → Spring：单一固定回调地址 `POST {callbackUrl}/internal/jobs/{jobId}/events`，`callbackUrl` 由 Spring 在任务请求中携带（Compose 内为 `http://spring-boot:8080`），事件均为 JSON（camelCase）。
- 颜色映射的唯一权威是 Spring：Python 只返回 OCR 原始结果 `code`，`MAPPED/UNMAPPED` 判定与颜色快照回填全部在 Spring 应用事件时完成（008 `recognition_job_cell` 的 color 列）。

### 任务请求（multipart）

```
jobId: uuid                     # 幂等主键
attempt: int                    # 当前尝试号（重试时 Spring +1 重新提交）
image: file                     # JPEG/PNG，≤ 20MB
cropBox: json                   # {"x":int,"y":int,"width":int,"height":int} 原图像素
rows: int, cols: int
validCodes: json | null         # 图纸级编码快照（大写数组），Python 不校验内容
callbackUrl: string             # Spring 内部回调基址
```

响应：`202 { "taskId": uuid }`；校验失败 `400/422`（Spring 视为本轮失败，走 008 恢复/重试逻辑，不重试请求本身）。

### 事件协议（回调）

请求体：

```json
{ "jobId": "uuid", "attempt": 0, "sequence": 12, "type": "CELL_PROCESSED",
  "timestamp": "ISO-8601", "payload": { "row": 1, "col": 2, "code": "A01" } }
```

- `sequence`：Python 在**发送前**为每个生成事件分配，按 (jobId, attempt) 从 1 单调递增；**重传复用同一 sequence**——这是幂等键，Spring 依 `UNIQUE(job_id, attempt, sequence)` 去重（008）。
- `type` 枚举同 007：`JOB_STARTED`、`CELL_PROCESSED`、`CELL_FAILED`、`HEARTBEAT`、`JOB_SUCCEEDED`、`JOB_FAILED`（`RETRY_SCHEDULED` 仅 Spring 内部写）。
- `CELL_PROCESSED.payload`：`{ row, col, code }`（code 已大写，格式由 Spring 校验）。`CELL_FAILED.payload`：`{ row, col, reason }`。`JOB_SUCCEEDED.payload`：`{ processedCells, unmappedCells? }` 摘要。`JOB_FAILED.payload`：`{ code, message }`。
- 事件按 `(attempt, sequence)` 升序发送，`sequence` 不要求连续（Spring 不做乱序检测；进度只按已应用计数）。

### ACK 与至少一次投递

- Spring 对已应用或幂等去重的事件回 `202`；对 `attempt < job.attempt` 的过期事件回 `202` 但不应用（no-op，让 Python 停止重传）；对已终态任务的事件回 `409`（Python 视作已送达，停止发送）；其他 5xx 视为可重试。
- Python 对非 2xx/超时按指数退避重试：1s、2s、4s、8s、16s（同事件最多 5 次重试，共用同一 sequence）；耗尽后 Python 停止该任务的一切发送并删除临时文件，交由 Spring 的 stale 心跳恢复（008，90s 无事件 → 新 attempt 重派）。

### Heartbeat

- Python 每 30s 内若无其他事件发出，发送 `HEARTBEAT` 事件（payload 空或 `{processedCells}`）；Spring 每次事件应用都刷新 `heartbeat_at`（008）。

### 终态与校验

- Python 发完所有 cell 事件（全部 ACKed）后发 `JOB_SUCCEEDED`；任何永久性失败发 `JOB_FAILED`。
- Spring 收到 `JOB_SUCCEEDED` 时校验 `processed_cells == total_cells`：不一致 → 回 `400 INVALID_EVENT` 且不应用（Python 收到 400 即放弃，交恢复循环）；一致 → 按 008 原子创建 Blueprint。
- `attempt` 语义：Python 每次接收任务都重置自己的 sequence 计数；旧 attempt 残留事件按上述规则被 no-op 掉，cell 结果以新 attempt 的为准（PK 覆盖，008）。

### 临时文件生命周期

- Python 保存 image 到本地临时目录，任务结束（成功/失败/放弃）后删除；不持久化任何任务状态——重派时全新处理。

### 实现约定

- Spring 侧为内部回调注册独立 router（`/internal/**`），与对外 `/api/v1` 隔离且不经过网关；契约测试锁定事件 JSON 形状。
- Python 侧事件发送器为独立模块，可单测（背压、退避、sequence 分配）。
