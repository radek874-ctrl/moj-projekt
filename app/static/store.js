"use strict";

// Lokalny "serwer" działający w przeglądarce: te same ścieżki i odpowiedzi co
// API w FastAPI (app/routers), ale dane trzymane w localStorage telefonu.
// Dzięki temu interfejs (app.js) działa bez serwera i bez internetu.
const LocalApi = (() => {
  const KEY = "wydatki-data-v1";
  // Tak jak app/db.py: rodzaj operacji -> kolekcja.
  const TABLES = { expense: "expenses", income: "incomes" };
  const PREFIXES = { expenses: "expense", incomes: "income" };

  function normalize(data) {
    const db = {
      expenses: Array.isArray(data?.expenses) ? data.expenses : [],
      incomes: Array.isArray(data?.incomes) ? data.incomes : [],
      recurring: Array.isArray(data?.recurring) ? data.recurring : [],
      events: Array.isArray(data?.events) ? data.events : [],
      budgets: data?.budgets && typeof data.budgets === "object" ? data.budgets : {},
      nextId: data?.nextId || 1,
      nextRecurringId: data?.nextRecurringId || 1,
      nextEventId: data?.nextEventId || 1,
    };
    const ids = [...db.expenses, ...db.incomes].map((e) => e.id + 1);
    db.nextId = Math.max(db.nextId, 1, ...ids);
    db.nextRecurringId = Math.max(db.nextRecurringId, 1, ...db.recurring.map((r) => r.id + 1));
    db.nextEventId = Math.max(db.nextEventId, 1, ...db.events.map((e) => e.id + 1));
    return db;
  }

  function load() {
    try {
      return normalize(JSON.parse(localStorage.getItem(KEY)));
    } catch {
      return normalize(null);
    }
  }
  let db = load();
  const save = () => localStorage.setItem(KEY, JSON.stringify(db));

  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  // ---------- konwersje i walidacja (jak app/schemas.py) ----------
  const fromCents = (c) => Math.round(c || 0) / 100;
  const round2 = (x) => Math.round(x * 100) / 100;
  const currentMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

  function toCents(value, field = "amount") {
    const s = String(value ?? "").trim().replace(/\s/g, "").replace(",", ".");
    if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
      throw new HttpError(422, `${field}: kwota musi być dodatnia, maks. 2 miejsca po przecinku`);
    }
    return Math.round(Number(s) * 100);
  }

  function category(value) {
    const c = String(value ?? "").trim().toLowerCase();
    if (!c) throw new HttpError(422, "kategoria nie może być pusta");
    if (c.length > 50) throw new HttpError(422, "kategoria może mieć maks. 50 znaków");
    return c;
  }

  function validDate(value) {
    const s = String(value ?? "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
      throw new HttpError(422, "date: niepoprawna data (RRRR-MM-DD)");
    }
    return s;
  }

  function validMonth(value) {
    if (!MONTH_RE.test(value)) throw new HttpError(422, "Miesiąc musi mieć format RRRR-MM");
    return value;
  }

  function validKind(value) {
    const k = value ?? "expense";
    if (!(k in TABLES)) throw new HttpError(422, "kind: dozwolone expense lub income");
    return k;
  }

  function parseTransaction(body) {
    const description = String(body.description ?? "").trim();
    if (description.length > 255) throw new HttpError(422, "opis może mieć maks. 255 znaków");
    return {
      amount_cents: toCents(body.amount),
      category: category(body.category),
      description,
      date: validDate(body.date),
    };
  }

  const toTransaction = (e) => ({
    id: e.id,
    amount: fromCents(e.amount_cents),
    category: e.category,
    description: e.description,
    date: e.date,
    recurring_id: e.recurring_id ?? null,
  });

  function insert(kind, row, recurringId = null) {
    const e = { id: db.nextId++, ...row, recurring_id: recurringId };
    db[TABLES[kind]].push(e);
    return e;
  }

  // ---------- filtry (jak app/filters.py) ----------
  function filtered(rows, q, withCategory = true) {
    const cat = withCategory ? q.get("category")?.trim().toLowerCase() : null;
    const from = q.get("date_from");
    const to = q.get("date_to");
    return rows.filter(
      (e) => (!from || e.date >= from) && (!to || e.date <= to) && (!cat || e.category === cat)
    );
  }
  const rowsOf = (q) => db[TABLES[validKind(q.get("kind") ?? undefined)]];

  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

  // ---------- CSV ----------
  const CSV_TYPES = { expense: "expense", wydatek: "expense", income: "income", "przychód": "income", przychod: "income" };

  function parseCsv(text) {
    text = text.replace(/^﻿/, "");
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim() !== ""));
  }

  async function importCsv(defaultKind, formData) {
    const file = formData.get("file");
    if (!file || typeof file.text !== "function") throw new HttpError(400, "Brak pliku");
    const rows = parseCsv(await file.text());
    const header = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    const col = Object.fromEntries(header.map((h, i) => [h, i]));
    if (!["date", "amount", "category"].every((c) => c in col)) {
      throw new HttpError(400, "Brak wymaganych kolumn: amount, category, date");
    }
    let imported = 0;
    const errors = [];
    rows.forEach((r, i) => {
      let kind = defaultKind;
      const rawType = col.type != null ? (r[col.type] || "").trim().toLowerCase() : "";
      if (rawType) {
        if (!(rawType in CSV_TYPES)) return errors.push(`wiersz ${i + 2}: nieznany typ „${rawType}”`);
        kind = CSV_TYPES[rawType];
      }
      try {
        insert(kind, parseTransaction({
          date: r[col.date],
          amount: r[col.amount],
          category: r[col.category],
          description: col.description != null ? r[col.description] : "",
        }));
        imported++;
      } catch (e) {
        errors.push(`wiersz ${i + 2}: ${e.message}`);
      }
    });
    save();
    return { imported, errors };
  }

  // ---------- stałe opłaty (jak app/routers/recurring.py) ----------
  const toRecurring = (r) => ({
    id: r.id, kind: r.kind, name: r.name, category: r.category, amount: fromCents(r.amount_cents), day: r.day,
  });

  function recurringOr404(id) {
    const r = db.recurring.find((x) => x.id === +id);
    if (!r) throw new HttpError(404, "Nie znaleziono stałej opłaty");
    return r;
  }

  const booked = (r, month) =>
    db[TABLES[r.kind]]
      .filter((e) => e.recurring_id === r.id && e.date.startsWith(month))
      .sort((a, b) => a.id - b.id)[0];

  function recurringName(value) {
    const n = String(value ?? "").trim();
    if (!n) throw new HttpError(422, "nazwa nie może być pusta");
    if (n.length > 100) throw new HttpError(422, "nazwa może mieć maks. 100 znaków");
    return n;
  }

  function recurringDay(value) {
    const d = Number(value);
    if (!Number.isInteger(d) || d < 1 || d > 28) throw new HttpError(422, "day: dzień miesiąca 1–28");
    return d;
  }

  // ---------- kalendarz: arytmetyka terminów (jak app/routers/events.py) ----------
  const MAX_STEPS = 2400;
  const pad2 = (n) => String(n).padStart(2, "0");
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  };
  const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  function occurrence(base, repeat, n) {
    if (repeat === "none") return base;
    const [by, bm, bd] = base.split("-").map(Number);
    const total = bm - 1 + (repeat === "monthly" ? n : 12 * n);
    const y = by + Math.floor(total / 12), m = (total % 12) + 1;
    return `${y}-${pad2(m)}-${pad2(Math.min(bd, daysInMonth(y, m)))}`;
  }

  function nextAfter(base, repeat, doneUntil) {
    if (!doneUntil) return base;
    if (repeat === "none") return doneUntil >= base ? null : base;
    for (let n = 0; n < MAX_STEPS; n++) {
      const occ = occurrence(base, repeat, n);
      if (occ > doneUntil) return occ;
    }
    return null;
  }

  function previousBefore(base, repeat, current) {
    let prev = null;
    for (let n = 0; n < MAX_STEPS; n++) {
      const occ = occurrence(base, repeat, n);
      if (occ >= current || (repeat === "none" && n > 0)) break;
      prev = occ;
    }
    return prev;
  }

  const STATE_ORDER = { overdue: 0, soon: 1, later: 2, done: 3 };

  function toEvent(ev) {
    const next = nextAfter(ev.date, ev.repeat, ev.done_until);
    const daysLeft = next ? dayDiff(todayIso(), next) : null;
    const state = next == null ? "done" : daysLeft < 0 ? "overdue" : daysLeft <= ev.remind_days ? "soon" : "later";
    return {
      id: ev.id, title: ev.title, date: ev.date, repeat: ev.repeat, remind_days: ev.remind_days,
      amount: ev.amount_cents != null ? fromCents(ev.amount_cents) : null,
      category: ev.category, note: ev.note, next_date: next, days_left: daysLeft, state,
    };
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // Kolejność jak w API: stan, potem najbliższa data, potem tytuł.
  const listEvents = () => db.events.map(toEvent).sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
    cmp(a.next_date || "9999-12-31", b.next_date || "9999-12-31") ||
    cmp(a.title, b.title));

  function eventOr404(id) {
    const ev = db.events.find((x) => x.id === +id);
    if (!ev) throw new HttpError(404, "Nie znaleziono terminu");
    return ev;
  }

  function parseEvent(body) {
    const title = String(body.title ?? "").trim();
    if (!title) throw new HttpError(422, "tytuł nie może być pusty");
    if (title.length > 100) throw new HttpError(422, "tytuł może mieć maks. 100 znaków");
    const repeat = body.repeat ?? "none";
    if (!["none", "monthly", "yearly"].includes(repeat)) throw new HttpError(422, "repeat: none, monthly lub yearly");
    const remind = body.remind_days ?? 7;
    if (!Number.isInteger(Number(remind)) || remind < 0 || remind > 60) {
      throw new HttpError(422, "remind_days: od 0 do 60 dni");
    }
    const note = String(body.note ?? "").trim();
    if (note.length > 255) throw new HttpError(422, "notatka może mieć maks. 255 znaków");
    const cat = body.category == null || !String(body.category).trim() ? null : category(body.category);
    return {
      title,
      date: validDate(body.date),
      repeat,
      remind_days: Number(remind),
      amount_cents: body.amount != null ? toCents(body.amount) : null,
      category: cat,
      note,
    };
  }

  // ---------- trasy ----------
  const routes = [
    ["GET", /^\/health$/, () => ({ status: "ok" })],

    // --- wydatki i przychody ---
    ["GET", /^\/(expenses|incomes)$/, (q, body, [prefix]) => {
      const limit = Math.min(Math.max(+q.get("limit") || 100, 1), 1000);
      const offset = Math.max(+q.get("offset") || 0, 0);
      return filtered(db[prefix], q).sort(byDateDesc).slice(offset, offset + limit).map(toTransaction);
    }],

    ["POST", /^\/(expenses|incomes)$/, (q, body, [prefix]) => {
      const e = insert(PREFIXES[prefix], parseTransaction(body));
      save();
      return toTransaction(e);
    }],

    ["POST", /^\/(expenses|incomes)\/import$/, (q, body, [prefix]) => importCsv(PREFIXES[prefix], body)],

    ["PATCH", /^\/(expenses|incomes)\/(\d+)$/, (q, body, [prefix, id]) => {
      const e = db[prefix].find((x) => x.id === +id);
      if (!e) throw new HttpError(404, "Nie znaleziono");
      const current = toTransaction(e);
      Object.assign(e, parseTransaction({ ...current, ...Object.fromEntries(
        Object.entries(body).filter(([, v]) => v != null)) }));
      save();
      return toTransaction(e);
    }],

    ["DELETE", /^\/(expenses|incomes)\/(\d+)$/, (q, body, [prefix, id]) => {
      const i = db[prefix].findIndex((e) => e.id === +id);
      if (i < 0) throw new HttpError(404, "Nie znaleziono");
      db[prefix].splice(i, 1);
      save();
      return null;
    }],

    // --- analiza ---
    ["GET", /^\/analytics\/balance$/, (q) => {
      const totals = {};
      for (const [kind, table] of Object.entries(TABLES)) {
        for (const e of filtered(db[table], q, false)) {
          const m = (totals[e.date.slice(0, 7)] ||= { expense: 0, income: 0 });
          m[kind] += e.amount_cents;
        }
      }
      const months = Object.keys(totals).sort();
      const income = months.reduce((s, m) => s + totals[m].income, 0);
      const expenses = months.reduce((s, m) => s + totals[m].expense, 0);
      return {
        income: fromCents(income),
        expenses: fromCents(expenses),
        balance: fromCents(income - expenses),
        savings_rate: income ? round2((100 * (income - expenses)) / income) : null,
        months: months.map((m) => ({
          month: m,
          income: fromCents(totals[m].income),
          expenses: fromCents(totals[m].expense),
          balance: fromCents(totals[m].income - totals[m].expense),
        })),
      };
    }],

    ["GET", /^\/analytics\/summary$/, (q) => {
      const rows = filtered(rowsOf(q), q);
      const cents = rows.map((e) => e.amount_cents);
      const total = cents.reduce((a, b) => a + b, 0);
      const dates = rows.map((e) => e.date).sort();
      const start = q.get("date_from") || dates[0] || null;
      const end = q.get("date_to") || dates[dates.length - 1] || null;
      const days = start && end && end >= start ? daysBetween(start, end) : 0;
      return {
        count: rows.length,
        total: fromCents(total),
        average: rows.length ? round2(total / rows.length / 100) : 0,
        min: fromCents(rows.length ? Math.min(...cents) : 0),
        max: fromCents(rows.length ? Math.max(...cents) : 0),
        date_from: start,
        date_to: end,
        daily_average: days ? round2(total / days / 100) : 0,
      };
    }],

    ["GET", /^\/analytics\/by-category$/, (q) => {
      const groups = {};
      for (const e of filtered(rowsOf(q), q)) {
        const g = (groups[e.category] ||= { category: e.category, count: 0, cents: 0 });
        g.count++;
        g.cents += e.amount_cents;
      }
      const list = Object.values(groups).sort((a, b) => b.cents - a.cents || (a.category < b.category ? -1 : 1));
      const grand = list.reduce((s, g) => s + g.cents, 0);
      return list.map((g) => ({
        category: g.category,
        count: g.count,
        total: fromCents(g.cents),
        average: round2(g.cents / g.count / 100),
        share_percent: grand ? round2((100 * g.cents) / grand) : 0,
      }));
    }],

    ["GET", /^\/analytics\/monthly$/, (q) => {
      const groups = {};
      for (const e of filtered(rowsOf(q), q)) {
        const m = e.date.slice(0, 7);
        const g = (groups[m] ||= { month: m, count: 0, cents: 0 });
        g.count++;
        g.cents += e.amount_cents;
      }
      let prev = null;
      return Object.values(groups)
        .sort((a, b) => (a.month < b.month ? -1 : 1))
        .map((g) => {
          const change = prev ? round2((100 * (g.cents - prev)) / prev) : null;
          prev = g.cents;
          return { month: g.month, count: g.count, total: fromCents(g.cents), change_percent: change };
        });
    }],

    ["GET", /^\/analytics\/top$/, (q) => {
      const limit = Math.min(Math.max(+q.get("limit") || 10, 1), 100);
      return filtered(rowsOf(q), q)
        .sort((a, b) => b.amount_cents - a.amount_cents || (a.date < b.date ? 1 : -1))
        .slice(0, limit)
        .map(toTransaction);
    }],

    // --- stałe opłaty ---
    ["GET", /^\/recurring$/, (q) => {
      const month = validMonth(q.get("month") || currentMonth());
      return [...db.recurring]
        .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.day - b.day || (a.name < b.name ? -1 : 1)))
        .map((r) => {
          const paid = booked(r, month);
          return {
            ...toRecurring(r), month, paid: !!paid,
            transaction_id: paid ? paid.id : null,
            paid_amount: paid ? fromCents(paid.amount_cents) : null,
          };
        });
    }],

    ["POST", /^\/recurring$/, (q, body) => {
      const r = {
        id: db.nextRecurringId++,
        kind: validKind(body.kind),
        name: recurringName(body.name),
        category: category(body.category),
        amount_cents: toCents(body.amount),
        day: recurringDay(body.day ?? 10),
      };
      db.recurring.push(r);
      save();
      return toRecurring(r);
    }],

    ["PATCH", /^\/recurring\/(\d+)$/, (q, body, [id]) => {
      const r = recurringOr404(id);
      const next = { ...r };
      if (body.name != null) next.name = recurringName(body.name);
      if (body.category != null) next.category = category(body.category);
      if (body.amount != null) next.amount_cents = toCents(body.amount);
      if (body.day != null) next.day = recurringDay(body.day);
      Object.assign(r, next);
      save();
      return toRecurring(r);
    }],

    ["DELETE", /^\/recurring\/(\d+)$/, (q, body, [id]) => {
      const r = recurringOr404(id);
      for (const table of Object.values(TABLES)) {
        db[table].forEach((e) => { if (e.recurring_id === r.id) e.recurring_id = null; });
      }
      db.recurring = db.recurring.filter((x) => x !== r);
      save();
      return null;
    }],

    ["POST", /^\/recurring\/(\d+)\/pay$/, (q, body, [id]) => {
      const r = recurringOr404(id);
      const month = body.month != null ? validMonth(body.month) : currentMonth();
      if (booked(r, month)) throw new HttpError(409, "W tym miesiącu już zapłacone");
      const e = insert(r.kind, {
        amount_cents: body.amount != null ? toCents(body.amount) : r.amount_cents,
        category: r.category,
        description: r.name,
        date: `${month}-${String(r.day).padStart(2, "0")}`,
      }, r.id);
      save();
      return toTransaction(e);
    }],

    // --- kalendarz (jak app/routers/events.py) ---
    ["GET", /^\/events$/, () => listEvents()],

    ["GET", /^\/events\/reminders$/, () =>
      listEvents().filter((e) => e.state === "overdue" || e.state === "soon")],

    ["GET", /^\/events\/calendar$/, (q) => {
      const month = q.get("month");
      if (!month) throw new HttpError(422, "month: wymagany parametr RRRR-MM");
      validMonth(month);
      const [y, m] = month.split("-").map(Number);
      const start = `${month}-01`;
      const end = `${month}-${pad2(daysInMonth(y, m))}`;
      const items = [];
      for (const ev of db.events) {
        for (let n = 0; n < MAX_STEPS; n++) {
          const occ = occurrence(ev.date, ev.repeat, n);
          if (occ > end || (ev.repeat === "none" && n > 0)) break;
          if (occ >= start) {
            items.push({ event_id: ev.id, title: ev.title, date: occ, done: !!ev.done_until && occ <= ev.done_until });
          }
        }
      }
      return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title < b.title ? -1 : 1));
    }],

    ["POST", /^\/events$/, (q, body) => {
      const ev = { id: db.nextEventId++, ...parseEvent(body), done_until: null };
      db.events.push(ev);
      save();
      return toEvent(ev);
    }],

    ["PATCH", /^\/events\/(\d+)$/, (q, body, [id]) => {
      const ev = eventOr404(id);
      const current = { title: ev.title, date: ev.date, repeat: ev.repeat, remind_days: ev.remind_days,
        amount: ev.amount_cents != null ? fromCents(ev.amount_cents) : null, category: ev.category, note: ev.note };
      const changes = Object.fromEntries(Object.entries(body).filter(([, v]) => v != null));
      const next = parseEvent({ ...current, ...changes });
      if ("date" in changes) ev.done_until = null; // nowa data = liczymy od nowa
      Object.assign(ev, next);
      save();
      return toEvent(ev);
    }],

    ["DELETE", /^\/events\/(\d+)$/, (q, body, [id]) => {
      const ev = eventOr404(id);
      db.events = db.events.filter((x) => x !== ev);
      save();
      return null;
    }],

    ["POST", /^\/events\/(\d+)\/done$/, (q, body, [id]) => {
      const ev = eventOr404(id);
      const current = nextAfter(ev.date, ev.repeat, ev.done_until);
      if (current == null) throw new HttpError(409, "Ten termin jest już zrobiony");
      const expense = body.amount != null
        ? { amount_cents: toCents(body.amount), category: ev.category || "inne", description: ev.title, date: todayIso() }
        : null;
      ev.done_until = current;
      if (expense) insert("expense", expense);
      save();
      return toEvent(ev);
    }],

    ["POST", /^\/events\/(\d+)\/undo$/, (q, body, [id]) => {
      const ev = eventOr404(id);
      if (!ev.done_until) throw new HttpError(409, "Nie ma czego cofnąć");
      ev.done_until = previousBefore(ev.date, ev.repeat, ev.done_until);
      save();
      return toEvent(ev);
    }],

    // --- budżety ---
    ["GET", /^\/budgets\/status$/, (q) => {
      const month = validMonth(q.get("month") || currentMonth());
      return Object.keys(db.budgets).sort().map((cat) => {
        const lim = db.budgets[cat];
        const spent = db.expenses
          .filter((e) => e.category === cat && e.date.startsWith(month))
          .reduce((s, e) => s + e.amount_cents, 0);
        return {
          category: cat,
          monthly_limit: fromCents(lim),
          spent: fromCents(spent),
          remaining: fromCents(lim - spent),
          used_percent: round2((100 * spent) / lim),
          exceeded: spent > lim,
        };
      });
    }],

    ["GET", /^\/budgets$/, () =>
      Object.keys(db.budgets).sort().map((c) => ({ category: c, monthly_limit: fromCents(db.budgets[c]) }))],

    ["PUT", /^\/budgets\/(.+)$/, (q, body, [cat]) => {
      const c = category(decodeURIComponent(cat));
      db.budgets[c] = toCents(body.monthly_limit, "monthly_limit");
      save();
      return { category: c, monthly_limit: fromCents(db.budgets[c]) };
    }],

    ["DELETE", /^\/budgets\/(.+)$/, (q, body, [cat]) => {
      const c = category(decodeURIComponent(cat));
      if (!(c in db.budgets)) throw new HttpError(404, "Brak budżetu dla tej kategorii");
      delete db.budgets[c];
      save();
      return null;
    }],
  ];

  async function request(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const url = new URL(path, "http://local");
    let body = options.body;
    if (typeof body === "string") body = JSON.parse(body);
    for (const [m, re, handler] of routes) {
      const match = m === method && re.exec(url.pathname);
      if (match) return handler(url.searchParams, body || {}, match.slice(1));
    }
    throw new HttpError(404, "Nieznana ścieżka: " + url.pathname);
  }

  // Pełna kopia danych (wszystko) do pliku JSON i z powrotem.
  function exportJson() {
    return JSON.stringify({ version: 2, ...db }, null, 1);
  }
  function importJson(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data.expenses)) throw new Error("To nie jest kopia zapasowa aplikacji");
    db = normalize(data);
    save();
  }

  return { request, exportJson, importJson };
})();
