# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-16
**Branch:** master

## OVERVIEW

AI拼豆助手 (ai_dou) — Perler bead pattern recognition app. Users upload images of bead boards, crop the grid region, set rows/cols; the system OCRs alphanumeric bead codes per cell and generates read-only bead blueprints with color lookup from an official multi-brand bead color library.

**2026-08-15 架构决策：Kotlin 后端已删除，仅保留 Rust 运行时。** 原 `server/`（Spring Boot + Kotlin，云端 PostgreSQL + Python image_service 事件协议）已整体移除；本地运行与部署统一由 `local_server/`（Rust 单二进制：axum API + SQLite + ONNX CRNN 推理；前端以独立 `dist/` 目录磁盘托管，替换即生效，无需重编）承担。训练管线（Python）保留，仅用于开发期训练/评估/导出。

```
frontend/  ──build──▶  local_server/release/dist/（磁盘 serve，替换即生效，无需重编）
                           │  axum :5173（0.0.0.0，局域网）
                           │  ├─ /api/v1/*（契约 007）
                           │  ├─ 静态资源（磁盘 dist/ 目录，SPA，no-cache）
                           │  ├─ SQLite（data/bead-local.db，WAL）
                           │  └─ ONNX Runtime 推理（进程内 worker 线程）
training/（Python，开发期）──export_onnx──▶ artifacts/models/*/model.onnx
tag push（v*）──▶ .github/workflows/release.yml ──▶ GitHub Release zip（不含模型；模型由用户按 README 网盘下载）
```

## STRUCTURE

```
ai_dou/
├── local_server/           ──── PART 1: RUST RUNTIME（单二进制局域网部署）────
│   ├── src/ocr/            # CRNN 推理（onnxruntime/ort + INTER_AREA 预处理 + trie 解码）
│   ├── src/{api,service,db,models,export}.rs  # axum API + SQLite（/api/v1 契约）
│   ├── tests/              # api_contract.rs（18 测试 = Kotlin 9 个 MockMvc 移植 + 扩展）+ parity.rs
│   ├── src/bin/bench_acceptance.rs  # Rust 端验收门禁（4 真实集参照值硬编码）
│   ├── resources/default_colors.json  # mard 291 色运行时种子（committed）
│   ├── build-release.bat   # 本地打包：构建 + 自包含 release/ + 打 zip（不含模型，含 README/VERSION）
│   ├── start-local.bat     # 一键启动：后台无窗口 + 自动开浏览器 + 日志落盘
│   └── stop-local.bat      # 按端口杀进程
├── .github/workflows/release.yml  # 发布流水线：tag（v*）触发 → 构建 zip → GitHub Release
├── frontend/               ──── PART 2: FRONTEND（零后端依赖，同源 /api/v1）────
│   ├── src/
│   │   ├── api/            # Axios wrappers per resource (client.ts baseURL /api/v1)
│   │   ├── components/     # Layout, BeadBoard, Button, ToastContext, ...
│   │   ├── pages/          # 5 pages (Upload, History, BlueprintDetail, Correction, ColorLibrary)
│   │   ├── hooks/          # TanStack React Query: useJobs, useBlueprints, useColorLibrary
│   │   └── types/          # TypeScript interfaces mirroring /api/v1 schemas (types/api.ts)
│   ├── vite.config.ts      # Dev server :5173, proxies /api → :8080
│   └── package.json
├── training/               ──── PART 3: TRAINING + DATA（开发期，Python）────
│   ├── models/             # synth_generator (cell-level), board_generator, bead_ocr_vlm
│   ├── scripts/            # train_crnn, eval_acceptance, eval_cell_baseline, export_onnx,
│   │                       # publish_checkpoint, build_color_library, build_mard_board_dataset ...
│   ├── data/               # synthetic/boards (gitignored)
│   └── docs/               # PLAN.md, experiments/, baseline-*.md
├── ocr_core/               ──── PART 3b: 训练/导出共用的 Python OCR 核心 ────
│   ├── bead_ocr_crnn.py    # CRNN arch + checkpoint I/O（训练与 ONNX 导出的源）
│   ├── inference.py        # Python 推理路径（仅训练评估参照；运行时推理在 Rust）
│   ├── charset.py          # CHARS/CHAR_TO_IDX + charset_hash()（单一事实源）
│   └── code_library.py     # artifact-snapshot color codes
├── artifacts/              # 模型产物与颜色快照
│   ├── models/<name>-<version>/{model.pt, model.onnx, charset.json, manifest.json}
│   └── colors/library.json # 颜色快照（3113 codes: 1950 official + 1163 Zippland; committed）
├── docs/                   # 项目文档（acceptance.md, crop-math.md, board-viewer-perf.md ...）
├── .scratch/               # 本地运行/调试数据（gitignored）
└── README.md / AGENTS.md / CLAUDE.md
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| /api/v1 endpoints | `local_server/src/api.rs` | jobs/blueprints/colors + /internal/jobs/{id}/events |
| API contract DTOs | `local_server/src/models.rs` | 007: camelCase 序列化，与前端 types/api.ts 对齐 |
| Job lifecycle + 事件 | `local_server/src/service.rs` | 幂等 apply_event、原子 blueprint、事件裁剪/终态清理 |
| OCR 推理 | `local_server/src/ocr/` | preprocess (INTER_AREA) / model (ort) / decode (trie+置信度) |
| 校正导出 zip | `local_server/src/export.rs` | ImageCropService 移植（裁格/主色/色相） |
| SQLite schema | `local_server/src/db.rs` | 镜像原 V1__initial_schema.sql（JSONB→TEXT） |
| 前端 API client | `frontend/src/api/client.ts` | axios baseURL `/api/v1`，同源 |
| 模型 artifact | `artifacts/models/` | model.pt（训练）+ model.onnx（运行时）双产物 |
| Checkpoint 发布 | `training/scripts/publish_checkpoint.py` | 发布后须跑 export_onnx.py 生成 onnx |
| ONNX 导出 | `training/scripts/export_onnx.py` | pt → onnx（opset 17），manifest 合并 |
| 验收门禁（Python） | `training/scripts/eval_acceptance.py` | 固定基准 + 0.005 容差；支持 onnx 候选 |
| 验收门禁（Rust） | `local_server/src/bin/bench_acceptance.rs` | 4 真实集参照值硬编码 |
| CRNN 训练 | `training/scripts/train_crnn.py` | writes format_version=1 checkpoints |
| 颜色库重建 | `training/scripts/build_color_library.py` | beadcolors CSV → JSON 快照 |
| 合成图纸 | `training/models/board_generator.py` + `generate_board.py` | ADR 0005 |

## COLOR LIBRARY (017 → 018)

- 运行时种子：`local_server` 启动读 `data/default_colors.json`（mard-only 291 码，剥离 `#` 前缀），`INSERT OR REPLACE` 写入 SQLite（不重建表）
- 完整快照：`artifacts/colors/library.json`（OCR 词表/多品牌，committed）
- 排序：字母升序 + 数字按数值（A1 < A2 < A10），Rust 与 Kotlin 同逻辑
- 契约：`GET /api/v1/colors` → `ColorDto(code, name, hex, brand)`；job 快照 `colorLibraryVersion` 从 DB 读取

## SYNTHETIC BOARD GENERATION (ADR 0005)

（不变——训练侧逻辑，见旧版 AGENTS.md / docs/adr/0005-synthetic-board-generation.md）
- 整板合成：真实照片 → mard 调色板映射 → 图纸渲染 + board.json 元数据
- **仅 mard 品牌用于生成**（CLI 默认）

## CONVENTIONS

- **发布流水线（2026-08-16 上线）**：`.github/workflows/release.yml`，推送 tag（`v*`，tag 即版本）触发 → windows-latest 构建前端 + Rust release 二进制 + 契约测试 → 下载 onnxruntime 1.23.2 官方 DLL → 打包 `bead-local-server-<tag>.zip`（含 README.md/VERSION.txt，**不含模型**）→ 上传 artifact + 发布 GitHub Release。本地等价物：`build-release.bat`（一条命令出 zip）
- **无 pyproject.toml** — conda env `bead-train`（Python 训练）；Rust 工具链：`RUSTUP_HOME=D:\devtools\rust`、`CARGO_HOME=D:\repos\cargo`
- **数据库**：SQLite（local_server/data/bead-local.db，WAL 模式；任务终态后 VACUUM+checkpoint 回收空间）
- **事件策略**：任务进行中事件保留（上限 200 条），终态后全部删除（事件是中间数据；结果在 blueprint）
- **模型 artifacts**（010 R3）：immutable `artifacts/models/<name>-<version>/`；model.pt + model.onnx 双产物（运行时用 onnx）。**onnx 不入 git、不进发布 zip**——最终用户按 README「安装」第 2 步从网盘下载模型解压到应用目录 `models\`；模型缺失/加载失败时服务以无模型模式降级启动（创建任务返回 503 MODEL_NOT_INSTALLED，中文提示，见 `main.rs` + `api.rs create_job`）
- **Checkpoint 元数据**（010 R2）：hard-check format_version/model_arch/num_classes/input_size/input_channels/blank_index/charset_hash
- **`PaginatedResponse[T]` 镜像**：`local_server/src/models.rs` ↔ `frontend/src/types/api.ts` — keep aligned
- **ESLint flat config** — `frontend/eslint.config.js`（v10+）；**Tailwind v4 CSS-based**；无 Prettier
- **测试**：local_server 22（3 unit + 18 contract + 1 parity）；frontend 180（vitest）；训练 eval 见 eval_acceptance

## ANTI-PATTERNS (THIS PROJECT)

- **Rust Windows 构建**：PATH 里 MinGW `link` 抢占 MSVC link.exe → `.cargo/config.toml` 已固化 linker + LIB（Windows SDK 26100，机器特定）——**CI 构建前必须先删该文件**（windows-latest 自带 VS2022，rustc 自动发现 link.exe）
- **onnxruntime 版本**：ort 用 load-dynamic + api-23，`ORT_DYLIB_PATH` 指向 1.23.2 DLL（与 Python 参照同核心）；部署时 DLL 放 exe 旁；CI 从微软官方 release 下载 `onnxruntime-win-x64-1.23.2.zip`（lib/onnxruntime.dll + providers_shared.dll）
- **数值一致三定律**：batch 统一 128；输入 uint8 量化（round→u8→/255）；cv2 INTER_AREA = 加权区域平均
- **bat 脚本**：必须 CRLF（write 工具写 LF 会吞首字符）；`"%OUT%\data\"` 尾反斜杠是转义坑
- **Git Bash**：`python` 不可用（exit 49）→ 用 conda python；`taskkill /PID` 会被 MSYS 转义 → `//PID`
- **SQLite 删除不缩文件**：prune/删除后必须 `VACUUM + wal_checkpoint(TRUNCATE)`（compact）
- **多实例**：`netstat -ano | grep :8080` 查 OwningProcess 再 debug
- **前端缓存**：index.html 已带 `Cache-Control: no-cache`；遇到旧行为先硬刷新

## UNIQUE STYLES

- 单二进制运行时：axum + SQLite + ONNX Runtime + 磁盘托管前端（`release/dist/`，替换即生效，前端改版无需重编 exe），双端零依赖
- 进程内 OCR worker（std::thread）与 HTTP 事件回调走同一条幂等 apply_event 路径（保留 /internal/jobs/{id}/events 端点）
- 单字符集事实源 `ocr_core/charset.py`；Rust 端从 artifact charset.json 读取
- 模型转换门禁：eval_acceptance 支持 onnx 候选 + Rust bench_acceptance 硬编码参照值
- 事件人类化：前端按事件类型渲染中文描述（"第 9 行 第 35 列：识别为 B1（置信度 74.5%）"）

## DEAD CODE (HISTORICAL, REMOVED)

**2026-08-15：Kotlin 云端后端整体删除**（commit 见 git log）：
- `server/`（Spring Boot + Kotlin + PostgreSQL + Flyway + 9 MockMvc 契约测试）→ Rust 版 `local_server/` 承担（17 契约测试）
- `image_service/`（Python FastAPI CRNN + 事件回调协议 009）→ 进程内 worker 替代
- `kmp-app/`（KMP 离线推理实验）、`docker-compose*.yml`、`.env.example`、根 `uploads/`、`worktree/`
- 更早移除：FastAPI `backend/`（commit 77d564d）、EasyOCR/PaddleOCR/DeepSeek 引擎（002）

## COMMANDS

### 构建 / 启动 / 测试（Rust 运行时）

```bash
# 前端构建（产物在 frontend/dist；部署 = 拷贝到 release/dist/，运行中的服务立即生效，无需重编/重启）
cd frontend && node.exe node_modules/vite/bin/vite.js build
cp -r dist/* ../local_server/release/dist/   # 可选：或直接跑下面的 build-release.bat

# 本地一条命令出包：重编 exe + 同步 dist + 自包含 release/ + 打 zip（不含模型，含 README/VERSION）
cd local_server && cmd //c build-release.bat
# 产物：local_server/bead-local-server-v0.1.0.zip（解压任意目录 → 按 README 装模型 → 双击 start-local.bat）

# GitHub 发布（推荐）：打 tag 即发布，流水线自动出包 + GitHub Release
# tag 即版本（如 v0.1.0）；产物在 Release 页 / Actions artifact（zip 不含模型，见 README 安装说明）
git tag v0.1.0 && git push origin v0.1.0

# 一键启动（发布/开发机均可）：
cd local_server/release && start-local.bat   # 后台无窗口 + 自动开浏览器；stop-local.bat 停止

# 开发运行（默认 :5173；前端 dev :5173 proxy /api → 8080 联调时用 BEAD_PORT=8080）：
export PATH="/d/repos/cargo/bin:$PATH" RUSTUP_HOME='D:\devtools\rust' CARGO_HOME='D:\repos\cargo'
ORT_DYLIB_PATH=E:\devtools\conda\envs\bead-train\Lib\site-packages\onnxruntime\capi\onnxruntime.dll \
  cargo run    # env 覆盖：BEAD_PORT/BEAD_DB_PATH/BEAD_UPLOADS_DIR/BEAD_ARTIFACT_DIR

# 测试（21 个：3 unit + 17 contract + 1 parity）：
ORT_DYLIB_PATH=... cargo test
# Rust 端验收门禁（4 真实集，参照值硬编码在 bin）：
ORT_DYLIB_PATH=... cargo run --release --bin bench_acceptance
```

### 训练 / 模型发布（开发期，Python）

```bash
# conda 环境：bead-train（Python）；从仓库根运行
# 训练：省略 --out 自动命名 training/checkpoints/bean-mard-v<N>.pt（N 递增）
python -m training.scripts.train_crnn --synth-n 50000 --epochs 30
# 发布：省略 --name 自动编号 bean-mard-v<N>（基于 artifacts/models 最大 N+1）
# 名字必须符合 bean-mard-v<N> 格式（model_naming.py 校验）
python -m training.scripts.publish_checkpoint --checkpoint training/checkpoints/bean-mard-v<N>.pt
# ONNX 导出（发布双产物，manifest 合并）：
python -m training.scripts.export_onnx --checkpoint artifacts/models/<n>-<v>/model.pt \
    --out-dir artifacts/models/<n>-<v> --verify
# 验收门禁（pt 或 onnx 候选均可）：
python -m training.scripts.eval_acceptance --candidate <ckpt|model.onnx> \
    --production artifacts/models/<current>/model.pt --json training/docs/acceptance-x.json
# 颜色库重建：
python -m training.scripts.build_color_library --csv-dir .scratch/beadcolors-src --out artifacts/colors/library.json
```

### 前端

```bash
cd frontend && npm install && npm run dev   # :5173, proxies /api → :8080（须先起 local_server）
cd frontend && npm test                     # 180 tests
```

## NOTES

- 前端 dev proxy：`/api` → `http://localhost:8080`（vite.config.ts，dev 时 local_server 用 BEAD_PORT=8080）；生产同源（Rust 磁盘 serve `release/dist/`）
- 上传限制：30MB（axum DefaultBodyLimit 32MB 兜底），JPEG/PNG
- 基线模型：`bean-mard-v10`（原 crnn_color_mard_v8，zip exact_match 0.9405，post-CTC-fix）；**当前生产 = bean-mard-v12**（2026-08-15 部署）。bean-mard-v12 = v11 配方 + **修正 H18↔H12 标注噪声后重训**（用户修正 1_标注结果_07-29 的 46 个错标）；5 级模糊合成图纸 + 新标注保留；模糊图纸生成器与 blank-cap 代码保留。
- **模型验收门禁**：任何新 checkpoint 部署前必须跑 `eval_acceptance`（基准集与容差固定，不允许为过门禁增删）；Rust 端再跑 `bench_acceptance`
- **模型命名（2026-08-15 统一）**：所有模型统一为 `bean-mard-v<N>`，按事件时间顺序编号（旧=v1，新=vN）。artifacts/models/ 12 个目录 = v1..v12；training/checkpoints/ 45 个 .pt = v1..v45。`publish_checkpoint.py --name bean-mard-v<N>` 发布新模型。
- **真实样本**：丢进 `training/samples/标注数据/<新目录>/` 后跑 `build_color_dataset_v2 --name color_v<N>` 自动并入
- Legacy checkpoints（无 format_version）须先 `publish_checkpoint.py` 迁移
- 颜色库：`artifacts/colors/library.json`（2993+ codes）；运行时种子 `data/default_colors.json`（mard 291）
- 复杂度热点：`frontend/src/pages/UploadPage.tsx`（crop 交互 ~400 LOC）
- Wayfinder tracker：`.scratch/spring-kotlin-python-rewrite/`（历史决策记录，含 2026-08-15 删除 Kotlin 的决策上下文）
