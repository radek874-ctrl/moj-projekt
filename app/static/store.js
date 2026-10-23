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
      goals: Array.isArray(data?.goals) ? data.goals : [],
      budgets: data?.budgets && typeof data.budgets === "object" ? data.budgets : {},
      nextId: data?.nextId || 1,
      nextRecurringId: data?.nextRecurringId || 1,
      nextEventId: data?.nextEventId || 1,
      nextGoalId: data?.nextGoalId || 1,
    };
    const ids = [...db.expenses, ...db.incomes].map((e) => e.id + 1);
    db.nextId = Math.max(db.nextId, 1, ...ids);
    db.nextRecurringId = Math.max(db.nextRecurringId, 1, ...db.recurring.map((r) => r.id + 1));
    db.nextEventId = Math.max(db.nextEventId, 1, ...db.events.map((e) => e.id + 1));
    db.nextGoalId = Math.max(db.nextGoalId, 1, ...db.goals.map((g) => g.id + 1));
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
  const listeners = [];
  const save = () => {
    localStorage.setItem(KEY, JSON.stringify(db));
    listeners.forEach((fn) => { try { fn(); } catch {} });
  };

  // Nowe ID są losowe (a nie kolejne), żeby wpisy dodane na różnych telefonach
  // we wspólnym budżecie nigdy nie dostały tego samego numeru.
  const usedIds = () => new Set([...db.expenses, ...db.incomes, ...db.recurring, ...db.events, ...db.goals].map((x) => x.id));
  function newId() {
    const taken = usedIds();
    for (;;) {
      const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      if (!taken.has(id)) return id;
    }
  }

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
    const e = { id: newId(), ...row, recurring_id: recurringId };
    db[TABLES[kind]].push(e);
    return e;
  }

  // ---------- filtry (jak app/filters.py) ----------
  function filtered(rows, q, withCategory = true) {
    const cat = withCategory ? q.get("category")?.trim().toLowerCase() : null;
    const from = q.get("date_from");
    const to = q.get("date_to");
    const text = withCategory ? (q.get("q") || "").trim().toLowerCase() : "";
    return rows.filter(
      (e) => (!from || e.date >= from) && (!to || e.date <= to) && (!cat || e.category === cat) &&
        (!text || `${e.description} ${e.category}`.toLowerCase().includes(text))
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

  // ---------- podpowiedzi bez AI (jak app/insights.py – zmieniaj oba miejsca) ----------
  const NBSP = " ";
  const halfUp = (x) => Math.floor(x + 0.5);

  function zl(cents) {
    const value = halfUp(cents / 100);
    const sign = value < 0 ? "−" : "";
    let digits = String(Math.abs(value));
    const groups = [];
    while (digits) {
      groups.unshift(digits.slice(-3));
      digits = digits.slice(0, -3);
    }
    return `${sign}${groups.join(NBSP) || "0"}${NBSP}zł`;
  }

  const shiftYM = (y, m, delta) => {
    const total = m - 1 + delta;
    return [y + Math.floor(total / 12), ((total % 12) + 12) % 12 + 1];
  };
  const monthBounds = (y, m) => {
    const days = daysInMonth(y, m);
    return [`${y}-${pad2(m)}-01`, `${y}-${pad2(m)}-${pad2(days)}`, days];
  };
  const sumCents = (rows) => rows.reduce((s, r) => s + r.amount_cents, 0);
  function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : halfUp((s[n / 2 - 1] + s[n / 2]) / 2);
  }

  function computeInsights() {
    const today = todayIso();
    const [y, m, day] = today.split("-").map(Number);
    const month = today.slice(0, 7);
    const dim = daysInMonth(y, m);
    const inMonth = (rows) => rows.filter((r) => r.date.startsWith(month));
    const curExp = inMonth(db.expenses), curInc = inMonth(db.incomes);

    const [py, pm] = shiftYM(y, m, -3);
    const prevStart = monthBounds(py, pm)[0];
    const [ly, lm] = shiftYM(y, m, -1);
    const prevEnd = monthBounds(ly, lm)[1];
    const prevDays = [1, 2, 3].reduce((s, k) => s + monthBounds(...shiftYM(y, m, -k))[2], 0);
    const prevExp = db.expenses.filter((r) => prevStart <= r.date && r.date <= prevEnd);

    // --- prognoza końca miesiąca ---
    const paid = new Set([...curExp, ...curInc].filter((r) => r.recurring_id != null).map((r) => r.recurring_id));
    const plannedExp = sumCents(db.recurring.filter((r) => r.kind === "expense" && !paid.has(r.id)));
    const plannedInc = sumCents(db.recurring.filter((r) => r.kind === "income" && !paid.has(r.id)));
    const variablePrev = sumCents(prevExp.filter((r) => r.recurring_id == null));
    const variableNow = sumCents(curExp.filter((r) => r.recurring_id == null));
    const daily = variablePrev ? variablePrev / prevDays : variableNow / day;
    const projectedVariable = halfUp(daily * (dim - day));
    const incomeSoFar = sumCents(curInc), expensesSoFar = sumCents(curExp);
    const projectedIncome = incomeSoFar + plannedInc;
    const projectedExpenses = expensesSoFar + plannedExp + projectedVariable;
    const forecast = {
      month,
      income_so_far: incomeSoFar / 100,
      expenses_so_far: expensesSoFar / 100,
      planned_income: plannedInc / 100,
      planned_expenses: plannedExp / 100,
      projected_variable: projectedVariable / 100,
      projected_income: projectedIncome / 100,
      projected_expenses: projectedExpenses / 100,
      projected_balance: (projectedIncome - projectedExpenses) / 100,
      safe_daily: projectedIncome > 0
        ? halfUp(Math.max(0, projectedIncome - expensesSoFar - plannedExp) / (dim - day + 1)) / 100 : null,
    };

    const insights = [];
    const add = (key, level, title, text) => insights.push({ key, level, title, text });

    if (!db.expenses.length && !db.incomes.length) {
      add("start", "info", "Zacznij od kilku wpisów",
        "Dodaj wydatki i przychody, a tutaj pojawią się prognozy i podpowiedzi.");
      return { forecast, insights };
    }

    // a) prognoza bilansu
    if (projectedIncome > 0) {
      const balance = projectedIncome - projectedExpenses;
      if (balance < 0) {
        add("forecast", "alert", "Może zabraknąć pieniędzy",
          `Prognoza na koniec miesiąca: brakuje ok. ${zl(-balance)}. ` +
          `Uwzględniono stałe opłaty (${zl(plannedExp)}) i zwykłe tempo wydatków.`);
      } else {
        add("forecast", "good", "Prognoza na koniec miesiąca",
          `Powinno zostać ok. ${zl(balance)} (przychody ${zl(projectedIncome)}, ` +
          `wydatki ok. ${zl(projectedExpenses)}).`);
      }
    }

    // b) limity
    for (const cat of Object.keys(db.budgets).sort()) {
      const limit = db.budgets[cat];
      const spent = sumCents(curExp.filter((r) => r.category === cat));
      if (spent > limit) {
        add(`budget:${cat}`, "alert", `Limit „${cat}” przekroczony`,
          `Wydano ${zl(spent)} z ${zl(limit)} – o ${zl(spent - limit)} za dużo.`);
      } else if (day >= 5 && spent > 0) {
        const exceedDay = Math.floor((limit * day) / spent) + 1;
        if (exceedDay <= dim) {
          add(`budget:${cat}`, "warning", `Limit „${cat}” może się skończyć`,
            `Przy obecnym tempie limit ${zl(limit)} skończy się ok. ${exceedDay}. dnia miesiąca ` +
            `(wydano już ${zl(spent)}).`);
        }
      }
    }

    // c) skoki w kategoriach
    const spikes = [];
    for (const cat of [...new Set(curExp.map((r) => r.category))].sort()) {
      const cur = sumCents(curExp.filter((r) => r.category === cat));
      const prevTotal = sumCents(prevExp.filter((r) => r.category === cat));
      if (!prevTotal) continue;
      const avg = halfUp(prevTotal / 3);
      if (avg > 0 && cur * 10 > avg * 13 && cur - avg >= 5000) spikes.push([cur - avg, cat, cur, avg]);
    }
    spikes.sort((a, b) => b[0] - a[0] || cmp(a[1], b[1]));
    for (const [, cat, cur, avg] of spikes.slice(0, 3)) {
      const pct = halfUp(((cur - avg) * 100) / avg);
      add(`spike:${cat}`, "warning", `Więcej niż zwykle: ${cat}`,
        `W tym miesiącu ${zl(cur)} – o ${pct}% więcej niż średnio (${zl(avg)} miesięcznie).`);
    }

    // d) nietypowo duże pojedyncze wydatki
    const histStartDate = new Date(Date.UTC(y, m - 1, day) - 180 * 86400000);
    const histStart = histStartDate.toISOString().slice(0, 10);
    const unusual = [];
    for (const r of curExp) {
      const history = db.expenses
        .filter((h) => h.category === r.category && histStart <= h.date && h.date < `${month}-01`)
        .map((h) => h.amount_cents);
      if (history.length >= 5) {
        const med = median(history);
        if (med > 0 && r.amount_cents > 3 * med) unusual.push([r.amount_cents / med, r.id, r, med]);
      }
    }
    unusual.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (const [, , r, med] of unusual.slice(0, 2)) {
      add(`unusual:${r.id}`, "info", "Nietypowo duży wydatek",
        `${r.description || r.category}: ${zl(r.amount_cents)} – zwykle ok. ${zl(med)} w kategorii „${r.category}”.`);
    }

    // e) nadchodzące większe koszty z kalendarza
    const upcoming = db.events.map(toEvent)
      .filter((e) => e.amount && e.state !== "done" && e.days_left != null && e.days_left >= 0 && e.days_left <= 30)
      .sort((a, b) => a.days_left - b.days_left || cmp(a.title, b.title));
    if (upcoming.length) {
      const total = upcoming.reduce((s, e) => s + Math.round(e.amount * 100), 0);
      const parts = upcoming.slice(0, 3)
        .map((e) => `${e.title} ${zl(Math.round(e.amount * 100))} (za ${e.days_left} dni)`).join(", ");
      add("upcoming", "info", "Nadchodzące koszty z kalendarza",
        `W ciągu 30 dni: ${parts}. Razem ${zl(total)} – warto to odłożyć.`);
    }

    // f) oszczędzanie w poprzednim miesiącu
    const lastMonth = `${ly}-${pad2(lm)}`;
    const lastInc = sumCents(db.incomes.filter((r) => r.date.startsWith(lastMonth)));
    const lastExp = sumCents(db.expenses.filter((r) => r.date.startsWith(lastMonth)));
    if (lastInc > 0) {
      const rate = halfUp(((lastInc - lastExp) * 100) / lastInc);
      if (rate < 10) {
        add("savings", "warning", "Mało oszczędności",
          `W zeszłym miesiącu zostało ${rate}% przychodów. Dobra zasada: odkładaj co najmniej 10%.`);
      } else if (rate >= 20) {
        add("savings", "good", "Świetnie oszczędzasz", `W zeszłym miesiącu zostało Ci ${rate}% przychodów.`);
      }
    }
    return { forecast, insights };
  }

  // ---------- podpowiadanie kategorii (jak app/insights.py) ----------
  const KEYWORDS = {
    expense: [
      [["biedronka", "lidl", "żabka", "zabka", "kaufland", "carrefour", "auchan", "netto", "dino",
        "lewiatan", "stokrotka", "piekarnia", "spożywcz", "zakupy", "obiad", "pizza"], "jedzenie"],
      [["orlen", "bp ", "shell", "circle k", "lotos", "moya", "paliwo", "benzyn", "diesel", "tankow"], "paliwo"],
      [["tauron", "enea", "energa", "pge", "innogy", "e.on", "prąd", "prad"], "prąd"],
      [["pgnig", "gazownict", "gaz"], "gaz"],
      [["wodociąg", "wodociag", "mpwik", "woda", "ścieki"], "woda"],
      [["ogrzewan", "ciepło", "cieplo", "węgiel", "opał"], "ogrzewanie"],
      [["czynsz", "wspólnota", "spółdzielnia", "najem"], "czynsz"],
      [["rata", "raty", "kredyt", "hipote", "pożyczk"], "kredyt"],
      [["upc", "vectra", "netia", "światłowód", "internet"], "internet"],
      [["play", "plus", "orange", "t-mobile", "telefon", "abonament"], "telefon"],
      [["apteka", "lekarz", "dentyst", "przychodnia", "luxmed", "medicover", "leki"], "zdrowie"],
      [["pkp", "mpk", "ztm", "bilet", "uber", "bolt", "taxi", "taksówk", "autobus", "pociąg"], "transport"],
      [["pzu", "warta", "hestia", "allianz", "ubezpiecz", "polisa", "oc "], "ubezpieczenie"],
      [["netflix", "spotify", "kino", "hbo", "disney", "teatr", "koncert", "max "], "rozrywka"],
      [["zara", "reserved", "h&m", "ccc", "sinsay", "ubrani", "buty", "kurtk"], "ubrania"],
      [["pampers", "przedszkol", "żłobek", "zlobek", "zabawk", "szkoła", "szkola"], "dzieci"],
    ],
    income: [
      [["wypłat", "wyplat", "pensj", "wynagrodz", "pracodaw"], "wynagrodzenie"],
      [["premi", "bonus", "nagrod"], "premia"],
      [["800"], "800+"],
      [["emerytur", "rent"], "emerytura"],
      [["zwrot", "pit", "skarbow"], "zwrot podatku"],
      [["olx", "allegro", "vinted", "sprzeda"], "sprzedaż"],
      [["odsetk", "lokat"], "odsetki"],
    ],
  };
  const WORD_CHARS = "a-z0-9ąćęłńóśźż";
  const tokensOf = (s) => new Set(s.match(new RegExp(`[${WORD_CHARS}]{3,}`, "g")) || []);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function suggestCategory(text, kind) {
    const t = String(text ?? "").trim().toLowerCase();
    if (!t) return { category: null, source: null };
    const rows = db[TABLES[kind]].filter((r) => r.description !== "");
    const mostCommon = (matches) => {
      if (!matches.length) return null;
      const stats = {};
      for (const r of matches) {
        const s = (stats[r.category] ||= { count: 0, latest: ["", 0] });
        s.count++;
        if (r.date > s.latest[0] || (r.date === s.latest[0] && r.id > s.latest[1])) s.latest = [r.date, r.id];
      }
      return Object.keys(stats).sort((a, b) =>
        stats[b].count - stats[a].count || cmp(stats[b].latest[0], stats[a].latest[0]) ||
        stats[b].latest[1] - stats[a].latest[1])[0];
    };
    const exact = mostCommon(rows.filter((r) => r.description.trim().toLowerCase() === t));
    if (exact) return { category: exact, source: "history" };
    const tokens = tokensOf(t);
    if (tokens.size) {
      const shared = mostCommon(rows.filter((r) => [...tokensOf(r.description.toLowerCase())].some((w) => tokens.has(w))));
      if (shared) return { category: shared, source: "history" };
    }
    const padded = t + " ";
    for (const [words, cat] of KEYWORDS[kind]) {
      if (words.some((w) => new RegExp(`(?:^|[^${WORD_CHARS}])${escapeRe(w)}`).test(padded))) {
        return { category: cat, source: "keywords" };
      }
    }
    return { category: null, source: null };
  }

  // ---------- cele (jak app/routers/goals.py) ----------
  // ---------- doradca finansowy (jak app/advisor.py – zmieniaj oba miejsca) ----------
  const NEEDS = new Set(["jedzenie", "czynsz", "prąd", "gaz", "woda", "ogrzewanie", "kredyt", "internet", "telefon",
    "paliwo", "transport", "ubezpieczenie", "zdrowie", "dzieci", "podatki"]);
  const FIXED = new Set(["czynsz", "prąd", "gaz", "woda", "ogrzewanie", "kredyt", "internet", "telefon", "ubezpieczenie"]);
  const DEBT = new Set(["kredyt"]);
  const WEEKDAYS = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"];

  const pct = (part, whole) => (whole ? halfUp((10000 * part) / whole) / 100 : null);
  const ym = (y, m) => `${y}-${pad2(m)}`;
  const monthShift = (month, delta) => ym(...shiftYM(+month.slice(0, 4), +month.slice(5, 7), delta));
  const normName = (text) => text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const byDateId = (rows) => [...rows].sort((a, b) => cmp(a.date, b.date) || a.id - b.id);
  const inMonthOf = (rows, month) => rows.filter((r) => r.date.startsWith(month));
  const isFixed = (r) => r.recurring_id != null || FIXED.has(r.category);
  const isNeed = (r) => NEEDS.has(r.category) || isFixed(r);
  const monthIndex = (month) => +month.slice(0, 4) * 12 + +month.slice(5, 7);
  const tenths = (x10) => `${Math.floor(x10 / 10)},${x10 % 10}`;
  const lastOf = (rows) => rows.reduce((best, r) => (!best || cmp(r.date, best.date) > 0 ||
    (r.date === best.date && r.id > best.id) ? r : best), null);
  const isoDay = (iso, deltaDays = 0) => {
    const d = new Date(Date.parse(iso) + deltaDays * 86400000);
    return d.toISOString().slice(0, 10);
  };
  /** Kategoria o największej wartości w słowniku (remis: alfabetycznie). */
  const topKeys = (counts) => Object.keys(counts).sort((a, b) => counts[b] - counts[a] || cmp(a, b));

  function advisorReport(month, extraSavings = 0) {
    const expenses = byDateId(db.expenses), incomes = byDateId(db.incomes);
    const budgets = db.budgets;
    // Oszczędności: odłożone w celach + podane z zewnątrz (np. konto oszczędnościowe).
    const goalsSaved = db.goals.reduce((s, g) => s + g.saved_cents, 0) + extraSavings;

    const current = todayIso().slice(0, 7);
    const complete = month < current;
    const expM = inMonthOf(expenses, month), incM = inMonthOf(incomes, month);
    const income = sumCents(incM), spent = sumCents(expM);
    const prev = monthShift(month, -1);

    const start = complete ? 0 : 1;
    let window = [0, 1, 2].map((k) => monthShift(month, -(start + k)))
      .filter((m) => inMonthOf(expenses, m).length || inMonthOf(incomes, m).length).sort();
    if (!window.length) window = [month];
    const n = window.length;
    const wExp = expenses.filter((r) => window.includes(r.date.slice(0, 7)));
    const wInc = incomes.filter((r) => window.includes(r.date.slice(0, 7)));
    const avg = (rows) => halfUp(sumCents(rows) / n);
    const avgIncome = avg(wInc), avgExp = avg(wExp);
    const avgFixed = avg(wExp.filter(isFixed));
    const avgNeeds = avg(wExp.filter(isNeed));
    const avgDebt = avg(wExp.filter((r) => DEBT.has(r.category)));
    const avgWants = avgExp - avgNeeds;
    const avgSavings = avgIncome - avgExp;

    const emergency10 = avgExp ? halfUp((10 * goalsSaved) / avgExp) : null;
    const ratios = {
      needs_percent: pct(avgNeeds, avgIncome),
      wants_percent: pct(avgWants, avgIncome),
      savings_percent: pct(avgSavings, avgIncome),
      fixed_percent: pct(avgFixed, avgIncome),
      debt_to_income_percent: pct(avgDebt, avgIncome),
    };

    const before = new Set([1, 2, 3].map((k) => monthShift(month, -k)));
    const categories = [...new Set(expM.map((r) => r.category))].map((cat) => {
      const rows = expM.filter((r) => r.category === cat);
      const total = sumCents(rows);
      const usual = halfUp(sumCents(expenses.filter((r) => r.category === cat && before.has(r.date.slice(0, 7)))) / 3);
      return {
        category: cat,
        total: total / 100,
        share_percent: pct(total, spent),
        usual: usual / 100,
        change_percent: pct(total - usual, usual),
        need: rows.some(isNeed),
        fixed: rows.some(isFixed),
        _cents: total, _usual: usual,
      };
    }).sort((a, b) => b._cents - a._cents || cmp(a.category, b.category));

    // --- ocena kondycji 0–100 ---
    const components = [];
    let score = null;
    if (avgIncome > 0) {
      const sp = ratios.savings_percent, dti = ratios.debt_to_income_percent, fixed = ratios.fixed_percent;
      const comp = (key, label, value, points, max, text) => components.push({ key, label, value, points, max, text });
      comp("savings", "Oszczędzanie", sp, halfUp(30 * Math.min(Math.max(sp / 20, 0), 1)), 30,
        `Zostaje ${halfUp(sp)}% przychodów (cel: co najmniej 20%).`);
      if (emergency10 == null) {
        comp("emergency", "Poduszka finansowa", null, 25, 25, "Brak wydatków do porównania.");
      } else {
        comp("emergency", "Poduszka finansowa", emergency10 / 10, halfUp(25 * Math.min(emergency10 / 60, 1)), 25,
          `Oszczędności starczą na ${tenths(emergency10)} mies. wydatków (cel: 3–6).`);
      }
      const debtPts = dti <= 10 ? 20 : dti >= 40 ? 0 : halfUp((20 * (40 - dti)) / 30);
      comp("debt", "Zadłużenie", dti, debtPts, 20, `Raty kredytów to ${halfUp(dti)}% przychodów (bezpiecznie: do 30%).`);
      const fixedPts = fixed <= 50 ? 15 : fixed >= 80 ? 0 : halfUp((15 * (80 - fixed)) / 30);
      comp("fixed", "Koszty stałe", fixed, fixedPts, 15, `Stałe rachunki to ${halfUp(fixed)}% przychodów (dobrze: do 50%).`);
      const monthBudgets = Object.keys(budgets).sort();
      if (monthBudgets.length) {
        const ok = monthBudgets.filter((c) => sumCents(expM.filter((r) => r.category === c)) <= budgets[c]).length;
        comp("budgets", "Limity", ok, halfUp((10 * ok) / monthBudgets.length), 10,
          `Dotrzymane limity: ${ok} z ${monthBudgets.length}.`);
      } else {
        comp("budgets", "Limity", null, 5, 10, "Nie ustawiono limitów wydatków.");
      }
      score = components.reduce((s, c) => s + c.points, 0);
    }
    const label = score == null ? null : score >= 80 ? "bardzo dobra" : score >= 60 ? "dobra"
      : score >= 40 ? "przeciętna" : "słaba";

    // --- rekomendacje ---
    const recs = [];
    const rec = (key, text) => recs.push({ key, text });
    if (!expenses.length && !incomes.length) {
      rec("start", "Dodaj wydatki i przychody z kilku tygodni – wtedy pojawi się ocena i rekomendacje.");
    }
    if (avgIncome > 0) {
      const wantsByCat = {};
      for (const r of wExp) if (!isNeed(r)) wantsByCat[r.category] = (wantsByCat[r.category] || 0) + r.amount_cents;
      const topWant = topKeys(wantsByCat)[0];
      if (ratios.savings_percent < 10) {
        let text = `Zostaje tylko ${halfUp(ratios.savings_percent)}% przychodów. Celuj w co najmniej 10%, ` +
          `czyli ok. ${zl(halfUp(avgIncome / 10))} miesięcznie.`;
        if (topWant) {
          text += ` Największy wydatek „na przyjemności” to ${topWant}: średnio ` +
            `${zl(halfUp(wantsByCat[topWant] / n))} miesięcznie.`;
        }
        rec("savings", text);
      }
      if (emergency10 != null && emergency10 < 30) {
        const target = 3 * avgExp;
        rec("emergency", `Poduszka finansowa: odłożone ${zl(goalsSaved)}, to ${tenths(emergency10)} mies. ` +
          `wydatków. Zalecane minimum to 3 miesiące, czyli ok. ${zl(target)} – brakuje ${zl(target - goalsSaved)}.`);
      }
      if (ratios.debt_to_income_percent > 30) {
        rec("debt", `Raty kredytów to ${halfUp(ratios.debt_to_income_percent)}% przychodów – powyżej ` +
          "bezpiecznych 30%. Unikaj nowych zobowiązań, a nadwyżki kieruj na nadpłatę najdroższego kredytu.");
      }
      if (ratios.wants_percent > 30) {
        rec("wants", `Wydatki na przyjemności to ${halfUp(ratios.wants_percent)}% przychodów – zasada ` +
          "50/30/20 zaleca do 30%.");
      }
      if (ratios.needs_percent > 60) {
        rec("needs", `Koszty podstawowe pochłaniają ${halfUp(ratios.needs_percent)}% przychodów. ` +
          "Przejrzyj rachunki: taryfę prądu i gazu, abonamenty telefonu i internetu, " +
          "ubezpieczenia – tam najłatwiej o stałą oszczędność.");
      }
    }
    const spikes = categories.filter((c) => c._usual > 0 && c._cents - c._usual >= 10000 && c.change_percent >= 20);
    if (spikes.length) {
      const c = [...spikes].sort((a, b) => (a._usual - a._cents) - (b._usual - b._cents) || cmp(a.category, b.category))[0];
      rec("spike", `„${c.category}”: ${zl(c._cents)} w tym miesiącu, o ${halfUp(c.change_percent)}% ` +
        `więcej niż zwykle (${zl(c._usual)}).`);
    }
    if (!Object.keys(budgets).length && wExp.length) {
      const variable = {};
      for (const r of wExp) if (!isFixed(r)) variable[r.category] = (variable[r.category] || 0) + r.amount_cents;
      const top = topKeys(variable).slice(0, 2);
      if (top.length) rec("budgets", "Ustaw miesięczne limity na największe wydatki zmienne: " + top.join(" i ") + ".");
    }
    if (avgIncome > 0 && !recs.length && avgSavings > 0) {
      rec("good", `Finanse wyglądają zdrowo. Nadwyżkę (ok. ${zl(avgSavings)} miesięcznie) przelewaj ` +
        "regularnie na cele albo poduszkę finansową.");
    }

    categories.forEach((c) => { delete c._cents; delete c._usual; });
    return {
      month,
      complete,
      basis_months: window,
      totals: {
        income: income / 100, expenses: spent / 100, balance: (income - spent) / 100,
        savings_rate: pct(income - spent, income),
        prev_income: sumCents(inMonthOf(incomes, prev)) / 100, prev_expenses: sumCents(inMonthOf(expenses, prev)) / 100,
      },
      averages: {
        income: avgIncome / 100, expenses: avgExp / 100, fixed: avgFixed / 100,
        needs: avgNeeds / 100, wants: avgWants / 100, savings: avgSavings / 100, debt_payments: avgDebt / 100,
      },
      ratios,
      emergency_fund: { saved: goalsSaved / 100, months_covered: emergency10 == null ? null : emergency10 / 10 },
      categories,
      health: { score, label, components },
      recommendations: recs.slice(0, 5),
    };
  }

  function advisorTrends(kind, months) {
    const rows = byDateId(db[TABLES[kind]]);
    const current = todayIso().slice(0, 7);
    const labels = [];
    for (let k = months - 1; k >= 0; k--) labels.push(monthShift(current, -k));
    const full = months - 1;
    const series = (subset) => {
      const cents = labels.map((m) => sumCents(inMonthOf(subset, m)));
      const base = cents.slice(0, full);
      const average = halfUp(base.reduce((s, v) => s + v, 0) / full);
      const meanX = (full - 1) / 2;
      let sxx = 0, sxy = 0;
      for (let x = 0; x < full; x++) sxx += (x - meanX) ** 2;
      base.forEach((v, x) => { sxy += (x - meanX) * (v - average); });
      const slope = sxx ? sxy / sxx : 0;
      let trend;
      if (average === 0) trend = cents[cents.length - 1] ? "new" : "flat";
      else {
        const rel = slope / average;
        trend = rel > 0.05 ? "up" : rel < -0.05 ? "down" : "flat";
      }
      return {
        values: cents.map((c) => c / 100), average: average / 100, current: cents[cents.length - 1] / 100,
        slope: halfUp(slope) / 100, trend, _total: cents.reduce((s, v) => s + v, 0),
      };
    };
    const inRange = rows.filter((r) => labels.includes(r.date.slice(0, 7)));
    const cats = [...new Set(inRange.map((r) => r.category))]
      .map((cat) => ({ category: cat, ...series(inRange.filter((r) => r.category === cat)) }))
      .sort((a, b) => b._total - a._total || cmp(a.category, b.category));
    const total = series(inRange);
    [total, ...cats].forEach((c) => delete c._total);
    return { kind, months: labels, total, categories: cats };
  }

  function advisorCompare(kind, a, b) {
    const rows = byDateId(db[TABLES[kind]]);
    const ra = inMonthOf(rows, a), rb = inMonthOf(rows, b);
    const out = [...new Set([...ra, ...rb].map((r) => r.category))].map((cat) => {
      const ca = sumCents(ra.filter((r) => r.category === cat));
      const cb = sumCents(rb.filter((r) => r.category === cat));
      return { category: cat, a: ca / 100, b: cb / 100, diff: (cb - ca) / 100, change_percent: pct(cb - ca, ca), _d: cb - ca };
    }).sort((x, y) => Math.abs(y._d) - Math.abs(x._d) || cmp(x.category, y.category));
    out.forEach((c) => delete c._d);
    const ta = sumCents(ra), tb = sumCents(rb);
    return { kind, a, b, total_a: ta / 100, total_b: tb / 100, diff: (tb - ta) / 100, change_percent: pct(tb - ta, ta), categories: out };
  }

  function advisorMerchants(kind, from, to, limit) {
    const rows = byDateId(db[TABLES[kind]])
      .filter((r) => r.description.trim() && (!from || r.date >= from) && (!to || r.date <= to));
    const groups = {};
    for (const r of rows) (groups[normName(r.description)] ||= []).push(r);
    return Object.entries(groups).map(([key, items]) => {
      const last = lastOf(items);
      const cats = {};
      for (const r of items) cats[r.category] = (cats[r.category] || 0) + 1;
      const total = sumCents(items);
      return {
        name: last.description.trim(), category: topKeys(cats)[0], count: items.length, total: total / 100,
        average: halfUp(total / items.length) / 100, last_date: last.date, _t: total, _k: key,
      };
    }).sort((x, y) => y._t - x._t || cmp(x._k, y._k)).slice(0, limit)
      .map(({ _t, _k, ...m }) => m);
  }

  function advisorSubscriptions() {
    const today = todayIso();
    const since = isoDay(today, -365), activeSince = isoDay(today, -62);
    const registered = new Set(db.recurring.filter((r) => r.kind === "expense").map((r) => normName(r.name)));
    const groups = {};
    for (const r of byDateId(db.expenses)) {
      if (r.recurring_id == null && r.description.trim() && r.date >= since) (groups[normName(r.description)] ||= []).push(r);
    }
    const found = [];
    for (const [key, items] of Object.entries(groups)) {
      const med = median(items.map((r) => r.amount_cents));
      const months = [...new Set(items.map((r) => r.date.slice(0, 7)))].sort();
      const span = monthIndex(months[months.length - 1]) - monthIndex(months[0]) + 1;
      // Co najmniej 3 miesiące, mniej więcej raz w miesiącu (nie codzienne zakupy), w co najmniej
      // 3/4 miesięcy od pierwszej do ostatniej płatności i o zbliżonej kwocie (±50% u 3/4 płatności).
      if (months.length < 3 || 2 * items.length > 3 * months.length || 4 * months.length < 3 * span) continue;
      if (4 * items.filter((r) => 2 * Math.abs(r.amount_cents - med) <= med).length < 3 * items.length) continue;
      const last = lastOf(items);
      const amount = med;
      found.push({
        name: last.description.trim(),
        category: last.category,
        amount: amount / 100,
        yearly_cost: (12 * amount) / 100,
        fixed_amount: items.every((r) => 10 * Math.abs(r.amount_cents - med) <= med),
        months: months.length,
        typical_day: median(items.map((r) => +r.date.slice(8, 10))),
        first_date: items[0].date,
        last_date: last.date,
        active: last.date >= activeSince,
        registered: registered.has(key),
        _a: amount, _k: key,
      });
    }
    found.sort((x, y) => (x.active === y.active ? 0 : x.active ? -1 : 1) || y._a - x._a || cmp(x._k, y._k));
    const monthly = found.filter((s) => s.active).reduce((s, x) => s + x._a, 0);
    return { monthly_total: monthly / 100, yearly_total: (12 * monthly) / 100, items: found.map(({ _a, _k, ...s }) => s) };
  }

  function advisorPatterns(from, to, smallLimit) {
    const rows = byDateId(db.expenses).filter((r) => from <= r.date && r.date <= to);
    const total = sumCents(rows);
    const days = dayDiff(from, to) + 1;
    const byDay = Array.from({ length: 7 }, () => [0, 0]);
    for (const r of rows) {
      const d = (new Date(Date.parse(r.date)).getUTCDay() + 6) % 7;
      byDay[d][0] += r.amount_cents;
      byDay[d][1] += 1;
    }
    const parts = [0, 0, 0];
    for (const r of rows) {
      const day = +r.date.slice(8, 10);
      parts[day <= 10 ? 0 : day <= 20 ? 1 : 2] += r.amount_cents;
    }
    const small = rows.filter((r) => r.amount_cents < smallLimit);
    const weekend = byDay[5][0] + byDay[6][0];
    return {
      date_from: from, date_to: to, days,
      total: total / 100, count: rows.length,
      daily_average: halfUp(total / days) / 100,
      average_transaction: rows.length ? halfUp(total / rows.length) / 100 : 0,
      weekend_share_percent: pct(weekend, total),
      by_weekday: byDay.map(([t, c], i) => ({ weekday: WEEKDAYS[i], total: t / 100, count: c, share_percent: pct(t, total) })),
      by_part_of_month: ["1–10", "11–20", "21–koniec"].map((p, i) => ({ part: p, total: parts[i] / 100, share_percent: pct(parts[i], total) })),
      small_purchases: { limit: smallLimit / 100, count: small.length, total: sumCents(small) / 100, share_percent: pct(sumCents(small), total) },
    };
  }

  /** Parametr liczbowy z zakresu (jak Query(ge, le) w FastAPI). */
  function numParam(q, name, def, min, max, integer = false) {
    const raw = q.get(name);
    if (raw == null || raw === "") return def;
    const v = Number(raw);
    if (!Number.isFinite(v) || (integer && !Number.isInteger(v)) || v < min || v > max) {
      throw new HttpError(422, `${name}: wartość spoza zakresu ${min}–${max}`);
    }
    return v;
  }
  const optMonth = (q, name) => (q.get(name) ? validMonth(q.get(name)) : null);
  const optDate = (q, name) => (q.get(name) ? validDate(q.get(name)) : null);

  function toGoal(g) {
    const remaining = Math.max(0, g.target_cents - g.saved_cents);
    let monthly = null;
    if (g.deadline && remaining) {
      const [ty, tm] = todayIso().split("-").map(Number);
      const [dy, dm] = g.deadline.split("-").map(Number);
      const months = Math.max(1, (dy - ty) * 12 + dm - tm + 1);
      monthly = Math.floor(remaining / months + 0.5) / 100;
    }
    return {
      id: g.id, name: g.name, target: fromCents(g.target_cents), saved: fromCents(g.saved_cents),
      deadline: g.deadline, percent: Math.min(100, Math.floor((g.saved_cents * 100) / g.target_cents)),
      remaining: fromCents(remaining), monthly_needed: monthly, done: g.saved_cents >= g.target_cents,
    };
  }

  function goalOr404(id) {
    const g = db.goals.find((x) => x.id === +id);
    if (!g) throw new HttpError(404, "Nie znaleziono celu");
    return g;
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

    ["GET", /^\/analytics\/insights$/, () => computeInsights()],

    // --- doradca finansowy (jak app/routers/analytics.py) ---
    ["GET", /^\/analytics\/report$/, (q) =>
      advisorReport(optMonth(q, "month") || currentMonth(), halfUp(numParam(q, "savings", 0, 0, 100000000) * 100))],

    ["GET", /^\/analytics\/trends$/, (q) =>
      advisorTrends(validKind(q.get("kind") ?? undefined), numParam(q, "months", 6, 3, 24, true))],

    ["GET", /^\/analytics\/compare$/, (q) => {
      const b = optMonth(q, "b") || currentMonth();
      return advisorCompare(validKind(q.get("kind") ?? undefined), optMonth(q, "a") || monthShift(b, -1), b);
    }],

    ["GET", /^\/analytics\/merchants$/, (q) =>
      advisorMerchants(validKind(q.get("kind") ?? undefined), optDate(q, "date_from"), optDate(q, "date_to"),
        numParam(q, "limit", 20, 1, 100, true))],

    ["GET", /^\/analytics\/subscriptions$/, () => advisorSubscriptions()],

    ["GET", /^\/analytics\/patterns$/, (q) => {
      const to = optDate(q, "date_to") || todayIso();
      const from = optDate(q, "date_from") || isoDay(to, -89);
      if (from > to) throw new HttpError(422, "date_from musi być przed date_to");
      const limit = numParam(q, "small_limit", 50, 0, 10000);
      if (limit <= 0) throw new HttpError(422, "small_limit: musi być większy od 0");
      return advisorPatterns(from, to, halfUp(limit * 100));
    }],

    ["GET", /^\/analytics\/suggest-category$/, (q) => {
      const text = q.get("text");
      if (text == null) throw new HttpError(422, "text: wymagany parametr");
      if (text.length > 255) throw new HttpError(422, "text: maks. 255 znaków");
      return suggestCategory(text, validKind(q.get("kind") ?? undefined));
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
        id: newId(),
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
      const ev = { id: newId(), ...parseEvent(body), done_until: null };
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

    // --- cele oszczędnościowe (jak app/routers/goals.py) ---
    ["GET", /^\/goals$/, () => db.goals.map(toGoal).sort((a, b) =>
      (a.done - b.done) || cmp(a.deadline || "9999-12-31", b.deadline || "9999-12-31") || cmp(a.name, b.name))],

    ["POST", /^\/goals$/, (q, body) => {
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 100) throw new HttpError(422, "nazwa: od 1 do 100 znaków");
      const g = {
        id: newId(),
        name,
        target_cents: toCents(body.target, "target"),
        saved_cents: body.saved != null && Number(body.saved) !== 0 ? toCents(body.saved, "saved") : 0,
        deadline: body.deadline ? validDate(body.deadline) : null,
      };
      db.goals.push(g);
      save();
      return toGoal(g);
    }],

    ["PATCH", /^\/goals\/(\d+)$/, (q, body, [id]) => {
      const g = goalOr404(id);
      const next = { ...g };
      if (body.name) {
        next.name = String(body.name).trim();
        if (!next.name || next.name.length > 100) throw new HttpError(422, "nazwa: od 1 do 100 znaków");
      }
      if (body.target != null) next.target_cents = toCents(body.target, "target");
      if ("deadline" in body) next.deadline = body.deadline ? validDate(body.deadline) : null;
      Object.assign(g, next);
      save();
      return toGoal(g);
    }],

    ["POST", /^\/goals\/(\d+)\/deposit$/, (q, body, [id]) => {
      const g = goalOr404(id);
      const s = String(body.amount ?? "").trim().replace(",", ".");
      if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new HttpError(422, "amount: maks. 2 miejsca po przecinku");
      const amount = Math.round(Number(s) * 100);
      if (amount === 0) throw new HttpError(422, "Kwota nie może być zerowa");
      if (g.saved_cents + amount < 0) throw new HttpError(422, "Nie można wypłacić więcej, niż odłożono");
      g.saved_cents += amount;
      save();
      return toGoal(g);
    }],

    ["DELETE", /^\/goals\/(\d+)$/, (q, body, [id]) => {
      const g = goalOr404(id);
      db.goals = db.goals.filter((x) => x !== g);
      save();
      return null;
    }],

    // --- kategorie (jak app/routers/categories.py) ---
    ["GET", /^\/categories$/, () => {
      const out = [];
      for (const [kind, table] of Object.entries(TABLES)) {
        const stats = {};
        for (const e of db[table]) {
          const s = (stats[e.category] ||= { count: 0, cents: 0 });
          s.count++;
          s.cents += e.amount_cents;
        }
        Object.keys(stats).sort((a, b) => stats[b].count - stats[a].count || cmp(a, b))
          .forEach((c) => out.push({ kind, category: c, count: stats[c].count, total: fromCents(stats[c].cents) }));
      }
      return out;
    }],

    ["POST", /^\/categories\/rename$/, (q, body) => {
      const kind = validKind(body.kind);
      const from = category(body.from), to = category(body.to);
      if (from === to) throw new HttpError(422, "Nowa nazwa jest taka sama jak stara");
      let updated = 0;
      db[TABLES[kind]].forEach((e) => { if (e.category === from) { e.category = to; updated++; } });
      db.recurring.forEach((r) => { if (r.category === from && r.kind === kind) r.category = to; });
      if (kind === "expense") {
        db.events.forEach((e) => { if (e.category === from) e.category = to; });
        if (from in db.budgets) {
          if (!(to in db.budgets)) db.budgets[to] = db.budgets[from];
          delete db.budgets[from];
        }
      }
      save();
      return { updated };
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

  // ---------- dla synchronizacji wspólnego budżetu (sync.js) ----------
  const DATA_KEYS = ["expenses", "incomes", "recurring", "events", "goals", "budgets"];
  /** Kopia danych do synchronizacji (bez liczników ID). */
  function snapshot() {
    return JSON.parse(JSON.stringify(Object.fromEntries(DATA_KEYS.map((k) => [k, db[k]]))));
  }
  /** Podmienia dane po synchronizacji. */
  function replaceData(data) {
    db = normalize(data);
    localStorage.setItem(KEY, JSON.stringify(db));
  }
  const onChange = (fn) => listeners.push(fn);

  return { request, exportJson, importJson, snapshot, replaceData, onChange };
})();
