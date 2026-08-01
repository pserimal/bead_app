---
id: 006
title: React 前端与新版 REST API 范围
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

前端和对外 API 在一次性重写中的兼容与交互范围是什么？

## Resolution

保留 React + TypeScript + Vite，重写 API client、类型、hooks 和相关页面。上传页面改为单图纸裁剪框、行列数、颜色库和可选图纸级编码；文件选择不再自动触发识别。新 API 使用资源导向的 `/api/v1`，不兼容旧接口。历史页展示全部 RecognitionJob 并支持筛选；前端通过 React Query 轮询 Spring Boot，成功后查看 Blueprint。
