"""Kalendarz ważnych terminów z przypomnieniami (OC, przegląd, podatki, urodziny...).

Termin może być jednorazowy albo powtarzać się co miesiąc / co rok. Po
odhaczeniu („zrobione”) powtarzany termin przechodzi na następne wystąpienie,
a jednorazowy dostaje stan ``done``. Przypomnienie jest aktywne (``soon``)
od ``remind_days`` dni przed terminem; nieodhaczony termin po dacie ma stan
``overdue``.
"""

import calendar
import sqlite3
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.db import from_cents, get_db, to_cents
from app.routers.transactions import insert_transaction
from app.schemas import (
    MONTH_PATTERN, CalendarItem, Event, EventCreate, EventDone, EventState, EventUpdate,
    Kind, Repeat, TransactionCreate,
)

router = APIRouter(prefix="/events", tags=["kalendarz"])

Db = Annotated[sqlite3.Connection, Depends(get_db)]
MAX_STEPS = 2400  # bezpiecznik pętli: 200 lat terminów miesięcznych


# ---------- arytmetyka terminów ----------

def occurrence(base: date, repeat: str, n: int) -> date:
    """n-te wystąpienie terminu (0 = pierwsze). Dzień przycinany do końca miesiąca."""
    if repeat == Repeat.none.value:
        return base
    months = n if repeat == Repeat.monthly.value else 12 * n
    y, m = divmod(base.month - 1 + months, 12)
    year, month = base.year + y, m + 1
    return date(year, month, min(base.day, calendar.monthrange(year, month)[1]))


def next_after(base: date, repeat: str, done_until: date | None) -> date | None:
    """Pierwsze wystąpienie po ``done_until`` (bez niego: pierwsze w ogóle)."""
    if done_until is None:
        return base
    if repeat == Repeat.none.value:
        return None if done_until >= base else base
    for n in range(MAX_STEPS):
        occ = occurrence(base, repeat, n)
        if occ > done_until:
            return occ
    return None


def previous_before(base: date, repeat: str, current: date) -> date | None:
    """Ostatnie wystąpienie przed ``current`` (do cofania „zrobione”)."""
    prev = None
    for n in range(MAX_STEPS):
        occ = occurrence(base, repeat, n)
        if occ >= current or (repeat == Repeat.none.value and n > 0):
            break
        prev = occ
    return prev


def _to_model(row: sqlite3.Row, today: date) -> Event:
    base = date.fromisoformat(row["date"])
    done_until = date.fromisoformat(row["done_until"]) if row["done_until"] else None
    nxt = next_after(base, row["repeat"], done_until)
    days_left = (nxt - today).days if nxt else None
    if nxt is None:
        state = EventState.done
    elif days_left < 0:
        state = EventState.overdue
    elif days_left <= row["remind_days"]:
        state = EventState.soon
    else:
        state = EventState.later
    return Event(
        id=row["id"], title=row["title"], date=base, repeat=row["repeat"],
        remind_days=row["remind_days"],
        amount=from_cents(row["amount_cents"]) if row["amount_cents"] else None,
        category=row["category"], note=row["note"],
        next_date=nxt, days_left=days_left, state=state,
    )


def _get_or_404(db: sqlite3.Connection, event_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono terminu")
    return row


_STATE_ORDER = {EventState.overdue: 0, EventState.soon: 1, EventState.later: 2, EventState.done: 3}


# ---------- endpointy ----------

@router.get("", response_model=list[Event], summary="Wszystkie terminy (najpilniejsze pierwsze)")
def list_events(db: Db):
    today = date.today()
    events = [_to_model(r, today) for r in db.execute("SELECT * FROM events")]
    return sorted(events, key=lambda e: (_STATE_ORDER[e.state], e.next_date or date.max, e.title))


@router.get("/reminders", response_model=list[Event], summary="Aktywne przypomnienia")
def reminders(db: Db):
    """Terminy po czasie albo w okresie przypomnienia — to, co trzeba zrobić teraz."""
    return [e for e in list_events(db) if e.state in (EventState.overdue, EventState.soon)]


@router.get("/calendar", response_model=list[CalendarItem], summary="Wystąpienia w miesiącu")
def month_calendar(
    db: Db,
    month: Annotated[str, Query(pattern=MONTH_PATTERN, description="Miesiąc RRRR-MM")],
):
    """Wszystkie wystąpienia terminów w danym miesiącu (do widoku kalendarza)."""
    y, m = map(int, month.split("-"))
    start = date(y, m, 1)
    end = date(y, m, calendar.monthrange(y, m)[1])
    items = []
    for row in db.execute("SELECT * FROM events"):
        base = date.fromisoformat(row["date"])
        done_until = date.fromisoformat(row["done_until"]) if row["done_until"] else None
        for n in range(MAX_STEPS):
            occ = occurrence(base, row["repeat"], n)
            if occ > end or (row["repeat"] == Repeat.none.value and n > 0):
                break
            if occ >= start:
                items.append(CalendarItem(event_id=row["id"], title=row["title"], date=occ,
                                          done=done_until is not None and occ <= done_until))
    return sorted(items, key=lambda i: (i.date, i.title))


@router.post("", response_model=Event, status_code=status.HTTP_201_CREATED, summary="Dodaj termin")
def create_event(data: EventCreate, db: Db):
    cur = db.execute(
        """INSERT INTO events (title, date, repeat, remind_days, amount_cents, category, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (data.title, data.date.isoformat(), data.repeat.value, data.remind_days,
         to_cents(data.amount) if data.amount is not None else None, data.category, data.note.strip()),
    )
    return _to_model(_get_or_404(db, cur.lastrowid), date.today())


@router.patch("/{event_id}", response_model=Event, summary="Zmień termin")
def update_event(event_id: int, data: EventUpdate, db: Db):
    _get_or_404(db, event_id)
    changes = data.model_dump(exclude_unset=True)
    # Pusta kategoria ("") czyści ją; pozostałe pola z null pomijamy.
    changes = {k: v for k, v in changes.items() if v is not None or k == "category"}
    if "title" in changes:
        changes["title"] = changes["title"].strip()
    if "date" in changes:
        changes["date"] = changes["date"].isoformat()
        changes["done_until"] = None  # nowa data = liczymy od nowa
    if "repeat" in changes:
        changes["repeat"] = changes["repeat"].value
    if "amount" in changes:
        changes["amount_cents"] = to_cents(changes.pop("amount"))
    if changes:
        sets = ", ".join(f"{k} = ?" for k in changes)
        db.execute(f"UPDATE events SET {sets} WHERE id = ?", [*changes.values(), event_id])
    return _to_model(_get_or_404(db, event_id), date.today())


@router.delete("/{event_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Usuń termin")
def delete_event(event_id: int, db: Db):
    _get_or_404(db, event_id)
    db.execute("DELETE FROM events WHERE id = ?", (event_id,))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{event_id}/done", response_model=Event, summary="Oznacz jako zrobione")
def mark_done(event_id: int, db: Db, data: EventDone | None = None):
    """Odhacza najbliższe wystąpienie. Z ``amount`` zapisuje też wydatek z dzisiejszą datą
    (kategoria terminu albo „inne”, opis = tytuł terminu)."""
    data = data or EventDone()
    row = _get_or_404(db, event_id)
    base = date.fromisoformat(row["date"])
    done_until = date.fromisoformat(row["done_until"]) if row["done_until"] else None
    current = next_after(base, row["repeat"], done_until)
    if current is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ten termin jest już zrobiony")
    db.execute("UPDATE events SET done_until = ? WHERE id = ?", (current.isoformat(), event_id))
    if data.amount is not None:
        insert_transaction(db, Kind.expense, TransactionCreate(
            amount=data.amount, category=row["category"] or "inne",
            description=row["title"], date=date.today(),
        ))
    return _to_model(_get_or_404(db, event_id), date.today())


@router.post("/{event_id}/undo", response_model=Event, summary="Cofnij ostatnie „zrobione”")
def undo_done(event_id: int, db: Db):
    """Przywraca ostatnio odhaczone wystąpienie (zapisany wydatek trzeba usunąć osobno)."""
    row = _get_or_404(db, event_id)
    if not row["done_until"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "Nie ma czego cofnąć")
    base = date.fromisoformat(row["date"])
    prev = previous_before(base, row["repeat"], date.fromisoformat(row["done_until"]))
    db.execute("UPDATE events SET done_until = ? WHERE id = ?",
               (prev.isoformat() if prev else None, event_id))
    return _to_model(_get_or_404(db, event_id), date.today())
