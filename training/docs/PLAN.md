# Bead Code Recognition — CRNN Plan

> 业务方案 + 训练方法。带去 GPU 环境上执行。

## 1. 背景与约束

**业务目标**：用户上传拼豆图纸照片 → 自动识别每个格子的字母数字编码（`H7`, `F1`, `E11` 等）→ 查色卡生成可编辑图纸。

**硬约束**：
- **纯文字识别**。颜色识别不可靠（同一 code 不同色块、同一色块不同 code 都有），不许走颜色聚类 / CIEDE2000 / 连通域路线。
- **封闭字典**。code 格式为 `大写字母 + 1–2 位数字`（如 A1, H7, Z99），字典可扩展。识别结果按字典前缀树约束解码。
- 不依赖外部大模型 API。

## 2. 之前方案为什么失败

**实测结果**（`training/data/real/stand/拼豆日记54...gt.json`）：
- EasyOCR：auto_high_conf = 442 / 4032 = **11%**
- DeepSeek-OCR / qwen2.5vl / Template：未在真实图上验证，合成图上手测全部 < 30%

**根因**（三条，独立看任一条都足以判死刑）：

1. **字符像素太少**。派大星图 72×56 = 4032 格塞进 ~2000 px，每格 ~28 px，字符本身只有 **8–10 px 高**。通用 OCR 训练分布是文档级（≥ 16 px 字符），`text_threshold` 直接丢弃。
2. **字体 domain gap**。模板匹配假设字体已知，Perler 模板的字体我们不知道。
3. **VLM 感受野不匹配**。qwen2.5vl-7b 的 ViT 把 224×224 patch 切了，10 px 字符落进单个 patch 后信息全丢。

→ 唯一可行路线：**训一个直接在你图纸字符分布上学的小模型**。这就是 CRNN。

## 3. CRNN 方案

**输入**：48×48 灰度单格图（裁剪后 letterbox 进去，匹配真实 cell 尺寸）。

**架构**（3.7M 参数）：
```
Input (B, 1, 48, 48)
  → 5× Conv+BN+ReLU+MaxPool    # collapse H 48→1, W 48→11
  → Reshape to (T=11, B, 512)
  → 2-layer BiLSTM (hidden=128)
  → Linear(256 → 37)
  → log_softmax over time
Output (T=11, B, num_classes=37)
```

字符表：`['<blank>', 'A'–'Z', '0'–'9']` 共 37 token。`<blank>` 是 CTC blank（index 0）。

**损失**：CTC loss（label 是 code 的 token 序列，不需要对齐）。

**解码**：
- 训练时用 CTC greedy decode（最简单，无 trie 约束）。
- 推理时用 **constrained decode**：按 code 前缀树走，每步取 trie 子节点里 log-prob 最高的字符，避免出非法 token（如 `I`、`O`、`5` 单独出现时不会被解码成合法 code）。

**为什么不用 Transformer (TrOCR)**：
- TrOCR 需要预训练权重（HF 下载），环境不联网时不能用
- CRNN 3.7M 参数，CPU 上推理 0.5 ms/格，GPU 上更快
- CTC + 字典约束对封闭集已足够

## 4. 合成数据策略

**基于真实 cell 特征设计**（`training/crops/cut/1/` 观察结果）。每张输出 48×48 RGB。

每张合成图随机化：
- **底色**：从 65 色 Perler 色卡随机取（`default_colors.json` 的 hex 值）。
- **文字颜色**：背景亮度 < 130 → 白字，否则黑字。
- **字体**：Windows 系统字体随机（Calibri/Arial/Segoe/...），字号 36–50 px 在 96×96 画布上，降采样到 48×48 后文字占 40–55% 宽度。
- **边角色块**（60%）：一整条异色带（4–16 px 宽），覆盖某个完整边，模拟邻格颜色渗透。
- **水印**（30%）：大字中文（"小红书"等）在 5× 画布上渲染后随机裁剪回 cell，alpha 25–60，可能部分遮盖文字。
- **高斯模糊**：始终应用，radius 0.5–1.5（真实 cell 不锐利）。
- 额外：30% 追加 OpenCV 3×3 高斯模糊。
- 高斯噪声（40%）：σ ∈ [0, 4]
- JPEG 压缩（30%）：quality 60–90
- 亮度抖动（20%）：±10

`ocr_core/models/synth_generator.py` 已实现。生成时直接 `generate_dataset(n)` 返回 `Sample` 列表（`Sample.image` 为 (48, 48, 3) RGB ndarray）。（注：重写后 synth_generator 位于 `training/models/`，charset 复用 `ocr_core.charset`）

## 5. GPU 训练步骤

### 5.1 环境准备

```bash
# conda 环境（已有 bead-app）
conda activate bead-app

# GPU 版 PyTorch（按 CUDA 版本选；CUDA 11.8 兼容大多数卡）
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118
# 或 CUDA 12.1：
# pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# 验证 GPU 可用
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

### 5.2 中等规模 baseline（先跑这个）

```bash
cd backend
python -m training.scripts.train_crnn \
    --synth-n 50000 \
    --epochs 30 \
    --batch-size 128 \
    --lr 1e-3 \
    --out checkpoints/crnn_v1.pt
```

**预期时间**（GPU）：约 30–60 分钟（一张 RTX 3060/4060 级别）。

**预期时间**（CPU）：约 6–10 小时，不推荐。

**预期精度**（baseline 阶段）：
- 合成验证集 exact_match_rate > 95%（CTC 在封闭字典上很容易学）
- **真实图（`training/data/real/stand`）exact_match_rate 30–50%** ← 这个数字才决定后续

### 5.3 真实图评估

训练完后：

```bash
cd backend
python -m training.scripts.eval_stand
```

输出格式：
```
image                                          exact%    cov%  corr/gt
----------------------------------------------------------------------------------------------
拼豆日记54..._来自小红书网页版.jpg              35.20%   42.10%   485/1378
比奇堡居民..._来自小红书网页版.jpg              28.50%   35.00%   320/1123
海牛高达..._来自小红书网页版.jpg                41.20%   48.50%   560/1360
----------------------------------------------------------------------------------------------
OVERALL exact_match_rate = 0.3483  (1365/3861)
```

### 5.4 接入线上

（注：重写后不再需要 backend/.env——模型经 `MODEL_ARTIFACT_DIR` 指向 `artifacts/models/current`，识别由内部 image_service 完成。）
```
OCR_ENGINE=crnn
CRNN_MODEL_PATH=checkpoints/crnn_v1.pt
```

（注：重写后启动方式为 `MODEL_ARTIFACT_DIR=artifacts/models/current python -m uvicorn image_service.app.main:app --port 8001`，Spring 通过 `POST /v1/tasks` 派发任务。）

## 6. 训练结果决策树

跑完 `eval_stand.py` 后看 OVERALL exact_match_rate：

| OVERALL | 决策 |
|---|---|
| **> 50%** | 加大数据：`--synth-n 200000 --epochs 50`，第 2 周进入 fine-tune 阶段（需要 20–30 张新图纸 + 标注） |
| **30–50%** | 中等规模已可行。**同步调整合成字体**：从你的真实图里截一张高分辨率原图，肉眼判断字体（看起来像 Arial？Helvetica？）。把匹配的字体加进 `synth_generator._FONT_CANDIDATES` 重新训。 |
| **15–30%** | 合成 vs 真实字体差异大。先解决字体问题（见 30–50% 行的步骤），再训。 |
| **< 15%** | 方案本身有问题。换路线：1) 用 TrOCR-small 替代 CRNN（需要 HF 在线下载）；2) 或者承认模型路线不可行，回到「多 OCR 投票 + 用户补」方案。 |

## 7. 第 2 周计划（baseline 数字 > 30% 才进入）

1. **收集 20–30 张新图纸 + 标注**（你提供，最好覆盖不同密度 / 颜色组合 / 大小）
2. **加入 fine-tune 流程**：`train_crnn.py` 加 `--real-dir <path>` 参数，加载真实图做 fine-tune（学习率降到 1e-4，冻结前 3 层 CNN）
3. **集成投票**：`bead_ocr.py` 加 `ensemble` 引擎，并发跑 EasyOCR + CRNN，意见一致的高置信，意见不一致的格子推到前端让用户选
4. **前端**：低置信度格子用半透明红框，点击弹出 code 候选

## 8. 文件清单

| 文件 | 状态 | 说明 |
|---|---|---|
| `backend/app/services/synth_generator.py` | ✅ 已写 | 合成数据生成 |
| `ocr_core/bead_ocr_crnn.py` | ✅ 已写 | CRNN 模型 + 字典约束 decode（自 training/models 平移，010） |
| `ocr_core/inference.py` | ✅ 已写 | 推理入口（crop → CRNN → 结果，F1 置信度修复） |
| `image_service/app/worker.py` | ✅ 已写 | 逐 cell 回调（009） |
| `server/.../service/PythonTaskDispatcher.kt` | ✅ 已写 | Spring → Python 派发（009 反向） |
| `training/models/__init__.py` | ✅ 已加 | 模型包 |
| `training/scripts/train_crnn.py` | ✅ 已写 | 训练脚本 |
| `training/scripts/eval_stand.py` | ✅ 已写 | 种子图基准评估 |
| `docs/bead_crnn_plan.md` | ✅ 本文件 | 方案文档 |

## 9. 常见问题

**Q: 训练时 loss 不下降？**
A: 检查 `--lr` 是否过小（默认 1e-3）。合成数据生成是否报错（看终端 `[train] generating...` 后是否立刻进入 epoch）。

**Q: 合成验证集 > 95% 但真实图 < 10%？**
A: Domain gap。**首要检查**：合成字符字号 vs 真实字符字号。当前合成降到 20–36 px 宽（字符高 ~10 px），如果真实字符更小（如 6 px），把 `_render_cell` 的 `target_w` 改成 12–24 px 重训。

**Q: 推理时报 "CRNN checkpoint not found"？**
A: 检查 `CRNN_MODEL_PATH` 是否指向真实存在的 `.pt` 文件。训练脚本 `--out` 给的路径要和这个对齐。

**Q: GPU 显存不够？**
A: 降 `--batch-size` 到 64 或 32。模型本身只占 ~15MB。

**Q: 真实图字体识别错了，但合成验证集很高？**
A: 字体不匹配。**关键**：从你 3 张示例图里截一张最高分辨率的（比如 `training/data/real/stand/拼豆日记54...jpg`），肉眼判断字形最像哪个开源字体（DejaVu Sans？Arial？），把对应字体文件路径加到 `_FONT_CANDIDATES` 列表前面。

## 10. 给我回的最小信息

训练 + 评估完后，回我三件事：
1. `eval_stand.py` 的 OVERALL 数字 + 三张图各自的数字
2. 训练最终 loss 和 val 精度
3. 任何报错或异常截图

根据这些数字决定第 2 周走法。