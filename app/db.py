"""Warstwa dostępu do bazy SQLite.

Kwoty przechowywane są jako liczby całkowite w groszach (``amount_cents``),
żeby uniknąć błędów zaokrągleń typowych dla liczb zmiennoprzecinkowych.
"""

import os
import sqlite3
from collections.abc import Iterator

# Wydatki i przychody mają identyczną strukturę, ale leżą w osobnych tabelach.
# Klucz to wartość parametru ``kind`` w API.
TABLES = {"expense": "expenses", "income": "incomes"}

_TRANSACTION_TABLE = """
CREATE TABLE IF NOT EXISTS {table} (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    category     TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    date         TEXT    NOT NULL,
    recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_{table}_date ON {table}(date);
CREATE INDEX IF NOT EXISTS idx_{table}_category ON {table}(category);
"""

SCHEMA = (
    """
CREATE TABLE IF NOT EXISTS recurring (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT    NOT NULL CHECK (kind IN ('expense', 'income')),
    name         TEXT    NOT NULL,
    category     TEXT    NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    day          INTEGER NOT NULL CHECK (day BETWEEN 1 AND 28)
);

CREATE TABLE IF NOT EXISTS budgets (
    category            TEXT PRIMARY KEY,
    monthly_limit_cents INTEGER NOT NULL CHECK (monthly_limit_cents > 0)
);
"""
    + "".join(_TRANSACTION_TABLE.format(table=t) for t in TABLES.values())
)


def db_path() -> str:
    return os.environ.get("EXPENSES_DB", "expenses.db")


def connect(path: str | None = None) -> sqlite3.Connection:
    # Połączenie żyje w obrębie jednego żądania, ale FastAPI może wywołać
    # zależność i endpoint (async) w różnych wątkach.
    conn = sqlite3.connect(path or db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(path: str | None = None) -> None:
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
        # Migracja baz sprzed wprowadzenia stałych opłat.
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(expenses)")}
        if "recurring_id" not in columns:
            conn.execute("ALTER TABLE expenses ADD COLUMN recurring_id INTEGER")
        conn.commit()
    finally:
        conn.close()


def get_db() -> Iterator[sqlite3.Connection]:
    """Zależność FastAPI: jedno połączenie na żądanie."""
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def to_cents(amount) -> int:
    return int(round(amount * 100))


def from_cents(cents: int | None) -> float:
    return round((cents or 0) / 100, 2)
