from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import engine
from app.models.base import Base
from app.seed import seed_default_colors

from app.api import blueprints, colors


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await seed_default_colors()
    yield
    await engine.dispose()


app = FastAPI(
    title="拼豆助手 API",
    description="Backend API for 拼豆 (Bead Blueprint) application",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(colors.router)
app.include_router(blueprints.router)


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": "1.0.0"}

