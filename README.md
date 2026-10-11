# API do analizy wydatków

REST API (FastAPI + SQLite) do rejestrowania wydatków, importu z CSV,
analizy statystycznej i kontroli miesięcznych budżetów.

## Uruchomienie

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Dokumentacja interaktywna: http://localhost:8000/docs

Plik bazy danych ustawia zmienna `EXPENSES_DB` (domyślnie `expenses.db`).

## Testy

```bash
pytest
```

## Endpointy

### Wydatki

| Metoda | Ścieżka | Opis |
|---|---|---|
| `POST` | `/expenses` | Dodaj wydatek |
| `GET` | `/expenses` | Lista (filtry: `date_from`, `date_to`, `category`; paginacja: `limit`, `offset`) |
| `GET` | `/expenses/{id}` | Pojedynczy wydatek |
| `PATCH` | `/expenses/{id}` | Częściowa aktualizacja |
| `DELETE` | `/expenses/{id}` | Usunięcie |
| `POST` | `/expenses/import` | Import CSV (`multipart/form-data`, pole `file`) |

Przykład:

```bash
curl -X POST localhost:8000/expenses -H 'Content-Type: application/json' \
  -d '{"amount": 49.99, "category": "jedzenie", "description": "zakupy", "date": "2026-10-11"}'
```

Kategorie są normalizowane (małe litery, bez spacji na brzegach), więc
`"Jedzenie"` i `"jedzenie "` to ta sama kategoria. Kwoty muszą być dodatnie
i mieć maksymalnie 2 miejsca po przecinku.

**Format CSV** — kolumny `date,amount,category[,description]`, separator `,` lub `;`,
kwota może mieć przecinek dziesiętny:

```csv
date;amount;category;description
2026-10-01;12,50;jedzenie;obiad
2026-10-03;30;transport;bilet miesięczny
```

Błędne wiersze są pomijane i zwracane w polu `errors`.

### Analiza

Wszystkie endpointy przyjmują filtry `date_from`, `date_to`, `category`.

| Ścieżka | Zwraca |
|---|---|
| `GET /analytics/summary` | liczba, suma, średnia, min, max, średnia dzienna dla okresu |
| `GET /analytics/by-category` | suma, liczba, średnia i udział % każdej kategorii |
| `GET /analytics/monthly` | sumy miesięczne + zmiana % miesiąc do miesiąca |
| `GET /analytics/top?limit=10` | największe pojedyncze wydatki |

### Budżety

| Metoda | Ścieżka | Opis |
|---|---|---|
| `PUT` | `/budgets/{category}` | Ustaw miesięczny limit: `{"monthly_limit": 800}` |
| `GET` | `/budgets` | Lista budżetów |
| `GET` | `/budgets/status?month=2026-10` | Wydano / pozostało / % wykorzystania / przekroczenie (domyślnie bieżący miesiąc) |
| `DELETE` | `/budgets/{category}` | Usuń budżet |

## Struktura

```
app/
  main.py            # aplikacja FastAPI
  db.py              # SQLite, schemat, konwersja groszy
  schemas.py         # modele Pydantic
  filters.py         # wspólne filtry zapytań
  routers/
    expenses.py      # CRUD + import CSV
    analytics.py     # statystyki
    budgets.py       # budżety
tests/test_api.py
```

Kwoty są przechowywane w groszach (liczby całkowite), co eliminuje błędy zaokrągleń.
