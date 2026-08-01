---
id: 005
title: 数据、颜色库快照与部署边界
labels: [wayfinder:grilling]
state: closed
parent: 000
blocked_by: []
assignee: assistant
---

## Question

数据库、图片、颜色库、模型和部署环境分别由谁负责？

## Resolution

Spring Boot 独占 PostgreSQL 和原图存储；Python 只保留临时副本。新库从 Flyway 初始 schema 开始，使用 Spring Data JPA + Hibernate + JDBC。默认颜色库是 Spring Boot 的 seed 资源；任务创建时快照颜色库编码，Blueprint 保存识别时的颜色信息快照。首版使用 Docker Compose；模型以固定 artifact 交付，本地开发可只读挂载 checkpoint。首版不迁移旧业务数据。
