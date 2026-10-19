"use strict";

// =====================================================================
// Wspólny budżet na kilku telefonach (synchronizacja przez Supabase).
//
// Każdy telefon trzyma pełną kopię danych (działa też bez internetu).
// Synchronizacja: pobierz wersję ze wspólnej bazy → połącz ze swoimi zmianami
// (scalanie trójstronne względem ostatnio zsynchronizowanego stanu) → zapisz,
// o ile w międzyczasie nikt inny nie zapisał (inaczej powtórz).
// Konfiguracja bazy: sync/supabase-setup.sql.
// =====================================================================

const SyncMerge = (() => {
  const COLLECTIONS = ["expenses", "incomes", "recurring", "events", "goals"];
  // Porównanie niezależne od kolejności pól (baza jsonb zmienia kolejność kluczy).
  const canon = (v) => (Array.isArray(v) ? v.map(canon)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
  const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

  /** Scalanie jednego rekordu: L (ten telefon), R (wspólna baza), B (stan po ostatniej synchronizacji). */
  function pick(b, l, r) {
    if (same(l, r)) return l;
    if (same(l, b)) return r;   // tu bez zmian → bierzemy wersję z bazy (także usunięcie)
    if (same(r, b)) return l;   // w bazie bez zmian → bierzemy lokalną zmianę
    // Zmienione w obu miejscach: edycja wygrywa z usunięciem, a przy dwóch edycjach – lokalna.
    if (l === undefined) return r;
    return l;
  }

  function mergeById(base = [], local = [], remote = []) {
    const index = (arr) => new Map(arr.map((x) => [x.id, x]));
    const B = index(base), L = index(local), R = index(remote);
    const ids = new Set([...L.keys(), ...R.keys(), ...B.keys()]);
    const out = [];
    for (const id of ids) {
      const v = pick(B.get(id), L.get(id), R.get(id));
      if (v !== undefined) out.push(v);
    }
    // Stała kolejność: tak jak w bazie, potem nowe lokalne.
    const order = new Map([...remote, ...local].map((x, i) => [x.id, i]));
    return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  function mergeMap(base = {}, local = {}, remote = {}) {
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])) {
      const v = pick(base[k], local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  function merge3(base, local, remote) {
    base = base || {};
    const out = {};
    for (const c of COLLECTIONS) out[c] = mergeById(base[c], local[c], remote[c]);
    out.budgets = mergeMap(base.budgets, local.budgets, remote.budgets);
    return out;
  }

  return { merge3, same };
})();

const Sync = (() => {
  const CONFIG_KEY = "budzet-sync-config";   // {url, key} – projekt Supabase
  const STATE_KEY = "budzet-sync-state";     // {id, secret, version, base, lastSync}
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  let running = null;
  let again = false;
  let timer = null;
  let status = "off";   // off | ok | syncing | error | offline
  let lastError = "";
  const statusListeners = [];

  const config = () => ls.get(CONFIG_KEY);
  const state = () => ls.get(STATE_KEY);
  const enabled = () => !!(config()?.url && config()?.key && state()?.id);

  function setStatus(s, err = "") {
    status = s;
    lastError = err;
    statusListeners.forEach((fn) => fn(status, lastError));
  }

  async function rpc(fn, args, cfg = config()) {
    const url = cfg.url.replace(/\/+$/, "") + "/rest/v1/rpc/" + fn;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: cfg.key,
          "Content-Type": "application/json",
          // Starszy klucz „anon” to token JWT i idzie też w Authorization; nowy „publishable” – tylko w apikey.
          ...(cfg.key.startsWith("eyJ") ? { Authorization: `Bearer ${cfg.key}` } : {}),
        },
        body: JSON.stringify(args),
      });
    } catch {
      const e = new Error("Brak połączenia z internetem");
      e.offline = true;
      throw e;
    }
    if (!res.ok) {
      let msg = `${res.status}`;
      try { const b = await res.json(); msg = b.message || b.hint || msg; } catch {}
      if (res.status === 404) msg = "Baza nie jest skonfigurowana (uruchom supabase-setup.sql)";
      if (res.status === 401) msg = "Nieprawidłowy klucz Supabase";
      throw new Error(msg);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  function randomString(len) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    return Array.from(bytes, (b) => chars[b % chars.length]).join("");
  }

  /** Jedna runda synchronizacji (z ponowieniem przy jednoczesnym zapisie z innego telefonu). */
  async function syncOnce() {
    const st = state();
    for (let attempt = 0; attempt < 5; attempt++) {
      const localAtStart = LocalApi.snapshot();
      const remote = await rpc("budget_get", { p_id: st.id, p_secret: st.secret });
      if (!remote) throw new Error("Nie znaleziono wspólnego budżetu albo klucz jest nieprawidłowy");
      const merged = SyncMerge.merge3(st.base, localAtStart, remote.data);
      let version = remote.version;
      if (!SyncMerge.same(merged, remote.data)) {
        version = await rpc("budget_put", { p_id: st.id, p_secret: st.secret, p_data: merged, p_version: remote.version });
        if (version == null) continue;  // ktoś zapisał w międzyczasie – jeszcze raz
      }
      // Zmiany zrobione na tym telefonie w trakcie synchronizacji nakładamy na wynik.
      const localNow = LocalApi.snapshot();
      const result = SyncMerge.merge3(localAtStart, localNow, merged);
      if (!SyncMerge.same(result, localNow)) LocalApi.replaceData(result);
      ls.set(STATE_KEY, { ...st, version, base: merged, lastSync: new Date().toISOString() });
      return { changedLocally: !SyncMerge.same(localAtStart, merged), pending: !SyncMerge.same(result, merged) };
    }
    throw new Error("Zbyt wiele jednoczesnych zmian – spróbuj za chwilę");
  }

  /** Synchronizuje teraz (kolejne wywołania w trakcie łączą się w jedno). */
  async function syncNow() {
    if (!enabled()) return null;
    if (running) {
      again = true;
      return running;
    }
    setStatus("syncing");
    running = (async () => {
      let refresh = false;
      try {
        do {
          again = false;
          const r = await syncOnce();
          refresh ||= r.changedLocally;
          if (r.pending) again = true;
        } while (again);
        setStatus("ok");
      } catch (e) {
        setStatus(e.offline ? "offline" : "error", e.message);
      } finally {
        running = null;
      }
      return refresh;
    })();
    return running;
  }

  /** Po każdej zmianie danych – synchronizacja po krótkiej przerwie. */
  function scheduleSync() {
    if (!enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => syncNow().then((changed) => changed && Sync.onRemoteChange?.()), 1500);
  }

  async function create(cfg) {
    const id = randomString(12);
    const secret = randomString(28);
    const data = LocalApi.snapshot();
    await rpc("budget_create", { p_id: id, p_secret: secret, p_data: data }, cfg);
    ls.set(CONFIG_KEY, cfg);
    ls.set(STATE_KEY, { id, secret, version: 1, base: data, lastSync: new Date().toISOString() });
    setStatus("ok");
  }

  /** Dołącza do istniejącego budżetu. mode: "merge" (połącz z danymi z tego telefonu) | "replace". */
  async function join(invite, mode) {
    const cfg = { url: invite.u, key: invite.k };
    const remote = await rpc("budget_get", { p_id: invite.i, p_secret: invite.s }, cfg);
    if (!remote) throw new Error("Zaproszenie jest nieprawidłowe albo budżet został usunięty");
    ls.set(CONFIG_KEY, cfg);
    if (mode === "replace") {
      LocalApi.replaceData(remote.data);
      ls.set(STATE_KEY, { id: invite.i, secret: invite.s, version: remote.version, base: remote.data, lastSync: new Date().toISOString() });
    } else {
      // Pusta baza odniesienia = suma danych z obu stron.
      ls.set(STATE_KEY, { id: invite.i, secret: invite.s, version: remote.version, base: {}, lastSync: null });
      await syncNow();
      if (status === "error") throw new Error(lastError);
    }
    setStatus("ok");
  }

  function leave() {
    ls.del(STATE_KEY);
    setStatus("off");
  }

  function inviteCode() {
    const st = state(), cfg = config();
    const json = JSON.stringify({ u: cfg.url, k: cfg.key, i: st.id, s: st.secret });
    return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function parseInvite(code) {
    const raw = String(code).trim().replace(/^.*#join=/, "");
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const inv = JSON.parse(decodeURIComponent(escape(atob(b64 + "===".slice((b64.length + 3) % 4)))));
    if (!inv.u || !inv.k || !inv.i || !inv.s) throw new Error("Niepełne zaproszenie");
    return inv;
  }

  function inviteLink() {
    return `${location.origin}${location.pathname}#join=${inviteCode()}`;
  }

  return {
    config, state, enabled, syncNow, scheduleSync, create, join, leave, inviteCode, inviteLink, parseInvite,
    onStatus: (fn) => statusListeners.push(fn),
    get status() { return status; },
    get lastError() { return lastError; },
    onRemoteChange: null,
  };
})();
