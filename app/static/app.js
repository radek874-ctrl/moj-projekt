"use strict";

// ---------- narzędzia ----------
const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const money = (v) => fmt.format(v || 0);
const MONTHS = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
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

async function api(path, options = {}) {
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

const qs = (params) =>
  "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();

// ---------- nawigacja ----------
const loaders = {};

function show(view) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  loaders[view]?.()?.catch?.((e) => {
    if ($("#offline").hidden) toast("Błąd: " + e.message);
  });
  window.scrollTo(0, 0);
}

document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

// ---------- tooltip ----------
const tip = $("#tooltip");
function attachTip(el, text) {
  const open = () => {
    const r = el.getBoundingClientRect();
    tip.textContent = text;
    tip.hidden = false;
    const x = Math.min(Math.max(r.left + r.width / 2, 80), window.innerWidth - 80);
    tip.style.left = `${x}px`;
    tip.style.top = `${r.top}px`;
  };
  el.addEventListener("pointerenter", open);
  el.addEventListener("click", open);
  el.addEventListener("pointerleave", () => (tip.hidden = true));
}
document.addEventListener("scroll", () => (tip.hidden = true), { passive: true });

// ---------- analiza ----------
let period = "month";

function periodRange(p) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (p) {
    case "month": return { date_from: iso(new Date(y, m, 1)), date_to: iso(now) };
    case "prev": return { date_from: iso(new Date(y, m - 1, 1)), date_to: iso(new Date(y, m, 0)) };
    case "3m": return { date_from: iso(new Date(y, m - 2, 1)), date_to: iso(now) };
    case "year": return { date_from: iso(new Date(y, 0, 1)), date_to: iso(now) };
    default: return {};
  }
}

document.querySelectorAll(".periods button").forEach((b) =>
  b.addEventListener("click", () => {
    period = b.dataset.period;
    document.querySelectorAll(".periods button").forEach((x) => x.classList.toggle("active", x === b));
    loaders.analiza();
  })
);

function renderCategories(stats) {
  const box = $("#chart-categories");
  if (!stats.length) {
    box.innerHTML = '<div class="empty">Brak wydatków w tym okresie.</div>';
    return;
  }
  const max = stats[0].total;
  box.innerHTML = "";
  for (const s of stats) {
    const row = document.createElement("div");
    row.className = "hbar";
    row.innerHTML = `
      <span class="hbar-label">${esc(s.category)}</span>
      <span class="hbar-value">${money(s.total)} · ${s.share_percent.toLocaleString("pl-PL")}%</span>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(100 * s.total) / max}%"></div></div>`;
    attachTip(row, `${s.category}: ${s.count} × śr. ${money(s.average)}`);
    box.appendChild(row);
  }
}

function renderMonthly(rows) {
  // Zawsze ostatnie 12 miesięcy, także te bez wydatków.
  const now = new Date();
  const byMonth = Object.fromEntries(rows.map((r) => [r.month, r]));
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = monthKey(d);
    months.push({ key, label: MONTHS[d.getMonth()], ...(byMonth[key] || { total: 0, count: 0 }) });
  }
  const max = Math.max(...months.map((m) => m.total), 1);
  const box = $("#chart-monthly");
  box.innerHTML = "";
  const axis = document.createElement("div");
  axis.className = "col-axis";
  months.forEach((m, i) => {
    const col = document.createElement("div");
    col.className = "col" + (i === months.length - 1 ? " current" : "");
    col.innerHTML = `<div class="col-fill" style="height:${(100 * m.total) / max}%"></div>`;
    const change = m.change_percent != null ? ` (${m.change_percent > 0 ? "+" : ""}${m.change_percent}%)` : "";
    attachTip(col, `${m.label} ${m.key.slice(0, 4)}: ${money(m.total)}${change}`);
    box.appendChild(col);
    axis.insertAdjacentHTML("beforeend", `<span>${m.label}</span>`);
  });
  box.nextElementSibling?.classList.contains("col-axis") && box.nextElementSibling.remove();
  box.after(axis);
}

function expenseItem(e, withDelete) {
  const li = document.createElement("li");
  li.innerHTML = `
    <div class="meta">
      <div class="title">${esc(e.description || e.category)}</div>
      <div class="sub">${e.description ? esc(e.category) + " · " : ""}${formatDate(e.date)}</div>
    </div>
    <span class="amount">${money(e.amount)}</span>
    ${withDelete ? '<button class="del" aria-label="Usuń">✕</button>' : ""}`;
  if (withDelete) {
    li.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`Usunąć wydatek ${money(e.amount)} (${e.category})?`)) return;
      await api(`/expenses/${e.id}`, { method: "DELETE" });
      li.remove();
      toast("Usunięto");
    });
  }
  return li;
}

loaders.analiza = async () => {
  const range = periodRange(period);
  const now = new Date();
  const yearAgo = iso(new Date(now.getFullYear(), now.getMonth() - 11, 1));
  const [summary, cats, monthly, top] = await Promise.all([
    api("/analytics/summary" + qs(range)),
    api("/analytics/by-category" + qs(range)),
    api("/analytics/monthly" + qs({ date_from: yearAgo })),
    api("/analytics/top" + qs({ ...range, limit: 5 })),
  ]);
  $("#sum-total").textContent = money(summary.total);
  $("#sum-daily").textContent = money(summary.daily_average);
  $("#sum-count").textContent = summary.count;
  renderCategories(cats);
  renderMonthly(monthly);
  const list = $("#top-list");
  list.innerHTML = top.length ? "" : '<li class="empty">Brak wydatków.</li>';
  top.forEach((e) => list.appendChild(expenseItem(e, false)));
};

// ---------- kategorie (podpowiedzi) ----------
async function loadCategories() {
  const cats = await api("/analytics/by-category");
  $("#categories").innerHTML = cats.map((c) => `<option value="${esc(c.category)}">`).join("");
  const chips = $("#category-chips");
  chips.innerHTML = "";
  cats.slice(0, 6).forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c.category;
    b.addEventListener("click", () => ($("#expense-form").category.value = c.category));
    chips.appendChild(b);
  });
}

// ---------- dodawanie ----------
const form = $("#expense-form");
form.date.value = iso(new Date());

loaders.dodaj = () => {
  loadCategories().catch(() => {});
  form.amount.focus();
};

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const amount = parseAmount(form.amount.value);
  if (!(amount > 0)) return toast("Podaj poprawną kwotę");
  try {
    await api("/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount,
        category: form.category.value,
        description: form.description.value,
        date: form.date.value,
      }),
    });
  } catch (e) {
    return toast("Błąd: " + e.message);
  }
  toast(`Zapisano ${money(amount)}`);
  form.amount.value = "";
  form.description.value = "";
  form.amount.focus();
  loadCategories().catch(() => {});
});

const importForm = $("#import-form");
importForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const data = new FormData(importForm);
  try {
    const r = await api("/expenses/import", { method: "POST", body: data });
    $("#import-result").innerHTML =
      `Zaimportowano: ${r.imported}` + (r.errors.length ? `<br>Błędy:<br>${r.errors.map(esc).join("<br>")}` : "");
    importForm.reset();
  } catch (e) {
    $("#import-result").textContent = "Błąd: " + e.message;
  }
});

// ---------- lista ----------
const PAGE = 50;
let listOffset = 0;

async function loadList(reset) {
  if (reset) {
    listOffset = 0;
    $("#expense-list").innerHTML = "";
  }
  const items = await api("/expenses" + qs({ limit: PAGE, offset: listOffset }));
  const ul = $("#expense-list");
  if (reset && !items.length) ul.innerHTML = '<li class="empty">Nie masz jeszcze żadnych wydatków.</li>';
  items.forEach((e) => ul.appendChild(expenseItem(e, true)));
  listOffset += items.length;
  $("#load-more").hidden = items.length < PAGE;
}
loaders.lista = () => loadList(true);
$("#load-more").addEventListener("click", () => loadList(false));

// ---------- budżety ----------
loaders.budzety = async () => {
  const month = monthKey(new Date());
  const [y, m] = month.split("-").map(Number);
  $("#budget-month").textContent = `${MONTHS[m - 1]} ${y}`;
  loadCategories().catch(() => {});
  const list = await api("/budgets/status" + qs({ month }));
  const box = $("#budget-list");
  if (!list.length) {
    box.innerHTML = '<div class="empty">Brak budżetów. Ustaw limit poniżej.</div>';
    return;
  }
  box.innerHTML = "";
  for (const b of list) {
    const state = b.exceeded ? "over" : b.used_percent >= 80 ? "warn" : "ok";
    const label = b.exceeded ? "⚠ Przekroczono o " + money(-b.remaining) : "Zostało " + money(b.remaining);
    const div = document.createElement("div");
    div.className = `budget ${state}`;
    div.innerHTML = `
      <div class="budget-head"><span class="name">${esc(b.category)}</span>
        <span>${money(b.spent)} / ${money(b.monthly_limit)}</span></div>
      <div class="budget-bar"><div style="width:${Math.min(b.used_percent, 100)}%"></div></div>
      <div class="budget-foot"><span>${label} · ${Math.round(b.used_percent)}%</span>
        <button type="button">Usuń</button></div>`;
    div.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`Usunąć budżet „${b.category}”?`)) return;
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
    await api(`/budgets/${encodeURIComponent(f.category.value.trim())}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_limit: limit }),
    });
  } catch (e) {
    return toast("Błąd: " + e.message);
  }
  f.reset();
  toast("Zapisano limit");
  loaders.budzety();
});

// ---------- instalacja (PWA) ----------
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
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// start
show("analiza");
