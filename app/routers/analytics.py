"""Statystyki wydatków lub przychodów (parametr ``kind``) oraz bilans domowy."""

import sqlite3
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query

from app import advisor
from app.db import TABLES, from_cents, get_db
from app.filters import DateFilters, TransactionFilters
from app.routers.transactions import row_to_transaction
from app.insights import compute_insights, suggest_category
from app.schemas import (
    MONTH_PATTERN, Balance, BalanceMonth, CategoryStat, CategorySuggestion, Comparison, FinancialReport,
    Insights, Kind, Merchant, MonthlyStat, Patterns, Subscriptions, Summary, Transaction, Trends,
)

router = APIRouter(prefix="/analytics", tags=["analiza"])

Db = Annotated[sqlite3.Connection, Depends(get_db)]
Filters = Annotated[TransactionFilters, Depends()]
KindParam = Annotated[Kind, Query(description="expense = wydatki (domyślnie), income = przychody")]


@router.get("/balance", response_model=Balance, summary="Bilans: przychody − wydatki")
def balance(db: Db, filters: Annotated[DateFilters, Depends()]):
    """Ile wpłynęło, ile wydano i ile zostało — łącznie i w podziale na miesiące."""
    where, params = filters.where()
    totals: dict[str, dict[str, int]] = {}
    for kind, table in TABLES.items():
        for r in db.execute(
            f"SELECT substr(date, 1, 7) AS month, SUM(amount_cents) AS total "
            f"FROM {table}{where} GROUP BY month",
            params,
        ):
            totals.setdefault(r["month"], {"expense": 0, "income": 0})[kind] = r["total"]

    income = sum(m["income"] for m in totals.values())
    expenses = sum(m["expense"] for m in totals.values())
    return Balance(
        income=from_cents(income),
        expenses=from_cents(expenses),
        balance=from_cents(income - expenses),
        savings_rate=round(100 * (income - expenses) / income, 2) if income else None,
        months=[
            BalanceMonth(month=month, income=from_cents(m["income"]),
                         expenses=from_cents(m["expense"]),
                         balance=from_cents(m["income"] - m["expense"]))
            for month, m in sorted(totals.items())
        ],
    )


@router.get("/summary", response_model=Summary, summary="Podsumowanie okresu")
def summary(db: Db, filters: Filters, kind: KindParam = Kind.expense):
    """Suma, liczba, średnia, min/max i średnia dzienna."""
    where, params = filters.where()
    row = db.execute(
        f"""SELECT COUNT(*) AS cnt, SUM(amount_cents) AS total, MIN(amount_cents) AS mn,
                   MAX(amount_cents) AS mx, MIN(date) AS first, MAX(date) AS last
            FROM {TABLES[kind.value]}{where}""",
        params,
    ).fetchone()
    count = row["cnt"]
    total = row["total"] or 0

    # Okres: jawnie podane granice mają pierwszeństwo przed zakresem danych.
    start = filters.date_from or (date.fromisoformat(row["first"]) if row["first"] else None)
    end = filters.date_to or (date.fromisoformat(row["last"]) if row["last"] else None)
    days = (end - start).days + 1 if start and end and end >= start else 0

    return Summary(
        count=count,
        total=from_cents(total),
        average=from_cents(total / count) if count else 0.0,
        min=from_cents(row["mn"]),
        max=from_cents(row["mx"]),
        date_from=start,
        date_to=end,
        daily_average=from_cents(total / days) if days else 0.0,
    )


@router.get("/by-category", response_model=list[CategoryStat], summary="Podział na kategorie")
def by_category(db: Db, filters: Filters, kind: KindParam = Kind.expense):
    """Sumy w kategoriach, malejąco, z udziałem procentowym."""
    where, params = filters.where()
    rows = db.execute(
        f"""SELECT category, COUNT(*) AS cnt, SUM(amount_cents) AS total
            FROM {TABLES[kind.value]}{where} GROUP BY category ORDER BY total DESC, category""",
        params,
    ).fetchall()
    grand_total = sum(r["total"] for r in rows)
    return [
        CategoryStat(
            category=r["category"],
            count=r["cnt"],
            total=from_cents(r["total"]),
            average=from_cents(r["total"] / r["cnt"]),
            share_percent=round(100 * r["total"] / grand_total, 2) if grand_total else 0.0,
        )
        for r in rows
    ]


@router.get("/monthly", response_model=list[MonthlyStat], summary="Sumy miesięczne")
def monthly(db: Db, filters: Filters, kind: KindParam = Kind.expense):
    """Sumy miesięczne wraz ze zmianą procentową miesiąc do miesiąca."""
    where, params = filters.where()
    rows = db.execute(
        f"""SELECT substr(date, 1, 7) AS month, COUNT(*) AS cnt, SUM(amount_cents) AS total
            FROM {TABLES[kind.value]}{where} GROUP BY month ORDER BY month""",
        params,
    ).fetchall()
    result, previous = [], None
    for r in rows:
        change = round(100 * (r["total"] - previous) / previous, 2) if previous else None
        result.append(MonthlyStat(month=r["month"], count=r["cnt"],
                                  total=from_cents(r["total"]), change_percent=change))
        previous = r["total"]
    return result


@router.get("/top", response_model=list[Transaction], summary="Największe pozycje")
def top(db: Db, filters: Filters, kind: KindParam = Kind.expense,
        limit: int = Query(default=10, ge=1, le=100)):
    where, params = filters.where()
    rows = db.execute(
        f"SELECT * FROM {TABLES[kind.value]}{where} ORDER BY amount_cents DESC, date DESC LIMIT ?",
        [*params, limit],
    ).fetchall()
    return [row_to_transaction(r) for r in rows]


@router.get("/insights", response_model=Insights, summary="Inteligentne podpowiedzi i prognoza")
def insights(db: Db):
    """Prognoza bilansu na koniec miesiąca oraz podpowiedzi: zagrożone limity, skoki wydatków
    w kategoriach, nietypowo duże wydatki, nadchodzące koszty z kalendarza, ocena oszczędzania.
    Liczone lokalnie, bez AI."""
    return compute_insights(db, date.today())


@router.get("/suggest-category", response_model=CategorySuggestion, summary="Podpowiedz kategorię z opisu")
def suggest(db: Db, text: Annotated[str, Query(max_length=255, description="Opis, np. „Orlen”")],
            kind: KindParam = Kind.expense):
    """Najpierw szuka podobnych opisów w Twoich wpisach, potem w słowniku (Biedronka → jedzenie,
    Orlen → paliwo, Tauron → prąd...)."""
    return suggest_category(db, text, kind.value)


# ---------- doradca finansowy ----------

MonthParam = Annotated[str | None, Query(pattern=MONTH_PATTERN, description="Miesiąc RRRR-MM")]


def _current_month() -> str:
    return date.today().strftime("%Y-%m")


@router.get("/report", response_model=FinancialReport, summary="Raport kondycji finansów")
def financial_report(db: Db, month: MonthParam = None,
                     savings: float = Query(default=0, ge=0, le=100_000_000,
                                            description="Oszczędności poza aplikacją (zł), doliczane do celów")):
    """Pełny obraz finansów w jednym zapytaniu: przychody i wydatki miesiąca na tle poprzednich,
    średnie z 3 pełnych miesięcy, podział na potrzeby/przyjemności/oszczędności (zasada 50/30/20),
    koszty stałe, raty kredytów względem przychodów (DTI), poduszka finansowa (odłożone w celach
    w miesiącach wydatków), kategorie z odchyleniem od normy, **ocena kondycji 0–100**
    z rozbiciem na składniki i konkretne rekomendacje z kwotami."""
    return advisor.report(db, month or _current_month(), date.today(), advisor.half_up(savings * 100))


@router.get("/trends", response_model=Trends, summary="Trendy kategorii miesiąc po miesiącu")
def category_trends(db: Db, kind: KindParam = Kind.expense,
                    months: int = Query(default=6, ge=3, le=24, description="Ile ostatnich miesięcy")):
    """Sumy kategorii w kolejnych miesiącach (ostatni = bieżący, niepełny), średnia z pełnych
    miesięcy i kierunek zmian (up / down / flat / new) wg linii trendu."""
    return advisor.trends(db, kind.value, months, date.today())


@router.get("/compare", response_model=Comparison, summary="Porównanie dwóch miesięcy")
def compare_months(db: Db, a: MonthParam = None, b: MonthParam = None, kind: KindParam = Kind.expense):
    """Różnice w kategoriach między miesiącem `a` (domyślnie poprzedni) i `b` (domyślnie bieżący),
    od największej zmiany."""
    b = b or _current_month()
    return advisor.compare(db, kind.value, a or advisor.month_shift(b, -1), b)


@router.get("/merchants", response_model=list[Merchant], summary="Gdzie wydajesz najwięcej")
def top_merchants(db: Db, filters: Annotated[DateFilters, Depends()], kind: KindParam = Kind.expense,
                  limit: int = Query(default=20, ge=1, le=100)):
    """Wpisy zgrupowane po opisie (sklep, firma), od największej sumy."""
    return advisor.merchants(db, kind.value, filters.date_from and filters.date_from.isoformat(),
                             filters.date_to and filters.date_to.isoformat(), limit)


@router.get("/subscriptions", response_model=Subscriptions, summary="Wykryte stałe płatności")
def detected_subscriptions(db: Db):
    """Powtarzające się co miesiąc płatności o podobnej kwocie (abonamenty, raty, składki) z
    ostatnich 12 miesięcy, wpisywane ręcznie – z kosztem rocznym i informacją, czy są już na
    liście stałych opłat."""
    return advisor.subscriptions(db, date.today())


@router.get("/patterns", response_model=Patterns, summary="Nawyki zakupowe")
def spending_patterns(db: Db, filters: Annotated[DateFilters, Depends()],
                      small_limit: float = Query(default=50, gt=0, le=10000,
                                                 description="Próg „drobnego” wydatku w zł")):
    """Wydatki wg dnia tygodnia, udział weekendu, części miesiąca i drobnych zakupów
    (domyślnie ostatnie 90 dni)."""
    today = date.today()
    date_to = filters.date_to or today
    date_from = filters.date_from or (date_to - timedelta(days=89))
    if date_from > date_to:
        raise HTTPException(422, "date_from musi być przed date_to")
    return advisor.patterns(db, date_from.isoformat(), date_to.isoformat(), advisor.half_up(small_limit * 100))
