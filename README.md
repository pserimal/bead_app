# 🧩 拼豆助手

拼豆助手是一个基于计算机视觉的拼豆图案设计与管理应用。用户可以通过上传图片，自动识别颜色并生成拼豆蓝图。

## 功能特性

- 📸 图片上传与颜色识别（基于 EasyOCR + OpenCV）
- 🎨 自动生成拼豆蓝图
- 📋 拼豆项目管理
- 🔍 历史蓝图检索

## 技术栈

### 后端
- **FastAPI** - Web 框架
- **SQLAlchemy** + **asyncpg** - 数据库 ORM
- **Alembic** - 数据库迁移
- **OpenCV** + **EasyOCR** - 图像处理
- **Pytest** - 测试框架

### 前端
- **React 18** + **TypeScript**
- **Vite** - 构建工具
- **React Router** - 路由管理
- **TanStack React Query** - 数据请求
- **Axios** - HTTP 客户端
- **Tailwind CSS** - 样式框架
- **Vitest** - 单元测试

## 前置要求

- [Miniconda / Conda](https://docs.conda.io/) (Python 环境管理)
- [Node.js](https://nodejs.org/) (>= 18)
- [PostgreSQL](https://www.postgresql.org/) (本地开发数据库)

## 快速开始

### 1. 克隆项目

```bash
git clone <repository-url>
cd ai_dou
```

### 2. 后端设置

```bash
# 创建 Conda 环境
conda env create -f backend/environment.yml

# 激活环境
conda activate bead-app

# 启动开发服务器
cd backend
uvicorn app.main:app --reload --port 8000
```

### 3. 前端设置

```bash
cd frontend
npm install
npm run dev
```

### 4. 访问应用

- 前端: http://localhost:5173
- API 文档: http://localhost:8000/docs

## 项目结构

```
ai_dou/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   └── main.py          # FastAPI 应用入口
│   ├── tests/
│   │   ├── __init__.py
│   │   └── test_app.py      # API 测试
│   └── environment.yml      # Conda 环境定义
├── frontend/
│   └── ...                  # Vite React 前端
├── .gitignore
└── README.md
```

## 数据库配置

默认连接配置:
- 用户名: `admin`
- 密码: `123456`
- 数据库: `bead_app`
- 主机: `localhost`
