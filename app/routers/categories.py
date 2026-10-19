"""Kategorie: przegląd użycia oraz zmiana nazwy / scalanie (np. po literówce)."""

import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.db import TABLES, from_cents, get_db
from app.schemas import CategoryInfo, CategoryRename, RenameResult

router = APIRouter(prefix="/categories", tags=["kategorie"])

Db = Annotated[sqlite3.Connection, Depends(get_db)]


@router.get("", response_model=list[CategoryInfo], summary="Używane kategorie")
def list_categories(db: Db):
    """Kategorie wydatków i przychodów z liczbą wpisów i sumą, najczęściej używane pierwsze."""
    result = []
    for kind, table in TABLES.items():
        for r in db.execute(
            f"SELECT category, COUNT(*) AS cnt, SUM(amount_cents) AS total FROM {table} "
            f"GROUP BY category ORDER BY cnt DESC, category"
        ):
            result.append(CategoryInfo(kind=kind, category=r["category"], count=r["cnt"],
                                       total=from_cents(r["total"])))
    return result


@router.post("/rename", response_model=RenameResult, summary="Zmień nazwę lub scal kategorie")
def rename_category(data: CategoryRename, db: Db):
    """Zmienia kategorię we wpisach, stałych pozycjach, terminach i limitach.
    Jeśli docelowa kategoria już istnieje, kategorie zostają scalone
    (przy konflikcie limitów zostaje limit kategorii docelowej)."""
    if data.old == data.new:
        raise HTTPException(422, "Nowa nazwa jest taka sama jak stara")
    table = TABLES[data.kind.value]
    updated = db.execute(f"UPDATE {table} SET category = ? WHERE category = ?", (data.new, data.old)).rowcount
    db.execute("UPDATE recurring SET category = ? WHERE category = ? AND kind = ?",
               (data.new, data.old, data.kind.value))
    if data.kind.value == "expense":
        db.execute("UPDATE events SET category = ? WHERE category = ?", (data.new, data.old))
        if db.execute("SELECT 1 FROM budgets WHERE category = ?", (data.new,)).fetchone():
            db.execute("DELETE FROM budgets WHERE category = ?", (data.old,))
        else:
            db.execute("UPDATE budgets SET category = ? WHERE category = ?", (data.new, data.old))
    return RenameResult(updated=updated)
