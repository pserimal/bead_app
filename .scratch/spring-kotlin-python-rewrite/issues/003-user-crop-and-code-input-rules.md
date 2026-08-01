---
id: 003
title: 用户裁剪识别与编码输入规则
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

新系统保留哪条图像识别路径，以及用户提供的图纸级编码如何校验和保存？

## Resolution

只保留用户裁剪路径：原图、原始像素坐标裁剪框、行数和列数都是识别任务输入；自动网格检测、整图 OCR、图例 OCR 和双区域裁剪删除。编码格式为 `^[A-Za-z][0-9]{1,3}$`，接口统一转大写；前后端都校验格式，非法格式不创建任务。合法但不在颜色库的编码允许使用，仅标记 `UNMAPPED`；`validCodes` 只作为当前 RecognitionJob/Blueprint 的图纸级快照，不写回颜色库。
