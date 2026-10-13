from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from app.db import init_db
from app.routers import analytics, budgets, recurring, transactions

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


TAGS = [
    {"name": "wydatki", "description": "Pojedyncze wydatki: dodawanie, lista z filtrami, edycja, import CSV."},
    {"name": "przychody", "description": "Wpływy do budżetu domowego (wynagrodzenie, premie, zasiłki...). "
                                         "Te same operacje co dla wydatków."},
    {"name": "stałe opłaty", "description": "Co miesiąc powtarzające się pozycje (gaz, prąd, kredyt, pensja). "
                                            "Jedno wywołanie `/pay` księguje je w danym miesiącu."},
    {"name": "analiza", "description": "Bilans domowy oraz statystyki wydatków lub przychodów (`kind`)."},
    {"name": "budżety", "description": "Miesięczne limity wydatków na kategorie."},
    {"name": "system", "description": "Stan usługi."},
]

app = FastAPI(
    title="Budżet domowy – API",
    description=(
        "Przychody, wydatki, stałe opłaty, budżety i analiza.\n\n"
        "Kwoty w złotych (maks. 2 miejsca po przecinku), daty w formacie `RRRR-MM-DD`, "
        "miesiące `RRRR-MM`. Kategorie są zapisywane małymi literami."
    ),
    version="2.0.0",
    lifespan=lifespan,
    openapi_tags=TAGS,
)

app.include_router(transactions.expenses_router)
app.include_router(transactions.incomes_router)
app.include_router(recurring.router)
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
