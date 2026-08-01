---
id: 011
title: 迁移前 CRNN 用户裁剪基线与验收方法
labels: [wayfinder:task]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

在删除旧 backend 前，使用用户裁剪路径和现有 `crnn_v2.pt` 建立可重复的识别基线：确定样本、标签、准确率/UNKNOWN 率/置信度/耗时指标、结果保存位置和新 Python 服务的“不低于基线”验收规则。

## Resolution

（task 已实际执行：脚本 `training/scripts/eval_cell_baseline.py`、报告 `training/docs/baseline-2026-07-31.md`、指标 `baseline-2026-07-31.json` + `-sweep.json`，均位于主仓库；由 `/worker` subagent 在 `bead-train` env 实测）

### 样本与标签

- zip 集：`../../../training/samples/stand/标注结果/1_标注结果_2026-07-26.zip` 的 7630 个 48×48 cell，标签来自 manifest.csv「编码」列（23 个编码）。
- dir 集：`../../../training/samples/stand/cells/` 50 格，标签来自文件名（含 OOD 编码，仅记录不作验收）。
- 关键事实：zip 集与 Experiment 001 训练集同源（逐字节相同）→ 本基线是训练分布内能力，非独立泛化；带网格坐标的 GT 缺失，只能做 cell 级评估。

### 基线 checkpoint

- **`crnn_real_m.pt`**（zip 集 exact_match 0.7008，10 个 checkpoint 中最高；次高 crnn_rm 0.4409）；num_classes=19。
- **`crnn_v2.pt` 不存在**（config 默认路径指向不存在的文件）——基线显式改用 crnn_real_m.pt。

### 基线数字（CPU）

| 集合 | n | exact_match (raw) | conf mean/p10/p90 | ms/cell |
|---|---|---|---|---|
| zip | 7630 | **0.7008** (5347/7630) | 0.0021/0.0001/0.0034 | 0.975 |
| dir | 50 | 0.0400 | 0.0068/... | 1.226 |

### 验收规则（新 Python image-service）

1. 硬门槛：zip 集 raw constrained exact_match **≥ 0.7008**（容差 ±0.005，确定性解码应可逐位复现 5347/7630）；
2. 23 个编码 per-code accuracy 不低丁基线（±0.02）；
3. UNKNOWN/min_conf 语义对齐（见 F1——旧公式会拒绝全部 cell，新服务必须修正或显式决策并说明）；
4. CPU 单 cell ≤ 2.0 ms；
5. 后续有网格坐标 GT 时追加图级 exact-match 基线（`eval_stand.py` 格式）。

### 阻断级发现（F1，必须带进实现）

运行时置信度公式 `exp(score/len(code))` 对 T=11 CRNN 失准（正确格 ~0.002），`min_conf=0.5` 拒绝全部 cell——旧 CRNN 路径实际无法产出结果。新服务必须修复置信度归一化（按平均每步 log-prob）。

复现命令与 sweep 对比表详见 `training/docs/baseline-2026-07-31.md`。
