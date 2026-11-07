/* Open BIM Studio service worker: makes the app load and run offline once installed.
 * the BUILD string and the PRECACHE array are filled in by the build (vite.config.ts); in dev they stay
 * unset and the worker is not registered.
 *
 * Caching policy (v3) — mixed-version imports are worse than a slow reload:
 *   1. navigations            → network-first with cache:"reload" (never trust the HTTP cache
 *                               for the shell; a deployed page must never come back stale)
 *   2. immutable assets       → cache-first. Only URLs that change name when their bytes
 *                               change: hashed /assets/* output, /icons/* and the versioned
 *                               /web-ifc/<semver>/ folder that must match the bundled glue.
 *   3. everything else        → network-first, cache as offline fallback. Root /web-ifc/*
 *                               WASM files are MUTABLE (their bytes change when the web-ifc
 *                               pin moves), so they must never be served cache-first — a
 *                               stale 3-arg web-ifc.wasm paired with the 4-arg bundled glue
 *                               aborts every IFC import with
 *                               "BindingError: StreamMeshes called with 4 arguments, expected 3".
 */
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
  // account + cloud-project responses are private: never stored in the shared cache
  if (/^\/api\/(auth|cloud)\//.test(url.pathname)) return;

  if (req.mode === "navigate") {
    // app shell: always fresh from the network (cache:"reload" bypasses the HTTP
    // cache too), fall back to the cached shell only when offline
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: "reload" });
        const cache = await caches.open(CACHE);
        cache.put("/", res.clone());
        return res;
      } catch {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  // immutable: the URL changes whenever the bytes change, so cache-first is safe
  const p = url.pathname;
  const immutable = /^\/assets\//.test(p) || /^\/icons\//.test(p) || /^\/web-ifc\/\d+\.\d+\.\d+\//.test(p);
  if (immutable) {
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
    return;
  }

  // mutable static files + /api reads: network-first so updates always arrive,
  // remembered in the cache only as an offline fallback
  event.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: "no-cache" });
      if (res.ok && res.type === "basic") (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch {
      const cached = await caches.match(req, { ignoreVary: true });
      if (cached) return cached;
      return Response.error();
    }
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "obs-skip-waiting") self.skipWaiting();
});
