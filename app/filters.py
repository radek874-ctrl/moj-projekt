from dataclasses import dataclass
from datetime import date

from fastapi import Query


@dataclass
class ExpenseFilters:
    """Wspólne filtry dla listy wydatków i endpointów analitycznych."""

    date_from: date | None = Query(default=None, description="Data początkowa (włącznie)")
    date_to: date | None = Query(default=None, description="Data końcowa (włącznie)")
    category: str | None = Query(default=None, description="Kategoria")

    def where(self) -> tuple[str, list]:
        clauses, params = [], []
        if self.date_from:
            clauses.append("date >= ?")
            params.append(self.date_from.isoformat())
        if self.date_to:
            clauses.append("date <= ?")
            params.append(self.date_to.isoformat())
        if self.category:
            clauses.append("category = ?")
            params.append(self.category.strip().lower())
        sql = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        return sql, params
