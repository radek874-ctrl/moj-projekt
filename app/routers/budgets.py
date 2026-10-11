import re
import sqlite3
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.db import from_cents, get_db, to_cents
from app.schemas import Budget, BudgetIn, BudgetStatus

router = APIRouter(prefix="/budgets", tags=["budżety"])

Db = Annotated[sqlite3.Connection, Depends(get_db)]

MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def _norm(category: str) -> str:
    category = category.strip().lower()
    if not category:
        raise HTTPException(422, "Pusta kategoria")
    return category


@router.get("", response_model=list[Budget])
def list_budgets(db: Db):
    rows = db.execute("SELECT * FROM budgets ORDER BY category").fetchall()
    return [Budget(category=r["category"], monthly_limit=from_cents(r["monthly_limit_cents"]))
            for r in rows]


@router.get("/status", response_model=list[BudgetStatus])
def budget_status(
    db: Db,
    month: str | None = Query(default=None, description="Miesiąc RRRR-MM (domyślnie bieżący)"),
):
    """Wykorzystanie budżetów w danym miesiącu."""
    month = month or date.today().strftime("%Y-%m")
    if not MONTH_RE.match(month):
        raise HTTPException(422, "Miesiąc musi mieć format RRRR-MM")
    rows = db.execute(
        """SELECT b.category, b.monthly_limit_cents AS lim,
                  COALESCE(SUM(e.amount_cents), 0) AS spent
           FROM budgets b
           LEFT JOIN expenses e
             ON e.category = b.category AND substr(e.date, 1, 7) = ?
           GROUP BY b.category ORDER BY b.category""",
        (month,),
    ).fetchall()
    return [
        BudgetStatus(
            category=r["category"],
            monthly_limit=from_cents(r["lim"]),
            spent=from_cents(r["spent"]),
            remaining=from_cents(r["lim"] - r["spent"]),
            used_percent=round(100 * r["spent"] / r["lim"], 2),
            exceeded=r["spent"] > r["lim"],
        )
        for r in rows
    ]


@router.put("/{category}", response_model=Budget)
def set_budget(category: str, data: BudgetIn, db: Db):
    """Ustawia (lub nadpisuje) miesięczny limit dla kategorii."""
    category = _norm(category)
    db.execute(
        """INSERT INTO budgets (category, monthly_limit_cents) VALUES (?, ?)
           ON CONFLICT(category) DO UPDATE SET monthly_limit_cents = excluded.monthly_limit_cents""",
        (category, to_cents(data.monthly_limit)),
    )
    return Budget(category=category, monthly_limit=float(data.monthly_limit))


@router.delete("/{category}", status_code=status.HTTP_204_NO_CONTENT)
def delete_budget(category: str, db: Db):
    cur = db.execute("DELETE FROM budgets WHERE category = ?", (_norm(category),))
    if cur.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Brak budżetu dla tej kategorii")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
