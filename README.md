# 🧩 拼豆助手

拼豆助手是一个拼豆图案识别应用。用户上传拼豆图纸图片，框选网格区域、设置行列数；系统对每个格子做 OCR（CRNN 模型）识别编码，对照拼豆颜色库生成可读的拼豆图纸。

## 功能特性

- 🖼️ 单裁剪上传：图片 + 裁剪框 + 行列数（裁剪框支持拖拽缩放/键盘微调/数值输入）
- 🔤 CRNN 逐格 OCR：识别格子内印刷的字母数字编码（如 H7、F2、C21）
- 🎨 颜色库映射：mard 291 色（运行时）+ 多品牌快照（OCR 词表），UNMAPPED 编码明确标注、可校正
- 📋 识别任务追踪：异步任务、实时进度、人类化事件时间线、自动重试
- 🔍 任务历史 + 图纸详情（只读棋盘 + 颜色图例 + 校正导出）

## 架构

**2026-08-15：Kotlin 云端后端已移除，统一为 Rust 单二进制运行时。**

```
[ 浏览器（本机/局域网任意设备）]
        │  http://<本机IP>:8080
        ▼
[ bead-local-server.exe  （单进程，零外部依赖）]
        │  axum
        ├─ /api/v1/* ──── SQLite（data/bead-local.db）
        ├─ 静态资源 ────── 前端 React build（磁盘 dist/ 目录，替换即生效）
        └─ OCR worker ──── ONNX Runtime（model.onnx）进程内推理
```

- **local_server/** — Rust（axum + SQLite + ONNX Runtime）：API、任务编排、事件、蓝图生成、前端托管
- **frontend/** — React + TypeScript + Vite（构建产物部署为 `release/dist/`，磁盘托管、替换即生效、无需重编 exe；也可 npm run dev 开发）
- **training/** — Python CRNN 训练 + 数据标注 + 模型发布（开发期工具，非运行时依赖）
- **ocr_core/** — 训练/导出共用的 Python OCR 核心（运行时推理在 Rust）

## 快速开始（部署）

```bash
# 前置：Windows 机器（无需安装任何运行时）
1. 解压 local_server/bead-local-server-v0.1.0.zip 到任意目录
2. 双击 start-local.bat（后台启动 + 自动打开浏览器 http://localhost:8080）
3. 局域网其他设备访问 http://<本机IP>:8080
4. 停止：双击 stop-local.bat
```

日志：`data/server.log` / `data/server.err.log`；数据库：`data/bead-local.db`（自动创建）。

## 开发

### Rust 运行时（local_server/）

```bash
# 前置：Rust 1.97（rustup，RUSTUP_HOME=D:\devtools\rust, CARGO_HOME=D:\repos\cargo）、
#       Windows SDK 26100、onnxruntime 1.23.2 DLL（ORT_DYLIB_PATH）
cd local_server
ORT_DYLIB_PATH=<onnxruntime.dll> cargo run          # :8080
ORT_DYLIB_PATH=<onnxruntime.dll> cargo test         # 21 tests
ORT_DYLIB_PATH=<onnxruntime.dll> cargo run --release --bin bench_acceptance  # 验收门禁

# 出包（前端构建 + exe + DLL + 数据 + 模型 → zip）
cd ../frontend && npm run build
cd ../local_server && cmd /c build-release.bat
```

### 前端（frontend/）

```bash
cd frontend && npm install && npm run dev   # :5173，/api 代理到 :8080（需先起 local_server）
cd frontend && npm test                     # 175 tests
```

### 训练 / 模型（training/，conda env bead-train）

```bash
python -m training.scripts.train_crnn --synth-n 50000 --epochs 30
python -m training.scripts.publish_checkpoint --checkpoint <ckpt> --name <n> --version <v>
python -m training.scripts.export_onnx --checkpoint artifacts/models/<n>-<v>/model.pt \
    --out-dir artifacts/models/<n>-<v> --verify        # 发布 model.onnx 双产物
python -m training.scripts.eval_acceptance --candidate <ckpt|onnx> --production <current>  # 门禁
```

## 技术栈

### 运行时（Rust）
- **axum 0.8** + **tokio** — HTTP API
- **rusqlite (SQLite, bundled)** — 持久化（WAL）
- **ort (ONNX Runtime 1.23.2, load-dynamic)** — CRNN 推理
- **axum 静态文件服务** — 前端 `dist/` 目录磁盘托管（替换即生效；非 embed）
- **serde / chrono / uuid / image / zip**

### 前端
- **React 19** + **TypeScript** + **Vite** + **TanStack React Query** + **Tailwind CSS v4** + **Vitest**

### 训练（Python，开发期）
- **PyTorch** — CRNN 训练
- **onnx / onnxruntime** — 导出与验证

## 文档

- `AGENTS.md` / `CLAUDE.md` — 架构、命令、坑位
- `docs/acceptance.md` — 模型验收门禁（固定基准 + 容差）
- `docs/crop-math.md` — 裁剪数学契约（Rust + 前端两处实现）
- `docs/board-viewer-perf.md` — 图纸查看器性能门禁
- `docs/adr/` — 架构决策记录
- `.scratch/spring-kotlin-python-rewrite/` — 历史架构决策（含 2026-08-15 Kotlin 移除）
