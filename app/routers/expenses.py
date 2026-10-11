import csv
import io
import sqlite3
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, UploadFile, status
from pydantic import ValidationError

from app.db import from_cents, get_db, to_cents
from app.filters import ExpenseFilters
from app.schemas import Expense, ExpenseCreate, ExpenseUpdate, ImportResult

router = APIRouter(prefix="/expenses", tags=["wydatki"])

Db = Annotated[sqlite3.Connection, Depends(get_db)]


def _row_to_expense(row: sqlite3.Row) -> Expense:
    return Expense(
        id=row["id"],
        amount=from_cents(row["amount_cents"]),
        category=row["category"],
        description=row["description"],
        date=row["date"],
    )


def _get_or_404(db: sqlite3.Connection, expense_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM expenses WHERE id = ?", (expense_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono wydatku")
    return row


def _insert(db: sqlite3.Connection, data: ExpenseCreate) -> int:
    cur = db.execute(
        "INSERT INTO expenses (amount_cents, category, description, date) VALUES (?, ?, ?, ?)",
        (to_cents(data.amount), data.category, data.description, data.date.isoformat()),
    )
    return cur.lastrowid


@router.post("", response_model=Expense, status_code=status.HTTP_201_CREATED)
def create_expense(data: ExpenseCreate, db: Db):
    expense_id = _insert(db, data)
    return _row_to_expense(_get_or_404(db, expense_id))


@router.get("", response_model=list[Expense])
def list_expenses(
    db: Db,
    filters: Annotated[ExpenseFilters, Depends()],
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    where, params = filters.where()
    rows = db.execute(
        f"SELECT * FROM expenses{where} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()
    return [_row_to_expense(r) for r in rows]


@router.get("/{expense_id}", response_model=Expense)
def get_expense(expense_id: int, db: Db):
    return _row_to_expense(_get_or_404(db, expense_id))


@router.patch("/{expense_id}", response_model=Expense)
def update_expense(expense_id: int, data: ExpenseUpdate, db: Db):
    _get_or_404(db, expense_id)
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
        db.execute(f"UPDATE expenses SET {sets} WHERE id = ?", [*values, expense_id])
    return _row_to_expense(_get_or_404(db, expense_id))


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_expense(expense_id: int, db: Db):
    _get_or_404(db, expense_id)
    db.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/import", response_model=ImportResult)
async def import_csv(file: UploadFile, db: Db):
    """Import wydatków z pliku CSV.

    Wymagane kolumny: ``date`` (RRRR-MM-DD), ``amount``, ``category``;
    opcjonalnie ``description``. Separator: przecinek lub średnik.
    Kwota może używać przecinka jako separatora dziesiętnego.
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
        try:
            data = ExpenseCreate(
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
        _insert(db, data)
        imported += 1
    return ImportResult(imported=imported, errors=errors)
