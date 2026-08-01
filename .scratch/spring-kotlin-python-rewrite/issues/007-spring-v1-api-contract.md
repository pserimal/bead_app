---
id: 007
title: Spring Boot `/api/v1` 对外 DTO 与错误契约
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

为 RecognitionJob、Blueprint、Cell、ColorLibrary、历史筛选、追踪查询定义完整的 `/api/v1` 资源、请求/响应 DTO、分页字段、状态过滤和结构化错误响应，使 React 与 Spring 可以独立实现并测试。

## Resolution

（用户已认可资源拓扑；以下为完整契约）

### 资源与 URL

```
POST   /api/v1/jobs                    创建识别任务（multipart）
GET    /api/v1/jobs                    任务历史列表（分页 + status 筛选）
GET    /api/v1/jobs/{id}               任务详情（进度、阶段、快照、错误）
GET    /api/v1/jobs/{id}/events        只读追踪事件流（分页，按 sequence 升序）
GET    /api/v1/blueprints              图纸列表（摘要，分页）
GET    /api/v1/blueprints/{id}         图纸详情（cells 内嵌返回）
GET    /api/v1/blueprints/{id}/image   原图（Spring 存储的原始上传）
GET    /api/v1/colors                  颜色库列表（分页 + q 前缀搜索）
GET    /api/v1/colors/{code}           单个颜色
```

Cell 不单独暴露资源；事件是 Job 的子资源而非顶层资源；颜色库首版只读（seed 资源 + 快照，无写接口）。

### 通用约定

- 所有字段 camelCase；时间 ISO-8601 UTC（`2026-07-12T08:00:00Z`）。
- 分页请求：`page`（1 起，默认 1）、`pageSize`（默认 20，上限 100）、`sortBy`（白名单字段，默认 `createdAt`）、`sortDir`（`asc`/`desc`，默认 `desc`）。
- 分页响应信封：`{ "items": [...], "page": 1, "pageSize": 20, "total": 137, "totalPages": 7 }`。

### 错误契约

所有非 2xx 响应统一形状：

```json
{
  "code": "JOB_NOT_FOUND",
  "message": "识别任务不存在",
  "details": { "jobId": "..." },
  "traceId": "..."
}
```

- 400 `INVALID_IMAGE` / `INVALID_CROP_BOX`（裁剪框越界或非法）/ `INVALID_CODE_FORMAT` / `INVALID_JOB_STATUS`
- 404 `JOB_NOT_FOUND` / `BLUEPRINT_NOT_FOUND` / `COLOR_NOT_FOUND`
- 409 `JOB_ALREADY_TERMINAL`（对已终态任务的重试等操作）
- 413 `FILE_TOO_LARGE`（> 20MB）；415 `UNSUPPORTED_MEDIA_TYPE`（非 JPEG/PNG）
- 422 `VALIDATION_ERROR`（字段级，`details.fields` = `{ "field": ["message"] }`）
- 500 `INTERNAL_ERROR`

### 创建任务 `POST /api/v1/jobs`（multipart/form-data）

- `image`：文件，JPEG/PNG，≤ 20MB
- `cropBoxX` / `cropBoxY` / `cropBoxWidth` / `cropBoxHeight`：原图像素坐标整数，须在图像边界内
- `rows` / `cols`：整数 1..500
- `codes`：可选 JSON 字符串数组（图纸级编码，如 `["A01","B12"]`）；服务端统一转大写，非法格式 → 422

响应 202 `JobDetail`（创建即入队，状态 `PENDING`）。

### JobDetail

```json
{
  "id": "uuid",
  "status": "PROCESSING",
  "stage": "QUEUED|OCR",
  "processedCells": 12, "totalCells": 841,
  "heartbeatAt": "...",
  "attempt": 0, "maxRetries": 2,
  "retryCount": 0,
  "blueprintId": null,
  "error": null | { "code": "...", "message": "..." },
  "warnings": [{ "code": "UNMAPPED_COLOR", "row": 1, "col": 2, "detail": "编码 B99 不在颜色库" }],
  "snapshot": { "model": "crnn_v2.pt", "colorLibraryVersion": "seed-2026-07-12" },
  "createdAt": "...", "updatedAt": "..."
}
```

`GET /api/v1/jobs` 支持 `status` 过滤（枚举之一，可多值逗号分隔）与分页；列表项为摘要（无 `error`/`warnings`/`snapshot` 细节）。

### 事件流 `GET /api/v1/jobs/{id}/events`

只读、分页、按 `(attempt, sequence)` 升序；每项：

```json
{ "attempt": 0, "sequence": 5, "type": "CELL_PROCESSED",
  "timestamp": "...", "payload": { "row": 1, "col": 2, "code": "A01", "status": "MAPPED" } }
```

type 枚举：`JOB_STARTED`、`CELL_PROCESSED`、`CELL_FAILED`、`HEARTBEAT`、`RETRY_SCHEDULED`、`JOB_SUCCEEDED`、`JOB_FAILED`。

### Blueprint

列表项（摘要，无 cells）：`{ "id", "jobId", "rows", "cols", "createdAt" }`。

详情 `GET /api/v1/blueprints/{id}`（cells 内嵌，一次拿全）：

```json
{
  "id": "uuid", "jobId": "uuid", "rows": 29, "cols": 29,
  "validCodes": ["A01", "B12"],
  "cells": [
    { "row": 1, "col": 1, "code": "A01", "status": "MAPPED",
      "color": { "code": "A01", "name": "White", "hex": "FFFFFF" } }
  ],
  "createdAt": "..."
}
```

- Cell `status`：`MAPPED` / `UNMAPPED`（编码合法但不在颜色库快照内）；`UNMAPPED` 时 `color` 为 `null`。
- `color` 是任务创建时的颜色库快照（005 决议），不是实时外键。

### 颜色库

`GET /api/v1/colors?q=A&page=1&pageSize=100`：`q` 为 code 前缀搜索；列表项与详情均为 `{ "code", "name", "hex" }`。`GET /api/v1/colors/{code}` 不存在时 404 `COLOR_NOT_FOUND`。

### 实现与测试约定

React 与 Spring 按此契约独立实现：前端类型定义在 `frontend/src/types/api.ts`，Spring 侧以契约测试（MVC MockMvc + jsonPath）锁定 DTO 形状，防止漂移。
