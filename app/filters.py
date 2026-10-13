from dataclasses import dataclass
from datetime import date

from fastapi import Query


@dataclass
class DateFilters:
    """Zakres dat wspólny dla list i analiz."""

    date_from: date | None = Query(default=None, description="Data początkowa (włącznie)")
    date_to: date | None = Query(default=None, description="Data końcowa (włącznie)")

    def clauses(self) -> tuple[list[str], list]:
        clauses, params = [], []
        if self.date_from:
            clauses.append("date >= ?")
            params.append(self.date_from.isoformat())
        if self.date_to:
            clauses.append("date <= ?")
            params.append(self.date_to.isoformat())
        return clauses, params

    def where(self) -> tuple[str, list]:
        clauses, params = self.clauses()
        return (" WHERE " + " AND ".join(clauses)) if clauses else "", params


@dataclass
class TransactionFilters(DateFilters):
    """Zakres dat + kategoria."""

    category: str | None = Query(default=None, description="Kategoria")

    def clauses(self) -> tuple[list[str], list]:
        clauses, params = super().clauses()
        if self.category:
            clauses.append("category = ?")
            params.append(self.category.strip().lower())
        return clauses, params


ExpenseFilters = TransactionFilters  # zgodność wstecz
