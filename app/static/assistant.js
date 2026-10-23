"use strict";

// =====================================================================
// Asystent AI (Claude) – czat po polsku nad danymi budżetu.
//
// Działa w przeglądarce z kluczem API użytkownika (zapisanym tylko w tym
// telefonie). Claude korzysta z narzędzi, które wołają to samo API co reszta
// aplikacji (LocalApi albo serwer). Każdy zapis (nowy wydatek, opłacenie
// rachunku, nowy termin) wymaga potwierdzenia przez użytkownika.
// =====================================================================

const AI_KEY_STORAGE = "budzet-ai-key";
const AI_MODEL_STORAGE = "budzet-ai-model";
const AI_SDK_URL = "vendor/anthropic-sdk.js";

// Ceny w USD za 1 mln tokenów (wejście / wyjście) – do orientacyjnego kosztu odpowiedzi.
const AI_MODELS = {
  "claude-opus-5-5": { label: "Claude Opus 5.5 – najmądrzejszy", price: [4, 20], fallback: true },
  "claude-sonnet-5-5": { label: "Claude Sonnet 5.5 – szybszy, tańszy", price: [2, 10], fallback: true },
  "claude-haiku-5-5": { label: "Claude Haiku 5.5 – najtańszy", price: [0.1, 0.5], fallback: false },
};
const AI_DEFAULT_MODEL = "claude-opus-5-5";
const AI_MAX_STEPS = 10;

const aiStore = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};

let aiHistory = [];     // pełna historia rozmowy (z blokami narzędzi i myślenia) – tylko dopisywana
let aiBusy = false;
let aiSdkPromise = null;

function loadSdk() {
  if (window.Anthropic) return Promise.resolve(window.Anthropic);
  aiSdkPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = AI_SDK_URL;
    s.onload = () => resolve(window.Anthropic);
    s.onerror = () => {
      aiSdkPromise = null;
      reject(new Error("Nie udało się wczytać modułu AI – sprawdź internet."));
    };
    document.head.appendChild(s);
  });
  return aiSdkPromise;
}

// ---------------------------------------------------------------------
// Narzędzia dla Claude
// ---------------------------------------------------------------------
const DATE = { type: "string", description: "Data RRRR-MM-DD" };
const MONTH = { type: "string", description: "Miesiąc RRRR-MM" };
const KIND = { type: "string", enum: ["expense", "income"], description: "expense = wydatki, income = przychody" };

const AI_TOOLS = [
  {
    name: "get_balance",
    description: "Bilans: suma przychodów, wydatków, różnica i stopa oszczędności w okresie, także w podziale na miesiące. Bez dat = cała historia.",
    input_schema: { type: "object", properties: { date_from: DATE, date_to: DATE } },
  },
  {
    name: "get_categories",
    description: "Sumy w kategoriach (z udziałem %) dla wydatków albo przychodów w okresie.",
    input_schema: { type: "object", properties: { kind: KIND, date_from: DATE, date_to: DATE }, required: ["kind"] },
  },
  {
    name: "list_transactions",
    description: "Lista pojedynczych wydatków albo przychodów (najnowsze pierwsze), z filtrami.",
    input_schema: {
      type: "object",
      properties: {
        kind: KIND, date_from: DATE, date_to: DATE,
        category: { type: "string", description: "Kategoria (małymi literami)" },
        q: { type: "string", description: "Szukaj w opisie i kategorii, np. „orlen”" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Ile pozycji (domyślnie 50)" },
      },
      required: ["kind"],
    },
  },
  {
    name: "get_insights",
    description: "Prognoza bilansu na koniec bieżącego miesiąca oraz automatyczne podpowiedzi (zagrożone limity, skoki wydatków, nietypowe wydatki, nadchodzące koszty, oszczędzanie).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_bills",
    description: "Stałe opłaty i stałe przychody (np. prąd, gaz, kredyt, pensja) ze statusem: czy w danym miesiącu już zapłacone. Zwraca id potrzebne do pay_bill.",
    input_schema: { type: "object", properties: { month: MONTH } },
  },
  {
    name: "get_events",
    description: "Ważne terminy z kalendarza (OC, przegląd, podatki...) z liczbą dni do terminu i stanem.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_budgets",
    description: "Miesięczne limity wydatków na kategorie: ile wydano, ile zostało, czy przekroczono.",
    input_schema: { type: "object", properties: { month: MONTH } },
  },
  {
    name: "get_goals",
    description: "Cele oszczędnościowe: kwota celu, odłożone, postęp %, termin i ile odkładać miesięcznie.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_report",
    description: "NAJWAŻNIEJSZE narzędzie doradcy: pełny raport kondycji finansów za miesiąc. Zawiera przychody/wydatki miesiąca i poprzedniego, średnie z 3 pełnych miesięcy (basis_months), podział potrzeby/przyjemności/oszczędności (50/30/20), koszty stałe, raty względem przychodów (DTI), poduszkę finansową w miesiącach wydatków, kategorie z odchyleniem od normy (usual = średnia z 3 poprzednich miesięcy), ocenę 0–100 z rozbiciem na składniki i gotowe rekomendacje z kwotami. Użyj na start każdej analizy i pytań typu „jak stoję z finansami”.",
    input_schema: {
      type: "object",
      properties: {
        month: { ...MONTH, description: "Miesiąc RRRR-MM (domyślnie bieżący, niepełny)" },
        savings: { type: "number", description: "Oszczędności poza aplikacją w zł (konto oszczędnościowe, lokaty), jeśli użytkownik je podał – doliczane do poduszki" },
      },
    },
  },
  {
    name: "get_trends",
    description: "Trendy: sumy każdej kategorii w kolejnych miesiącach (ostatni = bieżący, niepełny), średnia z pełnych miesięcy, nachylenie (zł/miesiąc) i kierunek up/down/flat/new. Do pytań „co rośnie”, „jak zmieniały się wydatki”.",
    input_schema: { type: "object", properties: { kind: KIND, months: { type: "integer", minimum: 3, maximum: 24, description: "Ile miesięcy (domyślnie 6)" } } },
  },
  {
    name: "compare_months",
    description: "Porównanie dwóch miesięcy w kategoriach (od największej zmiany). Domyślnie poprzedni (a) vs bieżący (b).",
    input_schema: { type: "object", properties: { a: MONTH, b: MONTH, kind: KIND } },
  },
  {
    name: "get_merchants",
    description: "Wpisy zgrupowane po opisie (sklep, firma): liczba, suma, średnia, ostatnia data – gdzie idzie najwięcej pieniędzy.",
    input_schema: { type: "object", properties: { kind: KIND, date_from: DATE, date_to: DATE, limit: { type: "integer", minimum: 1, maximum: 100 } } },
  },
  {
    name: "get_subscriptions",
    description: "Wykryte regularne płatności z ostatnich 12 miesięcy (abonamenty, raty, rachunki) wpisywane ręcznie: typowa kwota, koszt roczny, czy kwota stała (fixed_amount), czy nadal aktywne i czy są już na liście stałych opłat (registered). Do szukania oszczędności i porządkowania stałych opłat.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_patterns",
    description: "Nawyki zakupowe (domyślnie ostatnie 90 dni): wydatki wg dnia tygodnia, udział weekendu, części miesiąca (np. dużo zaraz po wypłacie), drobne zakupy poniżej progu (efekt „kawy na mieście”), średnia transakcja i dzienna.",
    input_schema: { type: "object", properties: { date_from: DATE, date_to: DATE, small_limit: { type: "number", description: "Próg drobnego wydatku w zł (domyślnie 50)" } } },
  },
  {
    name: "add_transaction",
    description: "Zapisuje nowy wydatek albo przychód. Aplikacja pokaże użytkownikowi okno potwierdzenia przed zapisem.",
    input_schema: {
      type: "object",
      properties: {
        kind: KIND,
        amount: { type: "number", description: "Kwota w złotych, dodatnia, maks. 2 miejsca po przecinku" },
        category: { type: "string", description: "Kategoria, najlepiej jedna z istniejących" },
        description: { type: "string", description: "Krótki opis, np. nazwa sklepu" },
        date: { type: "string", description: "Data RRRR-MM-DD (domyślnie dziś)" },
      },
      required: ["kind", "amount", "category"],
    },
  },
  {
    name: "pay_bill",
    description: "Oznacza stałą opłatę (lub stały przychód) jako zapłaconą w danym miesiącu – tworzy odpowiedni wpis. Wymaga potwierdzenia użytkownika.",
    input_schema: {
      type: "object",
      properties: {
        recurring_id: { type: "integer", description: "id z get_bills" },
        month: MONTH,
        amount: { type: "number", description: "Kwota, jeśli inna niż typowa" },
      },
      required: ["recurring_id"],
    },
  },
  {
    name: "add_event",
    description: "Dodaje ważny termin do kalendarza z przypomnieniem. Wymaga potwierdzenia użytkownika.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: DATE,
        repeat: { type: "string", enum: ["none", "monthly", "yearly"] },
        remind_days: { type: "integer", minimum: 0, maximum: 60, description: "Ile dni wcześniej przypomnieć (domyślnie 7)" },
        amount: { type: "number", description: "Przewidywany koszt (opcjonalnie)" },
        category: { type: "string", description: "Kategoria wydatku przy opłaceniu (opcjonalnie)" },
        note: { type: "string" },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "set_budget",
    description: "Ustawia (lub zmienia) miesięczny limit wydatków na kategorię. Wymaga potwierdzenia użytkownika.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string" }, monthly_limit: { type: "number", description: "Limit w zł" } },
      required: ["category", "monthly_limit"],
    },
  },
  {
    name: "add_goal",
    description: "Tworzy cel oszczędnościowy (np. poduszka finansowa, wakacje). Wymaga potwierdzenia użytkownika.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        target: { type: "number", description: "Kwota celu w zł" },
        saved: { type: "number", description: "Ile już odłożono (opcjonalnie)" },
        deadline: DATE,
      },
      required: ["name", "target"],
    },
  },
  {
    name: "add_bill",
    description: "Dodaje stałą opłatę lub stały przychód (np. wykryty abonament z get_subscriptions), żeby był w prognozach i przypomnieniach. Wymaga potwierdzenia użytkownika.",
    input_schema: {
      type: "object",
      properties: {
        kind: KIND,
        name: { type: "string", description: "Nazwa, np. Netflix" },
        category: { type: "string" },
        amount: { type: "number", description: "Typowa kwota w zł" },
        day: { type: "integer", minimum: 1, maximum: 28, description: "Dzień miesiąca płatności" },
      },
      required: ["name", "category", "amount"],
    },
  },
];

const TOOL_LABELS = {
  get_balance: "sprawdzam bilans",
  get_categories: "liczę kategorie",
  list_transactions: "przeglądam wpisy",
  get_insights: "liczę prognozę",
  get_bills: "sprawdzam stałe opłaty",
  get_events: "zaglądam do kalendarza",
  get_budgets: "sprawdzam limity",
  get_goals: "sprawdzam cele",
  add_transaction: "zapis wpisu",
  pay_bill: "opłacenie rachunku",
  add_event: "nowy termin",
  get_report: "analizuję kondycję finansów",
  get_trends: "sprawdzam trendy",
  compare_months: "porównuję miesiące",
  get_merchants: "sprawdzam sklepy i firmy",
  get_subscriptions: "szukam stałych płatności",
  get_patterns: "badam nawyki zakupowe",
  set_budget: "ustawienie limitu",
  add_goal: "nowy cel",
  add_bill: "nowa stała opłata",
};

const AI_WRITE_TOOLS = new Set(["add_transaction", "pay_bill", "add_event", "set_budget", "add_goal", "add_bill"]);
const KIND_PL = { expense: "Wydatek", income: "Przychód" };

/** Pyta użytkownika o zgodę na zapis. Zwraca true/false. */
async function confirmWrite(title, rows) {
  const body = `<dl class="ai-confirm">${rows.filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <p class="muted">Asystent chce to zapisać. Sprawdź dane.</p>`;
  return (await openDialog(title, body, "Zapisz")) !== null;
}

async function runTool(name, input) {
  const p = input || {};
  switch (name) {
    case "get_balance":
      return api("/analytics/balance" + qs({ date_from: p.date_from, date_to: p.date_to }));
    case "get_categories":
      return api("/analytics/by-category" + qs({ kind: p.kind, date_from: p.date_from, date_to: p.date_to }));
    case "list_transactions":
      return api(PATH[p.kind === "income" ? "income" : "expense"] + qs({
        date_from: p.date_from, date_to: p.date_to, category: p.category, q: p.q, limit: Math.min(p.limit || 50, 200),
      }));
    case "get_insights":
      return api("/analytics/insights");
    case "get_bills":
      return api("/recurring" + qs({ month: p.month }));
    case "get_events":
      return api("/events");
    case "get_goals":
      return api("/goals");
    case "get_budgets":
      return api("/budgets/status" + qs({ month: p.month }));
    case "get_report":
      return api("/analytics/report" + qs({ month: p.month, savings: p.savings }));
    case "get_trends":
      return api("/analytics/trends" + qs({ kind: p.kind, months: p.months }));
    case "compare_months":
      return api("/analytics/compare" + qs({ a: p.a, b: p.b, kind: p.kind }));
    case "get_merchants":
      return api("/analytics/merchants" + qs({ kind: p.kind, date_from: p.date_from, date_to: p.date_to, limit: p.limit }));
    case "get_subscriptions":
      return api("/analytics/subscriptions");
    case "get_patterns":
      return api("/analytics/patterns" + qs({ date_from: p.date_from, date_to: p.date_to, small_limit: p.small_limit }));
    case "set_budget": {
      const ok = await confirmWrite("Limit wydatków – zapisać?", [
        ["Kategoria", p.category], ["Limit miesięczny", money(p.monthly_limit)],
      ]);
      if (!ok) return { cancelled: true, message: "Użytkownik anulował." };
      const cat = String(p.category || "").trim().toLowerCase();
      return { saved: await api(`/budgets/${encodeURIComponent(cat)}`, json("PUT", { monthly_limit: p.monthly_limit })) };
    }
    case "add_goal": {
      const ok = await confirmWrite("Nowy cel – zapisać?", [
        ["Cel", p.name], ["Kwota", money(p.target)], ["Odłożone", p.saved ? money(p.saved) : ""],
        ["Termin", p.deadline ? formatDate(p.deadline) : ""],
      ]);
      if (!ok) return { cancelled: true, message: "Użytkownik anulował." };
      return { saved: await api("/goals", json("POST", { name: p.name, target: p.target, saved: p.saved || 0, deadline: p.deadline || null })) };
    }
    case "add_bill": {
      const kind = p.kind === "income" ? "income" : "expense";
      const ok = await confirmWrite(`${kind === "income" ? "Stały przychód" : "Stała opłata"} – zapisać?`, [
        ["Nazwa", p.name], ["Kategoria", p.category], ["Kwota", money(p.amount)], ["Dzień miesiąca", p.day || 10],
      ]);
      if (!ok) return { cancelled: true, message: "Użytkownik anulował." };
      return { saved: await api("/recurring", json("POST", { kind, name: p.name, category: p.category, amount: p.amount, day: p.day || 10 })) };
    }
    case "add_transaction": {
      const date = p.date || iso(new Date());
      const ok = await confirmWrite(`${KIND_PL[p.kind] || "Wpis"} – zapisać?`, [
        ["Kwota", money(p.amount)], ["Kategoria", p.category], ["Opis", p.description], ["Data", formatDate(date)],
      ]);
      if (!ok) return { cancelled: true, message: "Użytkownik anulował zapis." };
      const saved = await api(PATH[p.kind === "income" ? "income" : "expense"], json("POST", {
        amount: p.amount, category: p.category, description: p.description || "", date,
      }));
      return { saved };
    }
    case "pay_bill": {
      const month = p.month || monthKey(new Date());
      const bill = (await api("/recurring" + qs({ month }))).find((r) => r.id === p.recurring_id);
      if (!bill) return { error: "Nie ma stałej opłaty o takim id." };
      const ok = await confirmWrite(`${bill.name} – oznaczyć jako zapłacone?`, [
        ["Miesiąc", monthLabel(month)], ["Kwota", money(p.amount ?? bill.amount)],
      ]);
      if (!ok) return { cancelled: true, message: "Użytkownik anulował." };
      return { saved: await api(`/recurring/${bill.id}/pay`, json("POST", { month, amount: p.amount ?? bill.amount })) };
    }
    case "add_event": {
      const ok = await confirmWrite("Nowy termin – zapisać?", [
        ["Co", p.title], ["Kiedy", formatDate(p.date)], ["Powtarzaj", REPEAT_LABEL[p.repeat || "none"]],
        ["Przypomnienie", `${p.remind_days ?? 7} dni wcześniej`], ["Kwota", p.amount ? money(p.amount) : ""],
      ]);
      if (!ok) return { cancelled: true, message: "Użytkownik anulował." };
      return { saved: await api("/events", json("POST", { remind_days: 7, ...p })) };
    }
    default:
      return { error: `Nieznane narzędzie ${name}` };
  }
}

// ---------------------------------------------------------------------
// Rozmowa
// ---------------------------------------------------------------------
function systemPrompt() {
  const now = new Date();
  const weekday = now.toLocaleDateString("pl-PL", { weekday: "long" });
  const cats = [...CATEGORIES.expense.map(([c]) => c)].join(", ");
  const incs = [...CATEGORIES.income.map(([c]) => c)].join(", ");
  return `Jesteś doradcą finansowym i analitykiem budżetu domowego w aplikacji „Budżet domowy” na telefonie. Masz wgląd w dane użytkownika przez narzędzia: analizujesz wydatki i przychody, oceniasz kondycję finansów, szukasz oszczędności, planujesz i zapisujesz wpisy.

Dziś jest ${weekday}, ${iso(now)}. Waluta: złoty (zł).

Jak analizujesz (metoda specjalisty):
- Ogólne pytania o finanse („jak stoję”, „co poprawić”, „przeanalizuj”) zaczynaj od get_report. Potem dobierz narzędzia do pytania: get_trends (co rośnie w czasie), compare_months (skąd różnica), get_merchants (gdzie konkretnie), get_subscriptions (stałe płatności i abonamenty), get_patterns (nawyki: weekendy, drobne zakupy, wydatki po wypłacie), list_transactions (szczegóły).
- Bieżący miesiąc jest niepełny – nie porównuj go wprost z pełnymi miesiącami; używaj prognozy z get_insights albo średnich z get_report (basis_months).
- Miary i progi, którymi się kierujesz:
  • stopa oszczędności: minimum 10%, dobrze 20% i więcej;
  • zasada 50/30/20: potrzeby do ~50%, przyjemności do ~30%, oszczędności co najmniej 20% przychodów;
  • poduszka finansowa: 3–6 miesięcy wydatków (w aplikacji = odłożone w celach; jeśli użytkownik poda oszczędności spoza aplikacji, przekaż je w parametrze savings);
  • raty kredytów (DTI) do 30% przychodów, powyżej 40% – sytuacja ryzykowna;
  • koszty stałe do ~50% przychodów.
- Kolejność priorytetów w radach: 1) nie wydawać więcej niż wpływa, 2) poduszka finansowa, 3) spłata drogich długów (karty, chwilówki, raty), 4) cele (wakacje, samochód), 5) dalsze oszczędzanie.
- Rady mają być konkretne, z kwotami z danych: „rozrywka: średnio 450 zł/mies.; ograniczenie do 300 zł da 1 800 zł rocznie”. Przeliczaj efekty roczne (×12). Wskazuj 2–3 najważniejsze rzeczy, nie wszystko naraz.
- Szukając oszczędności, sprawdź: abonamenty z get_subscriptions (czy wszystkie potrzebne), kategorie z trendem „up”, odchylenia od normy w get_report, drobne zakupy i weekendy w get_patterns, największych sprzedawców w get_merchants.
- Możesz od razu zaproponować działania i wykonać je narzędziami: limit na kategorię (set_budget), cel oszczędnościowy, np. poduszka (add_goal), dopisanie wykrytej stałej płatności do stałych opłat (add_bill), termin w kalendarzu (add_event).
- Pamiętaj o polskich realiach: rachunki za media (prąd, gaz, woda, ogrzewanie), czynsz, raty, OC i przegląd auta raz w roku, 800+, PIT i zwrot podatku wiosną, wydatki sezonowe (święta w grudniu, wakacje, wyprawka we wrześniu, ogrzewanie zimą) – uwzględniaj sezonowość przy porównaniach.

Zasady:
- Liczby bierz wyłącznie z narzędzi. Nigdy nie zgaduj kwot – jeśli czegoś nie wiesz, sprawdź narzędziem. Obliczenia (sumy, różnice, efekty roczne) rób starannie.
- Do zapisu używaj narzędzi add_transaction, pay_bill, add_event, set_budget, add_goal, add_bill. Aplikacja sama poprosi użytkownika o potwierdzenie, więc nie dopytuj o zgodę osobno; dopytaj tylko, gdy brakuje kwoty albo nie wiadomo, czy to wydatek, czy przychód.
- Jeśli użytkownik anuluje zapis, przyjmij to i nie ponawiaj.
- Przy rachunku za coś, co jest stałą opłatą (prąd, gaz, kredyt...), najpierw sprawdź get_bills i użyj pay_bill zamiast dodawać zwykły wydatek.
- Kategorie wydatków w aplikacji: ${cats} (można też inne). Kategorie przychodów: ${incs}. Kategorie zapisuj małymi literami.
- Ze zdjęcia paragonu odczytaj sklep, datę i sumę do zapłaty (nie pojedyncze pozycje), zaproponuj kategorię i zapisz jeden wydatek przez add_transaction. Jeśli zdjęcie jest nieczytelne, powiedz to.
- Odpowiadaj po polsku, krótko i konkretnie, jak w czacie na telefonie. Kwoty pisz jak „1 234,56 zł”. Możesz używać **pogrubienia** i krótkich list z myślnikami, bez tabel i nagłówków.
- Zwracaj się do użytkownika neutralnie, bez form zależnych od płci (np. „wydano”, „Twoje wydatki”, „możesz”).
- Prognoza z get_insights zawiera safe_daily – ile można wydawać dziennie do końca miesiąca; używaj jej przy pytaniach „ile mogę wydać”.
- Doradzasz w budżecie domowym: oszczędzanie, wydatki, długi, planowanie. Nie polecaj konkretnych instrumentów inwestycyjnych, banków ani produktów i nie udzielaj porad prawnych ani podatkowych – przy takich pytaniach podaj ogólne zasady i zasugeruj licencjonowanego doradcę.`;
}

function aiClient(Anthropic) {
  return new Anthropic({ apiKey: aiStore.get(AI_KEY_STORAGE), dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function requestParams() {
  const model = aiStore.get(AI_MODEL_STORAGE) || AI_DEFAULT_MODEL;
  const params = {
    model,
    max_tokens: 16000,
    system: systemPrompt(),
    tools: AI_TOOLS,
    messages: aiHistory,
    cache_control: { type: "ephemeral" },
    output_config: { effort: "low" },
  };
  // Gdy filtr bezpieczeństwa odrzuci prośbę, API samo ponowi ją na zalecanym modelu zapasowym.
  if (AI_MODELS[model]?.fallback) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

function costOf(usage, model) {
  const [pin, pout] = (AI_MODELS[model] || AI_MODELS[AI_DEFAULT_MODEL]).price;
  const input = (usage.input_tokens || 0) + 1.25 * (usage.cache_creation_input_tokens || 0) +
    0.1 * (usage.cache_read_input_tokens || 0);
  return (input * pin + (usage.output_tokens || 0) * pout) / 1e6;
}

function friendlyError(Anthropic, e) {
  if (Anthropic && e instanceof Anthropic.AuthenticationError) return "Nieprawidłowy klucz API. Sprawdź go w ustawieniach (⚙).";
  if (Anthropic && e instanceof Anthropic.PermissionDeniedError) return "Ten klucz API nie ma dostępu do wybranego modelu.";
  if (Anthropic && e instanceof Anthropic.RateLimitError) return "Za dużo zapytań naraz – spróbuj za chwilę.";
  if (Anthropic && e instanceof Anthropic.APIConnectionError) return "Brak połączenia z internetem.";
  if (Anthropic && e instanceof Anthropic.BadRequestError) {
    const msg = e.error?.error?.message || e.message || "";
    if (/credit|balance/i.test(msg)) return "Brak środków na koncie Anthropic – doładuj je w console.anthropic.com.";
    return "Błąd zapytania: " + msg;
  }
  if (Anthropic && e instanceof Anthropic.APIError && e.status >= 500) return "Serwer AI jest chwilowo niedostępny – spróbuj za chwilę.";
  return "Błąd: " + (e.message || e);
}

async function askAssistant(content) {
  if (aiBusy) return;
  if (!aiStore.get(AI_KEY_STORAGE)) {
    openAiSettings();
    return;
  }
  aiBusy = true;
  setAiBusy(true);
  const historyBefore = aiHistory.length;
  aiHistory.push({ role: "user", content });
  let Anthropic = null;
  let cost = 0;
  try {
    Anthropic = await loadSdk();
    const client = aiClient(Anthropic);
    for (let step = 0; step < AI_MAX_STEPS; step++) {
      const params = requestParams();
      const response = await client.beta.messages.create(params);
      cost += costOf(response.usage || {}, params.model);
      aiHistory.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) addAiMessage("assistant", block.text);
      }
      if (response.stop_reason === "refusal") {
        addAiMessage("note", "Asystent nie może pomóc w tej sprawie. Spróbuj zapytać inaczej.");
        break;
      }
      if (response.stop_reason === "max_tokens") {
        addAiMessage("note", "Odpowiedź była za długa i została ucięta.");
        break;
      }
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") break;

      const results = [];
      for (const block of response.content.filter((b) => b.type === "tool_use")) {
        addAiMessage("tool", `${TOOL_LABELS[block.name] || block.name}…`);
        try {
          const out = await runTool(block.name, block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out ?? null) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(e.message || e), is_error: true });
        }
      }
      aiHistory.push({ role: "user", content: results });
      // Odśwież widok, jeśli asystent coś zapisał.
      if (response.content.some((b) => b.type === "tool_use" && AI_WRITE_TOOLS.has(b.name))) {
        refreshCurrentView();
      }
    }
  } catch (e) {
    // Nieudana tura: wracamy do historii sprzed pytania (to wciąż poprawny początek
    // rozmowy), żeby można było po prostu zapytać ponownie.
    aiHistory.length = historyBefore;
    addAiMessage("error", friendlyError(Anthropic, e));
  } finally {
    if (cost > 0) addAiMessage("cost", `koszt ≈ $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`);
    aiBusy = false;
    setAiBusy(false);
  }
}

// ---------------------------------------------------------------------
// Interfejs czatu
// ---------------------------------------------------------------------
function renderAiText(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function addAiMessage(role, text, extraHtml = "") {
  const box = $("#ai-messages");
  $("#ai-welcome").hidden = true;
  const div = document.createElement("div");
  div.className = `ai-msg ai-${role}`;
  div.innerHTML = (role === "assistant" ? renderAiText(text) : esc(text)) + extraHtml;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setAiBusy(busy) {
  $("#ai-typing").hidden = !busy;
  $("#ai-send").disabled = busy;
  $("#ai-photo-btn").classList.toggle("disabled", busy);
  if (busy) $("#ai-messages").scrollTop = $("#ai-messages").scrollHeight;
}

function refreshCurrentView() {
  const active = document.querySelector(".tabbar button.active")?.dataset.view;
  if (active) loaders[active]?.()?.catch?.(() => {});
}

function openAssistant() {
  $("#ai-panel").hidden = false;
  document.body.classList.add("ai-open");
  if (!aiStore.get(AI_KEY_STORAGE)) openAiSettings();
  else setTimeout(() => $("#ai-input").focus(), 50);
  loadSdk().catch(() => {});
}

function closeAssistant() {
  $("#ai-panel").hidden = true;
  document.body.classList.remove("ai-open");
}

async function openAiSettings() {
  const model = aiStore.get(AI_MODEL_STORAGE) || AI_DEFAULT_MODEL;
  const hasKey = !!aiStore.get(AI_KEY_STORAGE);
  const data = await openDialog("Ustawienia asystenta AI", `
    <p class="muted">Asystent korzysta z Claude (Anthropic). Potrzebny jest własny klucz API –
      załóż konto na <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>,
      doładuj konto i utwórz klucz w zakładce „API Keys”.</p>
    <label>Klucz API
      <input name="key" type="password" autocomplete="off" placeholder="${hasKey ? "zapisany – wpisz nowy, aby zmienić" : "sk-ant-..."}">
    </label>
    <label>Model
      <select name="model">${Object.entries(AI_MODELS).map(([id, m]) =>
        `<option value="${id}"${id === model ? " selected" : ""}>${m.label}</option>`).join("")}</select>
    </label>
    <p class="muted">Płacisz za użycie: zwykle ułamek centa do kilku centów za pytanie (koszt widać pod każdą odpowiedzią).<br>
      Klucz jest zapisany tylko w tym telefonie. Pytania i potrzebne do odpowiedzi dane budżetu są wysyłane do Anthropic.</p>
    ${hasKey ? '<label class="check"><input type="checkbox" name="forget"> Usuń zapisany klucz z telefonu</label>' : ""}`,
  "Zapisz");
  if (!data) return;
  if (data.get("forget")) {
    aiStore.remove(AI_KEY_STORAGE);
    toast("Klucz usunięty");
    return;
  }
  const key = String(data.get("key") || "").trim();
  if (key) aiStore.set(AI_KEY_STORAGE, key);
  aiStore.set(AI_MODEL_STORAGE, data.get("model"));
  if (!aiStore.get(AI_KEY_STORAGE)) return toast("Wpisz klucz API, aby korzystać z asystenta");
  toast("Zapisano ustawienia asystenta");
  $("#ai-input").focus();
}

/** Zmniejsza zdjęcie (dłuższy bok maks. 1568 px) i zwraca blok obrazu dla Claude. */
function imageBlockFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      resolve({ block: { type: "image", source: { type: "base64", media_type: "image/jpeg", data: dataUrl.split(",")[1] } }, dataUrl });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Nie udało się odczytać zdjęcia"));
    };
    img.src = url;
  });
}

function initAssistant() {
  $("#ai-fab").addEventListener("click", openAssistant);
  $("#ai-close").addEventListener("click", closeAssistant);
  $("#ai-settings").addEventListener("click", openAiSettings);
  $("#ai-new").addEventListener("click", () => {
    if (aiBusy) return;
    aiHistory = [];
    $("#ai-messages").innerHTML = "";
    $("#ai-welcome").hidden = false;
  });

  $("#ai-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = $("#ai-input").value.trim();
    if (!text || aiBusy) return;
    $("#ai-input").value = "";
    addAiMessage("user", text);
    askAssistant(text);
  });

  $$("#ai-welcome [data-ask]").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.ask === "photo") return $("#ai-photo").click();
    $("#ai-input").value = b.dataset.ask;
    $("#ai-form").requestSubmit();
  }));

  $("#ai-photo-btn").addEventListener("click", () => {
    if (!aiBusy) $("#ai-photo").click();
  });
  $("#ai-photo").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    try {
      const { block, dataUrl } = await imageBlockFromFile(file);
      const note = $("#ai-input").value.trim();
      $("#ai-input").value = "";
      addAiMessage("user", note || "Zdjęcie paragonu", `<img class="ai-photo" src="${dataUrl}" alt="zdjęcie">`);
      askAssistant([block, { type: "text", text: note || "To zdjęcie paragonu. Zapisz go jako wydatek." }]);
    } catch (e) {
      toast(e.message);
    }
  });
}

initAssistant();
