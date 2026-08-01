# 实现进度记录（地图完成后）

> 地图（000）已关闭后开始实施。本文件跟踪 `server/`（Spring Boot + Kotlin）的实现状态，对应 014 退役清单的阶段 1 起。

## 已完成（2026-07-31/08-01 会话）

### 工具链（本机，Windows 侧）
- conda env `bead-java`：**JDK 21.0.10 LTS** + Gradle 8.10.2 + PostgreSQL 18.4（本地临时，已弃用）
- **数据库：远程 `192.168.5.88:5432`（PostgreSQL 16.13），账号 admin / 密码 123456**
  - `bead_app`：生产库，旧 FastAPI 表已按用户确认清空（选项 3），Flyway V1 重建 6 表 + 65 色 seed（version=seed-1）
  - `bead_app_test`：测试库，Flyway 建表，契约测试使用
  - 注意：WSL 网络不通，服务/构建/psql 全走 Windows 侧
- 构建命令（WSL 下）：`cd server && cmd.exe /c "E:\devtools\conda\envs\bead-java\Library\bin\gradle.bat clean build test --no-daemon"`（JAVA_HOME 指向 bead-java）；`gradlew` 已生成

### server/ 工程（Kotlin + Spring Boot 3.3.5）
- **007 契约**：`/api/v1/jobs`（POST multipart 创建 202 / GET 列表分页+status 筛选 / GET {id} / GET {id}/events 只读事件流）、`/api/v1/blueprints`（列表/详情 cells 内嵌/image）、`/api/v1/colors`（列表 q 前缀 / {code}）——全部按契约实现
- **008 schema**：Flyway V1（6 表 + 索引 + CHECK 约束），JPA 实体 + 复合主键 IdClass
- **008 事务规则**：`(job_id, attempt, sequence)` 幂等去重、过期 attempt no-op、终态 409、JOB_SUCCEEDED 原子创建 Blueprint 并回填 blueprint_id、JOB_FAILED 未达上限自动重试（attempt+1）、stale 心跳恢复扫描（启动 + 30s 周期，90s 阈值）
- **009 回调**：`POST /internal/jobs/{id}/events` 入站事件处理器（与对外 /api/v1 隔离）
- **005 seed**：65 色颜色库从 `default_colors.json`（复制自旧 backend）幂等 seed，version=seed-1；原图存储 `./uploads`（StorageService）
- **错误契约**：全局异常处理器，统一 `{code, message, details, traceId}` 形状

### 测试与验证
- **9/9 契约测试通过**（MockMvc + jsonPath）：创建 202、分页信封、status 筛选、详情快照、事件流升序、逐 cell 幂等、SUCCEEDED 原子建蓝图（含 UNMAPPED）、终态 409、404/400 错误形状、颜色查询
- **端到端冒烟通过**（真实服务 :8080）：创建任务 → 4 cell 回调 → SUCCEEDED_WITH_WARNINGS → 蓝图详情（Z99 UNMAPPED、H1/H2/H3 颜色快照）→ 事件流 6 条 → 404 错误形状
- **浏览器全流程测试通过**（chrome-devtools，前端 :5173 + 后端 :8080 + 远程库）：
  - 上传页：选图（7.3MB）不自动识别、裁剪框、90×158 行列、编码校验 → 创建任务跳转追踪页
  - 追踪页：PENDING→PROCESSING→SUCCEEDED_WITH_WARNINGS，React Query 2s 轮询进度 0→14220（4% 实测），心跳时间更新，502+ 事件时间线，终态出现「查看图纸」
  - 蓝图页：棋盘豆粒渲染（含 `?` 斜纹 UNMAPPED）、警告横幅（(2,1) Z99）、颜色图例 + UNMAPPED 条目
  - 历史页：3 任务列表、状态徽章、分页、状态筛选（排队中→1 条）
  - 颜色库：65 色网格 + 前缀搜索（H10→Burgundy）
  - 控制台 0 错误 0 警告

### 前端适配（新 /api/v1 契约）
- 重写 `frontend/src/api/{client,jobs,blueprints,colors}.ts` + `types/api.ts` + hooks；4 页面重写（Upload/History/JobDetail/BlueprintDetail/ColorLibrary），新增 `/jobs/:id` 路由；vite 代理 → :8080
- 环境坑：Windows `NODE_ENV=production` 导致 npm 跳过 devDependencies（需 `set NODE_ENV=development` 或 `--include=dev`）
- 配置坑：application.yml 曾被外部改坏（multipart 配置错位到 bead.servlet.multipart、port 8787）→ 已修复为 spring.servlet.multipart + 8080

## 待办（下一步）

- [x] **014 阶段 1：ocr_core 包迁移（训练侧）**（2026-08-01 完成）
- [x] **009 反向：Spring → Python 任务调度器 + Python image-service**（2026-08-01 完成）
- [x] **014 阶段 2-4：依赖清理、旧 backend 删除、回归验证**（2026-08-01 完成）
- [x] **docker-compose（013）**（2026-08-01 完成，见下方「013 compose 记录」）
- [ ] 提交 git（server/、ocr_core/、image_service/、backend 删除、文档更新）

## 013 compose 记录（2026-08-01）

- `docker-compose.yml`：3 服务 1 对外端口（spring :8080）；双网络（frontend 仅 spring / internal 全内）；postgres:16-alpine 版本 pin + pg_isready 健康检查；spring actuator /actuator/health 检查（60s start_period）；python /health model_ready 检查（60s 容忍 torch 冷启动）；单向依赖闸门（spring→db healthy，python→spring started）；全部 unless-stopped；凭据 .env 注入（DB_USER/DB_PASSWORD/DB_NAME）；模型 artifact 只读挂载 :ro；CORS env 可配；uploads 卷
- `docker-compose.dev.yml`：dev 覆盖发布 5432/8001、--reload、模型挂宿主机 artifact
- `server/Dockerfile`（gradle 8.10-jdk21 多阶段 → temurin 21-jre）；`image_service/Dockerfile`（python:3.11-slim + torch CPU + libgl，context=仓库根复制 ocr_core）
- `.env.example`：DB 凭据 + MODEL_ARTIFACT_HOST_DIR + CORS
- `.dockerignore`（仓库根，014 反模式修复）
- Spring 侧配套：CorsConfig（bead.cors.allowed-origins env）；dispatcher storage 路径改注入（去掉 System.getProperty）；
- 验证：compose yaml 解析 OK；9/9 测试通过；本机无 docker 未实际 up（需在目标机验证）
- 注意：compose 内置 postgres 与用户指定的远程库（192.168.5.88）二选一——compose 是完整拓扑（013），本地开发仍直连远程库

## 014 阶段 2-4 记录（2026-08-01）

- **阶段 0**：基线文件强制入 git（`git add -f` training/docs/baseline-* + eval_cell_baseline.py，因 training/docs/ 被 .git/info/exclude）
- **阶段 2-3**：`git rm -r backend/`（124 tracked 文件）+ 删除 untracked 残留（bead_app.db/uploads/test_env.db）；`build_gt_from_ocr.py`/`redraw_ocr_results.py`（EasyOCR 存档脚本）随 backend 删除；default_colors.json → `artifacts/colors/library.json`（已验证 identical 65 码）
- **阶段 4 验证**：
  - 删除前基线重跑 exact_match=0.7008 ✓
  - grep gate：training/ocr_core/image_service 无 `from app.*`/`CRNN_MODEL_PATH`/`OCR_ENGINE` ✓（0 命中）
  - 全量 import 冒烟（ocr_core + 全部训练脚本 + image_service）✓
  - 训练冒烟 `train_crnn --synth-n 200 --epochs 1` ✓
  - 后端 9/9 + 前端 138/138 测试 ✓
  - 端到端：真实图片 100 cells → SUCCEEDED 100/100，蓝图生成（F2×29/H11×26/H7×24...）✓
- **排障记录（重要）**：
  - Kotlin final 类 + @Async 代理不可靠 → dispatcher 改用内部线程池（Executors.newFixedThreadPool）
  - appendInternalEvent 分页取 1 条导致 maxSeq 算错撞 uq_job_event → 改为取 10000 条内存过滤
  - **多 Spring 实例并存**导致 curl 打到旧进程（旧代码无 dispatcher）→ 排查时先确认 8080 监听者 PID
  - `cmd &` 后台启动的 stdout 重定向不可靠 → 日志以 DB 状态为准验证

## 009 反向实现记录（2026-08-01）

- **Python image-service**（主仓库 `image_service/`，FastAPI :8001）：`/v1/tasks`（multipart 任务）+ `/health`（model_ready）+ `/health/model`；worker 用 ocr_core 推理（include_all=True，UNMAPPED 判定在 Spring）；逐 cell 回调 CELL_PROCESSED + 心跳 + JOB_SUCCEEDED/FAILED；退避重试 1s..16s × 5；临时文件用完删；`MODEL_ARTIFACT_DIR` 指向发布 artifact
- **Spring 调度器**（`PythonTaskDispatcher`）：创建任务/重试/stale 恢复时异步 multipart 派发 `POST /v1/tasks`（Java HttpClient）；回调基址 CALLBACK_BASE_URL env
- **协议修正**：JOB_STARTED sequence 1→0（009 规定 Python 从 1 开始，避免撞幂等键）；RETRY_SCHEDULED 改用 appendInternalEvent（当前 attempt 下取下一空闲序列）
- **端到端实测**（浏览器）：上传 test.jpg → Spring 创建任务并自动派发 → Python 真实 OCR（crnn_real_m）→ 841 个 CELL_PROCESSED 回调 → SUCCEEDED 841/841 → 蓝图 29×29（7 色：H11×433/H7×290/H22×92/H12×14/H21×8/F2×3/H17×1）→ 前端追踪页/图纸页全部正确
- 运行：`MODEL_ARTIFACT_DIR=artifacts/models/crnn_real_m-2026-08-01T00-00-00Z python -m uvicorn image_service.app.main:app --port 8001`（主仓库）

## 014 阶段 1 迁移记录（2026-08-01，主仓库）

- 新建 `ocr_core/`（顶层包）：`charset.py`（37 字符表单一事实源 + charset_hash）、`code_library.py`（artifact 快照加载，不读 backend）、`bead_ocr_crnn.py`（CRNN + R2 元数据 + 纯函数解码器，删除全局 _CHAR_TO_IDX）、`inference.py`（移植 + F1 置信度修复 exp(score/T)）
- `training/scripts/publish_checkpoint.py`：legacy 3-key → format_version=1 迁移 + 不可变 artifact 目录 + current 指针 + --colors 生成颜色库快照
- 训练侧切 import：train_crnn / eval_stand / eval_cell_baseline / synth_generator（charset re-export + code_library）/ bead_ocr_vlm
- 删 `training/models/bead_ocr_crnn.py`（已迁 ocr_core）；build_gt_from_ocr / redraw_ocr_results 标 DEPRECATED（EasyOCR 已删，014 阶段 3 移除）
- **验收**：eval_cell_baseline --legacy → exact_match 0.7008（与 011 基线逐位一致）；发布后新格式 load_checkpoint 正式通过；grep gate 仅剩 2 个 DEPRECATED 脚本
- artifact 产出：`artifacts/models/crnn_real_m-2026-08-01T00-00-00Z/{model.pt,charset.json,manifest.json}` + `artifacts/colors/library.json`（65 码）
- 已知：crnn_real_m.pt 的 code_dict_version=null（legacy 迁移无法回填训练词表，软校验告警路径已就绪）；train_crnn 只在 val_em>0 时保存（既有行为）

## 环境备注

- WSL 无外网；所有构建/DB 操作走 Windows 侧（conda bead-java + 网络）。
- 远程 PostgreSQL 16.13（Flyway 完全支持）；本地 18.4 已弃用（数据目录 .scratch/pgdata 可删）。
- 运行服务：`cd server && E:\devtools\conda\envs\bead-java\Library\bin\java.exe -jar build\libs\bead-server-0.1.0.jar`（JDK 21）
