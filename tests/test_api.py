import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("EXPENSES_DB", str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


def add(client, amount, category, date, description=""):
    r = client.post("/expenses", json={
        "amount": amount, "category": category, "date": date, "description": description,
    })
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def seeded(client):
    add(client, 100.00, "Jedzenie", "2026-09-01")
    add(client, 50.50, "transport", "2026-09-15")
    add(client, 200.00, "jedzenie", "2026-10-02")
    add(client, 49.50, "rozrywka", "2026-10-05")
    return client


def test_crud(client):
    e = add(client, 12.34, "  Jedzenie ", "2026-10-01", "chleb")
    assert e["amount"] == 12.34
    assert e["category"] == "jedzenie"

    assert client.get(f"/expenses/{e['id']}").json() == e

    r = client.patch(f"/expenses/{e['id']}", json={"amount": 20, "description": "bułki"})
    assert r.status_code == 200
    assert r.json()["amount"] == 20.0
    assert r.json()["description"] == "bułki"
    assert r.json()["category"] == "jedzenie"

    assert client.delete(f"/expenses/{e['id']}").status_code == 204
    assert client.get(f"/expenses/{e['id']}").status_code == 404


@pytest.mark.parametrize("payload", [
    {"amount": -5, "category": "x", "date": "2026-10-01"},
    {"amount": 0, "category": "x", "date": "2026-10-01"},
    {"amount": 1.234, "category": "x", "date": "2026-10-01"},
    {"amount": 5, "category": "   ", "date": "2026-10-01"},
    {"amount": 5, "category": "x", "date": "nie-data"},
])
def test_validation(client, payload):
    assert client.post("/expenses", json=payload).status_code == 422


def test_list_filters(seeded):
    all_ = seeded.get("/expenses").json()
    assert len(all_) == 4
    assert all_[0]["date"] == "2026-10-05"  # najnowsze pierwsze

    food = seeded.get("/expenses", params={"category": "JEDZENIE"}).json()
    assert {e["amount"] for e in food} == {100.0, 200.0}

    oct_ = seeded.get("/expenses", params={"date_from": "2026-10-01"}).json()
    assert len(oct_) == 2

    page = seeded.get("/expenses", params={"limit": 1, "offset": 1}).json()
    assert page[0]["date"] == "2026-10-02"


def test_summary(seeded):
    s = seeded.get("/analytics/summary").json()
    assert s["count"] == 4
    assert s["total"] == 400.0
    assert s["average"] == 100.0
    assert s["min"] == 49.5
    assert s["max"] == 200.0
    assert s["date_from"] == "2026-09-01"
    assert s["date_to"] == "2026-10-05"
    assert s["daily_average"] == round(400 / 35, 2)


def test_summary_empty(client):
    s = client.get("/analytics/summary").json()
    assert s["count"] == 0
    assert s["total"] == 0
    assert s["daily_average"] == 0


def test_by_category(seeded):
    stats = seeded.get("/analytics/by-category").json()
    assert [c["category"] for c in stats] == ["jedzenie", "transport", "rozrywka"]
    assert stats[0]["total"] == 300.0
    assert stats[0]["share_percent"] == 75.0
    assert sum(c["share_percent"] for c in stats) == pytest.approx(100, abs=0.05)


def test_monthly(seeded):
    months = seeded.get("/analytics/monthly").json()
    assert months == [
        {"month": "2026-09", "count": 2, "total": 150.5, "change_percent": None},
        {"month": "2026-10", "count": 2, "total": 249.5, "change_percent": 65.78},
    ]


def test_top(seeded):
    top = seeded.get("/analytics/top", params={"limit": 2}).json()
    assert [e["amount"] for e in top] == [200.0, 100.0]


def test_budgets(seeded):
    assert seeded.put("/budgets/Jedzenie", json={"monthly_limit": 150}).status_code == 200
    seeded.put("/budgets/transport", json={"monthly_limit": 100})

    status = {b["category"]: b for b in seeded.get("/budgets/status", params={"month": "2026-10"}).json()}
    assert status["jedzenie"]["spent"] == 200.0
    assert status["jedzenie"]["remaining"] == -50.0
    assert status["jedzenie"]["exceeded"] is True
    assert status["transport"]["spent"] == 0
    assert status["transport"]["exceeded"] is False

    assert seeded.get("/budgets/status", params={"month": "2026-13"}).status_code == 422
    assert seeded.delete("/budgets/transport").status_code == 204
    assert seeded.delete("/budgets/transport").status_code == 404
    assert [b["category"] for b in seeded.get("/budgets").json()] == ["jedzenie"]


def test_import_csv(client):
    csv_data = (
        "date;amount;category;description\n"
        "2026-10-01;12,50;Jedzenie;obiad\n"
        "2026-10-02;abc;transport;zła kwota\n"
        "2026-10-03;30;transport;\n"
    ).encode()
    r = client.post("/expenses/import", files={"file": ("w.csv", csv_data, "text/csv")})
    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == 2
    assert len(body["errors"]) == 1 and body["errors"][0].startswith("wiersz 3")
    assert client.get("/analytics/summary").json()["total"] == 42.5


def test_import_csv_missing_columns(client):
    r = client.post("/expenses/import", files={"file": ("w.csv", b"foo,bar\n1,2\n", "text/csv")})
    assert r.status_code == 400


def test_frontend(client):
    r = client.get("/")
    assert r.status_code == 200 and "Budżet domowy" in r.text
    assert 'APP_MODE = "server"' in client.get("/config.js").text
    assert client.get("/sw.js").headers["content-type"].startswith("text/javascript") or \
        client.get("/sw.js").headers["content-type"].startswith("application/javascript")
    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200
    for icon in manifest.json()["icons"]:
        assert client.get("/" + icon["src"]).status_code == 200
    # API nie jest przesłonięte przez pliki statyczne
    assert client.get("/health").json() == {"status": "ok"}


# ---------- przychody, bilans, stałe opłaty ----------

def add_income(client, amount, category, date, description=""):
    r = client.post("/incomes", json={
        "amount": amount, "category": category, "date": date, "description": description,
    })
    assert r.status_code == 201, r.text
    return r.json()


def test_incomes_crud(client):
    i = add_income(client, 6500, "Wynagrodzenie", "2026-10-10", "pensja")
    assert i["category"] == "wynagrodzenie"
    assert client.get(f"/incomes/{i['id']}").json()["amount"] == 6500.0
    assert client.patch(f"/incomes/{i['id']}", json={"amount": 6600}).json()["amount"] == 6600.0
    # przychody nie mieszają się z wydatkami
    assert client.get("/expenses").json() == []
    assert client.get(f"/expenses/{i['id']}").status_code == 404
    assert client.delete(f"/incomes/{i['id']}").status_code == 204
    assert client.get("/incomes").json() == []


def test_balance(seeded):
    add_income(seeded, 1000, "wynagrodzenie", "2026-09-10")
    add_income(seeded, 200, "premia", "2026-10-10")
    b = seeded.get("/analytics/balance").json()
    assert b["income"] == 1200.0
    assert b["expenses"] == 400.0
    assert b["balance"] == 800.0
    assert b["savings_rate"] == 66.67
    assert b["months"] == [
        {"month": "2026-09", "income": 1000.0, "expenses": 150.5, "balance": 849.5},
        {"month": "2026-10", "income": 200.0, "expenses": 249.5, "balance": -49.5},
    ]
    oct_ = seeded.get("/analytics/balance", params={"date_from": "2026-10-01"}).json()
    assert oct_["balance"] == -49.5


def test_balance_without_income(seeded):
    assert seeded.get("/analytics/balance").json()["savings_rate"] is None


def test_analytics_kind_income(seeded):
    add_income(seeded, 1000, "wynagrodzenie", "2026-09-10")
    add_income(seeded, 300, "800+", "2026-09-12")
    cats = seeded.get("/analytics/by-category", params={"kind": "income"}).json()
    assert [(c["category"], c["total"]) for c in cats] == [("wynagrodzenie", 1000.0), ("800+", 300.0)]
    assert seeded.get("/analytics/summary", params={"kind": "income"}).json()["total"] == 1300.0
    # domyślnie wydatki
    assert seeded.get("/analytics/summary").json()["total"] == 400.0
    assert seeded.get("/analytics/summary", params={"kind": "xyz"}).status_code == 422


def test_recurring_flow(client):
    gas = client.post("/recurring", json={"name": "Gaz", "category": "Gaz", "amount": 120, "day": 15}).json()
    pay = client.post("/recurring", json={"kind": "income", "name": "Pensja", "category": "wynagrodzenie",
                                          "amount": 6000, "day": 10}).json()
    assert gas["kind"] == "expense" and gas["category"] == "gaz"

    status = client.get("/recurring", params={"month": "2026-10"}).json()
    assert [(s["name"], s["paid"]) for s in status] == [("Gaz", False), ("Pensja", False)]

    # rachunek wyższy niż zwykle
    t = client.post(f"/recurring/{gas['id']}/pay", json={"month": "2026-10", "amount": 143.27})
    assert t.status_code == 201
    assert t.json() | {"id": 0} == {"id": 0, "amount": 143.27, "category": "gaz", "description": "Gaz",
                                    "date": "2026-10-15", "recurring_id": gas["id"]}
    assert client.post(f"/recurring/{gas['id']}/pay", json={"month": "2026-10"}).status_code == 409
    # pensja z typową kwotą trafia do przychodów
    assert client.post(f"/recurring/{pay['id']}/pay", json={"month": "2026-10"}).json()["amount"] == 6000.0
    assert client.get("/incomes").json()[0]["recurring_id"] == pay["id"]

    status = {s["name"]: s for s in client.get("/recurring", params={"month": "2026-10"}).json()}
    assert status["Gaz"]["paid"] and status["Gaz"]["paid_amount"] == 143.27
    assert client.get("/recurring", params={"month": "2026-11"}).json()[0]["paid"] is False

    # cofnięcie = usunięcie operacji
    client.delete(f"/expenses/{t.json()['id']}")
    assert client.get("/recurring", params={"month": "2026-10"}).json()[0]["paid"] is False

    # zmiana kwoty i usunięcie szablonu (zaksięgowane operacje zostają)
    assert client.patch(f"/recurring/{gas['id']}", json={"amount": 130}).json()["amount"] == 130.0
    assert client.delete(f"/recurring/{pay['id']}").status_code == 204
    assert client.get("/incomes").json()[0]["recurring_id"] is None
    assert client.get("/recurring", params={"month": "2026-13"}).status_code == 422
    assert client.post("/recurring", json={"name": "X", "category": "x", "amount": 1, "day": 31}).status_code == 422


def test_import_csv_with_type_column(client):
    csv_data = (
        "date;type;amount;category;description\n"
        "2026-10-01;wydatek;100;prąd;\n"
        "2026-10-10;przychód;5000;wynagrodzenie;pensja\n"
        "2026-10-11;coś;1;x;\n"
    ).encode()
    r = client.post("/expenses/import", files={"file": ("w.csv", csv_data, "text/csv")}).json()
    assert r["imported"] == 2 and len(r["errors"]) == 1
    assert client.get("/analytics/balance").json()["balance"] == 4900.0


def test_migrates_old_database(tmp_path, monkeypatch):
    import sqlite3
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, amount_cents INTEGER NOT NULL,
            category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', date TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')));
        INSERT INTO expenses (amount_cents, category, date) VALUES (1234, 'prąd', '2026-10-01');
    """)
    conn.close()
    monkeypatch.setenv("EXPENSES_DB", str(path))
    with TestClient(app) as c:
        assert c.get("/expenses").json()[0]["amount"] == 12.34
        assert c.get("/analytics/balance").json()["expenses"] == 12.34


# ---------- kalendarz ----------

from datetime import date, timedelta  # noqa: E402

from app.routers.events import next_after, occurrence  # noqa: E402


def test_occurrence_clamps_day():
    assert occurrence(date(2026, 1, 31), "monthly", 1) == date(2026, 2, 28)
    assert occurrence(date(2026, 1, 31), "monthly", 2) == date(2026, 3, 31)
    assert occurrence(date(2028, 2, 29), "yearly", 1) == date(2029, 2, 28)
    assert next_after(date(2026, 5, 10), "yearly", date(2026, 5, 10)) == date(2027, 5, 10)
    assert next_after(date(2026, 5, 10), "none", date(2026, 5, 10)) is None


def test_events_states_and_reminders(client):
    today = date.today()
    d = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731
    oc = client.post("/events", json={"title": "OC samochodu", "date": d(5), "repeat": "yearly",
                                      "amount": 1200, "category": "ubezpieczenie"}).json()
    assert oc["state"] == "soon" and oc["days_left"] == 5 and oc["remind_days"] == 7
    client.post("/events", json={"title": "Przegląd", "date": d(30), "remind_days": 14})
    client.post("/events", json={"title": "PIT", "date": d(-2)})
    later = client.post("/events", json={"title": "Urodziny", "date": d(10), "remind_days": 3}).json()
    assert later["state"] == "later"

    assert [e["title"] for e in client.get("/events").json()] == ["PIT", "OC samochodu", "Urodziny", "Przegląd"]
    assert [e["title"] for e in client.get("/events/reminders").json()] == ["PIT", "OC samochodu"]
    assert client.post("/events", json={"title": " ", "date": d(1)}).status_code == 422
    assert client.post("/events", json={"title": "x", "date": d(1), "remind_days": 61}).status_code == 422


def test_event_done_creates_expense_and_moves_to_next_year(client):
    today = date.today()
    due = today + timedelta(days=3)
    oc = client.post("/events", json={"title": "OC", "date": due.isoformat(), "repeat": "yearly",
                                      "category": "Ubezpieczenie"}).json()
    done = client.post(f"/events/{oc['id']}/done", json={"amount": 1234.5}).json()
    assert done["next_date"] == occurrence(due, "yearly", 1).isoformat()
    assert done["state"] == "later"
    exp = client.get("/expenses").json()[0]
    assert (exp["amount"], exp["category"], exp["description"], exp["date"]) == \
        (1234.5, "ubezpieczenie", "OC", today.isoformat())

    assert client.post(f"/events/{oc['id']}/undo").json()["next_date"] == due.isoformat()
    assert client.post(f"/events/{oc['id']}/undo").status_code == 409

    once = client.post("/events", json={"title": "Lekarz", "date": due.isoformat()}).json()
    r = client.post(f"/events/{once['id']}/done").json()
    assert r["state"] == "done" and r["next_date"] is None
    assert client.post(f"/events/{once['id']}/done").status_code == 409
    assert len(client.get("/expenses").json()) == 1  # bez kwoty nie ma wydatku


def test_event_calendar_and_update(client):
    ev = client.post("/events", json={"title": "Rata", "date": "2026-01-31", "repeat": "monthly"}).json()
    client.post("/events", json={"title": "Wizyta", "date": "2026-02-10"})
    feb = client.get("/events/calendar", params={"month": "2026-02"}).json()
    assert [(i["title"], i["date"]) for i in feb] == [("Wizyta", "2026-02-10"), ("Rata", "2026-02-28")]
    assert client.get("/events/calendar", params={"month": "2025-12"}).json() == []

    client.post(f"/events/{ev['id']}/done")  # odhacza styczeń
    jan = client.get("/events/calendar", params={"month": "2026-01"}).json()
    assert jan[0]["done"] is True

    upd = client.patch(f"/events/{ev['id']}", json={"date": "2026-03-15", "remind_days": 1}).json()
    assert upd["next_date"] == "2026-03-15" and upd["remind_days"] == 1  # zmiana daty zeruje postęp
    assert client.patch(f"/events/{ev['id']}", json={"category": "Kredyt"}).json()["category"] == "kredyt"
    assert client.patch(f"/events/{ev['id']}", json={"category": ""}).json()["category"] is None
    assert client.delete(f"/events/{ev['id']}").status_code == 204
    assert client.get("/events/calendar", params={"month": "2026-13"}).status_code == 422


# ---------- podpowiedzi (bez AI) ----------

import calendar  # noqa: E402

from app.insights import zl  # noqa: E402


def _month_day(offset_months: int, day: int) -> str:
    t = date.today()
    y, m = divmod(t.month - 1 + offset_months, 12)
    y, m = t.year + y, m + 1
    return date(y, m, min(day, calendar.monthrange(y, m)[1])).isoformat()


def test_insights_empty(client):
    r = client.get("/analytics/insights").json()
    assert [i["key"] for i in r["insights"]] == ["start"]
    assert r["forecast"]["projected_balance"] == 0


def test_insights_forecast_and_warnings(client):
    today = date.today()
    # historia: 3 poprzednie miesiące po 300 zł na jedzenie (5 zakupów po 60 zł)
    for k in (1, 2, 3):
        for d in (3, 8, 13, 18, 23):
            add(client, 60, "jedzenie", _month_day(-k, d), "Biedronka")
    # zeszły miesiąc: przychód 1000, wydatki 300 (jedzenie) + 650
    add_income(client, 1000, "wynagrodzenie", _month_day(-1, 10))
    add(client, 650, "inne", _month_day(-1, 11))
    # ten miesiąc: duży zakup jedzenia (skok + nietypowy wydatek), limit przekroczony
    add(client, 500, "jedzenie", today.replace(day=1).isoformat(), "Wielkie zakupy")
    client.put("/budgets/jedzenie", json={"monthly_limit": 400})
    client.post("/recurring", json={"name": "Prąd", "category": "prąd", "amount": 200, "day": 28})
    client.post("/recurring", json={"kind": "income", "name": "Pensja", "category": "wynagrodzenie",
                                    "amount": 3000, "day": 28})

    r = client.get("/analytics/insights").json()
    f = r["forecast"]
    dim = calendar.monthrange(today.year, today.month)[1]
    prev_days = sum(calendar.monthrange(*map(int, _month_day(-k, 1).split("-")[:2]))[1] for k in (1, 2, 3))
    variable_prev = 3 * 30000 + 65000  # jedzenie z 3 mies. + "inne"
    expected_variable = int(variable_prev / prev_days * (dim - today.day) + 0.5)
    assert f["planned_expenses"] == 200 and f["planned_income"] == 3000
    assert f["projected_variable"] == expected_variable / 100
    assert f["projected_expenses"] == (50000 + 20000 + expected_variable) / 100
    assert f["projected_balance"] == (300000 - 70000 - expected_variable) / 100

    keys = {i["key"]: i for i in r["insights"]}
    assert keys["forecast"]["level"] == "good"
    assert keys["budget:jedzenie"]["level"] == "alert"
    assert "o 100\u00a0zł za dużo" in keys["budget:jedzenie"]["text"]
    assert keys["spike:jedzenie"]["text"].startswith("W tym miesiącu 500 zł – o 67% więcej")
    assert keys[next(k for k in keys if k.startswith("unusual:"))]["text"].startswith("Wielkie zakupy: 500")
    assert keys["savings"]["level"] == "warning" and "5% przychodów" in keys["savings"]["text"]


def test_insights_upcoming_events(client):
    add(client, 10, "inne", date.today().isoformat())
    client.post("/events", json={"title": "OC", "date": (date.today() + timedelta(days=10)).isoformat(),
                                 "amount": 1200})
    up = next(i for i in client.get("/analytics/insights").json()["insights"] if i["key"] == "upcoming")
    assert "OC 1 200 zł (za 10 dni)" in up["text"]


def test_zl_format():
    assert zl(123456) == "1 235 zł"
    assert zl(-5000) == "−50 zł"
    assert zl(0) == "0 zł"


def test_suggest_category(client):
    s = lambda text, kind="expense": client.get(  # noqa: E731
        "/analytics/suggest-category", params={"text": text, "kind": kind}).json()
    assert s("ORLEN Warszawa") == {"category": "paliwo", "source": "keywords"}
    assert s("Rachunek Tauron") == {"category": "prąd", "source": "keywords"}
    assert s("wypłata październik", "income") == {"category": "wynagrodzenie", "source": "keywords"}
    assert s("coś zupełnie innego") == {"category": None, "source": None}
    # historia użytkownika ma pierwszeństwo przed słownikiem
    add(client, 30, "rozrywka", "2026-10-01", "Orlen hot-dog")
    add(client, 30, "rozrywka", "2026-10-02", "Orlen hot-dog")
    assert s("orlen hot-dog") == {"category": "rozrywka", "source": "history"}
    assert s("Kebab u Aliego") == {"category": None, "source": None}
    add(client, 25, "jedzenie", "2026-10-03", "Kebab u Aliego")
    assert s("kebab na mieście") == {"category": "jedzenie", "source": "history"}


# ---------- wyszukiwanie, bezpieczna kwota, cele, kategorie ----------

def test_search_q_is_case_and_polish_insensitive(client):
    add(client, 10, "jedzenie", "2026-10-01", "Żabka Łódź")
    add(client, 20, "paliwo", "2026-10-02", "Orlen")
    found = lambda q: [e["description"] for e in client.get("/expenses", params={"q": q}).json()]  # noqa: E731
    assert found("żABKA") == ["Żabka Łódź"]
    assert found("łÓdź") == ["Żabka Łódź"]
    assert found("PALIWO") == ["Orlen"]  # szuka też w kategorii
    assert found("xyz") == []


def test_forecast_safe_daily(client):
    today = date.today()
    dim = calendar.monthrange(today.year, today.month)[1]
    assert client.get("/analytics/insights").json()["forecast"]["safe_daily"] is None
    add_income(client, 3000, "wynagrodzenie", today.replace(day=1).isoformat())
    add(client, 500, "jedzenie", today.isoformat())
    client.post("/recurring", json={"name": "Czynsz", "category": "czynsz", "amount": 1000, "day": 28})
    f = client.get("/analytics/insights").json()["forecast"]
    assert f["safe_daily"] == int(150000 / (dim - today.day + 1) + 0.5) / 100


def test_goals(client):
    in3 = date.today().replace(day=1)
    y, m = divmod(in3.month - 1 + 2, 12)
    deadline = date(in3.year + y, m + 1, 15).isoformat()  # 3 miesiące licząc bieżący
    g = client.post("/goals", json={"name": " Wakacje ", "target": 3000, "saved": 600, "deadline": deadline}).json()
    assert (g["name"], g["percent"], g["remaining"], g["monthly_needed"], g["done"]) == ("Wakacje", 20, 2400, 800, False)
    assert client.post(f"/goals/{g['id']}/deposit", json={"amount": 2400}).json()["done"] is True
    assert client.post(f"/goals/{g['id']}/deposit", json={"amount": -5000}).status_code == 422
    assert client.post(f"/goals/{g['id']}/deposit", json={"amount": 0}).status_code == 422
    w = client.post(f"/goals/{g['id']}/deposit", json={"amount": -1000}).json()
    assert w["saved"] == 2000 and w["percent"] == 66
    nod = client.patch(f"/goals/{g['id']}", json={"deadline": None, "target": 4000}).json()
    assert nod["deadline"] is None and nod["monthly_needed"] is None and nod["target"] == 4000
    client.post("/goals", json={"name": "Auto", "target": 100, "saved": 100})
    assert [x["name"] for x in client.get("/goals").json()] == ["Wakacje", "Auto"]  # zrealizowane na końcu
    assert client.delete(f"/goals/{g['id']}").status_code == 204
    assert client.post("/goals", json={"name": "", "target": 1}).status_code == 422


def test_categories_rename_and_merge(client):
    add(client, 10, "jedzneie", "2026-10-01")  # literówka
    add(client, 20, "jedzneie", "2026-10-02")
    add(client, 30, "jedzenie", "2026-10-03")
    client.put("/budgets/jedzneie", json={"monthly_limit": 100})
    client.put("/budgets/jedzenie", json={"monthly_limit": 500})
    client.post("/recurring", json={"name": "Catering", "category": "jedzneie", "amount": 50, "day": 1})
    cats = client.get("/categories").json()
    assert cats[0] == {"kind": "expense", "category": "jedzneie", "count": 2, "total": 30.0}
    r = client.post("/categories/rename", json={"kind": "expense", "from": "Jedzneie", "to": "jedzenie"})
    assert r.json() == {"updated": 2}
    assert client.get("/categories").json() == [{"kind": "expense", "category": "jedzenie", "count": 3, "total": 60.0}]
    assert client.get("/budgets").json() == [{"category": "jedzenie", "monthly_limit": 500.0}]
    assert client.get("/recurring").json()[0]["category"] == "jedzenie"
    assert client.post("/categories/rename", json={"kind": "expense", "from": "a", "to": "A"}).status_code == 422


# ---------- doradca finansowy ----------

def _months_back(n):
    from app.advisor import month_shift
    from datetime import date
    return month_shift(date.today().strftime("%Y-%m"), -n)


def _seed_months(client, months=3, income=5000, loan=1500, fun=400, food=900):
    for k in range(months, 0, -1):
        m = _months_back(k)
        client.post("/incomes", json={"amount": income, "category": "wynagrodzenie", "date": f"{m}-10"})
        add(client, loan, "kredyt", f"{m}-05", "Rata")
        add(client, food, "jedzenie", f"{m}-12", "Biedronka")
        add(client, fun, "rozrywka", f"{m}-20", "Kino")
        add(client, 49, "rozrywka", f"{m}-03", "Netflix")


def test_report_empty(client):
    r = client.get("/analytics/report").json()
    assert r["health"]["score"] is None
    assert r["recommendations"][0]["key"] == "start"
    assert client.get("/analytics/report", params={"month": "2026-13"}).status_code == 422


def test_report_health_and_ratios(client):
    _seed_months(client)
    r = client.get("/analytics/report").json()
    assert r["complete"] is False
    assert r["basis_months"] == [_months_back(3), _months_back(2), _months_back(1)]
    a = r["averages"]
    assert a["income"] == 5000 and a["expenses"] == 2849 and a["debt_payments"] == 1500
    assert a["needs"] == 2400 and a["wants"] == 449 and a["fixed"] == 1500
    assert r["ratios"]["debt_to_income_percent"] == 30.0
    assert r["ratios"]["savings_percent"] == 43.02
    h = {c["key"]: c for c in r["health"]["components"]}
    assert h["savings"]["points"] == 30 and h["emergency"]["points"] == 0
    assert h["debt"]["points"] == 7 and h["fixed"]["points"] == 15 and h["budgets"]["points"] == 5
    assert r["health"]["score"] == 57 and r["health"]["label"] == "przeciętna"
    keys = [x["key"] for x in r["recommendations"]]
    assert keys == ["emergency", "budgets"]
    assert "brakuje 8\u00a0547\u00a0zł" in r["recommendations"][0]["text"]

    # Oszczędności spoza aplikacji poprawiają poduszkę.
    r2 = client.get("/analytics/report", params={"savings": 20000}).json()
    assert r2["emergency_fund"]["months_covered"] == 7.0
    assert r2["health"]["score"] == 82

    # Zakończony miesiąc: okres bazowy kończy się na nim.
    last = client.get("/analytics/report", params={"month": _months_back(1)}).json()
    assert last["complete"] is True and last["basis_months"][-1] == _months_back(1)
    assert last["totals"]["savings_rate"] == 43.02


def test_report_spike_and_low_savings(client):
    _seed_months(client, income=3000)
    m = _months_back(0)
    add(client, 600, "rozrywka", f"{m}-01", "Koncert")
    r = client.get("/analytics/report").json()
    cat = next(c for c in r["categories"] if c["category"] == "rozrywka")
    assert cat["usual"] == 449 and cat["change_percent"] == 33.63 and cat["need"] is False
    keys = [x["key"] for x in r["recommendations"]]
    assert keys[0] == "savings" and "debt" in keys and "spike" in keys
    assert "rozrywka" in r["recommendations"][0]["text"]


def test_trends_compare(client):
    _seed_months(client)
    add(client, 100, "rozrywka", f"{_months_back(2)}-21")
    add(client, 300, "rozrywka", f"{_months_back(1)}-21")
    t = client.get("/analytics/trends", params={"months": 4}).json()
    assert t["months"][-1] == _months_back(0)
    fun = next(c for c in t["categories"] if c["category"] == "rozrywka")
    assert fun["values"] == [449, 549, 749, 0] and fun["trend"] == "up" and fun["slope"] == 150
    assert next(c for c in t["categories"] if c["category"] == "kredyt")["trend"] == "flat"
    assert client.get("/analytics/trends", params={"months": 2}).status_code == 422

    c = client.get("/analytics/compare", params={"a": _months_back(3), "b": _months_back(1)}).json()
    assert c["diff"] == 300 and c["categories"][0] == {
        "category": "rozrywka", "a": 449, "b": 749, "diff": 300, "change_percent": 66.82}


def test_merchants_and_subscriptions(client):
    _seed_months(client, months=4)
    add(client, 12, "jedzenie", f"{_months_back(1)}-13", "  biedronka ")
    m = client.get("/analytics/merchants", params={"limit": 2}).json()
    assert m[0]["name"] == "Rata" and m[1]["name"] == "biedronka" and m[1]["count"] == 5
    s = client.get("/analytics/subscriptions").json()
    names = {i["name"]: i for i in s["items"]}
    assert names["Netflix"]["fixed_amount"] is True and names["Netflix"]["yearly_cost"] == 588
    assert names["Netflix"]["active"] is True and names["Netflix"]["registered"] is False
    client.post("/recurring", json={"kind": "expense", "name": "netflix", "category": "rozrywka", "amount": 49, "day": 3})
    s = client.get("/analytics/subscriptions").json()
    assert next(i for i in s["items"] if i["name"] == "Netflix")["registered"] is True


def test_patterns(client):
    add(client, 100, "jedzenie", "2026-06-06")   # sobota
    add(client, 30, "jedzenie", "2026-06-08")    # poniedziałek
    add(client, 70, "rozrywka", "2026-06-25")
    p = client.get("/analytics/patterns", params={"date_from": "2026-06-01", "date_to": "2026-06-30"}).json()
    assert p["days"] == 30 and p["total"] == 200 and p["daily_average"] == 6.67
    assert p["weekend_share_percent"] == 50.0
    assert p["by_weekday"][0] == {"weekday": "poniedziałek", "total": 30, "count": 1, "share_percent": 15.0}
    assert [x["total"] for x in p["by_part_of_month"]] == [130, 0, 70]
    assert p["small_purchases"]["count"] == 1
    assert client.get("/analytics/patterns", params={"date_from": "2026-07-01", "date_to": "2026-06-01"}).status_code == 422
