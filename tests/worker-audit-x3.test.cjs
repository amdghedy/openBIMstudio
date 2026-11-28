// Worker audit X-3 (#92 O4) — CORS scoping, /api/visits rate limit,
// reset token never in a URL.
//
// Behavioural tests against the real worker code (compiled from source
// with tsc, like the layout-plot suite): the default export runs with a
// mocked env whose Durable Object namespaces are backed by in-memory
// storage, and VisitCounter is exercised directly for the limiter.
//
// Proved fail-without-fix against the base: the auth OPTIONS test fails
// (the old code answered `*`), the second rapid POST succeeds (no
// limiter), the garbage-IP test counts a second visitor (the header was
// trusted blindly), and the forgot test returns resetUrl (no
// resetToken). #92 itself stays OPEN — this is the code side only.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-worker-x3-"));
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* ignore */ }
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

execSync(
  "npx tsc worker/index.ts worker/auth.ts worker/linkedin.ts worker/fetch-sheet.ts " +
    "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const W = require(find(out, "index.js"));

/** In-memory Durable Object storage. */
function memStorage() {
  const m = new Map();
  let alarm = null;
  return {
    _map: m,
    async get(k) { return m.get(k); },
    async put(k, v) { m.set(k, v); },
    async delete(k) { return m.delete(k); },
    async list({ prefix = "" } = {}) {
      return new Map([...m.entries()].filter(([k]) => k.startsWith(prefix)));
    },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
  };
}

function counterEnv(storage) {
  const counter = new W.VisitCounter({ storage });
  const stub = { fetch: (req) => counter.fetch(req) };
  const ns = { idFromName: () => "global", get: () => stub };
  return { counter, ns };
}

function workerEnv({ counterNs, authStub } = {}) {
  const c = counterNs ?? counterEnv(memStorage()).ns;
  const a = authStub ?? { fetch: async () => new Response(JSON.stringify({ error: "no auth stub" }), { status: 503, headers: { "content-type": "application/json" } }) };
  const authNs = { idFromName: () => "global", get: () => a };
  return {
    ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
    COUNTER: c,
    AUTH: authNs,
  };
}

const req = (url, init = {}) => new Request(url, init);
const visitsPost = (ip, ua, extra = {}) => req("https://studio.example/api/visits", {
  method: "POST",
  headers: { "cf-connecting-ip": ip, "user-agent": ua, ...(extra.headers ?? {}) },
  ...extra.init,
});

(async () => {
  await t("X-3 CORS: GET /api/visits stays public (ACAO *)", async () => {
    const env = workerEnv();
    const res = await W.default.fetch(req("https://studio.example/api/visits"), env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json();
    assert.deepStrictEqual(body, { visits: 0, loads: 0, uniques: 0 });
  });

  await t("X-3 CORS: OPTIONS /api/visits keeps the public preflight", async () => {
    const env = workerEnv();
    const res = await W.default.fetch(req("https://studio.example/api/visits", { method: "OPTIONS" }), env);
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
  });

  await t("X-3 CORS: OPTIONS on an auth route grants nothing", async () => {
    const env = workerEnv();
    const res = await W.default.fetch(req("https://studio.example/api/auth/me", { method: "OPTIONS" }), env);
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), null);
  });

  await t("X-3 CORS: worker-level auth errors carry no ACAO grant", async () => {
    const env = workerEnv({
      authStub: { fetch: async () => { throw new Error("vault down"); } },
    });
    const res = await W.default.fetch(req("https://studio.example/api/auth/forgot", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }),
    }), env);
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.headers.get("access-control-allow-origin"), null);
  });

  await t("X-3 CORS: `*` appears only on the public counter + its preflight", async () => {
    const src = fs.readFileSync(path.join(root, "worker", "index.ts"), "utf8");
    const hits = [...src.matchAll(/access-control-allow-origin/g)].map((m) => {
      const line = src.slice(0, m.index).split("\n").length;
      return line;
    });
    assert.ok(hits.length >= 2, "expected at least the PUBLIC_JSON and CORS_PREFLIGHT grants");
    // Neither grant may sit in the private JSON headers or the auth OPTIONS path.
    const privBlock = src.slice(src.indexOf("const PRIVATE_JSON"), src.indexOf("} as const;", src.indexOf("const PRIVATE_JSON")));
    assert.ok(!privBlock.includes("access-control-allow-origin"), "PRIVATE_JSON must not grant ACAO");
    const authOpts = src.slice(src.indexOf('url.pathname.startsWith("/api/auth/")'));
    assert.ok(!authOpts.slice(0, 400).includes("CORS_PREFLIGHT"), "auth OPTIONS must not use the public preflight");
  });

  await t("X-3 visits: a second POST from the same visitor within 10 s is 429", async () => {
    const { counter } = counterEnv(memStorage());
    const first = await counter.fetch(visitsPost("1.2.3.4", "UA-1"));
    assert.strictEqual(first.status, 200);
    const second = await counter.fetch(visitsPost("1.2.3.4", "UA-1"));
    assert.strictEqual(second.status, 429);
    assert.strictEqual(second.headers.get("retry-after"), "10");
    const body = await second.json();
    assert.ok(!("visits" in body) || body.visits === undefined, "a 429 must not count");
    // And the first POST did count exactly once.
    const stats = await counter.fetch(req("https://studio.example/api/visits"));
    assert.deepStrictEqual(await stats.json(), { visits: 1, loads: 1, uniques: 1 });
  });

  await t("X-3 visits: 600 distinct visitors in a minute pass, the 601st is 429", async () => {
    const { counter } = counterEnv(memStorage());
    for (let i = 0; i < 600; i++) {
      const res = await counter.fetch(visitsPost(`10.0.${Math.floor(i / 256)}.${i % 256}`, `UA-${i}`));
      assert.strictEqual(res.status, 200, `POST ${i} must pass`);
    }
    const over = await counter.fetch(visitsPost("10.9.9.9", "UA-over"));
    assert.strictEqual(over.status, 429);
    assert.strictEqual(over.headers.get("retry-after"), "60");
    const stats = await counter.fetch(req("https://studio.example/api/visits"));
    assert.deepStrictEqual(await stats.json(), { visits: 600, loads: 600, uniques: 600 });
  });

  await t("X-3 visits: a garbage x-obs-visitor-ip falls back to cf-connecting-ip", async () => {
    const { counter } = counterEnv(memStorage());
    const a = await counter.fetch(visitsPost("1.2.3.4", "UA-A", { headers: { "x-obs-visitor-ip": "not-an-ip" } }));
    assert.strictEqual(a.status, 200);
    // Same real IP and UA, different garbage header: if the header were
    // trusted this would be a fresh visitor (200, visits 2); ignored, it
    // is the same visitor — the per-visitor limiter answers 429.
    const b = await counter.fetch(visitsPost("1.2.3.4", "UA-A", { headers: { "x-obs-visitor-ip": "also-garbage" } }));
    assert.strictEqual(b.status, 429);
    const stats = await counter.fetch(req("https://studio.example/api/visits"));
    assert.deepStrictEqual(await stats.json(), { visits: 1, loads: 1, uniques: 1 });
  });

  await t("X-3 visits: a well-formed x-obs-visitor-ip is still trusted (Vercel proxy)", async () => {
    const { counter } = counterEnv(memStorage());
    const a = await counter.fetch(visitsPost("1.2.3.4", "UA-A", { headers: { "x-obs-visitor-ip": "9.9.9.9" } }));
    assert.strictEqual(a.status, 200);
    const b = await counter.fetch(visitsPost("1.2.3.4", "UA-A", { headers: { "x-obs-visitor-ip": "8.8.8.8" } }));
    assert.strictEqual(b.status, 200);
    const stats = await counter.fetch(req("https://studio.example/api/visits"));
    assert.deepStrictEqual(await stats.json(), { visits: 2, loads: 2, uniques: 2 });
  });

  await t("X-3 visits: the alarm sweeper drops stale rate-limit markers", async () => {
    const storage = memStorage();
    const counter = new W.VisitCounter({ storage });
    await storage.put("rl:hash1", Date.now() - 60_000);
    await storage.put("rlg:1", 600); // an ancient minute bucket
    await storage.put("r:hash2", Date.now() - 31 * 60_000); // stale session marker (control: 31 min > 30-min window)
    await counter.alarm();
    assert.strictEqual(await storage.get("rl:hash1"), undefined);
    assert.strictEqual(await storage.get("rlg:1"), undefined);
    assert.strictEqual(await storage.get("r:hash2"), undefined);
  });

  await t("X-3 reset: no-mail forgot returns the code, never a URL", async () => {
    const authStub = {
      fetch: async () => new Response(JSON.stringify({ ok: true, hasAccount: true, token: "tok-abc" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    };
    const env = workerEnv({ authStub }); // no RESEND_API_KEY
    const res = await W.default.fetch(req("https://studio.example/api/auth/forgot", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.com" }),
    }), env);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.mailSent, false);
    assert.strictEqual(body.resetToken, "tok-abc");
    assert.ok(!("resetUrl" in body), `resetUrl must be gone, got ${JSON.stringify(body)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
