---
id: 013
title: Docker Compose 服务拓扑、健康检查与恢复
labels: [wayfinder:research]
state: closed
parent: 000
blocked_by: [008, 009, 010]
assignee: researcher-compose
---

## Question

确定 frontend、Spring Boot、Python FastAPI、PostgreSQL、模型 artifact 和图片 volume 在 Docker Compose 中的运行拓扑、健康/就绪检查、启动顺序、Python 重启后的任务恢复和本地开发覆盖方式。

## Resolution

（由 `/research` subagent 调查，详见 `research/013-brief.md`；web 工具不可用，最佳实践主张需在实现时验证）

### 拓扑（3 服务，1 个对外端口）

- `postgres`（postgres:16-alpine，版本 pin）：仅 internal 网络，不发布宿主机端口；数据卷持久化。
- `spring-boot`：唯一对外 HTTP 服务，发布 :8080；数据源指向 internal 网络内的 postgres。
- `python-crnn`：内部 FastAPI，永不发布端口（002）；无 DB 访问（005）；模型 artifact 只读挂载（010）。
- 双网络：`frontend`（仅 spring）+ `internal`（postgres + python + spring 后端流量）。

### 健康检查

- postgres：`pg_isready`（5s 间隔 / 3s 超时 / 10 重试 / 10s start_period）。
- spring-boot：actuator `/actuator/health` grep `"status":"UP"`（10s/5s/12/60s）；DataSource contributor 使其成为 Flyway+DB 就绪闸门。
- python-crnn：`/health` grep `"model_ready":true` + `/health/model` 元数据端点（10s/5s/6/60s，容忍 torch 冷启动）。

### 启动顺序与依赖

- 单向闸门：spring 依赖 `postgres: service_healthy`；python 依赖 `spring-boot: service_started`（软依赖）。
- Spring 不依赖 python healthy：008 的 90s stale 心跳扫描 + 最多 2 次重试已使 Spring 对 python 宕机具备韧性，硬闸门只会拖慢冷启动。

### 恢复

- 全部 `restart: unless-stopped`；`depends_on` 只是启动顺序闸门，不是监督者——运行时恢复归 004/008/009 协议（扫描重派、`jobId+attempt+sequence` 幂等、1s..16s 回调退避）。
- 容器失败矩阵（postgres 重启 → 连接池重连、spring 重启 → 启动扫描恢复 PROCESSING 任务、python 重启 → 无状态天然可重启）详见 brief。

### 反模式移除

- 硬编码 `admin:123456` → 环境变量注入；不发布 5432/8000；去掉 `./backend:/app` + `--reload`；postgres 版本 pin；补 `restart`、`start_period`；拆分网络。

### 本地开发

- 前端宿主机 :5173（CORS 环境变量可配）；模型 artifact 以 `MODEL_ARTIFACT_HOST_DIR` bind `:ro`（dev → `./training/checkpoints`）；dev override 发布 5432/8000。
