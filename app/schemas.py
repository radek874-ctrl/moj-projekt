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


class Forecast(BaseModel):
    month: str
    income_so_far: float
    expenses_so_far: float
    planned_income: float = Field(description="Niezaksięgowane stałe przychody w tym miesiącu")
    planned_expenses: float = Field(description="Niezapłacone stałe opłaty w tym miesiącu")
    projected_variable: float = Field(description="Przewidywane pozostałe wydatki zmienne (wg średniej z 3 mies.)")
    projected_income: float
    projected_expenses: float
    projected_balance: float = Field(description="Prognozowany bilans na koniec miesiąca")
    safe_daily: float | None = Field(
        description="Ile można wydawać dziennie do końca miesiąca (przychody − wydane − niezapłacone "
                    "stałe opłaty, podzielone przez pozostałe dni); null bez przychodów")


class Insight(BaseModel):
    key: str = Field(description="Identyfikator podpowiedzi, np. budget:jedzenie")
    level: str = Field(description="good | info | warning | alert")
    title: str
    text: str


class Insights(BaseModel):
    forecast: Forecast
    insights: list[Insight]


class CategorySuggestion(BaseModel):
    category: str | None
    source: str | None = Field(description="history (z Twoich wpisów) | keywords (słownik) | null")


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


# ---------- kalendarz ----------

class Repeat(str, Enum):
    """Powtarzanie terminu."""

    none = "none"
    monthly = "monthly"
    yearly = "yearly"


class EventState(str, Enum):
    """Stan terminu względem dzisiejszej daty."""

    overdue = "overdue"   # po terminie, nieodhaczony
    soon = "soon"         # w okresie przypomnienia
    later = "later"       # jeszcze nie czas
    done = "done"         # jednorazowy, wykonany


class EventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=100, examples=["OC samochodu"])
    date: dt.date = Field(description="Termin (dla powtarzanych: pierwsze wystąpienie)")
    repeat: Repeat = Repeat.none
    remind_days: int = Field(default=7, ge=0, le=60, description="Ile dni wcześniej przypomnieć")
    amount: Amount | None = Field(default=None, gt=0, max_digits=12, decimal_places=2,
                                  description="Przewidywany koszt (opcjonalnie)")
    category: str | None = Field(default=None, max_length=50,
                                 description="Kategoria wydatku przy opłaceniu (opcjonalnie)")
    note: str = Field(default="", max_length=255)

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("tytuł nie może być pusty")
        return v

    @field_validator("category")
    @classmethod
    def _category(cls, v: str | None) -> str | None:
        return None if v is None or not v.strip() else _normalize_category(v)


class EventUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=100)
    date: dt.date | None = None
    repeat: Repeat | None = None
    remind_days: int | None = Field(default=None, ge=0, le=60)
    amount: Amount | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    category: str | None = Field(default=None, max_length=50)
    note: str | None = Field(default=None, max_length=255)

    @field_validator("category")
    @classmethod
    def _category(cls, v: str | None) -> str | None:
        return None if v is None or not v.strip() else _normalize_category(v)


class Event(BaseModel):
    id: int
    title: str
    date: dt.date
    repeat: Repeat
    remind_days: int
    amount: float | None
    category: str | None
    note: str
    next_date: dt.date | None = Field(description="Najbliższy niewykonany termin (null = wykonany)")
    days_left: int | None = Field(description="Dni do terminu (ujemne = po terminie)")
    state: EventState


class EventDone(BaseModel):
    amount: Amount | None = Field(default=None, gt=0, max_digits=12, decimal_places=2,
                                  description="Jeśli podane, zapisuje też wydatek z tą kwotą")


class CalendarItem(BaseModel):
    event_id: int
    title: str
    date: dt.date
    done: bool


# ---------- cele oszczędnościowe ----------

class GoalCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100, examples=["Wakacje"])
    target: Amount = Field(gt=0, max_digits=12, decimal_places=2, examples=[5000])
    saved: Amount = Field(default=Decimal(0), ge=0, max_digits=12, decimal_places=2)
    deadline: dt.date | None = Field(default=None, description="Do kiedy (opcjonalnie)")

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("nazwa nie może być pusta")
        return v


class GoalUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    target: Amount | None = Field(default=None, gt=0, max_digits=12, decimal_places=2)
    deadline: dt.date | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        if v is not None and not v.strip():
            raise ValueError("nazwa nie może być pusta")
        return v


class GoalDeposit(BaseModel):
    amount: Amount = Field(max_digits=12, decimal_places=2,
                           description="Wpłata (dodatnia) albo wypłata (ujemna)")


class Goal(BaseModel):
    id: int
    name: str
    target: float
    saved: float
    deadline: dt.date | None
    percent: int = Field(description="Postęp w % (zaokrąglony w dół)")
    remaining: float
    monthly_needed: float | None = Field(description="Ile odkładać miesięcznie, żeby zdążyć (gdy jest termin)")
    done: bool


# ---------- kategorie ----------

class CategoryInfo(BaseModel):
    kind: Kind
    category: str
    count: int
    total: float


class CategoryRename(BaseModel):
    kind: Kind
    old: str = Field(min_length=1, max_length=50, alias="from")
    new: str = Field(min_length=1, max_length=50, alias="to")

    model_config = {"populate_by_name": True}

    _old = field_validator("old")(_normalize_category)
    _new = field_validator("new")(_normalize_category)


class RenameResult(BaseModel):
    updated: int = Field(description="Ile wpisów zmieniono")


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


# ---------- doradca finansowy (app/advisor.py) ----------

class ReportTotals(BaseModel):
    income: float
    expenses: float
    balance: float
    savings_rate: float | None = Field(description="% przychodów, który został")
    prev_income: float = Field(description="Przychody w poprzednim miesiącu")
    prev_expenses: float = Field(description="Wydatki w poprzednim miesiącu")


class ReportAverages(BaseModel):
    """Średnie miesięczne z okresu bazowego (``basis_months``)."""

    income: float
    expenses: float
    fixed: float = Field(description="Koszty stałe: rachunki, czynsz, raty, stałe opłaty")
    needs: float = Field(description="Potrzeby (zasada 50/30/20)")
    wants: float = Field(description="Przyjemności (zasada 50/30/20)")
    savings: float = Field(description="Przychody − wydatki")
    debt_payments: float = Field(description="Raty kredytów")


class ReportRatios(BaseModel):
    """Udziały w przychodach (%). None, gdy brak przychodów."""

    needs_percent: float | None
    wants_percent: float | None
    savings_percent: float | None
    fixed_percent: float | None
    debt_to_income_percent: float | None


class EmergencyFund(BaseModel):
    saved: float = Field(description="Odłożone w celach oszczędnościowych + parametr `savings`")
    months_covered: float | None = Field(description="Na ile miesięcy wydatków to starczy")


class ReportCategory(BaseModel):
    category: str
    total: float
    share_percent: float | None
    usual: float = Field(description="Średnio miesięcznie w 3 poprzednich miesiącach")
    change_percent: float | None
    need: bool = Field(description="Potrzeba (true) czy przyjemność (false)")
    fixed: bool


class HealthComponent(BaseModel):
    key: str
    label: str
    value: float | None
    points: int
    max: int
    text: str


class Health(BaseModel):
    score: int | None = Field(description="0–100; None, gdy brak przychodów")
    label: str | None
    components: list[HealthComponent]


class Recommendation(BaseModel):
    key: str
    text: str


class FinancialReport(BaseModel):
    month: str
    complete: bool = Field(description="Czy miesiąc już się skończył")
    basis_months: list[str] = Field(description="Miesiące, z których liczone są średnie i ocena")
    totals: ReportTotals
    averages: ReportAverages
    ratios: ReportRatios
    emergency_fund: EmergencyFund
    categories: list[ReportCategory]
    health: Health
    recommendations: list[Recommendation]


class TrendSeries(BaseModel):
    values: list[float] = Field(description="Sumy w kolejnych miesiącach (jak ``months``)")
    average: float = Field(description="Średnia z pełnych miesięcy (bez bieżącego)")
    current: float
    slope: float = Field(description="Zmiana miesiąc do miesiąca wg linii trendu (zł)")
    trend: str = Field(description="up | down | flat | new")


class CategoryTrend(TrendSeries):
    category: str


class Trends(BaseModel):
    kind: Kind
    months: list[str]
    total: TrendSeries
    categories: list[CategoryTrend]


class CompareCategory(BaseModel):
    category: str
    a: float
    b: float
    diff: float
    change_percent: float | None


class Comparison(BaseModel):
    kind: Kind
    a: str
    b: str
    total_a: float
    total_b: float
    diff: float
    change_percent: float | None
    categories: list[CompareCategory]


class Merchant(BaseModel):
    name: str
    category: str
    count: int
    total: float
    average: float
    last_date: dt.date


class Subscription(BaseModel):
    name: str
    category: str
    amount: float = Field(description="Typowa kwota (mediana)")
    yearly_cost: float
    fixed_amount: bool = Field(description="Zawsze ta sama kwota (±10%) – abonament; inaczej rachunek o zmiennej kwocie")
    months: int = Field(description="W ilu miesiącach wystąpiła płatność")
    typical_day: int
    first_date: dt.date
    last_date: dt.date
    active: bool = Field(description="Ostatnia płatność w ciągu 62 dni (nie pominięto dwóch miesięcy)")
    registered: bool = Field(description="Czy jest już na liście stałych opłat")


class Subscriptions(BaseModel):
    monthly_total: float
    yearly_total: float
    items: list[Subscription]


class WeekdayStat(BaseModel):
    weekday: str
    total: float
    count: int
    share_percent: float | None


class PartOfMonth(BaseModel):
    part: str
    total: float
    share_percent: float | None


class SmallPurchases(BaseModel):
    limit: float
    count: int
    total: float
    share_percent: float | None


class Patterns(BaseModel):
    date_from: dt.date
    date_to: dt.date
    days: int
    total: float
    count: int
    daily_average: float
    average_transaction: float
    weekend_share_percent: float | None
    by_weekday: list[WeekdayStat]
    by_part_of_month: list[PartOfMonth]
    small_purchases: SmallPurchases
