"""Warstwa dostępu do bazy SQLite.

Kwoty przechowywane są jako liczby całkowite w groszach (``amount_cents``),
żeby uniknąć błędów zaokrągleń typowych dla liczb zmiennoprzecinkowych.
"""

import os
import sqlite3
from collections.abc import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    category     TEXT    NOT NULL,
    description  TEXT    NOT NULL DEFAULT '',
    date         TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);

CREATE TABLE IF NOT EXISTS budgets (
    category            TEXT PRIMARY KEY,
    monthly_limit_cents INTEGER NOT NULL CHECK (monthly_limit_cents > 0)
);
"""


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
