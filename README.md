# 🧩 拼豆助手

拼豆助手是一个拼豆图案识别应用。用户上传拼豆图纸图片，框选网格区域、设置行列数；系统对每个格子做 OCR（CRNN 模型）识别编码，对照 Perler 颜色库生成可读的拼豆图纸。

## 功能特性

- 🖼️ 单裁剪上传：图片 + 裁剪框 + 行列数（裁剪框支持拖拽缩放/键盘微调/数值输入）
- 🔤 CRNN 逐格 OCR：识别格子内印刷的字母数字编码（如 H7、F2、C21）
- 🎨 颜色库映射：65 色 Perler 快照，UNMAPPED 编码明确标注
- 📋 识别任务追踪：异步任务、实时进度、事件时间线、心跳与自动重试
- 🔍 任务历史 + 图纸详情（只读棋盘 + 颜色图例）

## 架构

```
[ React/Vite :5173 ]  ──/api/v1──▶  [ Spring Boot + Kotlin :8080 ]  ──▶  [ PostgreSQL ]
                                        │ POST /v1/tasks (multipart)
                                        ▼
                              [ Python image_service :8001 (internal) ]
                                        │  [ ocr_core/ 共享推理核心 ]
                                        └── 逐 cell 回调事件 ──▶ Spring（幂等应用）
```

- **server/** — Spring Boot + Kotlin（JDK 21）：对外 API、任务编排、事件幂等、蓝图生成（008）
- **image_service/** — 内部 Python FastAPI：CRNN 推理 + 逐 cell 回调（009）
- **ocr_core/** — 共享 OCR 核心：CRNN 架构、checkpoint 校验、推理、字符表（010）
- **frontend/** — React + TypeScript + Vite
- **training/** — CRNN 训练 + 数据标注 + 模型发布

## 技术栈

### 后端
- **Spring Boot 3.3** + **Kotlin** (JDK 21) — API + 编排
- **Spring Data JPA** + **PostgreSQL 16** + **Flyway** — 持久化
- **Python FastAPI** (uvicorn) — 内部识别服务
- **PyTorch** — CRNN 推理（CPU）

### 前端
- **React 19** + **TypeScript**
- **Vite** — 构建工具
- **TanStack React Query** — 数据请求（2s 轮询）
- **Tailwind CSS v4** — 样式
- **Vitest** — 单元测试

## 前置要求

- JDK 21 + Gradle 8.10（`server/`）
- Python 3.10+（torch、opencv、fastapi — `image_service/requirements.txt`）
- Node.js ≥ 18（`frontend/`）
- PostgreSQL 16（远程 `192.168.5.88` 或 docker compose）

## 快速开始

### 1. 启动后端（server，:8080）

```bash
cd server && gradle test --no-daemon   # 9 个契约测试
cd server && gradle bootJar --no-daemon
java -jar build/libs/bead-server-0.1.0.jar
```

数据库连接在 `server/src/main/resources/application.yml`（默认远程 `192.168.5.88:5432`，可用 `SPRING_DATASOURCE_URL` 等 env 覆盖）；Flyway 启动时自动迁移。

### 2. 启动 Python image-service（:8001，内部）

```bash
MODEL_ARTIFACT_DIR=artifacts/models/current \
  python -m uvicorn image_service.app.main:app --host 127.0.0.1 --port 8001
```

模型 artifact 由 `training/scripts/publish_checkpoint.py` 发布；`artifacts/models/current` 指向启用版本。

### 3. 启动前端（:5173）

```bash
cd frontend && npm install && npm run dev
```

### 4. 访问应用

- 前端: http://localhost:5173
- API: http://localhost:8080/api/v1

### 5. Docker Compose（013 三服务）

```bash
cp .env.example .env
docker compose up -d --build            # postgres + spring + python（:8080 对外）
```

## 项目结构

```
ai_dou/
├── server/              # Spring Boot + Kotlin API（:8080）
├── image_service/       # 内部 Python CRNN 服务（:8001）
├── ocr_core/            # 共享 OCR 核心（训练/推理共用）
├── frontend/            # React + Vite SPA（:5173）
├── training/            # CRNN 训练 + 数据标注 + 模型发布
├── artifacts/           # 模型 artifact + 颜色库快照
├── docker-compose.yml   # 三服务拓扑
└── docs/                # 项目文档
```

## 识别流程（一次上传）

1. 前端上传图片 + 裁剪框 + 行列数 → `POST /api/v1/jobs`（202）
2. Spring 保存原图，创建任务（PENDING），异步派发 Python
3. Python 用 CRNN 逐格识别 → 逐 cell 回调 `CELL_PROCESSED`
4. Spring 幂等应用事件，更新进度；前端 2s 轮询展示
5. 全部完成 → `JOB_SUCCEEDED` 原子生成 Blueprint → 前端查看只读图纸

详细协议（事件、重试、恢复、错误码）见 `.scratch/spring-kotlin-python-rewrite/` 决策记录与 `CLAUDE.md`。

## 数据库配置

默认连接配置（开发环境，可用 env 覆盖）:
- 用户名: `admin` / 密码: `123456`
- 数据库: `bead_app`（测试库 `bead_app_test`）
- 主机: `192.168.5.88:5432`（compose 内为 `db:5432`）
