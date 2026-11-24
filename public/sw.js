/* Open BIM Studio service worker: makes the app load and run offline once installed.
 * the BUILD string and the PRECACHE array are filled in by the build (vite.config.ts); in dev they stay
 * unset and the worker is not registered.
 *
 * Caching policy (v4) — mixed-version imports are worse than a slow reload:
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
 *
 * Versioned WASM lives in its own cache (v4): the BUILD cache rotates on
 * every build (its name hashes the file list + the build time), so before
 * v4 an unchanged web-ifc pin still forced a full 23 MB WASM re-download on
 * every redeploy. The versioned folder's URL already encodes the pin, so
 * its bytes are immutable for a given version — it is cached under
 * `obs-webifc-<version>`, which survives app rebuilds and is only evicted
 * when the pin itself moves (activate deletes obs-webifc-* caches whose
 * version differs from the build's pin). A pin move still fetches the new
 * WASM once (new URL, cache miss) — that part is unavoidable and correct.
 */
const BUILD = "__OBS_BUILD__";
const WEB_IFC_VERSION = "__OBS_WEB_IFC_VERSION__";
const PRECACHE = /*__OBS_PRECACHE__*/ [];
const CACHE = "obs-" + BUILD;
const WEBIFC_CACHE = "obs-webifc-" + WEB_IFC_VERSION;
const SHELL = ["/", "/app.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

// True only once the build has stamped the real web-ifc pin into this file
// (vite.config.ts). In dev the placeholder stays and the worker is never
// registered anyway, so the version cache is never used unversioned.
// (startsWith, not a comparison against the placeholder literal: the build
// replaces every occurrence, so the literal must not appear here.)
const WEBIFC_KNOWN = !WEB_IFC_VERSION.startsWith("__OBS_");

function isVersionedWebIfc(pathname) {
  return /^\/web-ifc\/\d+\.\d+\.\d+\//.test(pathname);
}

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
    for (const key of await caches.keys()) {
      if (!key.startsWith("obs-")) continue;
      if (key === CACHE) continue;
      // The version cache survives app rebuilds by design — only a pin move
      // evicts it, and only when this build knows its own pin.
      if (key === WEBIFC_CACHE) continue;
      if (key.startsWith("obs-webifc-")) {
        if (WEBIFC_KNOWN) await caches.delete(key);
        continue;
      }
      await caches.delete(key);
    }
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
  // Auth and other API routes are never handled here. A top-level navigation to
  // /api/auth/google/start answers with a redirect to Google; the app-shell branch
  // below cannot cache a redirect, throws, and would serve the cached home page
  // instead, so Google sign-in never leaves the app. Let the browser own /api.
  if (url.pathname.startsWith("/api/")) return;

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
  const immutable = /^\/assets\//.test(p) || /^\/icons\//.test(p) || isVersionedWebIfc(p);
  if (immutable) {
    // Versioned web-ifc WASM goes to the version cache, not the BUILD cache,
    // so it survives app rebuilds (see the v4 note above). Every other
    // immutable asset stays in the per-build cache.
    const cacheName = isVersionedWebIfc(p) && WEBIFC_KNOWN ? WEBIFC_CACHE : CACHE;
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(req, { ignoreVary: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok && res.type === "basic") cache.put(req, res.clone());
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
