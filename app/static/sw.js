// Service worker: trzyma pliki aplikacji w pamięci podręcznej, żeby działała
// z ikony także bez internetu. Zapytania do API (tryb serwera) idą zawsze do sieci.
const CACHE = "wydatki-v8";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "config.js",
  "store.js",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];
const SHELL_URLS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  url.search = "";
  if (event.request.method !== "GET" || !SHELL_URLS.has(url.href)) return;

  // Najpierw sieć (świeża wersja), bez sieci - kopia z cache.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
