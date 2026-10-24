/* Open BIM Studio service worker: makes the app load and run offline once installed.
 * the BUILD string and the PRECACHE array are filled in by the build (vite.config.ts); in dev they stay
 * unset and the worker is not registered. */
const BUILD = "__OBS_BUILD__";
const PRECACHE = /*__OBS_PRECACHE__*/ [];
const CACHE = "obs-" + BUILD;
const SHELL = ["/", "/app.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // the shell must succeed; everything else is fetched in the background so install stays fast
    await cache.addAll(SHELL);
    self.skipWaiting();
    (async () => {
      for (const url of PRECACHE) {
        try { if (!(await cache.match(url))) await cache.add(url); } catch { /* keep going */ }
      }
    })();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("obs-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // local AI proxies and the dev server are never cached
  if (/^\/(ollama|lmstudio|anthropic)\//.test(url.pathname)) return;

  if (req.mode === "navigate") {
    // app shell: try the network first so updates arrive, fall back to the cached shell offline
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put("/", res.clone());
        return res;
      } catch {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  // static files: cache first, then network (and remember it)
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreVary: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === "basic") (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch {
      return Response.error();
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "obs-skip-waiting") self.skipWaiting();
});
