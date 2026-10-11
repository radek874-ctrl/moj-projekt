from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import init_db
from app.routers import analytics, budgets, expenses


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="API do analizy wydatków",
    description="Rejestrowanie wydatków, import CSV, statystyki i kontrola budżetów.",
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(expenses.router)
app.include_router(analytics.router)
app.include_router(budgets.router)


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok"}
