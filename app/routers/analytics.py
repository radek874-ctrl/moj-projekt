import sqlite3
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.db import from_cents, get_db
from app.filters import ExpenseFilters
from app.schemas import CategoryStat, Expense, MonthlyStat, Summary
from app.routers.expenses import _row_to_expense

router = APIRouter(prefix="/analytics", tags=["analiza"])

Db = Annotated[sqlite3.Connection, Depends(get_db)]
Filters = Annotated[ExpenseFilters, Depends()]


@router.get("/summary", response_model=Summary)
def summary(db: Db, filters: Filters):
    """Podsumowanie: suma, liczba, średnia, min/max i średnia dzienna."""
    where, params = filters.where()
    row = db.execute(
        f"""SELECT COUNT(*) AS cnt, SUM(amount_cents) AS total, MIN(amount_cents) AS mn,
                   MAX(amount_cents) AS mx, MIN(date) AS first, MAX(date) AS last
            FROM expenses{where}""",
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


@router.get("/by-category", response_model=list[CategoryStat])
def by_category(db: Db, filters: Filters):
    """Wydatki pogrupowane po kategoriach, posortowane malejąco wg sumy."""
    where, params = filters.where()
    rows = db.execute(
        f"""SELECT category, COUNT(*) AS cnt, SUM(amount_cents) AS total
            FROM expenses{where} GROUP BY category ORDER BY total DESC, category""",
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


@router.get("/monthly", response_model=list[MonthlyStat])
def monthly(db: Db, filters: Filters):
    """Sumy miesięczne wraz ze zmianą procentową miesiąc do miesiąca."""
    where, params = filters.where()
    rows = db.execute(
        f"""SELECT substr(date, 1, 7) AS month, COUNT(*) AS cnt, SUM(amount_cents) AS total
            FROM expenses{where} GROUP BY month ORDER BY month""",
        params,
    ).fetchall()
    result, previous = [], None
    for r in rows:
        change = (
            round(100 * (r["total"] - previous) / previous, 2) if previous else None
        )
        result.append(
            MonthlyStat(month=r["month"], count=r["cnt"], total=from_cents(r["total"]),
                        change_percent=change)
        )
        previous = r["total"]
    return result


@router.get("/top", response_model=list[Expense])
def top_expenses(db: Db, filters: Filters, limit: int = Query(default=10, ge=1, le=100)):
    """Największe pojedyncze wydatki."""
    where, params = filters.where()
    rows = db.execute(
        f"SELECT * FROM expenses{where} ORDER BY amount_cents DESC, date DESC LIMIT ?",
        [*params, limit],
    ).fetchall()
    return [_row_to_expense(r) for r in rows]
