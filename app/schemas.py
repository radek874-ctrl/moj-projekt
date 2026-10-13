"""Modele danych API (wejście i wyjście)."""

import datetime as dt
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field, field_validator

Amount = Decimal  # kwoty przyjmujemy jako Decimal (maks. 2 miejsca po przecinku)
MONTH_PATTERN = r"^\d{4}-(0[1-9]|1[0-2])$"


class Kind(str, Enum):
    """Rodzaj operacji."""

    expense = "expense"
    income = "income"


def _normalize_category(value: str) -> str:
    value = value.strip().lower()
    if not value:
        raise ValueError("kategoria nie może być pusta")
    return value


# ---------- wydatki i przychody ----------

class TransactionCreate(BaseModel):
    amount: Amount = Field(gt=0, max_digits=12, decimal_places=2, examples=[189.99])
    category: str = Field(min_length=1, max_length=50, examples=["prąd"])
    description: str = Field(default="", max_length=255, examples=["Rachunek za wrzesień"])
    date: dt.date

    _category = field_validator("category")(_normalize_category)


class TransactionUpdate(BaseModel):
    amount: Amount | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    category: str | None = Field(default=None, min_length=1, max_length=50)
    description: str | None = Field(default=None, max_length=255)
    date: dt.date | None = None

    @field_validator("category")
    @classmethod
    def _category(cls, v: str | None) -> str | None:
        return None if v is None else _normalize_category(v)


class Transaction(BaseModel):
    id: int
    amount: float
    category: str
    description: str
    date: dt.date
    recurring_id: int | None = Field(
        default=None, description="Stała opłata, z której powstała operacja (jeśli dotyczy)"
    )


# Nazwy zachowane dla czytelności i zgodności wstecz.
ExpenseCreate = TransactionCreate
ExpenseUpdate = TransactionUpdate
Expense = Transaction


class ImportResult(BaseModel):
    imported: int = Field(description="Liczba zaimportowanych wierszy (wydatki + przychody)")
    errors: list[str]


# ---------- analiza ----------

class Summary(BaseModel):
    count: int
    total: float
    average: float
    min: float
    max: float
    date_from: dt.date | None
    date_to: dt.date | None
    daily_average: float = Field(description="Średnia kwota na dzień w analizowanym okresie")


class CategoryStat(BaseModel):
    category: str
    count: int
    total: float
    average: float
    share_percent: float


class MonthlyStat(BaseModel):
    month: str = Field(examples=["2026-10"])
    count: int
    total: float
    change_percent: float | None = Field(
        description="Zmiana względem poprzedniego miesiąca w zestawieniu (null dla pierwszego)"
    )


class BalanceMonth(BaseModel):
    month: str = Field(examples=["2026-10"])
    income: float
    expenses: float
    balance: float = Field(description="Przychody minus wydatki")


class Balance(BaseModel):
    income: float = Field(description="Suma przychodów")
    expenses: float = Field(description="Suma wydatków")
    balance: float = Field(description="Przychody minus wydatki (ujemne = deficyt)")
    savings_rate: float | None = Field(
        description="Jaka część przychodów została (%); null, gdy brak przychodów"
    )
    months: list[BalanceMonth]


# ---------- stałe opłaty ----------

class RecurringCreate(BaseModel):
    kind: Kind = Field(default=Kind.expense, description="expense = opłata, income = stały przychód")
    name: str = Field(min_length=1, max_length=100, examples=["Prąd"])
    category: str = Field(min_length=1, max_length=50, examples=["prąd"])
    amount: Amount = Field(gt=0, max_digits=12, decimal_places=2, examples=[180])
    day: int = Field(default=10, ge=1, le=28, description="Dzień miesiąca, w którym zwykle płacisz")

    _category = field_validator("category")(_normalize_category)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("nazwa nie może być pusta")
        return v


class RecurringUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    category: str | None = Field(default=None, min_length=1, max_length=50)
    amount: Amount | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    day: int | None = Field(default=None, ge=1, le=28)

    @field_validator("category")
    @classmethod
    def _category(cls, v: str | None) -> str | None:
        return None if v is None else _normalize_category(v)


class Recurring(BaseModel):
    id: int
    kind: Kind
    name: str
    category: str
    amount: float = Field(description="Typowa kwota")
    day: int


class RecurringStatus(Recurring):
    month: str = Field(description="Miesiąc, którego dotyczy status")
    paid: bool = Field(description="Czy w tym miesiącu już zaksięgowano")
    transaction_id: int | None = Field(description="Zaksięgowana operacja (gdy paid=true)")
    paid_amount: float | None = Field(description="Zaksięgowana kwota (gdy paid=true)")


class BookRequest(BaseModel):
    month: str | None = Field(default=None, pattern=MONTH_PATTERN,
                              description="Miesiąc RRRR-MM (domyślnie bieżący)")
    amount: Amount | None = Field(default=None, gt=0, max_digits=12, decimal_places=2,
                                  description="Kwota z rachunku, jeśli inna niż typowa")


# ---------- budżety ----------

class BudgetIn(BaseModel):
    monthly_limit: Amount = Field(gt=0, max_digits=12, decimal_places=2)


class Budget(BaseModel):
    category: str
    monthly_limit: float


class BudgetStatus(BaseModel):
    category: str
    monthly_limit: float
    spent: float
    remaining: float
    used_percent: float
    exceeded: bool
