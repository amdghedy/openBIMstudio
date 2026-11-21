/* Service-worker offline policy test (differentiation item 4).
 *
 * Runs the REAL public/sw.js in a vm sandbox with a fake
 * ServiceWorkerGlobalScope (CacheStorage, fetch, Request/Response) and
 * drives its install / activate / fetch handlers. No mocks of the product
 * logic: the worker source itself executes; only the platform APIs are
 * faked, and they are faithful Map-backed implementations of the Cache
 * Storage surface the worker uses.
 *
 * The build-artifact checks at the end run only when dist/sw.js exists
 * (i.e. after `npm run build`); they assert the vite plugin stamped the
 * web-ifc pin and kept versioned WASM out of the per-build precache.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const root = path.join(__dirname, "..");
const swSrc = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");

const ORIGIN = "http://localhost:3000";

class FakeResponse {
  constructor(body, opts = {}) {
    this.body = body;
    this.ok = opts.ok !== false;
    this.status = opts.status ?? 200;
    this.type = opts.type ?? "basic";
    this.url = opts.url ?? "";
  }
  clone() { return new FakeResponse(this.body, { ok: this.ok, status: this.status, type: this.type, url: this.url }); }
}
class FakeRequest {
  constructor(url, opts = {}) {
    this.url = url;
    this.method = opts.method ?? "GET";
    this.mode = opts.mode ?? "no-cors";
  }
}
class FakeCache {
  constructor() { this.entries = new Map(); }
  _key(req) { return typeof req === "string" ? req : req.url; }
  async match(req) { return this.entries.get(this._key(req)) ?? undefined; }
  async put(req, res) { this.entries.set(this._key(req), res); }
  async add(req) {
    const res = await this._fetch(req);
    await this.put(req, res);
  }
  async addAll(urls) { for (const u of urls) await this.add(u); }
  async delete(req) { return this.entries.delete(this._key(req)); }
  async keys() { return [...this.entries.keys()].map((url) => new FakeRequest(url)); }
}
class FakeCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return this.caches.get(name);
  }
  async keys() { return [...this.caches.keys()]; }
  async delete(name) { return this.caches.delete(name); }
  async match(req) {
    for (const c of this.caches.values()) {
      const hit = await c.match(req);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** Build one sandboxed worker instance. `online` controls the fake fetch. */
function makeWorker({ build = "testbuild1", webIfcVersion = "0.0.77", precache = [], online = true } = {}) {
  const listeners = {};
  const caches = new FakeCacheStorage();
  let claimed = false;
  let fetchCalls = [];
  const sandbox = {
    console,
    caches,
    self: null,
    Response: { error: () => new FakeResponse("error", { ok: false, status: 0 }) },
    URL,
    fetch: async (req) => {
      const url = typeof req === "string" ? req : req.url;
      fetchCalls.push(url);
      if (!online) throw new Error("network offline");
      return new FakeResponse("bytes:" + url, { url });
    },
  };
  sandbox.self = {
    location: { origin: ORIGIN },
    clients: { claim: async () => { claimed = true; } },
    skipWaiting: () => {},
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  // Cache.add needs the fake fetch; bind it after the storage exists.
  const origOpen = caches.open.bind(caches);
  caches.open = async (name) => {
    const c = await origOpen(name);
    c._fetch = sandbox.fetch;
    return c;
  };
  const src = swSrc
    .replace("__OBS_BUILD__", build)
    .replace("__OBS_WEB_IFC_VERSION__", webIfcVersion)
    .replace("/*__OBS_PRECACHE__*/ []", JSON.stringify(precache));
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "sw.js" });
  const waitUntils = [];
  const dispatch = async (type, event) => {
    const fns = listeners[type] || [];
    for (const fn of fns) fn(event);
    const pending = waitUntils.splice(0);
    await Promise.all(pending);
  };
  const eventWithWait = () => {
    const e = {};
    e.waitUntil = (p) => { waitUntils.push(Promise.resolve(p)); };
    return e;
  };
  const fetchEvent = (req) => {
    const e = { request: req };
    let responsePromise = null;
    e.respondWith = (p) => { responsePromise = Promise.resolve(p); };
    return { e, response: () => responsePromise };
  };
  return {
    listeners, caches, fetchCalls,
    isClaimed: () => claimed,
    dispatchInstall: () => dispatch("install", eventWithWait()),
    dispatchActivate: () => dispatch("activate", eventWithWait()),
    dispatchFetch: async (req) => {
      const { e, response } = fetchEvent(req);
      await dispatch("fetch", e);
      return response() ? await response() : null;
    },
  };
}

(async () => {
  await t("install precaches the shell into the per-build cache", async () => {
    const w = makeWorker({ precache: ["/assets/app-abc.js"] });
    await w.dispatchInstall();
    const keys = await w.caches.keys();
    assert.deepStrictEqual(keys, ["obs-testbuild1"]);
    const cache = await w.caches.open("obs-testbuild1");
    for (const url of ["/", "/app.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/assets/app-abc.js"]) {
      assert.ok(await cache.match(url), "precache missing " + url);
    }
  });

  await t("activate deletes the old build cache and stale web-ifc caches, keeps the current version cache", async () => {
    const w = makeWorker();
    const oldBuild = await w.caches.open("obs-oldbuild");
    await oldBuild.put("/assets/old.js", new FakeResponse("old"));
    const stale = await w.caches.open("obs-webifc-0.0.76");
    await stale.put("http://localhost:3000/web-ifc/0.0.76/web-ifc.wasm", new FakeResponse("stale-wasm"));
    const current = await w.caches.open("obs-webifc-0.0.77");
    await current.put("http://localhost:3000/web-ifc/0.0.77/web-ifc.wasm", new FakeResponse("current-wasm"));
    await w.dispatchActivate();
    const keys = await w.caches.keys();
    assert.ok(!keys.includes("obs-oldbuild"), "old build cache survived: " + keys);
    assert.ok(!keys.includes("obs-webifc-0.0.76"), "stale web-ifc cache survived: " + keys);
    assert.ok(keys.includes("obs-webifc-0.0.77"), "current web-ifc cache deleted: " + keys);
    assert.ok(w.isClaimed(), "clients.claim not called");
  });

  await t("versioned web-ifc WASM is served offline from the version cache, not the build cache", async () => {
    const online = makeWorker();
    const res = await online.dispatchFetch(new FakeRequest(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm"));
    assert.ok(res && res.ok, "online versioned fetch failed");
    assert.ok(online.fetchCalls.includes(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm"), "online fetch did not hit network");
    const versionCache = await online.caches.open("obs-webifc-0.0.77");
    assert.ok(await versionCache.match(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm"), "WASM not stored in version cache");
    const buildCache = await online.caches.open("obs-testbuild1");
    assert.ok(!(await buildCache.match(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm")), "WASM leaked into the build cache");
    // Second worker, same cache storage contents, offline: the WASM must come from cache.
    const offline = makeWorker({ online: false });
    const offlineVersion = await offline.caches.open("obs-webifc-0.0.77");
    await offlineVersion.put(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm", new FakeResponse("cached-wasm"));
    const cached = await offline.dispatchFetch(new FakeRequest(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm"));
    assert.ok(cached && cached.body === "cached-wasm", "offline versioned fetch did not return the cached WASM");
    assert.strictEqual(offline.fetchCalls.length, 0, "offline fetch hit the network");
  });

  await t("root /web-ifc/ WASM stays network-first (mutable) with the build cache only as offline fallback", async () => {
    const online = makeWorker();
    const res = await online.dispatchFetch(new FakeRequest(ORIGIN + "/web-ifc/web-ifc.wasm"));
    assert.ok(res && res.ok, "online root fetch failed");
    const buildCache = await online.caches.open("obs-testbuild1");
    assert.ok(await buildCache.match(ORIGIN + "/web-ifc/web-ifc.wasm"), "root WASM not stored as offline fallback");
    const versionCache = await online.caches.open("obs-webifc-0.0.77");
    assert.ok(!(await versionCache.match(ORIGIN + "/web-ifc/web-ifc.wasm")), "mutable root WASM landed in the version cache");
    const offline = makeWorker({ online: false });
    const offlineBuild = await offline.caches.open("obs-testbuild1");
    await offlineBuild.put(ORIGIN + "/web-ifc/web-ifc.wasm", new FakeResponse("fallback-wasm"));
    const fallback = await offline.dispatchFetch(new FakeRequest(ORIGIN + "/web-ifc/web-ifc.wasm"));
    assert.ok(fallback && fallback.body === "fallback-wasm", "offline root fetch did not use the fallback");
  });

  await t("navigation is network-first with the cached shell as the offline fallback", async () => {
    const online = makeWorker();
    const shell = await online.caches.open("obs-testbuild1");
    await shell.put("/", new FakeResponse("cached-shell"));
    const res = await online.dispatchFetch(new FakeRequest(ORIGIN + "/", { mode: "navigate" }));
    assert.ok(res && res.body.startsWith("bytes:"), "online navigation did not fetch fresh");
    const offline = makeWorker({ online: false });
    const offlineShell = await offline.caches.open("obs-testbuild1");
    await offlineShell.put("/", new FakeResponse("cached-shell"));
    const cached = await offline.dispatchFetch(new FakeRequest(ORIGIN + "/", { mode: "navigate" }));
    assert.ok(cached && cached.body === "cached-shell", "offline navigation did not serve the cached shell");
  });

  await t("hashed /assets/ stay cache-first in the per-build cache", async () => {
    const online = makeWorker();
    const first = await online.dispatchFetch(new FakeRequest(ORIGIN + "/assets/app-abc.js"));
    assert.ok(first && first.ok, "first asset fetch failed");
    assert.strictEqual(online.fetchCalls.filter((u) => u.endsWith("/assets/app-abc.js")).length, 1);
    const second = await online.dispatchFetch(new FakeRequest(ORIGIN + "/assets/app-abc.js"));
    assert.ok(second && second.ok, "second asset fetch failed");
    assert.strictEqual(online.fetchCalls.filter((u) => u.endsWith("/assets/app-abc.js")).length, 1, "cache-first asset re-fetched");
  });

  await t("unversioned worker (placeholder pin) falls back to the build cache and never deletes version caches", async () => {
    // Simulate the dev source: the placeholder was never replaced.
    const src = swSrc
      .replace("__OBS_BUILD__", "devbuild")
      .replace("/*__OBS_PRECACHE__*/ []", JSON.stringify([]));
    assert.ok(src.includes('"__OBS_WEB_IFC_VERSION__"'), "test setup: placeholder unexpectedly replaced");
    const w = makeWorker({ build: "devbuild", webIfcVersion: "__OBS_WEB_IFC_VERSION__" });
    const kept = await w.caches.open("obs-webifc-0.0.77");
    await kept.put(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm", new FakeResponse("kept-wasm"));
    await w.dispatchActivate();
    assert.ok((await w.caches.keys()).includes("obs-webifc-0.0.77"), "activate deleted a version cache it could not identify");
    const res = await w.dispatchFetch(new FakeRequest(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm"));
    assert.ok(res && res.ok, "unversioned versioned fetch failed");
    const buildCache = await w.caches.open("obs-devbuild");
    assert.ok(await buildCache.match(ORIGIN + "/web-ifc/0.0.77/web-ifc.wasm"), "unversioned WASM did not fall back to the build cache");
  });

  await t("pwa boot checks for worker updates on return to the tab (no 24 h throttle gap)", async () => {
    // The browser's automatic update check is throttled; the app must call
    // registration.update() itself or a redeploy sits unnoticed for a day.
    // Behaviour is proven by the offline-first e2e (phase B); this pins the
    // wiring so a refactor cannot silently drop it.
    const pwa = fs.readFileSync(path.join(root, "src/core/pwa.ts"), "utf8");
    assert.ok(pwa.includes("reg.update()"), "pwa.ts never calls registration.update()");
    assert.ok(pwa.includes("visibilitychange"), "pwa.ts has no visibilitychange update check");
    assert.ok(pwa.includes('"focus"') || pwa.includes("'focus'"), "pwa.ts has no focus update check");
    // And the registration must not depend on a load event that boot already missed.
    assert.ok(pwa.includes('document.readyState === "complete"'), "pwa.ts still waits for a load event that may already have fired");
  });

  await t("built dist/sw.js stamps the pin and keeps versioned WASM out of the precache (when a build exists)", async () => {
    const distSw = path.join(root, "dist", "sw.js");
    if (!fs.existsSync(distSw)) {
      console.log("    (skip: no dist/sw.js — run `npm run build` first)");
      return;
    }
    const built = fs.readFileSync(distSw, "utf8");
    assert.ok(!built.includes("__OBS_WEB_IFC_VERSION__"), "built sw.js still has the version placeholder");
    assert.ok(!built.includes("__OBS_BUILD__"), "built sw.js still has the build placeholder");
    const precacheJson = built.match(/const PRECACHE = (\[[^\]]*\]);/);
    assert.ok(precacheJson, "built sw.js has no PRECACHE assignment");
    const list = JSON.parse(precacheJson[1]);
    assert.ok(list.length > 50, "precache unexpectedly small: " + list.length);
    const versioned = list.filter((f) => /^\/web-ifc\/\d+\.\d+\.\d+\//.test(f));
    assert.deepStrictEqual(versioned, [], "versioned web-ifc files in the per-build precache: " + versioned.slice(0, 3));
    const pinned = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "web-ifc", "package.json"), "utf8")).version;
    assert.ok(built.includes(`const WEB_IFC_VERSION = "${pinned}"`),
      "built sw.js does not stamp the pinned web-ifc version " + pinned);
  });

  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})();
