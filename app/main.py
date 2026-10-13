from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.db import init_db
from app.routers import analytics, budgets, expenses

STATIC_DIR = Path(__file__).parent / "static"


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


# --- Interfejs aplikacji (PWA) ---
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    # Service worker musi być serwowany z katalogu głównego, żeby obejmował całą aplikację.
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache"})
