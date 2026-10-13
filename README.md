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

## Inteligencja

### Podpowiedzi bez AI (`/analytics/insights`, `/analytics/suggest-category`)

Liczone lokalnie, za darmo i bez internetu (`app/insights.py`, to samo w `store.js`):

- **prognoza na koniec miesiąca**: przychody i wydatki do tej pory, niezapłacone stałe
  pozycje i dalsze wydatki zmienne według średniej z 3 poprzednich miesięcy;
- **limity**: przekroczony albo „przy tym tempie skończy się ok. 24. dnia”;
- **skoki w kategoriach**: o ≥30% i ≥50 zł więcej niż średnia z 3 miesięcy;
- **nietypowo duże wydatki**: ponad 3× mediana kategorii z ostatnich 180 dni;
- **nadchodzące koszty** z kalendarza (30 dni) i **ocena oszczędzania** w zeszłym miesiącu.

`GET /analytics/suggest-category?text=Orlen&kind=expense` → `{"category": "paliwo", "source": "keywords"}`.
Najpierw sprawdza Twoje wcześniejsze wpisy (`history`), potem słownik (`keywords`).

### Asystent AI (Claude)

Przycisk ✨ w aplikacji otwiera czat (`app/static/assistant.js`). Asystent:
- odpowiada na pytania o finanse na podstawie danych z aplikacji (korzysta z narzędzi
  wywołujących to samo API: bilans, kategorie, wpisy, podpowiedzi, opłaty, kalendarz, limity);
- zapisuje wydatki i przychody, opłaca stałe rachunki i dodaje terminy, zawsze po potwierdzeniu
  w oknie dialogowym;
- czyta zdjęcia paragonów (📷) i zapisuje je jako wydatek.

Wymaga własnego klucza API Anthropic (⚙ w oknie asystenta). Klucz jest zapisany tylko
w przeglądarce. Pytania i potrzebne dane budżetu trafiają do Anthropic. Domyślny model to
Claude Opus 5.5 (do wyboru tańsze Sonnet 5.5 i Haiku 5.5), koszt każdej odpowiedzi widać pod nią.
Dla Opus i Sonnet włączony jest serwerowy fallback (`fallbacks: "default"`). Oficjalne SDK
`@anthropic-ai/sdk` 0.129.0 jest dołączone w `app/static/vendor/` (licencja MIT).

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
  insights.py          # podpowiedzi i prognoza bez AI, podpowiadanie kategorii
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
    assistant.js       # asystent AI (Claude) z narzędziami
    vendor/            # dołączone SDK Anthropic
start.sh / stop.sh     # serwer w Termuxie
install-termux.sh      # instalacja w Termuxie
tests/test_api.py
```

Kwoty są przechowywane w groszach (liczby całkowite), co eliminuje błędy zaokrągleń.
