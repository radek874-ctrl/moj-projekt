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

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2500);
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
      <span class="hbar-value">${money(s.total)} · ${Math.round(s.share_percent)}%</span>
      <div class="hbar-track"><div class="hbar-fill fill-${kind}" style="width:${(100 * s.total) / max}%"></div></div>`;
    attachTip(row, `${s.category}: ${s.count} × śr. ${money(s.average)}`);
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
  await Promise.all([renderEventsReminder(), renderBillsReminder(), renderInsights()]);
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
    fc.innerHTML = `
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
async function knownCategories(kind) {
  const used = (await api("/analytics/by-category" + qs({ kind }))).map((c) => c.category);
  const presets = CATEGORIES[kind].map(([c]) => c);
  return [...new Set([...presets, ...used])];
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
    b.innerHTML = `<span class="cat-ico">${icon(c)}</span><span class="cat-name">${esc(c)}</span>`;
    b.addEventListener("click", () => {
      txForm.category.value = c;
      clearCategoryHint();
      grid.querySelectorAll(".cat").forEach((x) => x.classList.toggle("active", x === b));
    });
    grid.appendChild(b);
  }
}

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
  await renderCategoryGrid();
  txForm.amount.focus();
};

txForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const amount = parseAmount(txForm.amount.value);
  if (!(amount > 0)) return toast("Podaj poprawną kwotę");
  try {
    await api(PATH[txKind], json("POST", {
      amount,
      category: txForm.category.value,
      description: txForm.description.value,
      date: txForm.date.value,
    }));
  } catch (e) {
    return toast("Błąd: " + e.message);
  }
  toast(`${txKind === "income" ? "Przychód" : "Wydatek"} zapisany: ${money(amount)}`);
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
// HISTORIA (wydatki i przychody razem)
// =====================================================================
const PAGE = 50;
let historyFilter = "all";
let historyShown = PAGE;

$$("#view-historia .periods button").forEach((b) =>
  b.addEventListener("click", () => {
    historyFilter = b.dataset.filter;
    setActive($$("#view-historia .periods button"), b);
    historyShown = PAGE;
    loaders.historia();
  })
);

function historyItem(t) {
  const li = document.createElement("li");
  li.innerHTML = `
    <span class="bill-ico">${icon(t.category)}</span>
    <div class="meta">
      <div class="title">${esc(t.description || t.category)}</div>
      <div class="sub">${t.description ? esc(t.category) + " · " : ""}${formatDate(t.date)}</div>
    </div>
    <span class="amount ${t.kind}">${t.kind === "income" ? "+" : "−"}${money(t.amount)}</span>
    <button class="del" aria-label="Usuń">✕</button>`;
  li.querySelector(".del").addEventListener("click", async () => {
    const what = t.kind === "income" ? "przychód" : "wydatek";
    if (!confirm(`Usunąć ${what} ${money(t.amount)} (${t.category})?`)) return;
    await api(`${PATH[t.kind]}/${t.id}`, { method: "DELETE" });
    li.remove();
    toast("Usunięto");
  });
  return li;
}

loaders.historia = async () => {
  const kinds = historyFilter === "all" ? ["expense", "income"] : [historyFilter];
  // Pobieramy o jeden więcej, żeby wiedzieć, czy jest następna strona.
  const lists = await Promise.all(kinds.map((k) =>
    api(PATH[k] + qs({ limit: Math.min(historyShown + 1, 1000) })).then((l) => l.map((t) => ({ ...t, kind: k })))));
  const all = lists.flat().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const ul = $("#history-list");
  ul.innerHTML = all.length ? "" : '<li class="empty">Nic tu jeszcze nie ma.</li>';
  all.slice(0, historyShown).forEach((t) => ul.appendChild(historyItem(t)));
  $("#load-more").hidden = all.length <= historyShown;
};
$("#load-more").addEventListener("click", () => {
  historyShown += PAGE;
  loaders.historia();
});

// =====================================================================
// LIMITY (budżety)
// =====================================================================
loaders.budzety = async () => {
  const month = monthKey(new Date());
  $("#budget-month").textContent = monthLabel(month);
  fillDatalists().catch(() => {});
  const list = await api("/budgets/status" + qs({ month }));
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
      loaders.budzety();
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
  loaders.budzety();
});

// =====================================================================
// Eksport i kopia zapasowa
// =====================================================================
function download(name, text, type) {
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
  $("#backup-save").addEventListener("click", () =>
    download(`budzet-kopia-${iso(new Date())}.json`, LocalApi.exportJson(), "application/json")
  );
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
