"""Analizy „doradcy finansowego”: raport kondycji finansów, trendy kategorii,
porównanie miesięcy, sprzedawcy, wykrywanie stałych płatności i nawyki zakupowe.

Ten sam algorytm jest zaimplementowany w ``app/static/store.js`` (tryb bez
serwera) — przy zmianach trzeba aktualizować oba miejsca. Obliczenia na groszach
(int) z zaokrąglaniem „połówki w górę” (``half_up``), procenty przez ``pct``,
żeby obie wersje dawały identyczne wyniki.
"""

import sqlite3
from collections import Counter
from datetime import date, timedelta

from app.db import TABLES
from app.insights import _month_bounds, _median, _shift, half_up, zl

# Koszty podstawowe („potrzeby” w zasadzie 50/30/20). Reszta to „przyjemności”.
NEEDS = {"jedzenie", "czynsz", "prąd", "gaz", "woda", "ogrzewanie", "kredyt", "internet", "telefon",
         "paliwo", "transport", "ubezpieczenie", "zdrowie", "dzieci", "podatki"}
# Koszty stałe: co miesiąc podobne i trudne do szybkiego obcięcia.
FIXED = {"czynsz", "prąd", "gaz", "woda", "ogrzewanie", "kredyt", "internet", "telefon", "ubezpieczenie"}
DEBT = {"kredyt"}
WEEKDAYS = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"]


def pct(part: int, whole: int) -> float | None:
    """Procent z dwoma miejscami po przecinku (None, gdy brak podstawy)."""
    return half_up(10000 * part / whole) / 100 if whole else None


def ym(y: int, m: int) -> str:
    return f"{y}-{m:02d}"


def month_shift(month: str, delta: int) -> str:
    return ym(*_shift(int(month[:4]), int(month[5:7]), delta))


def norm_name(text: str) -> str:
    return " ".join(text.lower().split())


def _load(db: sqlite3.Connection, kind: str) -> list[dict]:
    return [dict(r) for r in db.execute(f"SELECT * FROM {TABLES[kind]} ORDER BY date, id")]


def _sum(rows) -> int:
    return sum(r["amount_cents"] for r in rows)


def _in(rows, month: str) -> list[dict]:
    return [r for r in rows if r["date"].startswith(month)]


def _is_fixed(r: dict) -> bool:
    return r["recurring_id"] is not None or r["category"] in FIXED


def _is_need(r: dict) -> bool:
    return r["category"] in NEEDS or _is_fixed(r)


def _month_index(month: str) -> int:
    return int(month[:4]) * 12 + int(month[5:7])


def _tenths(x10: int) -> str:
    """Liczba dziesiątych -> tekst z przecinkiem: 23 -> '2,3'."""
    return f"{x10 // 10},{x10 % 10}"


# ---------- raport kondycji finansów ----------

def report(db: sqlite3.Connection, month: str, today: date, extra_savings: int = 0) -> dict:
    expenses, incomes = _load(db, "expense"), _load(db, "income")
    budgets = {r["category"]: r["monthly_limit_cents"] for r in db.execute("SELECT * FROM budgets")}
    # Oszczędności: odłożone w celach + podane z zewnątrz (np. konto oszczędnościowe).
    goals_saved = sum(r["saved_cents"] for r in db.execute("SELECT saved_cents FROM goals")) + extra_savings

    current = ym(today.year, today.month)
    complete = month < current
    exp_m, inc_m = _in(expenses, month), _in(incomes, month)
    income, spent = _sum(inc_m), _sum(exp_m)
    prev = month_shift(month, -1)

    # Okres bazowy do średnich: 3 pełne miesiące (z danymi) kończące się na wybranym
    # miesiącu, jeśli jest zakończony, albo poprzedzające go.
    start = 0 if complete else 1
    window = sorted(m for m in (month_shift(month, -k) for k in range(start, start + 3))
                    if _in(expenses, m) or _in(incomes, m))
    if not window:
        window = [month]
    n = len(window)
    w_exp = [r for r in expenses if r["date"][:7] in window]
    w_inc = [r for r in incomes if r["date"][:7] in window]
    avg = lambda rows: half_up(_sum(rows) / n)  # noqa: E731
    avg_income, avg_exp = avg(w_inc), avg(w_exp)
    avg_fixed = avg([r for r in w_exp if _is_fixed(r)])
    avg_needs = avg([r for r in w_exp if _is_need(r)])
    avg_debt = avg([r for r in w_exp if r["category"] in DEBT])
    avg_wants = avg_exp - avg_needs
    avg_savings = avg_income - avg_exp

    emergency10 = half_up(10 * goals_saved / avg_exp) if avg_exp else None
    ratios = {
        "needs_percent": pct(avg_needs, avg_income),
        "wants_percent": pct(avg_wants, avg_income),
        "savings_percent": pct(avg_savings, avg_income),
        "fixed_percent": pct(avg_fixed, avg_income),
        "debt_to_income_percent": pct(avg_debt, avg_income),
    }

    # Kategorie wybranego miesiąca na tle średniej z 3 poprzednich miesięcy.
    before = {month_shift(month, -k) for k in (1, 2, 3)}
    categories = []
    for cat in {r["category"] for r in exp_m}:
        rows = [r for r in exp_m if r["category"] == cat]
        total = _sum(rows)
        usual = half_up(_sum(r for r in expenses if r["category"] == cat and r["date"][:7] in before) / 3)
        categories.append({
            "category": cat,
            "total": total / 100,
            "share_percent": pct(total, spent),
            "usual": usual / 100,
            "change_percent": pct(total - usual, usual),
            "need": any(_is_need(r) for r in rows),
            "fixed": any(_is_fixed(r) for r in rows),
            "_cents": total, "_usual": usual,
        })
    categories.sort(key=lambda c: (-c["_cents"], c["category"]))

    # --- ocena kondycji 0–100 ---
    components = []
    score = None
    if avg_income > 0:
        sp = ratios["savings_percent"]
        dti = ratios["debt_to_income_percent"]
        fixed = ratios["fixed_percent"]

        def comp(key, label, value, points, max_points, text):
            components.append({"key": key, "label": label, "value": value,
                               "points": points, "max": max_points, "text": text})

        comp("savings", "Oszczędzanie", sp, half_up(30 * min(max(sp / 20, 0), 1)), 30,
             f"Zostaje {half_up(sp)}% przychodów (cel: co najmniej 20%).")
        if emergency10 is None:
            comp("emergency", "Poduszka finansowa", None, 25, 25, "Brak wydatków do porównania.")
        else:
            comp("emergency", "Poduszka finansowa", emergency10 / 10,
                 half_up(25 * min(emergency10 / 60, 1)), 25,
                 f"Oszczędności starczą na {_tenths(emergency10)} mies. wydatków (cel: 3–6).")
        debt_pts = 20 if dti <= 10 else 0 if dti >= 40 else half_up(20 * (40 - dti) / 30)
        comp("debt", "Zadłużenie", dti, debt_pts, 20,
             f"Raty kredytów to {half_up(dti)}% przychodów (bezpiecznie: do 30%).")
        fixed_pts = 15 if fixed <= 50 else 0 if fixed >= 80 else half_up(15 * (80 - fixed) / 30)
        comp("fixed", "Koszty stałe", fixed, fixed_pts, 15,
             f"Stałe rachunki to {half_up(fixed)}% przychodów (dobrze: do 50%).")
        month_budgets = sorted(budgets)
        if month_budgets:
            ok = sum(1 for c in month_budgets if _sum(r for r in exp_m if r["category"] == c) <= budgets[c])
            comp("budgets", "Limity", ok, half_up(10 * ok / len(month_budgets)), 10,
                 f"Dotrzymane limity: {ok} z {len(month_budgets)}.")
        else:
            comp("budgets", "Limity", None, 5, 10, "Nie ustawiono limitów wydatków.")
        score = sum(c["points"] for c in components)

    label = (None if score is None else "bardzo dobra" if score >= 80 else "dobra" if score >= 60
             else "przeciętna" if score >= 40 else "słaba")

    # --- rekomendacje ---
    recs: list[dict] = []

    def rec(key, text):
        recs.append({"key": key, "text": text})

    if not expenses and not incomes:
        rec("start", "Dodaj wydatki i przychody z kilku tygodni – wtedy pojawi się ocena i rekomendacje.")
    if avg_income > 0:
        wants_by_cat = Counter()
        for r in w_exp:
            if not _is_need(r):
                wants_by_cat[r["category"]] += r["amount_cents"]
        top_want = min(wants_by_cat, key=lambda c: (-wants_by_cat[c], c)) if wants_by_cat else None
        if ratios["savings_percent"] < 10:
            text = (f"Zostaje tylko {half_up(ratios['savings_percent'])}% przychodów. Celuj w co najmniej 10%, "
                    f"czyli ok. {zl(half_up(avg_income / 10))} miesięcznie.")
            if top_want:
                text += (f" Największy wydatek „na przyjemności” to {top_want}: średnio "
                         f"{zl(half_up(wants_by_cat[top_want] / n))} miesięcznie.")
            rec("savings", text)
        if emergency10 is not None and emergency10 < 30:
            target = 3 * avg_exp
            rec("emergency", f"Poduszka finansowa: odłożone {zl(goals_saved)}, to {_tenths(emergency10)} mies. "
                             f"wydatków. Zalecane minimum to 3 miesiące, czyli ok. {zl(target)} – "
                             f"brakuje {zl(target - goals_saved)}.")
        if ratios["debt_to_income_percent"] > 30:
            rec("debt", f"Raty kredytów to {half_up(ratios['debt_to_income_percent'])}% przychodów – powyżej "
                        f"bezpiecznych 30%. Unikaj nowych zobowiązań, a nadwyżki kieruj na nadpłatę "
                        f"najdroższego kredytu.")
        if ratios["wants_percent"] > 30:
            rec("wants", f"Wydatki na przyjemności to {half_up(ratios['wants_percent'])}% przychodów – zasada "
                         f"50/30/20 zaleca do 30%.")
        if ratios["needs_percent"] > 60:
            rec("needs", f"Koszty podstawowe pochłaniają {half_up(ratios['needs_percent'])}% przychodów. "
                         f"Przejrzyj rachunki: taryfę prądu i gazu, abonamenty telefonu i internetu, "
                         f"ubezpieczenia – tam najłatwiej o stałą oszczędność.")
    spikes = [c for c in categories if c["_usual"] > 0 and c["_cents"] - c["_usual"] >= 10000
              and c["change_percent"] >= 20]
    if spikes:
        c = min(spikes, key=lambda c: (c["_usual"] - c["_cents"], c["category"]))
        rec("spike", f"„{c['category']}”: {zl(c['_cents'])} w tym miesiącu, o {half_up(c['change_percent'])}% "
                     f"więcej niż zwykle ({zl(c['_usual'])}).")
    if not budgets and w_exp:
        variable = Counter()
        for r in w_exp:
            if not _is_fixed(r):
                variable[r["category"]] += r["amount_cents"]
        top = sorted(variable, key=lambda c: (-variable[c], c))[:2]
        if top:
            rec("budgets", "Ustaw miesięczne limity na największe wydatki zmienne: " + " i ".join(top) + ".")
    if avg_income > 0 and not recs and avg_savings > 0:
        rec("good", f"Finanse wyglądają zdrowo. Nadwyżkę (ok. {zl(avg_savings)} miesięcznie) przelewaj "
                    f"regularnie na cele albo poduszkę finansową.")

    for c in categories:
        del c["_cents"], c["_usual"]
    return {
        "month": month,
        "complete": complete,
        "basis_months": window,
        "totals": {
            "income": income / 100, "expenses": spent / 100, "balance": (income - spent) / 100,
            "savings_rate": pct(income - spent, income),
            "prev_income": _sum(_in(incomes, prev)) / 100, "prev_expenses": _sum(_in(expenses, prev)) / 100,
        },
        "averages": {
            "income": avg_income / 100, "expenses": avg_exp / 100, "fixed": avg_fixed / 100,
            "needs": avg_needs / 100, "wants": avg_wants / 100, "savings": avg_savings / 100,
            "debt_payments": avg_debt / 100,
        },
        "ratios": ratios,
        "emergency_fund": {"saved": goals_saved / 100,
                           "months_covered": None if emergency10 is None else emergency10 / 10},
        "categories": categories,
        "health": {"score": score, "label": label, "components": components},
        "recommendations": recs[:5],
    }


# ---------- trendy kategorii ----------

def trends(db: sqlite3.Connection, kind: str, months: int, today: date) -> dict:
    rows = _load(db, kind)
    current = ym(today.year, today.month)
    labels = [month_shift(current, -k) for k in range(months - 1, -1, -1)]
    full = months - 1  # ostatni miesiąc (bieżący) jest niepełny – nie liczy się do średniej i trendu

    def series(subset):
        cents = [_sum(_in(subset, m)) for m in labels]
        base = cents[:full]
        average = half_up(sum(base) / full)
        # Nachylenie prostej (metoda najmniejszych kwadratów) dla pełnych miesięcy.
        mean_x = (full - 1) / 2
        sxx = sum((x - mean_x) ** 2 for x in range(full))
        slope = sum((x - mean_x) * (v - average) for x, v in enumerate(base)) / sxx if sxx else 0
        if average == 0:
            trend = "new" if cents[-1] else "flat"
        else:
            rel = slope / average
            trend = "up" if rel > 0.05 else "down" if rel < -0.05 else "flat"
        return {"values": [c / 100 for c in cents], "average": average / 100,
                "current": cents[-1] / 100, "slope": half_up(slope) / 100, "trend": trend,
                "_total": sum(cents)}

    in_range = [r for r in rows if r["date"][:7] in labels]
    cats = []
    for cat in {r["category"] for r in in_range}:
        s = series([r for r in in_range if r["category"] == cat])
        cats.append({"category": cat, **s})
    cats.sort(key=lambda c: (-c["_total"], c["category"]))
    total = series(in_range)
    for c in [total, *cats]:
        del c["_total"]
    return {"kind": kind, "months": labels, "total": total, "categories": cats}


# ---------- porównanie miesięcy ----------

def compare(db: sqlite3.Connection, kind: str, a: str, b: str) -> dict:
    rows = _load(db, kind)
    ra, rb = _in(rows, a), _in(rows, b)
    out = []
    for cat in {r["category"] for r in ra + rb}:
        ca = _sum(r for r in ra if r["category"] == cat)
        cb = _sum(r for r in rb if r["category"] == cat)
        out.append({"category": cat, "a": ca / 100, "b": cb / 100, "diff": (cb - ca) / 100,
                    "change_percent": pct(cb - ca, ca), "_d": cb - ca})
    out.sort(key=lambda c: (-abs(c["_d"]), c["category"]))
    for c in out:
        del c["_d"]
    ta, tb = _sum(ra), _sum(rb)
    return {"kind": kind, "a": a, "b": b, "total_a": ta / 100, "total_b": tb / 100,
            "diff": (tb - ta) / 100, "change_percent": pct(tb - ta, ta), "categories": out}


# ---------- sprzedawcy / opisy ----------

def merchants(db: sqlite3.Connection, kind: str, date_from: str | None, date_to: str | None, limit: int) -> list:
    rows = [r for r in _load(db, kind) if r["description"].strip()
            and (not date_from or r["date"] >= date_from) and (not date_to or r["date"] <= date_to)]
    groups: dict[str, list] = {}
    for r in rows:
        groups.setdefault(norm_name(r["description"]), []).append(r)
    out = []
    for key, items in groups.items():
        last = max(items, key=lambda r: (r["date"], r["id"]))
        cats = Counter(r["category"] for r in items)
        total = _sum(items)
        out.append({
            "name": last["description"].strip(),
            "category": min(cats, key=lambda c: (-cats[c], c)),
            "count": len(items),
            "total": total / 100,
            "average": half_up(total / len(items)) / 100,
            "last_date": last["date"],
            "_t": total, "_k": key,
        })
    out.sort(key=lambda m: (-m["_t"], m["_k"]))
    for m in out:
        del m["_t"], m["_k"]
    return out[:limit]


# ---------- wykrywanie stałych płatności (abonamenty) ----------

def subscriptions(db: sqlite3.Connection, today: date) -> dict:
    since = (today - timedelta(days=365)).isoformat()
    active_since = (today - timedelta(days=62)).isoformat()
    registered = {norm_name(r["name"]) for r in db.execute("SELECT name FROM recurring WHERE kind = 'expense'")}
    groups: dict[str, list] = {}
    for r in _load(db, "expense"):
        if r["recurring_id"] is None and r["description"].strip() and r["date"] >= since:
            groups.setdefault(norm_name(r["description"]), []).append(r)
    found = []
    for key, items in groups.items():
        med = _median([r["amount_cents"] for r in items])
        months = sorted({r["date"][:7] for r in items})
        span = _month_index(months[-1]) - _month_index(months[0]) + 1
        # Co najmniej 3 miesiące, mniej więcej raz w miesiącu (nie codzienne zakupy), w co najmniej
        # 3/4 miesięcy od pierwszej do ostatniej płatności i o zbliżonej kwocie (±50% u 3/4 płatności).
        if len(months) < 3 or 2 * len(items) > 3 * len(months) or 4 * len(months) < 3 * span:
            continue
        if 4 * sum(1 for r in items if 2 * abs(r["amount_cents"] - med) <= med) < 3 * len(items):
            continue
        last = max(items, key=lambda r: (r["date"], r["id"]))
        amount = med
        found.append({
            "name": last["description"].strip(),
            "category": last["category"],
            "amount": amount / 100,
            "yearly_cost": 12 * amount / 100,
            "fixed_amount": all(10 * abs(r["amount_cents"] - med) <= med for r in items),
            "months": len(months),
            "typical_day": _median([int(r["date"][8:10]) for r in items]),
            "first_date": items[0]["date"],
            "last_date": last["date"],
            "active": last["date"] >= active_since,
            "registered": key in registered,
            "_a": amount, "_k": key,
        })
    found.sort(key=lambda s: (not s["active"], -s["_a"], s["_k"]))
    monthly = sum(s["_a"] for s in found if s["active"])
    for s in found:
        del s["_a"], s["_k"]
    return {"monthly_total": monthly / 100, "yearly_total": 12 * monthly / 100, "items": found}


# ---------- nawyki zakupowe ----------

def patterns(db: sqlite3.Connection, date_from: str, date_to: str, small_limit: int) -> dict:
    rows = [r for r in _load(db, "expense") if date_from <= r["date"] <= date_to]
    total = _sum(rows)
    days = (date.fromisoformat(date_to) - date.fromisoformat(date_from)).days + 1
    by_day = [[0, 0] for _ in range(7)]
    for r in rows:
        d = date.fromisoformat(r["date"]).weekday()
        by_day[d][0] += r["amount_cents"]
        by_day[d][1] += 1
    parts = [0, 0, 0]
    for r in rows:
        day = int(r["date"][8:10])
        parts[0 if day <= 10 else 1 if day <= 20 else 2] += r["amount_cents"]
    small = [r for r in rows if r["amount_cents"] < small_limit]
    weekend = by_day[5][0] + by_day[6][0]
    return {
        "date_from": date_from, "date_to": date_to, "days": days,
        "total": total / 100, "count": len(rows),
        "daily_average": half_up(total / days) / 100,
        "average_transaction": half_up(total / len(rows)) / 100 if rows else 0.0,
        "weekend_share_percent": pct(weekend, total),
        "by_weekday": [{"weekday": WEEKDAYS[i], "total": t / 100, "count": c, "share_percent": pct(t, total)}
                       for i, (t, c) in enumerate(by_day)],
        "by_part_of_month": [{"part": p, "total": v / 100, "share_percent": pct(v, total)}
                             for p, v in zip(["1–10", "11–20", "21–koniec"], parts)],
        "small_purchases": {"limit": small_limit / 100, "count": len(small), "total": _sum(small) / 100,
                            "share_percent": pct(_sum(small), total)},
    }
