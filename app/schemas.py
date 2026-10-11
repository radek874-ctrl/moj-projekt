import datetime as dt
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator


def _normalize_category(value: str) -> str:
    value = value.strip().lower()
    if not value:
        raise ValueError("kategoria nie może być pusta")
    return value


class ExpenseBase(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2, examples=[49.99])
    category: str = Field(min_length=1, max_length=50, examples=["jedzenie"])
    description: str = Field(default="", max_length=255, examples=["Zakupy w Biedronce"])
    date: dt.date

    _category = field_validator("category")(_normalize_category)


class ExpenseCreate(ExpenseBase):
    pass


class ExpenseUpdate(BaseModel):
    amount: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    category: str | None = Field(default=None, min_length=1, max_length=50)
    description: str | None = Field(default=None, max_length=255)
    date: dt.date | None = None

    @field_validator("category")
    @classmethod
    def _category(cls, v: str | None) -> str | None:
        return None if v is None else _normalize_category(v)


class Expense(BaseModel):
    id: int
    amount: float
    category: str
    description: str
    date: dt.date


class ImportResult(BaseModel):
    imported: int
    errors: list[str]


class Summary(BaseModel):
    count: int
    total: float
    average: float
    min: float
    max: float
    date_from: dt.date | None
    date_to: dt.date | None
    daily_average: float = Field(description="Średni wydatek na dzień w analizowanym okresie")


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


class BudgetIn(BaseModel):
    monthly_limit: Decimal = Field(gt=0, max_digits=12, decimal_places=2)


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
