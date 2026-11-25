/**
 * tests/fetch-sheet-ssrf.test.cjs
 * Draft cut-sheet link fetch (worker/fetch-sheet.ts): URL/host guards,
 * redirect handling, caps, auth, consent, same-origin, rate limit, and the
 * "disabled unless FETCH_SHEET_ENABLED" default. No network is used.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(root, ".fetch-sheet-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
process.on("exit", () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* */ } });
execSync("npx tsc worker/fetch-sheet.ts --outDir " + JSON.stringify(out)
  + " --module commonjs --target ES2022 --lib es2022,dom --skipLibCheck --noCheck", { cwd: root, stdio: "inherit", shell: true });
const F = require(path.join(out, "fetch-sheet.js"));

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }

const BAD = {
  "http://example.com/a.pdf": "not_https", "ftp://example.com/a.pdf": "not_https", "file:///etc/passwd": "not_https",
  "javascript:alert(1)": "not_https", "data:text/plain,hi": "not_https",
  "https://user:pw@example.com/a.pdf": "credentials_in_url", "https://user@example.com/a.pdf": "credentials_in_url",
  "https://example.com:8443/a.pdf": "bad_port", "https://example.com:80/a.pdf": "bad_port", "https://example.com:22/": "bad_port",
  "https://127.0.0.1/": "ip_literal", "https://10.0.0.5/": "ip_literal", "https://192.168.1.1/": "ip_literal",
  "https://172.16.0.1/": "ip_literal", "https://169.254.169.254/latest/meta-data/": "ip_literal", "https://0.0.0.0/": "ip_literal",
  "https://2130706433/": "ip_literal", "https://0x7f000001/": "ip_literal", "https://0x7f.0.0.1/": "ip_literal",
  "https://017700000001/": "ip_literal", "https://127.1/": "ip_literal", "https://[::1]/": "ip_literal",
  "https://[::ffff:127.0.0.1]/": "ip_literal", "https://[fe80::1]/": "ip_literal", "https://[fd00::1]/": "ip_literal",
  "https://8.8.8.8/": "ip_literal", "https://localhost/": "internal_host", "https://LOCALHOST./": "internal_host",
  "https://foo.localhost/": "internal_host", "https://printer.local/": "internal_host", "https://db.internal/": "internal_host",
  "https://intranet/": "internal_host", "https://router.lan/": "internal_host", "https://nas.home.arpa/": "internal_host",
  "https://x.workers.dev/": "internal_host", "https://metadata.google.internal/": "internal_host",
  "https://exa mple.com/": "bad_url", "": "bad_url", "not a url": "bad_url",
  "https://example.com\\@evil.com/": "bad_url", "https://exa_mple.com/": "bad_host",
};
t("every hostile or private-looking target is refused with a specific code", () => {
  for (const [u, code] of Object.entries(BAD)) {
    const r = F.checkTarget(u);
    assert.equal(r.ok, false, "should refuse " + u);
    assert.equal(r.code, code, u + " -> " + r.code);
  }
});
t("non-string and overlong input is refused", () => {
  for (const v of [null, undefined, 5, {}, []]) assert.equal(F.checkTarget(v).ok, false);
  assert.equal(F.checkTarget("https://example.com/" + "a".repeat(2100)).ok, false);
});
t("ordinary public https links pass, with the default port or 443", () => {
  for (const u of ["https://example.com/sheet.pdf", "https://cdn.vendor.co.uk/a/b.png?x=1", "https://example.com:443/s.pdf", "https://xn--bcher-kva.example.org/s.pdf"])
    assert.equal(F.checkTarget(u).ok, true, u);
});
t("content-type allow-list", () => {
  assert.equal(F.typeAllowed("application/pdf"), "application/pdf");
  assert.equal(F.typeAllowed("Image/PNG; charset=x"), "image/png");
  for (const v of ["text/html", "application/octet-stream", "image/svg+xml", "application/json", "", null]) assert.equal(F.typeAllowed(v), null, String(v));
});
const mk = (status, headers, body) => new Response(body ?? "x", { status, headers });
t("a redirect to a private target is refused, and not requested", async () => {
  const seen = [];
  const r = await F.safeFetch("https://example.com/a", ["example.com"], async (u) => { seen.push(u); return mk(302, { location: "https://169.254.169.254/latest" }, null); });
  assert.equal(r.ok, false); assert.equal(r.code, "redirect_ip_literal"); assert.deepEqual(seen, ["https://example.com/a"]);
});
t("redirect to http, to localhost, and via relative paths are checked per hop", async () => {
  let r = await F.safeFetch("https://example.com/a", ["example.com"], async () => mk(301, { location: "http://example.com/b" }, null));
  assert.equal(r.code, "redirect_not_https");
  r = await F.safeFetch("https://example.com/a", ["example.com"], async () => mk(301, { location: "https://localhost/b" }, null));
  assert.equal(r.code, "redirect_internal_host");
  const seen = [];
  r = await F.safeFetch("https://example.com/a", ["example.com"], async (u) => { seen.push(u); return seen.length === 1 ? mk(302, { location: "/b.pdf" }, null) : mk(200, { "content-type": "application/pdf" }, "%PDF"); });
  assert.equal(r.ok, true); assert.deepEqual(seen, ["https://example.com/a", "https://example.com/b.pdf"]);
});
t("redirect loops stop at the hop cap", async () => {
  let n = 0;
  const r = await F.safeFetch("https://example.com/a", ["example.com"], async () => { n++; return mk(302, { location: "https://example.com/a" }, null); });
  assert.equal(r.code, "too_many_redirects"); assert.equal(n, F.MAX_REDIRECTS + 1);
});
t("requests carry no cookies, no auth, and are manual-redirect GETs", async () => {
  let init;
  await F.safeFetch("https://example.com/a", ["example.com"], async (u, i) => { init = i; return mk(200, { "content-type": "text/plain" }, "ok"); });
  assert.equal(init.method, "GET"); assert.equal(init.redirect, "manual");
  const names = Object.keys(init.headers).map((h) => h.toLowerCase());
  assert.deepEqual(names.sort(), ["accept", "user-agent"]);
});
t("size cap: declared and streamed oversize bodies are refused", async () => {
  let r = await F.safeFetch("https://example.com/a", ["example.com"], async () => mk(200, { "content-type": "application/pdf", "content-length": String(F.MAX_BYTES + 1) }, "x"));
  assert.equal(r.code, "too_large");
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(F.MAX_BYTES / 2)); c.close(); } });
  r = await F.safeFetch("https://example.com/a", ["example.com"], async () => new Response(big, { status: 200, headers: { "content-type": "application/pdf" } }));
  assert.equal(r.code, "too_large");
});
t("wrong content type, upstream errors and unreachable hosts give distinct codes", async () => {
  assert.equal((await F.safeFetch("https://example.com/a", ["example.com"], async () => mk(200, { "content-type": "text/html" }))).code, "type_not_allowed");
  assert.equal((await F.safeFetch("https://example.com/a", ["example.com"], async () => mk(404, {}))).code, "upstream_status");
  assert.equal((await F.safeFetch("https://example.com/a", ["example.com"], async () => { throw new Error("boom"); })).code, "unreachable");
});
t("a hanging server hits the timeout", async () => {
  const save = F.TIMEOUT_MS;
  const r = await new Promise((res) => {
    const timer = setTimeout(() => res({ code: "test-too-slow" }), 15000);
    F.safeFetch("https://example.com/a", ["example.com"], (u, i) => new Promise((_, rej) => { i.signal.addEventListener("abort", () => rej(new Error("abort"))); })).then((x) => { clearTimeout(timer); res(x); });
  });
  assert.ok(["unreachable", "timeout"].includes(r.code), r.code);
});
const goodFetch = async () => mk(200, { "content-type": "application/pdf" }, "%PDF-1.4");
const req = (over = {}) => new Request("https://app.example/api/fetch-sheet", {
  method: "POST", headers: { origin: "https://app.example", "content-type": "application/json", ...(over.headers || {}) },
  body: over.body ?? JSON.stringify({ url: "https://example.com/s.pdf", consent: true }),
});
const deps = (o = {}) => ({ enabled: true, allowedHosts: ["example.com"], admit: async () => "ok", doFetch: goodFetch, ...o });
t("disabled by default: 404 and no fetch at all", async () => {
  let called = 0;
  const r = await F.handleFetchSheet(req(), deps({ enabled: false, doFetch: async () => { called++; return goodFetch(); } }));
  assert.equal(r.status, 404); assert.equal(called, 0);
});
t("other paths fall through", async () => {
  assert.equal(await F.handleFetchSheet(new Request("https://app.example/api/visits"), deps()), null);
});
t("requires POST, same origin, sign-in, consent", async () => {
  assert.equal((await F.handleFetchSheet(new Request("https://app.example/api/fetch-sheet"), deps())).status, 405);
  assert.equal((await F.handleFetchSheet(req({ headers: { origin: "https://evil.example" } }), deps())).status, 403);
  const noOrigin = new Request("https://app.example/api/fetch-sheet", { method: "POST", body: "{}" });
  assert.equal((await F.handleFetchSheet(noOrigin, deps())).status, 403);
  assert.equal((await F.handleFetchSheet(req(), deps({ admit: async () => "signin" }))).status, 401);
  assert.equal((await F.handleFetchSheet(req({ body: JSON.stringify({ url: "https://example.com/s.pdf" }) }), deps())).status, 400);
  assert.equal((await F.handleFetchSheet(req({ body: JSON.stringify({ url: "https://example.com/s.pdf", consent: "yes" }) }), deps())).status, 400);
  assert.equal((await F.handleFetchSheet(req({ body: "{not json" }), deps())).status, 400);
});
t("auth and consent are checked before any outbound request", async () => {
  let called = 0;
  const d = deps({ doFetch: async () => { called++; return goodFetch(); } });
  await F.handleFetchSheet(req({ headers: { origin: "https://evil.example" } }), d);
  await F.handleFetchSheet(req(), { ...d, admit: async () => "signin" });
  await F.handleFetchSheet(req({ body: JSON.stringify({ url: "https://example.com/s.pdf" }) }), d);
  assert.equal(called, 0);
});
t("success returns bytes with a safe header set and the host actually fetched", async () => {
  const r = await F.handleFetchSheet(req(), deps());
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("content-disposition"), "attachment");
  assert.equal(r.headers.get("x-fetched-host"), "example.com");
  assert.equal(await r.text(), "%PDF-1.4");
});
t("hostile target through the handler is a 400 and is never fetched", async () => {
  let called = 0;
  const r = await F.handleFetchSheet(req({ body: JSON.stringify({ url: "https://169.254.169.254/", consent: true }) }), deps({ doFetch: async () => { called++; return goodFetch(); } }));
  assert.equal(r.status, 400); assert.equal(called, 0);
});
t("limited users get 429 and nothing is fetched", async () => {
  let called = 0;
  const r = await F.handleFetchSheet(req(), deps({ admit: async () => "limited", doFetch: async () => { called++; return goodFetch(); } }));
  assert.equal(r.status, 429); assert.equal(called, 0);
});
t("host allow-list: only listed hosts, case-insensitive, exact (no suffix tricks)", async () => {
  assert.equal(F.checkTarget("https://example.com/a", ["example.com"]).ok, true);
  assert.equal(F.checkTarget("https://EXAMPLE.com./a", ["example.com"]).ok, true);
  for (const u of ["https://other.com/a", "https://evil-example.com/a", "https://example.com.evil.net/a", "https://sub.example.com/a"])
    assert.equal(F.checkTarget(u, ["example.com"]).code, "host_not_allowed", u);
});
t("a redirect from an allowed host to an unlisted public host is refused", async () => {
  const seen = [];
  const r = await F.safeFetch("https://example.com/a", ["example.com"], async (u) => { seen.push(u); return mk(302, { location: "https://other.com/x.pdf" }, null); });
  assert.equal(r.code, "redirect_host_not_allowed"); assert.equal(seen.length, 1);
});
t("an empty allow-list keeps the whole route off", async () => {
  let called = 0;
  const r = await F.handleFetchSheet(req(), deps({ allowedHosts: [], doFetch: async () => { called++; return goodFetch(); } }));
  assert.equal(r.status, 404); assert.equal(called, 0);
});
t("allow-list parsing drops wildcards, paths, ports and blanks", () => {
  assert.deepEqual(F.parseAllowedHosts(" A.com, b.org. ,*.c.com,d.com/x,e.com:8080,, "), ["a.com", "b.org"]);
  assert.deepEqual(F.parseAllowedHosts(undefined), []);
});
t("an unlisted host through the handler is 403 and never fetched", async () => {
  let called = 0;
  const r = await F.handleFetchSheet(req({ body: JSON.stringify({ url: "https://other.com/a.pdf", consent: true }) }), deps({ doFetch: async () => { called++; return goodFetch(); } }));
  assert.equal(r.status, 403); assert.equal(called, 0);
});
t("error bodies do not echo the requested URL", async () => {
  const r = await F.handleFetchSheet(req({ body: JSON.stringify({ url: "https://10.1.2.3/secret-path", consent: true }) }), deps());
  assert.ok(!(await r.text()).includes("secret-path"));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log("  ok - " + name); } catch (e) { fail++; console.log("  FAIL - " + name); console.error("    " + e.message); }
  }
  console.log(`\nfetch-sheet-ssrf: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
