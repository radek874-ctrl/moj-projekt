"use strict";

// =====================================================================
// Narzędzia
// =====================================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const fmt = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const money = (v) => fmt.format(v || 0);
const signed = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + money(Math.abs(v));
const MONTHS = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];
const MONTHS_FULL = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec",
  "sierpień", "wrzesień", "październik", "listopad", "grudzień"];

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const monthLabel = (key) => {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS_FULL[m - 1]} ${y}`;
};
const shiftMonth = (key, delta) => {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
};
const parseAmount = (s) => Number(String(s).replace(/\s/g, "").replace(",", "."));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function formatDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function toast(msg, actionLabel, action) {
  const el = $("#toast");
  el.textContent = msg;
  if (actionLabel) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-action";
    b.textContent = actionLabel;
    b.addEventListener("click", async () => {
      el.hidden = true;
      try { await action(); } catch (e) { toast("Błąd: " + e.message); }
    });
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), actionLabel ? 6000 : 2500);
}

// =====================================================================
// Kategorie z ikonami (podpowiedzi; można wpisać dowolną inną)
// =====================================================================
const CATEGORIES = {
  expense: [
    ["jedzenie", "🛒"], ["prąd", "⚡"], ["gaz", "🔥"], ["woda", "💧"], ["ogrzewanie", "♨️"],
    ["czynsz", "🏠"], ["kredyt", "🏦"], ["internet", "🌐"], ["telefon", "📱"], ["paliwo", "⛽"],
    ["transport", "🚌"], ["ubezpieczenie", "🛡️"], ["zdrowie", "💊"], ["dzieci", "🧸"],
    ["ubrania", "👕"], ["rozrywka", "🎬"], ["inne", "📦"],
  ],
  income: [
    ["wynagrodzenie", "💼"], ["premia", "🎁"], ["800+", "👶"], ["emerytura", "🧓"],
    ["zwrot podatku", "🧾"], ["sprzedaż", "🏷️"], ["odsetki", "📈"], ["inne", "💰"],
  ],
};
// Gotowe szablony stałych pozycji: [nazwa, kategoria, dzień]
const RECURRING_PRESETS = {
  expense: [["Prąd", "prąd", 15], ["Gaz", "gaz", 15], ["Woda", "woda", 15], ["Czynsz", "czynsz", 10],
    ["Kredyt", "kredyt", 5], ["Internet", "internet", 20], ["Telefon", "telefon", 20],
    ["Ubezpieczenie", "ubezpieczenie", 1]],
  income: [["Wynagrodzenie", "wynagrodzenie", 10], ["800+", "800+", 20], ["Emerytura", "emerytura", 1]],
};
const ICONS = Object.fromEntries([...CATEGORIES.expense, ...CATEGORIES.income]);
const icon = (cat) => ICONS[cat] || "•";

// =====================================================================
// Komunikacja z API (serwer FastAPI albo LocalApi w przeglądarce)
// =====================================================================
const LOCAL = window.APP_MODE === "local";
const PATH = { expense: "/expenses", income: "/incomes" };

async function api(path, options = {}) {
  if (LOCAL) return LocalApi.request(path, options);
  let res;
  try {
    res = await fetch(path, options);
  } catch (e) {
    $("#offline").hidden = false;
    throw e;
  }
  $("#offline").hidden = true;
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join(", ") : body.detail;
    } catch {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const qs = (params) =>
  "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();

// =====================================================================
// Nawigacja
// =====================================================================
const loaders = {};

function show(view) {
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  loaders[view]?.()?.catch?.((e) => {
    if ($("#offline").hidden) toast("Błąd: " + e.message);
  });
  window.scrollTo(0, 0);
}
$$(".tabbar button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

function setActive(buttons, active) {
  buttons.forEach((b) => {
    b.classList.toggle("active", b === active);
    if (b.hasAttribute("aria-checked")) b.setAttribute("aria-checked", b === active);
  });
}

// =====================================================================
// Tooltip i okno dialogowe
// =====================================================================
const tip = $("#tooltip");
function attachTip(el, text) {
  const open = () => {
    const r = el.getBoundingClientRect();
    tip.textContent = text;
    tip.hidden = false;
    const x = Math.min(Math.max(r.left + r.width / 2, 100), window.innerWidth - 100);
    tip.style.left = `${x}px`;
    tip.style.top = `${r.top}px`;
  };
  el.addEventListener("pointerenter", open);
  el.addEventListener("click", open);
  el.addEventListener("pointerleave", () => (tip.hidden = true));
}
document.addEventListener("scroll", () => (tip.hidden = true), { passive: true });

/** Pokazuje okno z formularzem. Zwraca FormData po „OK” albo null po „Anuluj”. */
function openDialog(title, bodyHtml, okLabel = "OK") {
  const dialog = $("#dialog");
  $("#dialog-title").textContent = title;
  $("#dialog-body").innerHTML = bodyHtml;
  $("#dialog-ok").textContent = okLabel;
  dialog.showModal();
  dialog.querySelector("input")?.focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok" ? new FormData($("#dialog-form")) : null);
    }, { once: true });
  });
}

// =====================================================================
// PULPIT
// =====================================================================
let period = "month";

function periodRange(p) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (p) {
    case "month": return { date_from: iso(new Date(y, m, 1)), date_to: iso(new Date(y, m + 1, 0)) };
    case "prev": return { date_from: iso(new Date(y, m - 1, 1)), date_to: iso(new Date(y, m, 0)) };
    case "3m": return { date_from: iso(new Date(y, m - 2, 1)), date_to: iso(new Date(y, m + 1, 0)) };
    case "year": return { date_from: iso(new Date(y, 0, 1)), date_to: iso(new Date(y, 11, 31)) };
    default: return {};
  }
}

$$("#view-pulpit .periods button").forEach((b) =>
  b.addEventListener("click", () => {
    period = b.dataset.period;
    setActive($$("#view-pulpit .periods button"), b);
    loaders.pulpit();
  })
);

function renderCategoryBars(box, stats, kind) {
  if (!stats.length) {
    box.innerHTML = `<div class="empty">Brak ${kind === "income" ? "przychodów" : "wydatków"} w tym okresie.</div>`;
    return;
  }
  const max = stats[0].total;
  box.innerHTML = "";
  for (const s of stats) {
    const row = document.createElement("div");
    row.className = "hbar";
    row.innerHTML = `
      <span class="hbar-label">${icon(s.category)} ${esc(s.category)}</span>
      <span class="hbar-value">${money(s.total)} · ${Math.round(s.share_percent)}% ›</span>
      <div class="hbar-track"><div class="hbar-fill fill-${kind}" style="width:${(100 * s.total) / max}%"></div></div>`;
    row.setAttribute("role", "button");
    row.addEventListener("click", () => openHistoryCategory(kind, s.category));
    box.appendChild(row);
  }
}

function renderMonthly(balanceMonths) {
  // Zawsze ostatnie 12 miesięcy, także te puste.
  const now = new Date();
  const byMonth = Object.fromEntries(balanceMonths.map((m) => [m.month, m]));
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    months.push({ key, label: MONTHS[d.getMonth()], ...(byMonth[key] || { income: 0, expenses: 0, balance: 0 }) });
  }
  const max = Math.max(...months.flatMap((m) => [m.income, m.expenses]), 1);
  const box = $("#chart-monthly");
  box.innerHTML = "";
  const axis = document.createElement("div");
  axis.className = "col-axis";
  for (const m of months) {
    const col = document.createElement("div");
    col.className = "col";
    col.innerHTML = `
      <div class="col-fill fill-income" style="height:${(100 * m.income) / max}%"></div>
      <div class="col-fill fill-expense" style="height:${(100 * m.expenses) / max}%"></div>`;
    attachTip(col, `${monthLabel(m.key)}: +${money(m.income)} / −${money(m.expenses)} = ${signed(m.balance)}`);
    box.appendChild(col);
    axis.insertAdjacentHTML("beforeend", `<span>${m.label}</span>`);
  }
  if (box.nextElementSibling?.classList.contains("col-axis")) box.nextElementSibling.remove();
  box.after(axis);
}

async function renderBillsReminder() {
  const items = await api("/recurring" + qs({ month: monthKey(new Date()) }));
  const unpaid = items.filter((r) => r.kind === "expense" && !r.paid);
  const el = $("#bills-reminder");
  if (!unpaid.length) {
    el.hidden = true;
    return;
  }
  const sum = unpaid.reduce((s, r) => s + r.amount, 0);
  el.innerHTML = `
    <div><strong>🧾 Do zapłaty w tym miesiącu: ${money(sum)}</strong>
      <div class="muted">${unpaid.map((r) => esc(r.name)).join(", ")}</div></div>
    <button class="btn btn-small" type="button">Opłaty ›</button>`;
  el.querySelector("button").addEventListener("click", () => show("oplaty"));
  el.hidden = false;
}

loaders.pulpit = async () => {
  const range = periodRange(period);
  const now = new Date();
  const yearAgo = iso(new Date(now.getFullYear(), now.getMonth() - 11, 1));
  const [bal, expCats, incCats, last12] = await Promise.all([
    api("/analytics/balance" + qs(range)),
    api("/analytics/by-category" + qs({ ...range, kind: "expense" })),
    api("/analytics/by-category" + qs({ ...range, kind: "income" })),
    api("/analytics/balance" + qs({ date_from: yearAgo })),
  ]);
  $("#bal-balance").textContent = signed(bal.balance);
  $("#bal-income").textContent = money(bal.income);
  $("#bal-expenses").textContent = money(bal.expenses);
  $("#bal-note").textContent =
    bal.savings_rate == null ? "Dodaj przychody, żeby zobaczyć, ile zostaje."
      : bal.balance >= 0 ? `✅ Zostaje ${Math.round(bal.savings_rate)}% przychodów`
        : `⚠️ Wydatki większe od przychodów o ${money(-bal.balance)}`;

  renderCategoryBars($("#chart-expense-categories"), expCats, "expense");
  $("#income-categories-card").hidden = !incCats.length;
  renderCategoryBars($("#chart-income-categories"), incCats, "income");
  renderMonthly(last12.months);
  await Promise.all([renderOnboarding(), renderBackupReminder(), renderEventsReminder(),
    renderBillsReminder(), renderInsights()]);
};

// =====================================================================
// PODPOWIEDZI (liczone lokalnie, bez AI)
// =====================================================================
const LEVEL_ICON = { good: "✅", info: "ℹ️", warning: "⚠️", alert: "🚨" };

async function renderInsights() {
  const { forecast: f, insights } = await api("/analytics/insights");
  const card = $("#insights-card");
  card.hidden = !insights.length;
  const fc = $("#forecast");
  if (f.projected_income > 0 || f.projected_expenses > 0) {
    const safe = f.safe_daily != null ? `
      <div class="safe-daily"><span>Możesz wydawać do końca miesiąca</span>
        <strong>${money(f.safe_daily)} <small>/ dzień</small></strong></div>` : "";
    fc.innerHTML = `${safe}
      <div class="forecast-row"><span>Prognoza na koniec miesiąca</span>
        <strong class="${f.projected_balance < 0 ? "neg" : ""}">${signed(f.projected_balance)}</strong></div>
      <div class="muted">Przychody ${money(f.projected_income)} · wydatki ok. ${money(f.projected_expenses)}
        (w tym jeszcze do zapłaty ${money(f.planned_expenses)} stałych i ok. ${money(f.projected_variable)} bieżących)</div>`;
    fc.hidden = false;
  } else {
    fc.hidden = true;
  }
  $("#insights-list").innerHTML = insights
    .filter((i) => i.key !== "forecast")
    .map((i) => `<li class="ins-${i.level}"><span class="ins-ico">${LEVEL_ICON[i.level] || "•"}</span>
      <div><strong>${esc(i.title)}</strong><div>${esc(i.text)}</div></div></li>`).join("");
}

// =====================================================================
// Podpowiedzi kategorii (stałe + używane wcześniej)
// =====================================================================
/** Najczęściej używane kategorie najpierw, potem pozostałe podpowiedzi. */
async function knownCategories(kind) {
  const used = (await api("/categories")).filter((c) => c.kind === kind).map((c) => c.category);
  const presets = CATEGORIES[kind].map(([c]) => c);
  return [...new Set([...used, ...presets])];
}

async function fillDatalists() {
  const [exp, inc] = await Promise.all([knownCategories("expense"), knownCategories("income")]);
  const opts = (list) => list.map((c) => `<option value="${esc(c)}">`).join("");
  $("#expense-categories").innerHTML = opts(exp);
  $("#all-categories").innerHTML = opts([...new Set([...exp, ...inc])]);
}

// =====================================================================
// DODAJ (wydatek albo przychód)
// =====================================================================
const txForm = $("#tx-form");
let txKind = "expense";
txForm.date.value = iso(new Date());

async function renderCategoryGrid() {
  const grid = $("#category-grid");
  const cats = await knownCategories(txKind);
  grid.innerHTML = "";
  for (const c of cats) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cat" + (txForm.category.value.trim().toLowerCase() === c ? " active" : "");
    b.innerHTML = `<span class="cat-ico">${icon(c)}</span><span class="cat-name${c.length > 10 ? " long" : ""}">${esc(c)}</span>`;
    b.addEventListener("click", () => {
      txForm.category.value = c;
      clearCategoryHint();
      grid.querySelectorAll(".cat").forEach((x) => x.classList.toggle("active", x === b));
    });
    grid.appendChild(b);
  }
}

// Szybkie powtórzenie: ostatnie różne wpisy (opis + kategoria + kwota) jako przyciski.
async function renderRecentChips() {
  const box = $("#recent-chips");
  const recent = await api(PATH[txKind] + qs({ limit: 40 }));
  const seen = new Set();
  const picks = [];
  for (const t of recent) {
    const key = `${t.description.toLowerCase()}|${t.category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(t);
    if (picks.length === 5) break;
  }
  box.innerHTML = picks.length ? '<span class="chips-label">Powtórz:</span>' : "";
  for (const t of picks) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${icon(t.category)} ${t.description || t.category} · ${money(t.amount)}`;
    b.addEventListener("click", () => {
      txForm.amount.value = String(t.amount).replace(".", ",");
      txForm.description.value = t.description;
      txForm.category.value = t.category;
      txForm.currency.value = "PLN";
      clearCategoryHint();
      updateFx();
      renderCategoryGrid().catch(() => {});
      txForm.amount.focus();
      txForm.amount.select();
    });
    box.appendChild(b);
  }
  box.hidden = !picks.length;
}

// ---------- waluty obce: kurs średni NBP (tabela A) z dnia wydatku ----------
const FX_CACHE_KEY = "budzet-fx-cache";
let fxRate = null;      // aktualny kurs dla formularza
let fxSeq = 0;

function fxCache() {
  try { return JSON.parse(localStorage.getItem(FX_CACHE_KEY)) || {}; } catch { return {}; }
}

/** Kurs NBP obowiązujący w danym dniu (ostatni opublikowany do tej daty). */
async function nbpRate(code, date) {
  const key = `${code}:${date}`;
  const cache = fxCache();
  if (cache[key]) return cache[key];
  const today = iso(new Date());
  const to = date > today ? today : date;
  const fromDate = new Date(`${to}T12:00:00`);
  fromDate.setDate(fromDate.getDate() - 10); // weekendy i święta: NBP nie publikuje kursów
  const url = `https://api.nbp.pl/api/exchangerates/rates/a/${code.toLowerCase()}/${iso(fromDate)}/${to}/?format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`NBP: ${res.status}`);
  const data = await res.json();
  const last = data.rates[data.rates.length - 1];
  const result = { rate: last.mid, date: last.effectiveDate, table: last.no };
  cache[key] = result;
  try { localStorage.setItem(FX_CACHE_KEY, JSON.stringify(cache)); } catch {}
  return result;
}

async function updateFx() {
  const code = txForm.currency.value;
  const box = $("#fx-box");
  const manual = box.querySelector(".fx-manual");
  fxRate = null;
  if (code === "PLN") {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const seq = ++fxSeq;
  const amount = parseAmount(txForm.amount.value);
  const manualRate = parseAmount(txForm.rate.value);
  if (!manual.hidden && manualRate > 0) {
    fxRate = { rate: manualRate, manual: true };
  } else {
    $("#fx-info").textContent = "Pobieram kurs NBP…";
    try {
      const r = await nbpRate(code, txForm.date.value || iso(new Date()));
      if (seq !== fxSeq) return;
      fxRate = r;
      manual.hidden = true;
    } catch {
      if (seq !== fxSeq) return;
      manual.hidden = false;
      $("#fx-info").textContent = "Nie udało się pobrać kursu NBP (brak internetu?). Wpisz kurs ręcznie:";
      return;
    }
  }
  const pln = amount > 0 ? Math.round(amount * fxRate.rate * 100) / 100 : null;
  $("#fx-info").textContent = (pln ? `= ${money(pln)} · ` : "") +
    (fxRate.manual ? `kurs ręczny ${String(fxRate.rate).replace(".", ",")}` : `kurs NBP ${String(fxRate.rate).replace(".", ",")} z ${formatDate(fxRate.date)}`);
}

txForm.currency.addEventListener("change", () => {
  txForm.rate.value = "";
  $("#fx-box .fx-manual").hidden = true;
  updateFx();
});
txForm.amount.addEventListener("input", () => { if (txForm.currency.value !== "PLN") updateFx(); });
txForm.date.addEventListener("change", () => { if (txForm.currency.value !== "PLN") updateFx(); });
txForm.rate.addEventListener("input", updateFx);

// Automatyczna kategoria: po wpisaniu opisu podpowiadamy kategorię (z historii albo słownika),
// ale tylko jeśli użytkownik nie wybrał jej sam.
let categoryAuto = false;
let suggestTimer;
txForm.description.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    const text = txForm.description.value.trim();
    if (!text || (txForm.category.value && !categoryAuto)) return;
    try {
      const s = await api("/analytics/suggest-category" + qs({ text, kind: txKind }));
      if (!s.category || (txForm.category.value && !categoryAuto)) return;
      txForm.category.value = s.category;
      categoryAuto = true;
      const hint = $("#cat-hint");
      hint.textContent = s.source === "history" ? "✨ jak poprzednio" : "✨ podpowiedź";
      hint.hidden = false;
      await renderCategoryGrid();
    } catch {}
  }, 300);
});

function clearCategoryHint() {
  categoryAuto = false;
  $("#cat-hint").hidden = true;
}

txForm.category.addEventListener("input", () => {
  clearCategoryHint();
  const v = txForm.category.value.trim().toLowerCase();
  $$("#category-grid .cat").forEach((b) => b.classList.toggle("active", b.querySelector(".cat-name").textContent === v));
});

$$("#tx-form .segmented button").forEach((b) =>
  b.addEventListener("click", () => {
    txKind = b.dataset.kind;
    setActive($$("#tx-form .segmented button"), b);
    txForm.classList.toggle("is-income", txKind === "income");
    $("#tx-submit").textContent = txKind === "income" ? "Zapisz przychód" : "Zapisz wydatek";
    txForm.category.value = "";
    renderCategoryGrid().catch(() => {});
    renderRecentChips().catch(() => {});
  })
);

/** Otwiera zakładkę „Dodaj” z wybranym rodzajem (expense/income). */
function openAdd(kind) {
  show("dodaj");
  $(`#tx-form .segmented [data-kind="${kind}"]`).click();
  txForm.amount.focus();
}
$$("[data-add]").forEach((b) => b.addEventListener("click", () => openAdd(b.dataset.add)));

loaders.dodaj = async () => {
  await Promise.all([renderCategoryGrid(), renderRecentChips()]);
  txForm.amount.focus();
};

txForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  let amount = parseAmount(txForm.amount.value);
  if (!(amount > 0)) return toast("Podaj poprawną kwotę");
  let description = txForm.description.value.trim();
  const code = txForm.currency.value;
  if (code !== "PLN") {
    await updateFx();
    if (!fxRate) return toast("Podaj kurs waluty");
    const rate = String(fxRate.rate).replace(".", ",");
    description = `${description ? description + " " : ""}(${amount.toFixed(2).replace(".", ",")} ${code} × ${rate})`.slice(0, 255);
    amount = Math.round(amount * fxRate.rate * 100) / 100;
  }
  let saved;
  try {
    saved = await api(PATH[txKind], json("POST", {
      amount,
      category: txForm.category.value,
      description,
      date: txForm.date.value,
    }));
  } catch (e) {
    return toast("Błąd: " + e.message);
  }
  const savedKind = txKind;
  toast(`${savedKind === "income" ? "Przychód" : "Wydatek"} zapisany: ${money(amount)}`, "Cofnij", async () => {
    await api(`${PATH[savedKind]}/${saved.id}`, { method: "DELETE" });
    toast("Cofnięto");
    renderRecentChips().catch(() => {});
  });
  renderRecentChips().catch(() => {});
  txForm.amount.value = "";
  txForm.description.value = "";
  txForm.category.value = "";
  clearCategoryHint();
  renderCategoryGrid().catch(() => {});
  txForm.amount.focus();
});

const importForm = $("#import-form");
importForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    const r = await api("/expenses/import", { method: "POST", body: new FormData(importForm) });
    $("#import-result").innerHTML =
      `Zaimportowano: ${r.imported}` + (r.errors.length ? `<br>Błędy:<br>${r.errors.map(esc).join("<br>")}` : "");
    importForm.reset();
  } catch (e) {
    $("#import-result").textContent = "Błąd: " + e.message;
  }
});

// =====================================================================
// STAŁE OPŁATY
// =====================================================================
let billsMonth = monthKey(new Date());
let recurringKind = "expense";
const recForm = $("#recurring-form");

$("#bills-prev").addEventListener("click", () => { billsMonth = shiftMonth(billsMonth, -1); loaders.oplaty(); });
$("#bills-next").addEventListener("click", () => { billsMonth = shiftMonth(billsMonth, 1); loaders.oplaty(); });

function billItem(r) {
  const li = document.createElement("li");
  const doneLabel = r.kind === "income" ? "wpłynęło" : "zapłacono";
  li.className = r.paid ? "paid" : "";
  li.innerHTML = `
    <span class="bill-ico">${icon(r.category)}</span>
    <div class="meta">
      <div class="title">${esc(r.name)}</div>
      <div class="sub">${r.paid ? `✓ ${doneLabel} ${money(r.paid_amount)}` : `${money(r.amount)} · do ${r.day}.`}</div>
    </div>
    ${r.paid
      ? '<button class="btn btn-small btn-ghost" data-act="undo">Cofnij</button>'
      : `<button class="btn btn-small" data-act="pay">${r.kind === "income" ? "Wpłynęło" : "Zapłać"}</button>`}
    <button class="icon-btn" data-act="edit" aria-label="Edytuj">✎</button>`;

  li.querySelector('[data-act="pay"]')?.addEventListener("click", async () => {
    const data = await openDialog(
      `${r.name} – ${monthLabel(billsMonth)}`,
      `<label>Kwota (zł)
         <input name="amount" type="text" inputmode="decimal" value="${String(r.amount).replace(".", ",")}" required>
       </label>
       <p class="muted">Zmień kwotę, jeśli rachunek jest inny niż zwykle.</p>`,
      r.kind === "income" ? "Zapisz wpływ" : "Zapłacone"
    );
    if (!data) return;
    const amount = parseAmount(data.get("amount"));
    if (!(amount > 0)) return toast("Podaj poprawną kwotę");
    try {
      await api(`/recurring/${r.id}/pay`, json("POST", { month: billsMonth, amount }));
      toast(`${r.name}: ${doneLabel} ${money(amount)}`);
    } catch (e) {
      toast("Błąd: " + e.message);
    }
    loaders.oplaty();
  });

  li.querySelector('[data-act="undo"]')?.addEventListener("click", async () => {
    if (!confirm(`Cofnąć „${r.name}” za ${monthLabel(billsMonth)}? Usunie to zapisaną operację.`)) return;
    await api(`${PATH[r.kind]}/${r.transaction_id}`, { method: "DELETE" });
    loaders.oplaty();
  });

  li.querySelector('[data-act="edit"]').addEventListener("click", async () => {
    const data = await openDialog(
      "Edytuj stałą pozycję",
      `<label>Nazwa <input name="name" value="${esc(r.name)}" maxlength="100" required></label>
       <label>Typowa kwota (zł)
         <input name="amount" type="text" inputmode="decimal" value="${String(r.amount).replace(".", ",")}" required></label>
       <label>Dzień płatności <input name="day" type="number" min="1" max="28" value="${r.day}" required></label>
       <label class="check"><input type="checkbox" name="delete"> Usuń tę pozycję
         <span class="muted">(zapisane płatności zostaną w historii)</span></label>`,
      "Zapisz"
    );
    if (!data) return;
    try {
      if (data.get("delete")) {
        await api(`/recurring/${r.id}`, { method: "DELETE" });
        toast("Usunięto");
      } else {
        await api(`/recurring/${r.id}`, json("PATCH", {
          name: data.get("name"), amount: parseAmount(data.get("amount")), day: Number(data.get("day")),
        }));
        toast("Zapisano");
      }
    } catch (e) {
      toast("Błąd: " + e.message);
    }
    loaders.oplaty();
  });
  return li;
}

loaders.oplaty = async () => {
  $("#bills-month").textContent = monthLabel(billsMonth);
  const items = await api("/recurring" + qs({ month: billsMonth }));
  const expenses = items.filter((r) => r.kind === "expense");
  const incomes = items.filter((r) => r.kind === "income");

  const unpaid = expenses.filter((r) => !r.paid);
  const paidCount = expenses.length - unpaid.length;
  $("#bills-summary").textContent = expenses.length
    ? `Zapłacono ${paidCount} z ${expenses.length}` +
      (unpaid.length ? ` · zostało ${money(unpaid.reduce((s, r) => s + r.amount, 0))}` : " · wszystko opłacone ✓")
    : "";

  const expList = $("#bills-expense");
  expList.innerHTML = expenses.length ? "" : '<li class="empty">Brak stałych opłat. Dodaj je poniżej – np. prąd, gaz, kredyt.</li>';
  expenses.forEach((r) => expList.appendChild(billItem(r)));

  $("#bills-income-card").hidden = !incomes.length;
  const incList = $("#bills-income");
  incList.innerHTML = "";
  incomes.forEach((r) => incList.appendChild(billItem(r)));

  renderRecurringPresets();
  fillDatalists().catch(() => {});
};

function renderRecurringPresets() {
  const box = $("#recurring-presets");
  box.innerHTML = "";
  for (const [name, category, day] of RECURRING_PRESETS[recurringKind]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${icon(category)} ${name}`;
    b.addEventListener("click", () => {
      recForm.name.value = name;
      recForm.category.value = category;
      recForm.day.value = day;
      recForm.amount.focus();
    });
    box.appendChild(b);
  }
}

$$("#recurring-form .segmented button").forEach((b) =>
  b.addEventListener("click", () => {
    recurringKind = b.dataset.kind;
    setActive($$("#recurring-form .segmented button"), b);
    renderRecurringPresets();
  })
);

recForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const amount = parseAmount(recForm.amount.value);
  if (!(amount > 0)) return toast("Podaj poprawną kwotę");
  try {
    await api("/recurring", json("POST", {
      kind: recurringKind,
      name: recForm.name.value,
      category: recForm.category.value,
      amount,
      day: Number(recForm.day.value),
    }));
  } catch (e) {
    return toast("Błąd: " + e.message);
  }
  toast(`Dodano: ${recForm.name.value}`);
  recForm.reset();
  recForm.day.value = 10;
  loaders.oplaty();
});

// =====================================================================
// KALENDARZ (ważne terminy z przypomnieniami)
// =====================================================================
// Gotowe terminy: [tytuł, ikona, powtarzanie, kategoria wydatku]
const EVENT_PRESETS = [
  ["OC samochodu", "🚗", "yearly", "ubezpieczenie"], ["Przegląd auta", "🔧", "yearly", "transport"],
  ["Ubezpieczenie domu", "🏠", "yearly", "ubezpieczenie"], ["Podatek od nieruchomości", "🧾", "yearly", "podatki"],
  ["PIT", "📄", "yearly", ""], ["Urodziny", "🎂", "yearly", ""], ["Wizyta u lekarza", "🩺", "none", "zdrowie"],
  ["Wymiana opon", "🛞", "yearly", "transport"],
];
const REPEAT_LABEL = { none: "jednorazowo", monthly: "co miesiąc", yearly: "co rok" };
const DAYS_PL = (n) => (n === 1 ? "1 dzień" : `${n} dni`);

let calMonth = monthKey(new Date());
let calSelected = iso(new Date());
const evForm = $("#event-form");
evForm.date.value = iso(new Date());

function whenLabel(e) {
  if (e.state === "done") return "✓ zrobione";
  if (e.days_left === 0) return "dziś!";
  if (e.days_left === 1) return "jutro";
  if (e.days_left < 0) return `po terminie ${DAYS_PL(-e.days_left)}`;
  return `za ${DAYS_PL(e.days_left)}`;
}

/** Link do Google Kalendarza z gotowym wydarzeniem całodniowym (prawdziwe powiadomienie w telefonie). */
function googleCalendarUrl(e) {
  const start = (e.next_date || e.date).replaceAll("-", "");
  const d = new Date(`${e.next_date || e.date}T12:00:00`);
  d.setDate(d.getDate() + 1);
  const end = iso(d).replaceAll("-", "");
  const details = [e.note, e.amount ? `Kwota: ${money(e.amount)}` : "",
    `Przypomnienie: ${e.remind_days ? DAYS_PL(e.remind_days) + " wcześniej" : "w dniu terminu"}`].filter(Boolean).join("\n");
  const params = new URLSearchParams({ action: "TEMPLATE", text: e.title, dates: `${start}/${end}`, details });
  if (e.repeat !== "none") params.set("recur", `RRULE:FREQ=${e.repeat === "yearly" ? "YEARLY" : "MONTHLY"}`);
  return "https://calendar.google.com/calendar/render?" + params.toString();
}

function eventItem(e) {
  const li = document.createElement("li");
  li.className = `ev-${e.state}`;
  const date = e.next_date || e.date;
  li.innerHTML = `
    <div class="meta">
      <div class="title">${esc(e.title)}</div>
      <div class="sub"><span class="when">${whenLabel(e)}</span> · ${formatDate(date)}
        · ${REPEAT_LABEL[e.repeat]}${e.amount ? " · " + money(e.amount) : ""}</div>
      ${e.note ? `<div class="sub">${esc(e.note)}</div>` : ""}
    </div>
    ${e.state === "done"
      ? '<button class="btn btn-small btn-ghost" data-act="undo">Przywróć</button>'
      : '<button class="btn btn-small" data-act="done">Zrobione</button>'}
    ${e.state === "done" ? "" : `<a class="icon-btn" href="${googleCalendarUrl(e)}" target="_blank" rel="noopener"
        aria-label="Dodaj do Kalendarza Google" title="Dodaj do Kalendarza Google">📆</a>`}
    <button class="icon-btn" data-act="edit" aria-label="Edytuj">✎</button>`;

  li.querySelector('[data-act="done"]')?.addEventListener("click", async () => {
    const data = await openDialog(
      `${e.title} – zrobione`,
      `<label>Zapisać jako wydatek? Kwota (zł)
         <input name="amount" type="text" inputmode="decimal" value="${e.amount ? String(e.amount).replace(".", ",") : ""}"
           placeholder="zostaw puste, jeśli bez wydatku">
       </label>
       <p class="muted">${e.repeat === "none" ? "Termin zostanie oznaczony jako zrobiony."
         : `Następny termin: ${formatDate(nextOccurrence(date, e.repeat))}.`}</p>`,
      "Zrobione"
    );
    if (!data) return;
    const raw = String(data.get("amount") || "").trim();
    const amount = raw ? parseAmount(raw) : null;
    if (raw && !(amount > 0)) return toast("Podaj poprawną kwotę albo zostaw puste");
    try {
      await api(`/events/${e.id}/done`, json("POST", amount ? { amount } : {}));
      toast(amount ? `Zrobione, zapisano wydatek ${money(amount)}` : "Zrobione ✓");
    } catch (err) {
      toast("Błąd: " + err.message);
    }
    loaders.kalendarz();
  });

  li.querySelector('[data-act="undo"]')?.addEventListener("click", async () => {
    await api(`/events/${e.id}/undo`, { method: "POST" });
    loaders.kalendarz();
  });

  li.querySelector('[data-act="edit"]').addEventListener("click", async () => {
    const opt = (v, label, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${label}</option>`;
    const data = await openDialog(
      "Edytuj termin",
      `<label>Co? <input name="title" value="${esc(e.title)}" maxlength="100" required></label>
       <label>Data <input name="date" type="date" value="${e.date}" required></label>
       <label>Powtarzaj <select name="repeat">${Object.entries(REPEAT_LABEL).map(([v, l]) => opt(v, l, e.repeat)).join("")}</select></label>
       <label>Przypomnij (dni wcześniej)
         <input name="remind_days" type="number" min="0" max="60" value="${e.remind_days}" required></label>
       <label>Kwota (opcjonalnie)
         <input name="amount" type="text" inputmode="decimal" value="${e.amount ? String(e.amount).replace(".", ",") : ""}"></label>
       <label>Kategoria wydatku <input name="category" list="expense-categories" value="${esc(e.category || "")}" maxlength="50"></label>
       <label>Notatka <input name="note" value="${esc(e.note)}" maxlength="255"></label>
       <a class="btn btn-secondary gcal" href="${googleCalendarUrl(e)}" target="_blank" rel="noopener">📆 Dodaj do Kalendarza Google</a>
       ${e.repeat !== "none" ? '<label class="check"><input type="checkbox" name="undo"> Cofnij ostatnie „zrobione”</label>' : ""}
       <label class="check"><input type="checkbox" name="delete"> Usuń ten termin</label>`,
      "Zapisz"
    );
    if (!data) return;
    try {
      if (data.get("delete")) {
        await api(`/events/${e.id}`, { method: "DELETE" });
        toast("Usunięto");
      } else {
        const rawAmount = String(data.get("amount") || "").trim();
        const patch = {
          title: data.get("title"),
          repeat: data.get("repeat"),
          remind_days: Number(data.get("remind_days")),
          category: data.get("category") || "",
          note: data.get("note"),
        };
        if (rawAmount) patch.amount = parseAmount(rawAmount);
        if (data.get("date") !== e.date) patch.date = data.get("date");
        await api(`/events/${e.id}`, json("PATCH", patch));
        if (data.get("undo")) await api(`/events/${e.id}/undo`, { method: "POST" });
        toast("Zapisano");
      }
    } catch (err) {
      toast("Błąd: " + err.message);
    }
    loaders.kalendarz();
  });
  return li;
}

function nextOccurrence(isoDate, repeat) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const months = repeat === "yearly" ? 12 : 1;
  const last = new Date(y, m - 1 + months + 1, 0).getDate();
  return iso(new Date(y, m - 1 + months, Math.min(d, last)));
}

function renderCalendarGrid(items) {
  const [y, m] = calMonth.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // poniedziałek = 0
  const today = iso(new Date());
  const byDay = {};
  items.forEach((i) => (byDay[i.date] ||= []).push(i));

  const grid = $("#cal-grid");
  grid.innerHTML = "<span></span>".repeat(offset);
  for (let d = 1; d <= days; d++) {
    const date = `${calMonth}-${pad(d)}`;
    const list = byDay[date] || [];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cal-cell" + (date === today ? " today" : "") + (date === calSelected ? " selected" : "");
    b.innerHTML = `<span>${d}</span><span class="cal-dots">${list.map((i) =>
      `<i class="${i.done ? "done" : ""}"></i>`).join("")}</span>`;
    b.setAttribute("aria-label", `${d} ${MONTHS_FULL[m - 1]}${list.length ? ": " + list.map((i) => i.title).join(", ") : ""}`);
    b.addEventListener("click", () => {
      calSelected = date;
      grid.querySelectorAll(".cal-cell").forEach((c) => c.classList.toggle("selected", c === b));
      renderCalendarDay(byDay[date] || []);
    });
    grid.appendChild(b);
  }
  renderCalendarDay(calSelected.startsWith(calMonth) ? byDay[calSelected] || [] : null);
}

function renderCalendarDay(list) {
  const box = $("#cal-day");
  if (list == null) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div class="cal-day-head">${formatDate(calSelected)}</div>` +
    (list.length
      ? list.map((i) => `<div class="cal-day-item${i.done ? " done" : ""}">${i.done ? "✓ " : "• "}${esc(i.title)}</div>`).join("")
      : '<div class="muted">Brak terminów.</div>') +
    '<button type="button" class="btn btn-small btn-ghost" id="cal-add-here">+ Dodaj termin na ten dzień</button>';
  $("#cal-add-here").addEventListener("click", () => {
    evForm.date.value = calSelected;
    evForm.title.focus();
    evForm.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

$("#cal-prev").addEventListener("click", () => { calMonth = shiftMonth(calMonth, -1); loaders.kalendarz(); });
$("#cal-next").addEventListener("click", () => { calMonth = shiftMonth(calMonth, 1); loaders.kalendarz(); });

function renderEventPresets() {
  const box = $("#event-presets");
  box.innerHTML = "";
  for (const [title, ico, repeat, category] of EVENT_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${ico} ${title}`;
    b.addEventListener("click", () => {
      evForm.title.value = title;
      evForm.repeat.value = repeat;
      evForm.category.value = category;
      evForm.date.focus();
    });
    box.appendChild(b);
  }
}
renderEventPresets();

evForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const rawAmount = evForm.amount.value.trim();
  const amount = rawAmount ? parseAmount(rawAmount) : null;
  if (rawAmount && !(amount > 0)) return toast("Podaj poprawną kwotę albo zostaw puste");
  let created;
  try {
    created = await api("/events", json("POST", {
      title: evForm.title.value,
      date: evForm.date.value,
      repeat: evForm.repeat.value,
      remind_days: Number(evForm.remind_days.value),
      amount,
      category: evForm.category.value,
      note: evForm.note.value,
    }));
  } catch (e) {
    return toast("Błąd: " + e.message);
  }
  toast(`Dodano: ${evForm.title.value}`);
  const toGoogle = evForm.gcal.checked;
  if (toGoogle) window.open(googleCalendarUrl(created), "_blank", "noopener");
  calMonth = evForm.date.value.slice(0, 7);
  calSelected = evForm.date.value;
  evForm.reset();
  evForm.date.value = iso(new Date());
  evForm.remind_days.value = "7";
  evForm.gcal.checked = toGoogle;
  loaders.kalendarz();
});

loaders.kalendarz = async () => {
  $("#cal-month").textContent = monthLabel(calMonth);
  const [items, events] = await Promise.all([
    api("/events/calendar" + qs({ month: calMonth })),
    api("/events"),
  ]);
  renderCalendarGrid(items);
  const ul = $("#events-list");
  ul.innerHTML = events.length ? "" : '<li class="empty">Brak terminów. Dodaj np. OC samochodu poniżej.</li>';
  events.forEach((e) => ul.appendChild(eventItem(e)));
  updateReminderBadge(events.filter((e) => e.state === "overdue" || e.state === "soon").length);
  fillDatalists().catch(() => {});
};

/** Licznik przypomnień na zakładce i (jeśli telefon pozwala) na ikonie aplikacji. */
function updateReminderBadge(count) {
  const badge = $("#cal-badge");
  badge.textContent = count;
  badge.hidden = !count;
  try {
    if (count) navigator.setAppBadge?.(count);
    else navigator.clearAppBadge?.();
  } catch {}
}

async function renderEventsReminder() {
  const list = await api("/events/reminders");
  updateReminderBadge(list.length);
  const el = $("#events-reminder");
  if (!list.length) {
    el.hidden = true;
    return;
  }
  el.innerHTML = `
    <div class="meta"><strong>📅 Przypomnienia</strong>
      ${list.slice(0, 4).map((e) => `<div class="rem-item${e.state === "overdue" ? " overdue" : ""}">
        ${esc(e.title)} – <b>${whenLabel(e)}</b> (${formatDate(e.next_date)})${e.amount ? " · " + money(e.amount) : ""}</div>`).join("")}
      ${list.length > 4 ? `<div class="muted">i ${list.length - 4} więcej…</div>` : ""}
    </div>
    <button class="btn btn-small" type="button">Kalendarz ›</button>`;
  el.querySelector("button").addEventListener("click", () => show("kalendarz"));
  el.hidden = false;
}

// =====================================================================
// HISTORIA (miesiąc po miesiącu, wyszukiwanie, filtr kategorii, edycja)
// =====================================================================
let histMonth = monthKey(new Date());
let histKind = "all";
let histCategory = null;   // {kind, category} – ustawiane np. po stuknięciu kategorii na Pulpicie
let histSearchTimer;
const WEEKDAYS = ["niedz.", "pon.", "wt.", "śr.", "czw.", "pt.", "sob."];

$("#hist-prev").addEventListener("click", () => { histMonth = shiftMonth(histMonth, -1); loaders.historia(); });
$("#hist-next").addEventListener("click", () => { histMonth = shiftMonth(histMonth, 1); loaders.historia(); });
$("#hist-search").addEventListener("input", () => {
  clearTimeout(histSearchTimer);
  histSearchTimer = setTimeout(() => loaders.historia(), 250);
});
$$("#view-historia .periods button[data-filter]").forEach((b) =>
  b.addEventListener("click", () => {
    histKind = b.dataset.filter;
    setActive($$("#view-historia .periods button[data-filter]"), b);
    loaders.historia();
  })
);
$("#hist-cat-chip").addEventListener("click", () => {
  histCategory = null;
  loaders.historia();
});

/** Otwiera historię przefiltrowaną po kategorii (wszystkie miesiące). */
function openHistoryCategory(kind, category) {
  histCategory = { kind, category };
  histKind = kind;
  $("#hist-search").value = "";
  setActive($$("#view-historia .periods button[data-filter]"), $(`#view-historia [data-filter="${kind}"]`));
  show("historia");
}

/** Okno edycji wpisu: zmiana pól albo usunięcie (z możliwością cofnięcia). */
async function editTransaction(t) {
  const what = t.kind === "income" ? "przychód" : "wydatek";
  const data = await openDialog(`Edytuj ${what}`, `
    <label>Kwota (zł)
      <input name="amount" type="text" inputmode="decimal" value="${String(t.amount).replace(".", ",")}" required></label>
    <label>Kategoria <input name="category" list="all-categories" value="${esc(t.category)}" maxlength="50" required></label>
    <label>Opis <input name="description" value="${esc(t.description)}" maxlength="255"></label>
    <label>Data <input name="date" type="date" value="${t.date}" required></label>
    ${t.recurring_id ? '<p class="muted">To płatność stałej opłaty – po usunięciu będzie znowu „do zapłaty”.</p>' : ""}
    <label class="check"><input type="checkbox" name="delete"> Usuń ten ${what}</label>`, "Zapisz");
  if (!data) return;
  try {
    if (data.get("delete")) {
      await api(`${PATH[t.kind]}/${t.id}`, { method: "DELETE" });
      toast(`Usunięto ${what} ${money(t.amount)}`, "Cofnij", async () => {
        await api(PATH[t.kind], json("POST", {
          amount: t.amount, category: t.category, description: t.description, date: t.date,
        }));
        refreshView();
      });
    } else {
      const amount = parseAmount(data.get("amount"));
      if (!(amount > 0)) return toast("Podaj poprawną kwotę");
      await api(`${PATH[t.kind]}/${t.id}`, json("PATCH", {
        amount, category: data.get("category"), description: data.get("description"), date: data.get("date"),
      }));
      toast("Zapisano zmiany");
    }
  } catch (e) {
    toast("Błąd: " + e.message);
  }
  refreshView();
}

function refreshView() {
  const active = $$(".view").length && [...$$(".view")].find((v) => !v.hidden)?.id.replace("view-", "");
  if (active) loaders[active]?.()?.catch?.(() => {});
}

function historyItem(t) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "hist-item";
  b.innerHTML = `
    <span class="bill-ico">${icon(t.category)}</span>
    <span class="meta">
      <span class="title">${esc(t.description || t.category)}</span>
      <span class="sub">${t.description ? esc(t.category) : ""}${t.recurring_id ? " · 🧾 stała" : ""}</span>
    </span>
    <span class="amount ${t.kind}">${t.kind === "income" ? "+" : "−"}${money(t.amount)}</span>`;
  b.addEventListener("click", () => editTransaction(t));
  return b;
}

loaders.historia = async () => {
  const text = $("#hist-search").value.trim();
  const acrossMonths = !!(text || histCategory);
  const kinds = histKind === "all" ? ["expense", "income"] : [histKind];
  const [y, m] = histMonth.split("-").map(Number);
  const range = acrossMonths ? {} : { date_from: `${histMonth}-01`, date_to: `${histMonth}-${pad(new Date(y, m, 0).getDate())}` };

  $("#hist-month").textContent = acrossMonths ? "Wszystkie miesiące" : monthLabel(histMonth);
  $("#hist-prev").hidden = $("#hist-next").hidden = acrossMonths;
  const chip = $("#hist-cat-chip");
  chip.hidden = !histCategory;
  if (histCategory) chip.textContent = `${icon(histCategory.category)} ${histCategory.category} ✕`;

  const lists = await Promise.all(kinds
    .filter((k) => !histCategory || histCategory.kind === k)
    .map((k) => api(PATH[k] + qs({ ...range, q: text, category: histCategory?.category, limit: 1000 }))
      .then((l) => l.map((t) => ({ ...t, kind: k })))));
  const all = lists.flat().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));

  const inc = all.filter((t) => t.kind === "income").reduce((s, t) => s + t.amount, 0);
  const exp = all.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0);
  $("#hist-summary").textContent = all.length
    ? `${all.length} poz. · +${money(inc)} · −${money(exp)}` : "";

  const box = $("#history-list");
  box.innerHTML = "";
  if (!all.length) {
    box.innerHTML = `<div class="empty">${acrossMonths ? "Nic nie znaleziono." : "Brak wpisów w tym miesiącu."}</div>`;
    return;
  }
  let day = null, group = null;
  for (const t of all) {
    if (t.date !== day) {
      day = t.date;
      const items = all.filter((x) => x.date === day);
      const net = items.reduce((s, x) => s + (x.kind === "income" ? x.amount : -x.amount), 0);
      const d = new Date(`${day}T12:00:00`);
      group = document.createElement("div");
      group.className = "hist-day";
      group.innerHTML = `<div class="hist-day-head"><span>${WEEKDAYS[d.getDay()]} ${formatDate(day)}</span>
        <span>${signed(Math.round(net * 100) / 100)}</span></div>`;
      box.appendChild(group);
    }
    group.appendChild(historyItem(t));
  }
};

// =====================================================================
// PLAN: cele oszczędnościowe + limity
// =====================================================================
const GOAL_PRESETS = [["🏖️", "Wakacje"], ["🛟", "Poduszka finansowa"], ["🚗", "Samochód"], ["🏠", "Remont"],
  ["🎁", "Prezenty świąteczne"], ["🎓", "Edukacja"]];
const goalForm = $("#goal-form");

function renderGoalPresets() {
  const box = $("#goal-presets");
  box.innerHTML = "";
  for (const [ico, name] of GOAL_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${ico} ${name}`;
    b.addEventListener("click", async () => {
      goalForm.name.value = name;
      if (name === "Poduszka finansowa") {
        // Zasada: równowartość 3–6 miesięcy wydatków. Liczymy 3× średnia z ostatnich 3 pełnych miesięcy.
        const now = new Date();
        const bal = await api("/analytics/balance" + qs({
          date_from: iso(new Date(now.getFullYear(), now.getMonth() - 3, 1)),
          date_to: iso(new Date(now.getFullYear(), now.getMonth(), 0)),
        }));
        if (bal.expenses > 0) {
          goalForm.target.value = String(Math.round(bal.expenses)).replace(".", ",");
          toast("Podpowiedź: 3 miesiące Twoich wydatków");
        }
      }
      goalForm.target.focus();
    });
    box.appendChild(b);
  }
}
renderGoalPresets();

function goalItem(g) {
  const div = document.createElement("div");
  div.className = "goal" + (g.done ? " done" : "");
  const when = g.deadline ? ` · do ${formatDate(g.deadline)}` : "";
  const need = g.done ? "🎉 Cel osiągnięty!"
    : g.monthly_needed ? `Odkładaj ok. ${money(g.monthly_needed)} miesięcznie, żeby zdążyć`
      : `Brakuje ${money(g.remaining)}`;
  div.innerHTML = `
    <div class="budget-head"><span class="name">${esc(g.name)}</span>
      <span>${money(g.saved)} / ${money(g.target)}</span></div>
    <div class="budget-bar goal-bar"><div style="width:${g.percent}%"></div></div>
    <div class="budget-foot"><span>${g.percent}%${when}</span></div>
    <div class="goal-need">${need}</div>
    <div class="goal-actions">
      <button type="button" class="btn btn-small" data-act="in">+ Wpłać</button>
      <button type="button" class="btn btn-small btn-ghost" data-act="out">− Wypłać</button>
      <button type="button" class="icon-btn" data-act="edit" aria-label="Edytuj">✎</button>
    </div>`;
  const move = async (sign) => {
    const data = await openDialog(sign > 0 ? `Wpłata: ${g.name}` : `Wypłata: ${g.name}`,
      `<label>Kwota (zł) <input name="amount" type="text" inputmode="decimal" required></label>
       <p class="muted">Odłożone teraz: ${money(g.saved)}</p>`, sign > 0 ? "Wpłać" : "Wypłać");
    if (!data) return;
    const amount = parseAmount(data.get("amount"));
    if (!(amount > 0)) return toast("Podaj poprawną kwotę");
    try {
      const r = await api(`/goals/${g.id}/deposit`, json("POST", { amount: sign * amount }));
      toast(r.done && !g.done ? `🎉 Cel „${g.name}” osiągnięty!` : `Zapisano: ${money(r.saved)} odłożone`);
    } catch (e) {
      toast("Błąd: " + e.message);
    }
    loaders.plan();
  };
  div.querySelector('[data-act="in"]').addEventListener("click", () => move(1));
  div.querySelector('[data-act="out"]').addEventListener("click", () => move(-1));
  div.querySelector('[data-act="edit"]').addEventListener("click", async () => {
    const data = await openDialog("Edytuj cel", `
      <label>Na co? <input name="name" value="${esc(g.name)}" maxlength="100" required></label>
      <label>Kwota celu (zł) <input name="target" type="text" inputmode="decimal"
        value="${String(g.target).replace(".", ",")}" required></label>
      <label>Do kiedy <input name="deadline" type="date" value="${g.deadline || ""}"></label>
      <label class="check"><input type="checkbox" name="delete"> Usuń ten cel</label>`, "Zapisz");
    if (!data) return;
    try {
      if (data.get("delete")) {
        await api(`/goals/${g.id}`, { method: "DELETE" });
        toast("Usunięto cel");
      } else {
        await api(`/goals/${g.id}`, json("PATCH", {
          name: data.get("name"), target: parseAmount(data.get("target")), deadline: data.get("deadline") || null,
        }));
        toast("Zapisano");
      }
    } catch (e) {
      toast("Błąd: " + e.message);
    }
    loaders.plan();
  });
  return div;
}

goalForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const target = parseAmount(goalForm.target.value);
  const saved = goalForm.saved.value.trim() ? parseAmount(goalForm.saved.value) : 0;
  if (!(target > 0) || !(saved >= 0)) return toast("Podaj poprawne kwoty");
  try {
    await api("/goals", json("POST", {
      name: goalForm.name.value, target, saved, deadline: goalForm.deadline.value || null,
    }));
  } catch (e) {
    return toast("Błąd: " + e.message);
  }
  toast(`Dodano cel: ${goalForm.name.value}`);
  goalForm.reset();
  loaders.plan();
});

loaders.plan = async () => {
  const month = monthKey(new Date());
  $("#budget-month").textContent = monthLabel(month);
  fillDatalists().catch(() => {});
  const [goals, list] = await Promise.all([api("/goals"), api("/budgets/status" + qs({ month }))]);

  const gbox = $("#goal-list");
  gbox.innerHTML = goals.length ? "" : '<div class="empty">Brak celów. Dodaj np. wakacje albo poduszkę finansową poniżej.</div>';
  goals.forEach((g) => gbox.appendChild(goalItem(g)));

  const box = $("#budget-list");
  if (!list.length) {
    box.innerHTML = '<div class="empty">Brak limitów. Ustaw np. limit na jedzenie poniżej.</div>';
    return;
  }
  box.innerHTML = "";
  for (const b of list) {
    const state = b.exceeded ? "over" : b.used_percent >= 80 ? "warn" : "ok";
    const label = b.exceeded ? "⚠ Przekroczono o " + money(-b.remaining) : "Zostało " + money(b.remaining);
    const div = document.createElement("div");
    div.className = `budget ${state}`;
    div.innerHTML = `
      <div class="budget-head"><span class="name">${icon(b.category)} ${esc(b.category)}</span>
        <span>${money(b.spent)} / ${money(b.monthly_limit)}</span></div>
      <div class="budget-bar"><div style="width:${Math.min(b.used_percent, 100)}%"></div></div>
      <div class="budget-foot"><span>${label} · ${Math.round(b.used_percent)}%</span>
        <button type="button">Usuń</button></div>`;
    div.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`Usunąć limit „${b.category}”?`)) return;
      await api(`/budgets/${encodeURIComponent(b.category)}`, { method: "DELETE" });
      loaders.plan();
    });
    box.appendChild(div);
  }
};

$("#budget-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const limit = parseAmount(f.limit.value);
  if (!(limit > 0)) return toast("Podaj poprawny limit");
  try {
    await api(`/budgets/${encodeURIComponent(f.category.value.trim())}`, json("PUT", { monthly_limit: limit }));
  } catch (e) {
    return toast("Błąd: " + e.message);
  }
  f.reset();
  toast("Zapisano limit");
  loaders.plan();
});

// =====================================================================
// USTAWIENIA: kopia, kategorie, eksport/import, asystent
// =====================================================================
const BACKUP_KEY = "budzet-last-backup";
const ONBOARDING_KEY = "budzet-onboarding-hidden";
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

$("#settings-btn").addEventListener("click", () => show("ustawienia"));
$("#ai-settings-open").addEventListener("click", () => openAiSettings());

function saveBackup() {
  download(`budzet-kopia-${iso(new Date())}.json`, LocalApi.exportJson(), "application/json");
  lsSet(BACKUP_KEY, iso(new Date()));
  toast("Kopia zapisana w Pobranych – przenieś ją np. na Dysk Google");
}

loaders.ustawienia = async () => {
  renderSyncCard();
  const last = lsGet(BACKUP_KEY);
  $("#backup-last").textContent = last ? `Ostatnia kopia: ${formatDate(last)}` : "Nie zapisano jeszcze żadnej kopii.";
  const cats = await api("/categories");
  const ul = $("#category-admin");
  ul.innerHTML = cats.length ? "" : '<li class="empty">Brak kategorii – pojawią się po dodaniu wpisów.</li>';
  for (const c of cats) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" class="hist-item">
      <span class="bill-ico">${icon(c.category)}</span>
      <span class="meta"><span class="title">${esc(c.category)}</span>
        <span class="sub">${c.kind === "income" ? "przychody" : "wydatki"} · ${c.count} poz. · ${money(c.total)}</span></span>
      <span class="muted">✎</span></button>`;
    li.querySelector("button").addEventListener("click", async () => {
      const data = await openDialog(`Kategoria „${c.category}”`, `
        <label>Nowa nazwa <input name="to" list="all-categories" value="${esc(c.category)}" maxlength="50" required></label>
        <p class="muted">Jeśli wpiszesz nazwę istniejącej kategorii, obie zostaną połączone.
          Zmiana obejmie wszystkie wpisy, stałe opłaty, terminy i limity.</p>`, "Zmień");
      if (!data) return;
      try {
        const r = await api("/categories/rename", json("POST", { kind: c.kind, from: c.category, to: data.get("to") }));
        toast(`Zmieniono ${r.updated} poz.`);
      } catch (e) {
        toast("Błąd: " + e.message);
      }
      loaders.ustawienia();
    });
    ul.appendChild(li);
  }
  fillDatalists().catch(() => {});
};

// =====================================================================
// PULPIT: pierwsze kroki i przypomnienie o kopii
// =====================================================================
async function renderOnboarding() {
  const el = $("#onboarding");
  if (lsGet(ONBOARDING_KEY)) return (el.hidden = true);
  const [cats, bills, budgets, goals] = await Promise.all([
    api("/categories"), api("/recurring"), api("/budgets"), api("/goals"),
  ]);
  const steps = [
    ["Dodaj stały przychód (np. pensję)", bills.some((b) => b.kind === "income") || cats.some((c) => c.kind === "income"),
      () => { show("oplaty"); $('#recurring-form .segmented [data-kind="income"]').click(); }],
    ["Dodaj stałe opłaty (prąd, gaz, kredyt…)", bills.some((b) => b.kind === "expense"), () => show("oplaty")],
    ["Zapisz pierwszy wydatek", cats.some((c) => c.kind === "expense"), () => openAdd("expense")],
    ["Ustaw limit albo cel oszczędnościowy", budgets.length > 0 || goals.length > 0, () => show("plan")],
  ];
  if (LOCAL) steps.push(["Zapisz kopię zapasową", !!lsGet(BACKUP_KEY), () => show("ustawienia")]);
  const done = steps.filter((s) => s[1]).length;
  if (done === steps.length) return (el.hidden = true);
  el.innerHTML = `
    <div class="onb-head"><strong>👋 Pierwsze kroki</strong><span class="muted">${done}/${steps.length}</span></div>
    <ul class="onb-list">${steps.map(([label, ok], i) =>
      `<li class="${ok ? "ok" : ""}"><button type="button" data-step="${i}">${ok ? "✅" : "⬜"} ${label}</button></li>`).join("")}</ul>
    <button type="button" class="btn btn-small btn-ghost" id="onb-hide">Ukryj</button>`;
  el.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => steps[b.dataset.step][2]()));
  $("#onb-hide").addEventListener("click", () => { lsSet(ONBOARDING_KEY, "1"); el.hidden = true; });
  el.hidden = false;
}

async function renderBackupReminder() {
  const el = $("#backup-reminder");
  el.hidden = true;
  if (!LOCAL) return;
  const last = lsGet(BACKUP_KEY);
  const days = last ? Math.round((Date.now() - Date.parse(last)) / 86400000) : Infinity;
  if (days < 30) return;
  const count = (await api("/categories")).reduce((s, c) => s + c.count, 0);
  if (count < 10) return;
  el.innerHTML = `
    <div><strong>💾 Czas na kopię zapasową</strong>
      <div class="muted">${last ? `Ostatnia kopia ${days} dni temu.` : "Nie masz jeszcze żadnej kopii."}
        Dane są tylko w tym telefonie.</div></div>
    <button class="btn btn-small" type="button">Zapisz</button>`;
  el.querySelector("button").addEventListener("click", () => { saveBackup(); el.hidden = true; });
  el.hidden = false;
}

// =====================================================================
// Eksport i kopia zapasowa
// =====================================================================
function download(name, text, type) {
  // W aplikacji na Androida (APK) zapis do „Pobranych” robi system.
  if (window.AndroidBridge?.saveFile) {
    if (!window.AndroidBridge.saveFile(name, text, type)) toast("Nie udało się zapisać pliku");
    else toast(`Zapisano w Pobranych: ${name}`);
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvField = (v) => (/[;"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

async function fetchAll(path) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await api(path + qs({ limit: 1000, offset }));
    all.push(...page);
    if (page.length < 1000) break;
  }
  return all;
}

$("#export-csv").addEventListener("click", async () => {
  const [exp, inc] = await Promise.all([fetchAll("/expenses"), fetchAll("/incomes")]);
  const rows = [...exp.map((t) => ({ ...t, type: "wydatek" })), ...inc.map((t) => ({ ...t, type: "przychód" }))]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lines = ["date;type;amount;category;description"].concat(
    rows.map((t) => [t.date, t.type, t.amount.toFixed(2), t.category, t.description].map(csvField).join(";"))
  );
  download(`budzet-${iso(new Date())}.csv`, "﻿" + lines.join("\n") + "\n", "text/csv");
  toast(`Wyeksportowano ${rows.length} pozycji`);
});

if (LOCAL) {
  $$(".local-only").forEach((el) => (el.hidden = false));
  $("#backup-save").addEventListener("click", () => { saveBackup(); loaders.ustawienia(); });
  $("#backup-load").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file || !confirm("Przywrócenie kopii zastąpi wszystkie obecne dane. Kontynuować?")) return;
    try {
      LocalApi.importJson(await file.text());
      toast("Przywrócono kopię");
    } catch (e) {
      toast("Błąd: " + e.message);
    }
  });
  // Poproś przeglądarkę, żeby nie usuwała danych przy braku miejsca.
  navigator.storage?.persist?.();
}

// =====================================================================
// WSPÓLNY BUDŻET (synchronizacja między telefonami – sync.js)
// =====================================================================
const SYNC_HELP_URL = "https://github.com/radek874-ctrl/moj-projekt/blob/ccr-fb1dc182-da1ttq/sync/README.md";
const SYNC_ICON = { off: "", ok: "☁️", syncing: "🔄", error: "⚠️", offline: "📴" };

function updateSyncBadge() {
  const b = $("#sync-status");
  b.hidden = !Sync.enabled();
  b.textContent = SYNC_ICON[Sync.status] || "☁️";
  b.title = Sync.status === "error" ? "Błąd synchronizacji: " + Sync.lastError
    : Sync.status === "offline" ? "Brak internetu – zsynchronizuje się później" : "Wspólny budżet";
}

function renderSyncCard() {
  const box = $("#sync-body");
  if (!box) return;
  if (Sync.enabled()) {
    const st = Sync.state();
    const statusText = {
      ok: "✅ Zsynchronizowano", syncing: "🔄 Synchronizuję…", offline: "📴 Brak internetu – dane czekają w telefonie",
      error: "⚠️ " + Sync.lastError, off: "",
    }[Sync.status] || "";
    box.innerHTML = `
      <p>Ten telefon korzysta ze <strong>wspólnego budżetu</strong>. Zmiany z każdego telefonu
        trafiają do wszystkich (także te zrobione bez internetu – po połączeniu).</p>
      <p class="muted">${statusText}${st.lastSync ? ` · ostatnio ${new Date(st.lastSync).toLocaleString("pl-PL")}` : ""}</p>
      <button type="button" class="btn" id="sync-invite">👥 Zaproś osobę</button>
      <button type="button" class="btn btn-secondary" id="sync-now">🔄 Synchronizuj teraz</button>
      <button type="button" class="btn btn-ghost" id="sync-leave">Odłącz ten telefon</button>`;
    $("#sync-invite").addEventListener("click", shareInvite);
    $("#sync-now").addEventListener("click", async () => {
      const changed = await Sync.syncNow();
      toast(Sync.status === "ok" ? "Zsynchronizowano" : Sync.lastError || "Błąd");
      if (changed) refreshView();
    });
    $("#sync-leave").addEventListener("click", () => {
      if (!confirm("Odłączyć ten telefon od wspólnego budżetu? Dane zostaną w telefonie, ale przestaną się synchronizować.")) return;
      Sync.leave();
      renderSyncCard();
      updateSyncBadge();
    });
    return;
  }
  const cfg = Sync.config() || {};
  box.innerHTML = `
    <p>Prowadź jeden budżet razem z domownikami – każdy na swoim telefonie.</p>
    <label>Masz zaproszenie? Wklej link lub kod
      <input id="sync-code" placeholder="https://…#join=… albo kod" autocomplete="off">
    </label>
    <button type="button" class="btn" id="sync-join">Dołącz</button>
    <details class="sync-create">
      <summary>Załóż nowy wspólny budżet</summary>
      <p class="muted">Potrzebna jest darmowa baza Supabase (jednorazowo, ok. 5 minut) –
        <a href="${SYNC_HELP_URL}" target="_blank" rel="noopener">instrukcja krok po kroku</a>.
        Osoby, które zaprosisz, nie muszą nic konfigurować.</p>
      <label>Project URL <input id="sync-url" placeholder="https://xxxx.supabase.co" value="${esc(cfg.url || "")}" autocomplete="off"></label>
      <label>Klucz publiczny (publishable / anon) <input id="sync-key" placeholder="sb_publishable_… albo eyJ…" value="${esc(cfg.key || "")}" autocomplete="off"></label>
      <button type="button" class="btn btn-secondary" id="sync-create">Utwórz i wyślij dane z tego telefonu</button>
    </details>`;
  $("#sync-join").addEventListener("click", () => joinFromCode($("#sync-code").value));
  $("#sync-create").addEventListener("click", async () => {
    const url = $("#sync-url").value.trim(), key = $("#sync-key").value.trim();
    if (!/^https:\/\/.+/.test(url) || key.length < 20) return toast("Wpisz Project URL i klucz anon z Supabase");
    try {
      await Sync.create({ url, key });
      toast("Wspólny budżet utworzony – zaproś domowników");
      renderSyncCard();
      updateSyncBadge();
      shareInvite();
    } catch (e) {
      toast("Błąd: " + e.message);
    }
  });
}

async function shareInvite() {
  const link = Sync.inviteLink();
  const text = "Dołącz do naszego wspólnego budżetu domowego:";
  if (window.AndroidBridge?.share) {
    window.AndroidBridge.share("Budżet domowy", `${text} ${link}`);
    return;
  }
  try {
    if (navigator.share) {
      await navigator.share({ title: "Budżet domowy", text, url: link });
      return;
    }
  } catch (e) {
    if (e.name === "AbortError") return;
  }
  try {
    await navigator.clipboard.writeText(link);
    toast("Link zaproszenia skopiowany – wklej go np. w WhatsAppie");
  } catch {
    await openDialog("Link zaproszenia", `<textarea class="invite-text" readonly>${esc(link)}</textarea>`, "OK");
  }
}

async function joinFromCode(code) {
  let invite;
  try {
    invite = Sync.parseInvite(code);
  } catch {
    return toast("To nie wygląda na poprawne zaproszenie");
  }
  const snap = LocalApi.snapshot();
  const hasData = snap.expenses.length + snap.incomes.length + snap.recurring.length + snap.events.length + snap.goals.length > 0;
  const data = await openDialog("Dołączyć do wspólnego budżetu?", `
    <p>Od teraz wpisy z tego telefonu i od domowników będą wspólne.</p>
    <p class="muted">⚠️ Każdy, kto ma link zaproszenia, widzi i może zmieniać ten budżet – wysyłaj go tylko zaufanym osobom.</p>
    ${hasData ? `<label class="check"><input type="checkbox" name="merge" checked>
      Dodaj też moje dotychczasowe wpisy z tego telefonu</label>` : ""}`, "Dołącz");
  if (!data) return;
  try {
    await Sync.join(invite, hasData && data.get("merge") ? "merge" : "replace");
    toast("Dołączono do wspólnego budżetu 🎉");
    lsSet(ONBOARDING_KEY, "1");
    updateSyncBadge();
    if ($("#view-ustawienia").hidden) refreshView(); else renderSyncCard();
  } catch (e) {
    toast("Błąd: " + e.message);
  }
}

if (LOCAL) {
  $("#sync-card").hidden = false;
  $("#sync-status").addEventListener("click", () => show("ustawienia"));
  Sync.onStatus(() => { updateSyncBadge(); if (!$("#view-ustawienia").hidden) renderSyncCard(); });
  Sync.onRemoteChange = refreshView;
  LocalApi.onChange(() => Sync.scheduleSync());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") Sync.syncNow().then((changed) => changed && refreshView());
  });
  window.addEventListener("online", () => Sync.syncNow().then((changed) => changed && refreshView()));
  setInterval(() => {
    if (document.visibilityState === "visible") Sync.syncNow().then((changed) => changed && refreshView());
  }, 60000);
  updateSyncBadge();
  if (location.hash.startsWith("#join=")) {
    const code = location.hash;
    history.replaceState(null, "", location.pathname);
    setTimeout(() => joinFromCode(code), 300);
  } else {
    Sync.syncNow().then((changed) => changed && refreshView());
  }
}

// =====================================================================
// Instalacja (PWA)
// =====================================================================
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("#install-btn").hidden = false;
});
$("#install-btn").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $("#install-btn").hidden = true;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

show("pulpit");
