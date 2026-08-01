---
id: 010
title: CRNN 训练推理共享核心与模型 artifact 边界
labels: [wayfinder:research]
state: closed
parent: 000
blocked_by: []
assignee: researcher
---

## Question

调查当前 CRNN checkpoint、字符表、constrained decoding 和训练代码的依赖，确定共享 OCR 核心模块的目录、checkpoint 元数据/兼容性校验、训练产物到 Python image-service 的发布方式，以及如何彻底移除旧 backend 依赖。

## Resolution

（由 `/research` subagent 调查，证据见 `research/010-brief.md`，本决议为结论摘要）

### 共享 OCR 核心：新建顶层 `ocr_core/` 包

- 位置：`ocr_core/`（与 `backend/`、`training/`、`frontend/` 平级），包含 `charset.py`（CHARS/CHAR_TO_IDX/IDX_TO_CHAR + `charset_hash()`，单一事实源，删除 `synth_generator.py` 中的副本）、`code_library.py`（从 artifact 快照加载颜色库，不读 `backend/app/data/default_colors.json`）、`bead_ocr_crnn.py`（CRNN 架构 + 保存/加载 + 解码器，自 `training/models/` 平移）、`inference.py`（crop→48×48 letterbox→批量推理→constrained decode）。
- 训练脚本与 Python image-service 都 import `ocr_core`，二者互不依赖；`pip install -e` 或 compose 内 PYTHONPATH 解决当前 `sys.path` 脆弱性。

### Checkpoint 元数据与兼容性校验（R2）

- 保存格式从裸 3-key dict 扩展为：`format_version`、`model_arch`、`num_classes`、`hidden`、`input_size`、`input_channels`、`blank_index`、`chars`、`charset_hash`（硬校验）、`code_dict_version`（软校验）、`code_dict`、`created_at`、`training` 溯源 + `state_dict`。
- 加载时：缺 `format_version` → 拒绝；架构/类数/尺寸/字符集 hash 不匹配 → 硬失败（消除当前 37-token 运行时表 vs ≤14 类 checkpoint 的越界崩溃）；`code_dict_version` 漂移 → 告警并暴露于 `/health/model`，继续服务。
- 解码器改为纯函数（显式传 `idx_to_char`/`char_to_idx`），删除模块级 `_CHAR_TO_IDX` 全局。

### 训练产物发布（R3）

- 新增 `training/scripts/publish_checkpoint.py`：输出不可变、带版本的 `artifacts/models/<name>-<version>/{model.pt, charset.json, code_dict.json, manifest.json}`；服务端通过 `MODEL_ARTIFACT_DIR` 指向单一 artifact。
- 首版 Compose 将 artifact 目录只读挂载进 Python image-service（`/models:ro`）；颜色库快照同 artifact 交付。废除 `CRNN_MODEL_PATH`。

### 旧 backend 依赖移除（R4，依赖顺序）

1. 删 `backend/app/services/bead_ocr_crnn_inference.py`（逻辑移入 `ocr_core/inference.py`，配置注入）；
2. 删 `backend/app/services/bead_ocr.py` 调度器（顺带移除两个潜在坏 import：`beader_ocr_easy`、`bead_ocr_paddle`）；
3. `bead_parser.py` 的裁剪路径逻辑移入新 image-service；
4. `eval_stand.py` 改 import `ocr_core`，训练侧不再 import `app.*`；
5. `synth_generator.py`/`bead_ocr_vlm.py` 字符表与库路径改走 `ocr_core`；
6. 依赖清单：删 `easyocr`、`onnxruntime`、`ultralytics`、`scikit-learn`、`colour-science`，删 `torchvision`（从未被 import）；新服务依赖 = torch + numpy + opencv-python-headless + fastapi + uvicorn + pydantic-settings；
7. 回归门槛：删除旧 backend 前快照 `eval_stand` 指标（链接 ticket 011 基线）。

## 关键事实（影响 011/014）

- `crnn_v2.pt` 不存在（worktree 与主仓库均无）；`.gitignore` 忽略所有 `training/checkpoints/*.pt`，与 `training/README.md` 的“提交了 checkpoint”说法矛盾。
- 当前 `default_colors.json` 实际只有 H/F/G 字母编码 → 现有 checkpoint 类数 ≤14。
- 本环境无 torch 的 docker backend 无法跑 CRNN；torch 需另行安装（`bead-train` env 可用）。
