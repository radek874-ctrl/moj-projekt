# Budżet domowy – API i aplikacja

Przychody, wydatki, stałe opłaty (gaz, prąd, woda, kredyt…), kalendarz ważnych
terminów z przypomnieniami, limity wydatków i analiza budżetu domowego. Ten sam kod działa w dwóch trybach:

| Tryb | Gdzie są dane | Jak uruchomić |
|---|---|---|
| **Aplikacja w przeglądarce** (zalecany) | w telefonie (pamięć przeglądarki) | https://radek874-ctrl.github.io/moj-projekt/ → „Zainstaluj” |
| **Serwer API** (FastAPI + SQLite) | plik `expenses.db` | `uvicorn app.main:app` |

## Najważniejsze pojęcia

| Pojęcie | Zasób API | Przykład |
|---|---|---|
| **Wydatek** | `/expenses` | zakupy 120 zł, paliwo 250 zł |
| **Przychód** | `/incomes` | wynagrodzenie 7200 zł, 800+ |
| **Stała pozycja** | `/recurring` | prąd ok. 180 zł do 15. każdego miesiąca |
| **Termin** | `/events` | OC samochodu co rok 18.10, przypomnienie tydzień wcześniej |
| **Limit** | `/budgets` | jedzenie maks. 1500 zł miesięcznie |
| **Bilans** | `/analytics/balance` | przychody − wydatki w okresie |

Zasady wspólne dla całego API:
- kwoty w złotych, dodatnie, maks. 2 miejsca po przecinku (`189.99`);
- daty `RRRR-MM-DD`, miesiące `RRRR-MM`;
- kategorie zapisywane małymi literami bez spacji na brzegach (`"Prąd "` → `"prąd"`);
- błędy walidacji zwracają `422`, brak obiektu `404`, konflikt `409`.

## Endpointy

Pełna, klikalna dokumentacja: `http://localhost:8000/docs`.

### Wydatki `/expenses` i przychody `/incomes`

Oba zasoby mają identyczne operacje.

| Metoda | Ścieżka | Opis |
|---|---|---|
| `POST` | `/expenses` | Dodaj: `{"amount": 189.99, "category": "prąd", "description": "", "date": "2026-10-15"}` |
| `GET` | `/expenses` | Lista, najnowsze pierwsze. Filtry: `date_from`, `date_to`, `category`; strony: `limit`, `offset` |
| `GET` | `/expenses/{id}` | Szczegóły |
| `PATCH` | `/expenses/{id}` | Zmień wybrane pola |
| `DELETE` | `/expenses/{id}` | Usuń |
| `POST` | `/expenses/import` | Import CSV (`multipart/form-data`, pole `file`) |

To samo pod `/incomes`.

**CSV**: kolumny `date;amount;category;description`, opcjonalnie `type`
(`wydatek` / `przychód`). Separator `;` lub `,`; kwota może mieć przecinek
dziesiętny. Wiersze bez `type` trafiają do zasobu, do którego wysłano plik.
Błędne wiersze są pomijane i opisane w polu `errors`.

```csv
date;type;amount;category;description
2026-10-10;przychód;7200;wynagrodzenie;pensja
2026-10-15;wydatek;212,37;prąd;rachunek
```

### Stałe opłaty i przychody `/recurring`

Szablon pozycji powtarzającej się co miesiąc. „Zapłać” tworzy zwykły wydatek
(albo przychód) powiązany z szablonem, więc status opłacenia wynika z danych,
a cofnięcie to usunięcie tej operacji.

| Metoda | Ścieżka | Opis |
|---|---|---|
| `POST` | `/recurring` | Dodaj: `{"kind": "expense", "name": "Prąd", "category": "prąd", "amount": 180, "day": 15}` |
| `GET` | `/recurring?month=2026-10` | Lista ze statusem: `paid`, `paid_amount`, `transaction_id` |
| `POST` | `/recurring/{id}/pay` | Oznacz jako zapłacone: `{"month": "2026-10", "amount": 212.37}` (oba pola opcjonalne) |
| `PATCH` | `/recurring/{id}` | Zmień nazwę, kategorię, kwotę lub dzień |
| `DELETE` | `/recurring/{id}` | Usuń szablon (zapisane płatności zostają w historii) |

`kind`: `expense` (opłata, domyślnie) albo `income` (stały przychód).
`day`: 1–28. Ponowna płatność w tym samym miesiącu zwraca `409`.

### Kalendarz terminów `/events`

Ważne daty (OC, przegląd, podatki, urodziny) z przypomnieniem kilka dni
wcześniej. Termin może być jednorazowy albo powtarzać się co miesiąc / co rok
(dzień przycinany do końca miesiąca, np. 31 → 28 lutego).

| Metoda | Ścieżka | Opis |
|---|---|---|
| `POST` | `/events` | Dodaj: `{"title": "OC samochodu", "date": "2026-10-18", "repeat": "yearly", "remind_days": 7, "amount": 1200, "category": "ubezpieczenie"}` |
| `GET` | `/events` | Wszystkie terminy, najpilniejsze pierwsze, z `next_date`, `days_left` i `state` |
| `GET` | `/events/reminders` | Tylko to, co wymaga uwagi teraz (`overdue` i `soon`) |
| `GET` | `/events/calendar?month=2026-10` | Wystąpienia w miesiącu (do siatki kalendarza) |
| `POST` | `/events/{id}/done` | Odhacz najbliższe wystąpienie; z `{"amount": 1234.50}` zapisuje też wydatek |
| `POST` | `/events/{id}/undo` | Cofnij ostatnie odhaczenie |
| `PATCH` | `/events/{id}` | Zmień (nowa `date` liczy terminy od nowa; `"category": ""` czyści kategorię) |
| `DELETE` | `/events/{id}` | Usuń |

`state`: `soon` – w okresie przypomnienia (≤ `remind_days` dni do terminu),
`overdue` – po terminie i nieodhaczony, `later` – jeszcze nie czas,
`done` – jednorazowy i zrobiony. `repeat`: `none`, `monthly`, `yearly`.

### Analiza `/analytics`

| Ścieżka | Zwraca |
|---|---|
| `GET /analytics/balance` | `income`, `expenses`, `balance`, `savings_rate` (% przychodów, które zostały) i to samo per miesiąc |
| `GET /analytics/summary` | liczba, suma, średnia, min, max, średnia dzienna |
| `GET /analytics/by-category` | suma, liczba, średnia i udział % każdej kategorii |
| `GET /analytics/monthly` | sumy miesięczne + zmiana % miesiąc do miesiąca |
| `GET /analytics/top?limit=10` | największe pozycje |

Wszystkie przyjmują `date_from` i `date_to`. Oprócz `balance` przyjmują też
`category` oraz `kind=expense` (domyślnie) lub `kind=income`, np.
`/analytics/by-category?kind=income` pokazuje źródła przychodów.

### Limity wydatków `/budgets`

| Metoda | Ścieżka | Opis |
|---|---|---|
| `PUT` | `/budgets/{kategoria}` | Ustaw limit: `{"monthly_limit": 1500}` |
| `GET` | `/budgets` | Lista limitów |
| `GET` | `/budgets/status?month=2026-10` | Wydano / zostało / % / czy przekroczono |
| `DELETE` | `/budgets/{kategoria}` | Usuń limit |

## Aplikacja (PWA)

Zakładki: **Pulpit** (bilans, przypomnienie o niezapłaconych rachunkach,
wykres przychodów i wydatków, kategorie), **Dodaj** (wydatek/przychód,
kategorie z ikonami, import, kopia zapasowa), **Opłaty** (stałe pozycje
z przyciskiem „Zapłać”), **Kalendarz** (siatka miesiąca, terminy, przypomnienia,
link „Dodaj do Kalendarza Google” dla powiadomień systemowych), **Historia**, **Limity**.

Przypomnienia pokazują się na Pulpicie i jako licznik na zakładce (oraz na ikonie
aplikacji, jeśli telefon to obsługuje) – po otwarciu aplikacji.

### Tryb bez serwera (GitHub Pages)

`app/static/store.js` odtwarza całe API w przeglądarce (te same ścieżki
i odpowiedzi), a dane trzyma w localStorage. Tryb wybiera `config.js`: plik
statyczny ustawia `"local"`, serwer FastAPI podmienia go na `"server"`.
Publikacja: workflow `.github/workflows/pages.yml` przy każdej zmianie
w `app/static` (jednorazowo: *Settings → Pages → Source: GitHub Actions*).

Dane są tylko w tym telefonie, dlatego warto co jakiś czas zrobić
*Dodaj → Kopia zapasowa → Zapisz pełną kopię*.

### Serwer na telefonie (Android + Termux, opcjonalnie)

```bash
git clone https://github.com/radek874-ctrl/moj-projekt.git
cd moj-projekt
./install-termux.sh   # raz
./start.sh            # uruchamia serwer i otwiera aplikację; ./stop.sh zatrzymuje
```

Serwer nasłuchuje tylko na `127.0.0.1`. Skróty na ekran główny tworzy
*Termux:Widget* („Wydatki”, „Wydatki stop”).

## Uruchomienie serwera i testy

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload   # dokumentacja: http://localhost:8000/docs
pytest
```

Plik bazy ustawia zmienna `EXPENSES_DB` (domyślnie `expenses.db`). Starsze
bazy są automatycznie uzupełniane o nowe tabele przy starcie.

## Struktura

```
app/
  main.py              # aplikacja FastAPI, opis API
  db.py                # SQLite: schemat, migracja, konwersja groszy
  schemas.py           # modele danych (wejście/wyjście)
  filters.py           # filtry zapytań (daty, kategoria)
  routers/
    transactions.py    # /expenses i /incomes (wspólna fabryka) + import CSV
    recurring.py       # /recurring – stałe opłaty i przychody
    events.py          # /events – kalendarz terminów i przypomnienia
    analytics.py       # /analytics – bilans i statystyki
    budgets.py         # /budgets – limity wydatków
  static/              # aplikacja (HTML/CSS/JS, manifest, service worker)
    store.js           # API w przeglądarce (tryb bez serwera)
start.sh / stop.sh     # serwer w Termuxie
install-termux.sh      # instalacja w Termuxie
tests/test_api.py
```

Kwoty są przechowywane w groszach (liczby całkowite), co eliminuje błędy zaokrągleń.
