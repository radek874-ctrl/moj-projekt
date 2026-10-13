"""Stałe opłaty i przychody (gaz, prąd, kredyt, wynagrodzenie...).

Szablon opisuje typową kwotę i dzień płatności. Co miesiąc oznaczasz go jako
zapłacony (POST /recurring/{id}/pay) — powstaje wtedy zwykły wydatek/przychód
powiązany z szablonem, więc status "zapłacone" wynika z danych, a cofnięcie
to po prostu usunięcie tej operacji.
"""

import sqlite3
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.db import TABLES, from_cents, get_db, to_cents
from app.routers.transactions import insert_transaction, row_to_transaction
from app.schemas import (
    MONTH_PATTERN, BookRequest, Kind, Recurring, RecurringCreate, RecurringStatus,
    RecurringUpdate, Transaction, TransactionCreate,
)

router = APIRouter(prefix="/recurring", tags=["stałe opłaty"])

Db = Annotated[sqlite3.Connection, Depends(get_db)]


def _current_month() -> str:
    return date.today().strftime("%Y-%m")


def _to_model(row: sqlite3.Row) -> Recurring:
    return Recurring(id=row["id"], kind=row["kind"], name=row["name"], category=row["category"],
                     amount=from_cents(row["amount_cents"]), day=row["day"])


def _get_or_404(db: sqlite3.Connection, recurring_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM recurring WHERE id = ?", (recurring_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono stałej opłaty")
    return row


def _booked(db: sqlite3.Connection, row: sqlite3.Row, month: str) -> sqlite3.Row | None:
    return db.execute(
        f"SELECT * FROM {TABLES[row['kind']]} WHERE recurring_id = ? AND substr(date, 1, 7) = ? "
        f"ORDER BY id LIMIT 1",
        (row["id"], month),
    ).fetchone()


@router.get("", response_model=list[RecurringStatus], summary="Lista ze statusem na miesiąc")
def list_recurring(
    db: Db,
    month: Annotated[str | None, Query(pattern=MONTH_PATTERN,
                                       description="Miesiąc RRRR-MM (domyślnie bieżący)")] = None,
):
    """Wszystkie stałe pozycje z informacją, czy w danym miesiącu są już zapłacone."""
    month = month or _current_month()
    result = []
    for row in db.execute("SELECT * FROM recurring ORDER BY kind, day, name"):
        paid = _booked(db, row, month)
        result.append(RecurringStatus(
            **_to_model(row).model_dump(), month=month, paid=paid is not None,
            transaction_id=paid["id"] if paid else None,
            paid_amount=from_cents(paid["amount_cents"]) if paid else None,
        ))
    return result


@router.post("", response_model=Recurring, status_code=status.HTTP_201_CREATED,
             summary="Dodaj stałą opłatę lub przychód")
def create_recurring(data: RecurringCreate, db: Db):
    cur = db.execute(
        "INSERT INTO recurring (kind, name, category, amount_cents, day) VALUES (?, ?, ?, ?, ?)",
        (data.kind.value, data.name, data.category, to_cents(data.amount), data.day),
    )
    return _to_model(_get_or_404(db, cur.lastrowid))


@router.patch("/{recurring_id}", response_model=Recurring, summary="Zmień")
def update_recurring(recurring_id: int, data: RecurringUpdate, db: Db):
    _get_or_404(db, recurring_id)
    changes = data.model_dump(exclude_unset=True, exclude_none=True)
    if "name" in changes:
        changes["name"] = changes["name"].strip()
    if "amount" in changes:
        changes["amount_cents"] = to_cents(changes.pop("amount"))
    if changes:
        sets = ", ".join(f"{k} = ?" for k in changes)
        db.execute(f"UPDATE recurring SET {sets} WHERE id = ?", [*changes.values(), recurring_id])
    return _to_model(_get_or_404(db, recurring_id))


@router.delete("/{recurring_id}", status_code=status.HTTP_204_NO_CONTENT,
               summary="Usuń (zaksięgowane operacje zostają)")
def delete_recurring(recurring_id: int, db: Db):
    _get_or_404(db, recurring_id)
    for table in TABLES.values():
        db.execute(f"UPDATE {table} SET recurring_id = NULL WHERE recurring_id = ?", (recurring_id,))
    db.execute("DELETE FROM recurring WHERE id = ?", (recurring_id,))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{recurring_id}/pay", response_model=Transaction, status_code=status.HTTP_201_CREATED,
             summary="Oznacz jako zapłacone w miesiącu")
def pay(recurring_id: int, db: Db, data: BookRequest | None = None):
    """Tworzy wydatek (lub przychód) z szablonu, z datą = dzień płatności w danym miesiącu.

    Kwotę można podać, gdy rachunek jest inny niż zwykle. Zwraca 409, jeśli w tym
    miesiącu pozycja jest już zapłacona.
    """
    data = data or BookRequest()
    row = _get_or_404(db, recurring_id)
    month = data.month or _current_month()
    if _booked(db, row, month):
        raise HTTPException(status.HTTP_409_CONFLICT, "W tym miesiącu już zapłacone")
    kind = Kind(row["kind"])
    transaction = TransactionCreate(
        amount=data.amount if data.amount is not None else from_cents(row["amount_cents"]),
        category=row["category"],
        description=row["name"],
        date=f"{month}-{row['day']:02d}",
    )
    new_id = insert_transaction(db, kind, transaction, recurring_id=recurring_id)
    created = db.execute(f"SELECT * FROM {TABLES[kind.value]} WHERE id = ?", (new_id,)).fetchone()
    return row_to_transaction(created)
