---
id: 014
title: 旧 FastAPI backend 退役与训练资产迁移清单
labels: [wayfinder:task]
state: closed
parent: 000
blocked_by: [010, 011]
assignee: assistant
---

## Question

列出旧 backend 中必须删除、必须迁移、必须保留和必须重新验证的文件/模块/测试/数据资产，确保删除 FastAPI runtime 不会破坏 training、checkpoint、基线测试或颜色库 seed。

## Resolution

> 本清单基于主仓库 `D:/projects/python/ai_dou` 实检（commit 5da0097，branch master；worktree flash-test 与主仓库同 .git）。路径均已验证存在。
> 执行顺序：**阶段 0 准备 → 阶段 1 迁移 → 阶段 2 依赖清理 → 阶段 3 删除 → 阶段 4 验证**。每个阶段完成后再进入下一阶段。

### 阶段 0 — 准备（删除前快照）

1. 确认基线已固化：`training/docs/baseline-2026-07-31.md` / `-sweep.json` 存在，`crnn_real_m.pt` 为选定 checkpoint（zip 集 exact_match 0.7008）。**注意 `training/docs/` 被 `.git/info/exclude` 本地排除**——若尚未入 git，先 `git add -f training/docs/baseline-2026-07-31.md training/docs/baseline-2026-07-31.json training/docs/baseline-2026-07-31-sweep.json`（或后续阶段提交）。
2. 记录旧 backend 测试基线：`cd backend && pytest` 全量跑一次并保存输出（15 个测试文件，含 hardcoded 图片路径的测试会失败——见阶段 3 删除项）。
3. 冻结决策待确认项（见「需用户确认」）。

### 阶段 1 — 迁移（保留资产，旧 backend 不动）

**训练资产（保留原位，按 002/005 属离线资产）**：

- `training/data/synthetic/`（78M，general + targeted_m）——保留，gitignored，无需处理。
- `training/samples/1_标注结果_2026-07-29/` + `.zip`（8644 cell，Experiment 001 训练集）——保留。
- `training/checkpoints/*.pt`（10 个，含 `crnn_real_m.pt`）——保留，gitignored（`training/checkpoints/*.pt`）；`crnn_v2.pt` 不存在，勿依赖 config 默认值。
- `examples/`（`1.jpg`..`6.jpg` + `examples/stand/`：`1.jpg/2.jpg/3.jpg`、`cells/`、`cut/`、`manifest.json`、`标注结果/1_标注结果_2026-07-26.zip`）——**实际标注数据源在 `examples/` 而非 `training/data/real/`（AGENTS.md 描述过时）**，保留。
- `training/label.html`（标注工具）——保留。
- `training/docs/PLAN.md`、`training/docs/experiments/001-real-baseline-and-mixed.md`——保留。

**需迁移/重构（010 ocr_core 重构，旧 backend 删除前完成）**：

- `training/models/bead_ocr_crnn.py` → 平移为 `ocr_core/bead_ocr_crnn.py`（架构 + 解码器 + checkpoint I/O）。
- `training/models/synth_generator.py` 的 CHARS/CHAR_TO_IDX/CODES → `ocr_core/charset.py`（删副本）；`bead_ocr_vlm.py` 的库路径硬编码一并替换。
- `training/scripts/eval_stand.py:92` 的 `from app.services.bead_ocr_crnn_inference import ...` → `from ocr_core.inference import ocr_cells_from_crop`。
- `training/scripts/build_gt_from_ocr.py` 的 `from app.services.bead_ocr_easy import ...` → 改为 `ocr_core` 或标注为废弃（EasyOCR 已删除）。
- `backend/app/data/default_colors.json`（65 码，H/F/G）→ **保留为颜色库 seed 源**：按 005 迁到 Spring 侧 seed 资源 + 010 R3 的 `ocr_core.code_library` artifact 快照；文件本身先复制到 `artifacts/colors/`（或新仓库位置），勿随 backend 一起删除。

### 阶段 2 — 依赖清理（010 R4 第 6 条）

- `backend/requirements.txt`：删 `colour-science`、`onnxruntime>=1.17.0`、`ultralytics>=8.0.0`、`scikit-learn>=1.2.0`、`easyocr`；保留项随新 Python image-service 重建（torch + numpy + opencv-python-headless + fastapi + uvicorn + pydantic-settings 等）。
- `backend/environment.yml`：删 `colour-science`、`scipy`（从未使用）、`torchvision`（从未 import）；`requests` 若无用处一并清理。
- `backend/app/config.py`：`CRNN_MODEL_PATH`、`OCR_ENGINE`、`OCR_MIN_CONF` → 由新服务 `MODEL_ARTIFACT_DIR`、`OCR_MIN_CONF`、`MAX_WORKERS` 取代；该文件随旧 backend 删除。
- 删除后校验：`grep -rn "colour-science\|ultralytics\|onnxruntime\|scikit-learn\|easyocr\|torchvision" --include=*.py --include=*.yml --include=*.txt .` 应为空。

### 阶段 3 — 删除（旧 FastAPI runtime）

**删除文件（010 R4 sever list，依赖顺序）**：

1. `backend/app/services/bead_ocr_crnn_inference.py`（逻辑已迁 `ocr_core/inference.py`）
2. `backend/app/services/bead_ocr.py`（调度器；顺带消除两处坏 import：`:37` `app.services.beader_ocr_easy`、`:91` `app.services.bead_ocr_paddle`）
3. `backend/app/services/bead_ocr_easy.py`、`bead_ocr_template.py`、`bead_ocr_deepseek.py`（002 决议删除 EasyOCR/PaddleOCR/模板/DeepSeek）
4. `backend/app/services/bead_parser.py`（裁剪路径逻辑移入新 image-service；`code_match.py`、`bead_grid_detector.py`、`pipeline/blue_line_grid_detector.py`、`bead_ocr_preprocess.py` 随自动网格/整图 OCR 路径一并删除，003 决议）
5. `backend/app/api/`、`backend/app/models/`、`backend/app/schemas/`、`backend/app/db.py`、`backend/app/main.py`、`backend/app/seed.py`、`backend/app/config.py`（整 app 目录——除 `data/default_colors.json` 已迁移）
6. `backend/migrations/`、`backend/alembic.ini`、`backend/tests/`（含 `test_api_upload.py` 等的 hardcoded 图片路径）、`backend/Dockerfile`、`backend/condaenv.4grzjfys.requirements.txt`、`backend/AGENTS.md`、`backend/app/services/AGENTS.md`、`backend/tests/AGENTS.md`
7. `backend/.env.example`、`backend/.env`（凭据不留在仓库）

**整目录删除**：`backend/` 剩余骨架（`__pycache__` 由 gitignore 覆盖）。

### 阶段 4 — 验证（回归）

1. **删除前**：`cd /mnt/d/projects/python/ai_dou && /mnt/e/devtools/conda/envs/bead-train/python.exe training/scripts/eval_cell_baseline.py --checkpoint training/checkpoints/crnn_real_m.pt --json training/docs/baseline-2026-07-31.json` —— 结果应与已存基线一致（exact_match 0.7008）。
2. **ocr_core 迁移后、backend 删除前**：同脚本改用 `ocr_core` 实现重跑 → zip 集 exact_match ≥ 0.7008（容差 ±0.005），per-code 23 码均 ≥ 基线（±0.02），CPU ms/cell ≤ 2.0（011 验收规则）。
3. **训练侧回归**：`python -m training.scripts.eval_stand`（import 已切 ocr_core）从 repo root 可跑；`python -m training.scripts.train_crnn --synth-n 1000 --epochs 1` 冒烟通过。
4. **backend 删除后**：`grep -rn "app.services\|app.config\|CRNN_MODEL_PATH\|OCR_ENGINE" training/` 应为空（训练侧不再 import `app.*`）。
5. **最终绿**：新 Compose（013）`docker compose up -d --wait` 全健康，Spring + Python image-service 就绪，`/api/v1/jobs` 冒烟。
6. **颜色库 seed 保留**：新 Spring 侧 seed 资源中 65 码（H/F/G）与 `default_colors.json` 一致。

### 需用户确认（不擅自决定）

- **`backend/bead_app.db`**：已 gitignored，内含旧业务数据；005 决议「不迁移旧业务数据」→ 默认删除，但删除前请用户确认无导出需求。
- **`backend/uploads/`**（含真实上传图片）与根目录 `uploads/`：gitignored；005 决议旧数据不迁移 → 默认删除，确认后执行。
- **`training/crops/`**（空目录）与 `training/data/annotations/`（不存在，标注数据实际在 `examples/stand/` 与 `training/samples/`）——AGENTS.md 结构描述已过时，是否新建/重定向目录结构由用户定。
- **旧测试**：`backend/tests/` 整体删除前，`test_crop_cells_ocr.py`、`test_confidence_gating.py`、`test_code_regex.py` 中与 `ocr_core` 语义相关的用例是否移植到新服务测试——由用户决定（建议移植 code_regex 与 crop 逻辑相关用例）。

### 文档更新（与删除同步，具体位置）

- `CLAUDE.md`：结构树（:11-12、:19-21）、FastAPI/uvicorn/:8000 启动命令（:56-67）、pipeline 描述（:46、:50）——改为 Spring Boot + ocr_core + Python image-service。
- `AGENTS.md`：OVERVIEW（:9）、STRUCTURE backend 段（:24-35）、WHERE TO LOOK 表（:61-85）、COMMANDS（:90 起）、NOTES——全部改写为三服务新拓扑。
- `CONTEXT.md`：:20 的 `backend/app/data/default_colors.json` 引用改为 Spring seed 资源路径。
- `README.md`：:15、:49-56、:70、:76-79 的 FastAPI/uvicorn/8000 描述与 backend 结构树。
- `training/README.md`：:14（backend 加载 checkpoint 描述）、:62、:74-76（依赖 backend/environment.yml、backend 加载方式）。
- `backend/AGENTS.md`、`backend/app/services/AGENTS.md`、`backend/tests/AGENTS.md`：随 backend 删除。
- `docs/agents/domain.md`：若含旧 pipeline 术语则更新（本清单未逐行核查该文件）。
- `docker-compose.yml`：按 013 替换为 postgres + spring-boot + python-crnn 三服务（移除旧 backend 服务与硬编码 admin:123456）。

### 提交建议

按阶段提交：阶段 1 迁移（ocr_core 新建 + 训练侧 import 切换）→ 阶段 2 依赖 → 阶段 3 删除 → 阶段 4 验证后提交；`training/docs/baseline-*` 与 `eval_cell_baseline.py` 若需入版本库，用 `git add -f`（`training/docs/` 被本地 exclude）。
