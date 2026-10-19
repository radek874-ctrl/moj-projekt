"""Cele oszczędnościowe: na co odkładasz, ile już masz i ile trzeba odkładać miesięcznie."""

import math
import sqlite3
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.db import from_cents, get_db, to_cents
from app.schemas import Goal, GoalCreate, GoalDeposit, GoalUpdate

router = APIRouter(prefix="/goals", tags=["cele"])

Db = Annotated[sqlite3.Connection, Depends(get_db)]


def _to_model(row: sqlite3.Row, today: date) -> Goal:
    target, saved = row["target_cents"], row["saved_cents"]
    remaining = max(0, target - saved)
    deadline = date.fromisoformat(row["deadline"]) if row["deadline"] else None
    monthly = None
    if deadline and remaining:
        # Liczba miesięcy do terminu, licząc bieżący (min. 1).
        months = max(1, (deadline.year - today.year) * 12 + deadline.month - today.month + 1)
        monthly = math.floor(remaining / months + 0.5) / 100
    return Goal(
        id=row["id"], name=row["name"], target=from_cents(target), saved=from_cents(saved),
        deadline=deadline, percent=min(100, saved * 100 // target), remaining=from_cents(remaining),
        monthly_needed=monthly, done=saved >= target,
    )


def _get_or_404(db: sqlite3.Connection, goal_id: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Nie znaleziono celu")
    return row


@router.get("", response_model=list[Goal], summary="Lista celów")
def list_goals(db: Db):
    today = date.today()
    goals = [_to_model(r, today) for r in db.execute("SELECT * FROM goals")]
    # Najpierw niezrealizowane, wg terminu; potem zrealizowane.
    return sorted(goals, key=lambda g: (g.done, g.deadline or date.max, g.name))


@router.post("", response_model=Goal, status_code=status.HTTP_201_CREATED, summary="Dodaj cel")
def create_goal(data: GoalCreate, db: Db):
    cur = db.execute(
        "INSERT INTO goals (name, target_cents, saved_cents, deadline) VALUES (?, ?, ?, ?)",
        (data.name, to_cents(data.target), to_cents(data.saved),
         data.deadline.isoformat() if data.deadline else None),
    )
    return _to_model(_get_or_404(db, cur.lastrowid), date.today())


@router.patch("/{goal_id}", response_model=Goal, summary="Zmień cel")
def update_goal(goal_id: int, data: GoalUpdate, db: Db):
    _get_or_404(db, goal_id)
    changes = data.model_dump(exclude_unset=True)
    sets = {}
    if changes.get("name"):
        sets["name"] = changes["name"].strip()
    if changes.get("target") is not None:
        sets["target_cents"] = to_cents(changes["target"])
    if "deadline" in changes:  # null usuwa termin
        sets["deadline"] = changes["deadline"].isoformat() if changes["deadline"] else None
    if sets:
        db.execute(f"UPDATE goals SET {', '.join(f'{k} = ?' for k in sets)} WHERE id = ?",
                   [*sets.values(), goal_id])
    return _to_model(_get_or_404(db, goal_id), date.today())


@router.post("/{goal_id}/deposit", response_model=Goal, summary="Wpłać lub wypłać")
def deposit(goal_id: int, data: GoalDeposit, db: Db):
    """Dodatnia kwota zwiększa odłożoną sumę, ujemna ją zmniejsza (nie poniżej zera)."""
    row = _get_or_404(db, goal_id)
    amount = to_cents(data.amount)
    if amount == 0:
        raise HTTPException(422, "Kwota nie może być zerowa")
    if row["saved_cents"] + amount < 0:
        raise HTTPException(422, "Nie można wypłacić więcej, niż odłożono")
    db.execute("UPDATE goals SET saved_cents = saved_cents + ? WHERE id = ?", (amount, goal_id))
    return _to_model(_get_or_404(db, goal_id), date.today())


@router.delete("/{goal_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Usuń cel")
def delete_goal(goal_id: int, db: Db):
    _get_or_404(db, goal_id)
    db.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
