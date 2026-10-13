"use strict";

// Lokalny "serwer" działający w przeglądarce: te same ścieżki i odpowiedzi co
// API w FastAPI (app/routers), ale dane trzymane w localStorage telefonu.
// Dzięki temu interfejs (app.js) działa bez Termuxa i bez internetu.
const LocalApi = (() => {
  const KEY = "wydatki-data-v1";

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(KEY));
      if (data && Array.isArray(data.expenses)) return data;
    } catch {}
    return { expenses: [], budgets: {}, nextId: 1 };
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

  function parseExpense(body) {
    const description = String(body.description ?? "").trim();
    if (description.length > 255) throw new HttpError(422, "opis może mieć maks. 255 znaków");
    return {
      amount_cents: toCents(body.amount),
      category: category(body.category),
      description,
      date: validDate(body.date),
    };
  }

  const toExpense = (e) => ({
    id: e.id,
    amount: fromCents(e.amount_cents),
    category: e.category,
    description: e.description,
    date: e.date,
  });

  function insert(row) {
    const e = { id: db.nextId++, ...row };
    db.expenses.push(e);
    return e;
  }

  // ---------- filtry (jak app/filters.py) ----------
  function filtered(q) {
    const cat = q.get("category")?.trim().toLowerCase();
    const from = q.get("date_from");
    const to = q.get("date_to");
    return db.expenses.filter(
      (e) => (!from || e.date >= from) && (!to || e.date <= to) && (!cat || e.category === cat)
    );
  }

  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;

  // ---------- CSV ----------
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

  async function importCsv(formData) {
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
      try {
        insert(parseExpense({
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

  // ---------- trasy ----------
  const routes = [
    ["GET", /^\/health$/, () => ({ status: "ok" })],

    ["GET", /^\/expenses$/, (q) => {
      const limit = Math.min(Math.max(+q.get("limit") || 100, 1), 1000);
      const offset = Math.max(+q.get("offset") || 0, 0);
      return filtered(q).sort(byDateDesc).slice(offset, offset + limit).map(toExpense);
    }],

    ["POST", /^\/expenses$/, (q, body) => {
      const e = insert(parseExpense(body));
      save();
      return toExpense(e);
    }],

    ["POST", /^\/expenses\/import$/, (q, body) => importCsv(body)],

    ["DELETE", /^\/expenses\/(\d+)$/, (q, body, [id]) => {
      const i = db.expenses.findIndex((e) => e.id === +id);
      if (i < 0) throw new HttpError(404, "Nie znaleziono wydatku");
      db.expenses.splice(i, 1);
      save();
      return null;
    }],

    ["GET", /^\/analytics\/summary$/, (q) => {
      const rows = filtered(q);
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
      for (const e of filtered(q)) {
        const g = (groups[e.category] ||= { category: e.category, count: 0, cents: 0 });
        g.count++;
        g.cents += e.amount_cents;
      }
      const list = Object.values(groups).sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category));
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
      for (const e of filtered(q)) {
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
      return filtered(q)
        .sort((a, b) => b.amount_cents - a.amount_cents || (a.date < b.date ? 1 : -1))
        .slice(0, limit)
        .map(toExpense);
    }],

    ["GET", /^\/budgets\/status$/, (q) => {
      const month = q.get("month") || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(422, "Miesiąc musi mieć format RRRR-MM");
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

  // Pełna kopia danych (wydatki + budżety) do pliku JSON i z powrotem.
  function exportJson() {
    return JSON.stringify({ version: 1, ...db }, null, 1);
  }
  function importJson(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data.expenses)) throw new Error("To nie jest kopia zapasowa aplikacji");
    db = { expenses: data.expenses, budgets: data.budgets || {}, nextId: data.nextId || 1 };
    db.nextId = Math.max(db.nextId, ...db.expenses.map((e) => e.id + 1), 1);
    save();
  }

  return { request, exportJson, importJson };
})();
