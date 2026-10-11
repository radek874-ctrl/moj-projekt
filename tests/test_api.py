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
