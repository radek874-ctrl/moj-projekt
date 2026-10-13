from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import Response
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
@app.get("/config.js", include_in_schema=False)
def frontend_config():
    # Ta sama aplikacja działa też bez serwera (GitHub Pages, dane w przeglądarce);
    # serwowana stąd ma korzystać z API.
    return Response('window.APP_MODE = "server";\n', media_type="application/javascript",
                    headers={"Cache-Control": "no-cache"})


# Pliki aplikacji serwowane z katalogu głównego (index.html pod "/").
# Montowane na końcu, żeby nie przesłaniały tras API.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
