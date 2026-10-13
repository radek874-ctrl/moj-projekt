"""Wydatki (/expenses) i przychody (/incomes).

Oba zasoby mają te same operacje, więc routery powstają z jednej fabryki.
"""

import csv
import io
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, UploadFile, status
from pydantic import ValidationError

from app.db import TABLES, from_cents, get_db, to_cents
from app.filters import TransactionFilters
from app.schemas import ImportResult, Kind, Transaction, TransactionCreate, TransactionUpdate

Db = Annotated[sqlite3.Connection, Depends(get_db)]

# Wartości kolumny "type" w CSV (eksport z aplikacji używa "wydatek"/"przychód").
CSV_TYPES = {
    "expense": Kind.expense, "wydatek": Kind.expense,
    "income": Kind.income, "przychód": Kind.income, "przychod": Kind.income,
}


def row_to_transaction(row: sqlite3.Row) -> Transaction:
    return Transaction(
        id=row["id"],
        amount=from_cents(row["amount_cents"]),
        category=row["category"],
        description=row["description"],
        date=row["date"],
        recurring_id=row["recurring_id"],
    )


def insert_transaction(db: sqlite3.Connection, kind: Kind, data: TransactionCreate,
                       recurring_id: int | None = None) -> int:
    cur = db.execute(
        f"""INSERT INTO {TABLES[kind.value]}
            (amount_cents, category, description, date, recurring_id) VALUES (?, ?, ?, ?, ?)""",
        (to_cents(data.amount), data.category, data.description, data.date.isoformat(), recurring_id),
    )
    return cur.lastrowid


def make_router(kind: Kind, prefix: str, tag: str, noun: str) -> APIRouter:
    """Tworzy router CRUD dla jednej tabeli. ``noun`` służy do komunikatów błędów."""
    table = TABLES[kind.value]
    router = APIRouter(prefix=prefix, tags=[tag])

    def get_or_404(db: sqlite3.Connection, item_id: int) -> sqlite3.Row:
        row = db.execute(f"SELECT * FROM {table} WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Nie znaleziono: {noun}")
        return row

    @router.post("", response_model=Transaction, status_code=status.HTTP_201_CREATED,
                 summary=f"Dodaj ({noun})")
    def create(data: TransactionCreate, db: Db):
        return row_to_transaction(get_or_404(db, insert_transaction(db, kind, data)))

    @router.get("", response_model=list[Transaction], summary="Lista (najnowsze pierwsze)")
    def list_items(
        db: Db,
        filters: Annotated[TransactionFilters, Depends()],
        limit: int = Query(default=100, ge=1, le=1000),
        offset: int = Query(default=0, ge=0),
    ):
        where, params = filters.where()
        rows = db.execute(
            f"SELECT * FROM {table}{where} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        return [row_to_transaction(r) for r in rows]

    @router.get("/{item_id}", response_model=Transaction, summary="Szczegóły")
    def get_item(item_id: int, db: Db):
        return row_to_transaction(get_or_404(db, item_id))

    @router.patch("/{item_id}", response_model=Transaction, summary="Zmień wybrane pola")
    def update(item_id: int, data: TransactionUpdate, db: Db):
        get_or_404(db, item_id)
        changes = data.model_dump(exclude_unset=True, exclude_none=True)
        columns = {
            "amount": ("amount_cents", to_cents),
            "category": ("category", str),
            "description": ("description", str),
            "date": ("date", lambda d: d.isoformat()),
        }
        if changes:
            sets = ", ".join(f"{columns[k][0]} = ?" for k in changes)
            values = [columns[k][1](v) for k, v in changes.items()]
            db.execute(f"UPDATE {table} SET {sets} WHERE id = ?", [*values, item_id])
        return row_to_transaction(get_or_404(db, item_id))

    @router.delete("/{item_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Usuń")
    def delete(item_id: int, db: Db):
        get_or_404(db, item_id)
        db.execute(f"DELETE FROM {table} WHERE id = ?", (item_id,))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post("/import", response_model=ImportResult, summary="Import z CSV")
    async def import_csv(file: UploadFile, db: Db):
        """Import z pliku CSV.

        Wymagane kolumny: ``date`` (RRRR-MM-DD), ``amount``, ``category``;
        opcjonalnie ``description`` i ``type`` (``wydatek``/``przychód``).
        Wiersze bez kolumny ``type`` trafiają do tego zasobu, do którego wysłano plik.
        Separator: przecinek lub średnik; kwota może mieć przecinek dziesiętny.
        Błędne wiersze są pomijane i zgłaszane w polu ``errors``.
        """
        try:
            text = (await file.read()).decode("utf-8-sig")
        except UnicodeDecodeError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Plik musi być zakodowany w UTF-8")

        try:
            dialect = csv.Sniffer().sniff(text.splitlines()[0] if text else "", delimiters=",;")
        except csv.Error:
            dialect = csv.excel
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)

        required = {"date", "amount", "category"}
        if not reader.fieldnames or not required.issubset(reader.fieldnames):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Brak wymaganych kolumn: {', '.join(sorted(required))}",
            )

        imported, errors = 0, []
        for line_no, row in enumerate(reader, start=2):
            row_kind = kind
            raw_type = (row.get("type") or "").strip().lower()
            if raw_type:
                if raw_type not in CSV_TYPES:
                    errors.append(f"wiersz {line_no}: nieznany typ „{raw_type}”")
                    continue
                row_kind = CSV_TYPES[raw_type]
            try:
                data = TransactionCreate(
                    date=row["date"].strip(),
                    amount=row["amount"].strip().replace(" ", "").replace(",", "."),
                    category=row["category"],
                    description=(row.get("description") or "").strip(),
                )
            except ValidationError as exc:
                details = "; ".join(
                    f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()
                )
                errors.append(f"wiersz {line_no}: {details}")
                continue
            except AttributeError:  # brakujące pola w wierszu (None zamiast tekstu)
                errors.append(f"wiersz {line_no}: niekompletny wiersz")
                continue
            insert_transaction(db, row_kind, data)
            imported += 1
        return ImportResult(imported=imported, errors=errors)

    return router


expenses_router = make_router(Kind.expense, "/expenses", "wydatki", "wydatek")
incomes_router = make_router(Kind.income, "/incomes", "przychody", "przychód")
