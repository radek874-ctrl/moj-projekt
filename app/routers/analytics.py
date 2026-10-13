"""Statystyki wydatków lub przychodów (parametr ``kind``) oraz bilans domowy."""

import sqlite3
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.db import TABLES, from_cents, get_db
from app.filters import DateFilters, TransactionFilters
from app.routers.transactions import row_to_transaction
from app.schemas import Balance, BalanceMonth, CategoryStat, Kind, MonthlyStat, Summary, Transaction

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
