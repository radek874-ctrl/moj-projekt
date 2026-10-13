"""Inteligentne podpowiedzi liczone lokalnie (bez AI): prognoza końca miesiąca,
ostrzeżenia o limitach i skokach wydatków, nietypowe wydatki, nadchodzące koszty
oraz podpowiadanie kategorii z opisu.

Ten sam algorytm jest zaimplementowany w ``app/static/store.js`` (tryb bez
serwera) — przy zmianach trzeba aktualizować oba miejsca. Wszystkie obliczenia
są na groszach (int) z zaokrąglaniem „połówki w górę”, żeby obie wersje dawały
identyczne wyniki.
"""

import calendar
import math
import re
import sqlite3
from collections import Counter
from datetime import date

from app.db import TABLES

# ---------- formatowanie i zaokrąglanie (identyczne w store.js) ----------

NBSP = " "


def half_up(x: float) -> int:
    """Zaokrąglenie połówek w górę (jak Math.round w JS)."""
    return math.floor(x + 0.5)


def zl(cents: int) -> str:
    """Kwota w pełnych złotych: 123456 -> '1 235 zł' (twarde spacje)."""
    value = half_up(cents / 100)
    sign = "−" if value < 0 else ""
    digits = str(abs(value))
    groups = []
    while digits:
        groups.insert(0, digits[-3:])
        digits = digits[:-3]
    return f"{sign}{NBSP.join(groups) or '0'}{NBSP}zł"


def _month_bounds(year: int, month: int) -> tuple[str, str, int]:
    days = calendar.monthrange(year, month)[1]
    return f"{year}-{month:02d}-01", f"{year}-{month:02d}-{days:02d}", days


def _shift(year: int, month: int, delta: int) -> tuple[int, int]:
    y, m = divmod(month - 1 + delta, 12)
    return year + y, m + 1


def _median(values: list[int]) -> int:
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else half_up((s[n // 2 - 1] + s[n // 2]) / 2)


# ---------- podpowiedzi ----------

def compute_insights(db: sqlite3.Connection, today: date) -> dict:
    from app.routers.events import _to_model as event_to_model  # unikamy importu cyklicznego

    expenses = [dict(r) for r in db.execute(f"SELECT * FROM {TABLES['expense']}")]
    incomes = [dict(r) for r in db.execute(f"SELECT * FROM {TABLES['income']}")]
    recurring = [dict(r) for r in db.execute("SELECT * FROM recurring")]
    budgets = {r["category"]: r["monthly_limit_cents"] for r in db.execute("SELECT * FROM budgets")}
    events = [event_to_model(r, today) for r in db.execute("SELECT * FROM events")]

    y, m = today.year, today.month
    month = f"{y}-{m:02d}"
    _, _, dim = _month_bounds(y, m)
    day = today.day
    in_month = lambda rows: [r for r in rows if r["date"].startswith(month)]  # noqa: E731
    cents = lambda rows: sum(r["amount_cents"] for r in rows)  # noqa: E731

    cur_exp, cur_inc = in_month(expenses), in_month(incomes)

    # Poprzednie 3 pełne miesiące.
    py, pm = _shift(y, m, -3)
    prev_start, _, _ = _month_bounds(py, pm)
    ly, lm = _shift(y, m, -1)
    _, prev_end, _ = _month_bounds(ly, lm)
    prev_days = sum(_month_bounds(*_shift(y, m, -k))[2] for k in (1, 2, 3))
    prev_exp = [r for r in expenses if prev_start <= r["date"] <= prev_end]

    # --- prognoza końca miesiąca ---
    paid_ids = {(r["recurring_id"]) for r in cur_exp + cur_inc if r["recurring_id"] is not None}
    planned_exp = sum(r["amount_cents"] for r in recurring if r["kind"] == "expense" and r["id"] not in paid_ids)
    planned_inc = sum(r["amount_cents"] for r in recurring if r["kind"] == "income" and r["id"] not in paid_ids)

    variable_prev = cents([r for r in prev_exp if r["recurring_id"] is None])
    variable_now = cents([r for r in cur_exp if r["recurring_id"] is None])
    daily = variable_prev / prev_days if variable_prev else variable_now / day
    projected_variable = half_up(daily * (dim - day))

    income_so_far, expenses_so_far = cents(cur_inc), cents(cur_exp)
    projected_income = income_so_far + planned_inc
    projected_expenses = expenses_so_far + planned_exp + projected_variable
    forecast = {
        "month": month,
        "income_so_far": income_so_far / 100,
        "expenses_so_far": expenses_so_far / 100,
        "planned_income": planned_inc / 100,
        "planned_expenses": planned_exp / 100,
        "projected_variable": projected_variable / 100,
        "projected_income": projected_income / 100,
        "projected_expenses": projected_expenses / 100,
        "projected_balance": (projected_income - projected_expenses) / 100,
    }

    insights: list[dict] = []

    def add(key: str, level: str, title: str, text: str) -> None:
        insights.append({"key": key, "level": level, "title": title, "text": text})

    if not expenses and not incomes:
        add("start", "info", "Zacznij od kilku wpisów",
            "Dodaj wydatki i przychody, a tutaj pojawią się prognozy i podpowiedzi.")
        return {"forecast": forecast, "insights": insights}

    # a) prognoza bilansu
    if projected_income > 0:
        balance = projected_income - projected_expenses
        if balance < 0:
            add("forecast", "alert", "Może zabraknąć pieniędzy",
                f"Prognoza na koniec miesiąca: brakuje ok. {zl(-balance)}. "
                f"Uwzględniono stałe opłaty ({zl(planned_exp)}) i zwykłe tempo wydatków.")
        else:
            add("forecast", "good", "Prognoza na koniec miesiąca",
                f"Powinno zostać ok. {zl(balance)} (przychody {zl(projected_income)}, "
                f"wydatki ok. {zl(projected_expenses)}).")

    # b) limity
    for cat in sorted(budgets):
        limit = budgets[cat]
        spent = cents([r for r in cur_exp if r["category"] == cat])
        if spent > limit:
            add(f"budget:{cat}", "alert", f"Limit „{cat}” przekroczony",
                f"Wydano {zl(spent)} z {zl(limit)} – o {zl(spent - limit)} za dużo.")
        elif day >= 5 and spent > 0:
            exceed_day = limit * day // spent + 1
            if exceed_day <= dim:
                add(f"budget:{cat}", "warning", f"Limit „{cat}” może się skończyć",
                    f"Przy obecnym tempie limit {zl(limit)} skończy się ok. {exceed_day}. dnia miesiąca "
                    f"(wydano już {zl(spent)}).")

    # c) skoki w kategoriach
    spikes = []
    for cat in sorted({r["category"] for r in cur_exp}):
        cur = cents([r for r in cur_exp if r["category"] == cat])
        prev_total = cents([r for r in prev_exp if r["category"] == cat])
        if not prev_total:
            continue
        avg = half_up(prev_total / 3)
        if avg > 0 and cur * 10 > avg * 13 and cur - avg >= 5000:
            spikes.append((cur - avg, cat, cur, avg))
    for _, cat, cur, avg in sorted(spikes, key=lambda s: (-s[0], s[1]))[:3]:
        pct = half_up((cur - avg) * 100 / avg)
        add(f"spike:{cat}", "warning", f"Więcej niż zwykle: {cat}",
            f"W tym miesiącu {zl(cur)} – o {pct}% więcej niż średnio ({zl(avg)} miesięcznie).")

    # d) nietypowo duże pojedyncze wydatki
    hist_start = date.fromordinal(today.toordinal() - 180).isoformat()
    unusual = []
    for r in cur_exp:
        history = [h["amount_cents"] for h in expenses
                   if h["category"] == r["category"] and hist_start <= h["date"] < f"{month}-01"]
        if len(history) >= 5:
            med = _median(history)
            if med > 0 and r["amount_cents"] > 3 * med:
                unusual.append((r["amount_cents"] / med, r["id"], r, med))
    for _, _, r, med in sorted(unusual, key=lambda u: (-u[0], u[1]))[:2]:
        name = r["description"] or r["category"]
        add(f"unusual:{r['id']}", "info", "Nietypowo duży wydatek",
            f"{name}: {zl(r['amount_cents'])} – zwykle ok. {zl(med)} w kategorii „{r['category']}”.")

    # e) nadchodzące większe koszty z kalendarza
    upcoming = sorted(
        (e for e in events if e.amount and e.state != "done" and e.days_left is not None and 0 <= e.days_left <= 30),
        key=lambda e: (e.days_left, e.title),
    )
    if upcoming:
        total = sum(round(e.amount * 100) for e in upcoming)
        parts = ", ".join(f"{e.title} {zl(round(e.amount * 100))} (za {e.days_left} dni)" for e in upcoming[:3])
        add("upcoming", "info", "Nadchodzące koszty z kalendarza",
            f"W ciągu 30 dni: {parts}. Razem {zl(total)} – warto to odłożyć.")

    # f) oszczędzanie w poprzednim miesiącu
    last_month = f"{ly}-{lm:02d}"
    last_inc = cents([r for r in incomes if r["date"].startswith(last_month)])
    last_exp = cents([r for r in expenses if r["date"].startswith(last_month)])
    if last_inc > 0:
        rate = half_up((last_inc - last_exp) * 100 / last_inc)
        if rate < 10:
            add("savings", "warning", "Mało oszczędności",
                f"W zeszłym miesiącu zostało {rate}% przychodów. Dobra zasada: odkładaj co najmniej 10%.")
        elif rate >= 20:
            add("savings", "good", "Świetnie oszczędzasz",
                f"W zeszłym miesiącu zostało Ci {rate}% przychodów.")

    return {"forecast": forecast, "insights": insights}


# ---------- podpowiadanie kategorii ----------

# Słowa kluczowe -> kategoria (pierwsze dopasowanie wygrywa). Dopasowanie od początku słowa.
KEYWORDS = {
    "expense": [
        (["biedronka", "lidl", "żabka", "zabka", "kaufland", "carrefour", "auchan", "netto", "dino",
          "lewiatan", "stokrotka", "piekarnia", "spożywcz", "zakupy", "obiad", "pizza"], "jedzenie"),
        (["orlen", "bp ", "shell", "circle k", "lotos", "moya", "paliwo", "benzyn", "diesel", "tankow"], "paliwo"),
        (["tauron", "enea", "energa", "pge", "innogy", "e.on", "prąd", "prad"], "prąd"),
        (["pgnig", "gazownict", "gaz"], "gaz"),
        (["wodociąg", "wodociag", "mpwik", "woda", "ścieki"], "woda"),
        (["ogrzewan", "ciepło", "cieplo", "węgiel", "opał"], "ogrzewanie"),
        (["czynsz", "wspólnota", "spółdzielnia", "najem"], "czynsz"),
        (["rata", "raty", "kredyt", "hipote", "pożyczk"], "kredyt"),
        (["upc", "vectra", "netia", "światłowód", "internet"], "internet"),
        (["play", "plus", "orange", "t-mobile", "telefon", "abonament"], "telefon"),
        (["apteka", "lekarz", "dentyst", "przychodnia", "luxmed", "medicover", "leki"], "zdrowie"),
        (["pkp", "mpk", "ztm", "bilet", "uber", "bolt", "taxi", "taksówk", "autobus", "pociąg"], "transport"),
        (["pzu", "warta", "hestia", "allianz", "ubezpiecz", "polisa", "oc "], "ubezpieczenie"),
        (["netflix", "spotify", "kino", "hbo", "disney", "teatr", "koncert", "max "], "rozrywka"),
        (["zara", "reserved", "h&m", "ccc", "sinsay", "ubrani", "buty", "kurtk"], "ubrania"),
        (["pampers", "przedszkol", "żłobek", "zlobek", "zabawk", "szkoła", "szkola"], "dzieci"),
    ],
    "income": [
        (["wypłat", "wyplat", "pensj", "wynagrodz", "pracodaw"], "wynagrodzenie"),
        (["premi", "bonus", "nagrod"], "premia"),
        (["800"], "800+"),
        (["emerytur", "rent"], "emerytura"),
        (["zwrot", "pit", "skarbow"], "zwrot podatku"),
        (["olx", "allegro", "vinted", "sprzeda"], "sprzedaż"),
        (["odsetk", "lokat"], "odsetki"),
    ],
}
_WORD_START = r"(?:^|[^a-z0-9ąćęłńóśźż])"
_TOKEN = re.compile(r"[a-z0-9ąćęłńóśźż]{3,}")


def suggest_category(db: sqlite3.Connection, text: str, kind: str) -> dict:
    """Kategoria dla opisu: najpierw z historii użytkownika, potem ze słownika."""
    t = text.strip().lower()
    if not t:
        return {"category": None, "source": None}
    rows = [dict(r) for r in db.execute(
        f"SELECT description, category, date, id FROM {TABLES[kind]} WHERE description != ''")]

    def most_common(matches: list[dict]) -> str | None:
        if not matches:
            return None
        counts = Counter(r["category"] for r in matches)
        latest = {}
        for r in matches:
            key = (r["date"], r["id"])
            if r["category"] not in latest or key > latest[r["category"]]:
                latest[r["category"]] = key
        return max(counts, key=lambda c: (counts[c], latest[c]))

    exact = most_common([r for r in rows if r["description"].strip().lower() == t])
    if exact:
        return {"category": exact, "source": "history"}
    tokens = set(_TOKEN.findall(t))
    if tokens:
        shared = most_common([r for r in rows if tokens & set(_TOKEN.findall(r["description"].lower()))])
        if shared:
            return {"category": shared, "source": "history"}
    padded = t + " "
    for words, category in KEYWORDS[kind]:
        if any(re.search(_WORD_START + re.escape(w), padded) for w in words):
            return {"category": category, "source": "keywords"}
    return {"category": None, "source": None}
