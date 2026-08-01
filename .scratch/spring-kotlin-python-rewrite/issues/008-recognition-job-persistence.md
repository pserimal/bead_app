---
id: 008
title: RecognitionJob 持久化、事件日志与恢复事务
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

RecognitionJob、RecognitionJobCell、RecognitionJobEvent、attempt、租约、心跳、重试和 Blueprint 生成的最终 PostgreSQL schema 与事务边界是什么？重点确定重复事件、stale 任务恢复和最终 Blueprint 原子创建的规则。

## Resolution

（基于 004 生命周期、005 数据归属、007 外部契约决议）

### 表结构（Flyway 初始 schema，snake_case）

```sql
recognition_job (
  id uuid PK,
  status varchar(32) NOT NULL,          -- PENDING|PROCESSING|SUCCEEDED|SUCCEEDED_WITH_WARNINGS|FAILED
  stage varchar(16) NOT NULL DEFAULT 'QUEUED',  -- QUEUED|OCR
  rows int NOT NULL, cols int NOT NULL,
  crop_box jsonb NOT NULL,              -- {x,y,width,height} 原图像素
  valid_codes jsonb,                    -- 图纸级编码快照（大写数组）
  input_image_path varchar NOT NULL,    -- Spring 原图存储路径
  color_library_version varchar NOT NULL,  -- 任务创建时的颜色库快照版本
  model_snapshot varchar NOT NULL,      -- 使用的 CRNN checkpoint 标识
  attempt int NOT NULL DEFAULT 0,       -- 当前尝试号，重试 +1
  retry_count int NOT NULL DEFAULT 0,
  max_retries int NOT NULL DEFAULT 2,
  processed_cells int NOT NULL DEFAULT 0,
  total_cells int NOT NULL,
  heartbeat_at timestamptz,
  error_code varchar, error_message text,
  blueprint_id uuid UNIQUE NULL,        -- 完成时原子创建后回填
  created_at timestamptz, updated_at timestamptz
)

recognition_job_event (
  id bigserial PK,
  job_id uuid FK -> recognition_job,
  attempt int NOT NULL,
  sequence bigint NOT NULL,
  type varchar(32) NOT NULL,            -- 007 契约枚举
  payload jsonb NOT NULL,
  created_at timestamptz,
  UNIQUE (job_id, attempt, sequence)    -- 幂等键
)

recognition_job_cell (
  job_id uuid FK,
  row int NOT NULL, col int NOT NULL,
  code varchar(8) NOT NULL,
  status varchar(16) NOT NULL,          -- MAPPED|UNMAPPED
  color_code varchar(8), color_name varchar, color_hex varchar(6),
  updated_at timestamptz,
  PRIMARY KEY (job_id, row, col)        -- 跨 attempt 覆盖写
)

blueprint (
  id uuid PK,
  job_id uuid UNIQUE FK -> recognition_job,
  rows int, cols int,
  valid_codes jsonb,
  created_at timestamptz
)

blueprint_cell (
  blueprint_id uuid FK, row int, col int,
  code varchar(8), status varchar(16),
  color_code varchar(8), color_name varchar, color_hex varchar(6),
  PRIMARY KEY (blueprint_id, row, col)
)

color_library (code varchar(8) PK, name varchar, hex varchar(6), version varchar NOT NULL)
```

### 事件应用（幂等规则）

1. 入站事件先以 `(job_id, attempt, sequence)` 做 `INSERT ... ON CONFLICT DO NOTHING`；冲突即已应用过 → 直接返回 ACK，不重复副作用。
2. 未冲突则在同一事务内应用副作用：`CELL_PROCESSED` → upsert `recognition_job_cell`（PRIMARY KEY 覆盖跨 attempt 的旧值）+ 递增 `processed_cells` + 更新 `heartbeat_at`；`HEARTBEAT` → 仅更新 `heartbeat_at`。
3. 每次事件应用后校验 `job.status`：终态（SUCCEEDED 系 / FAILED）拒绝再接收非幂等事件（→ 009 回调返回 409，Python 视为已送达）。

### 终态与 Blueprint 原子创建

- `JOB_SUCCEEDED` 事件到达时，在同一事务内：
  1. 校验 `job.status IN (PENDING, PROCESSING)`（防双终端）；
  2. 将全部 `recognition_job_cell` 复制为 `blueprint` + `blueprint_cell`（含颜色快照列）；
  3. `job.status = SUCCEEDED`（若存在 `UNMAPPED` cell 或 `CELL_FAILED` 但重试耗尽后成功 → `SUCCEEDED_WITH_WARNINGS`），回填 `blueprint_id`；
  4. 记录 `JOB_SUCCEEDED` 事件。
  - 任一步失败 → 整个事务回滚，任务保持 PROCESSING，恢复循环会再次处理。
- `JOB_FAILED` 事件：同一事务内若 `retry_count < max_retries` → `retry_count+1`、`attempt+1`、状态保持 `PROCESSING`、写 `RETRY_SCHEDULED` 事件并重新调度 Python 任务；否则 `status = FAILED`、写 `error_code/message`。

### 恢复（stale 心跳检测）

- 判定：`status = PROCESSING` 且 `heartbeat_at < now() - 90s`（或超时阈值配置项）。
- 恢复循环（Spring 调度器，固定间隔）：逐任务开启独立事务，逻辑同 `JOB_FAILED` 的失败分支——未达重试上限则 `attempt+1` 重派，否则置 `FAILED`；每个恢复周期先写 `RETRY_SCHEDULED`/`JOB_FAILED` 事件。
- 应用启动时先跑一次全量扫描，再进入周期调度。
- Python 侧发送超过 90s 未收到任何事件即应自检（009 定义），Spring 不依赖 Python 自愈。

### 事务边界清单

| 操作 | 事务内容 |
|---|---|
| 创建任务 | job + 首个 `JOB_STARTED` 事件 |
| 应用入站事件 | 事件插入（幂等）+ 该事件副作用 |
| 终态完成 | 终态事件 + blueprint 复制 + 状态翻转（全部原子） |
| 恢复/重试 | 状态/attempt 更新 + 事件 + 重新调度 |
| 心跳 | 仅 `heartbeat_at`（可独立轻事务） |

### 实现约定

- Flyway 迁移管理 schema；JPA 实体映射 snake_case 列；`jsonb` 用 `@JdbcTypeCode(SqlTypes.JSON)`。
- `attempt` 与 `retry_count` 分离：`attempt` 是幂等键的一部分（事件按 attempt 隔离），`retry_count` 仅用于上限判断。
- 全部写路径经服务层统一入口（单写入者），避免并发事件交叉事务。
