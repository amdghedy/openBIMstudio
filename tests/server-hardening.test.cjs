/* Server hardening tests — remediation program Phase 1.2 / 1.3.
 *
 * Covers the mandated scenarios:
 *   unsafe startup configuration · missing token · invalid token ·
 *   origin mismatch · oversized body · request flooding · malformed JSON ·
 *   SSE connection limits · file-name/header injection (see server-security)
 *   replayed or expired SSE credentials.
 *
 * Pure modules are tested directly; end-to-end behavior is tested against a
 * spawned server on an ephemeral loopback port with an isolated data dir.
 */
const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
const t = (n, f) => {
  if (f.length) { // async test
    f().then(() => { pass++; console.log("  PASS " + n); runNext(); })
      .catch((e) => { fail++; console.log("  FAIL " + n + ": " + e.message); runNext(); });
  } else {
    try { f(); pass++; console.log("  PASS " + n); }
    catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
  }
};

/* ── Pure: startup config (fail-closed) ─────────────────────────────── */
const cfgTests = (m) => {
  const { resolveStartupConfig, isLoopbackHost, tokenIsStrong } = m;

  t("loopback default allows tokenless start", () => {
    const c = resolveStartupConfig({ host: undefined, token: "", allowedOrigins: undefined });
    assert.ok(c.ok, JSON.stringify(c));
    assert.strictEqual(c.host, "127.0.0.1");
  });

  t("UNSAFE: non-loopback without token is refused", () => {
    const c = resolveStartupConfig({ host: "0.0.0.0", token: "", allowedOrigins: "" });
    assert.strictEqual(c.ok, false);
    assert.match(c.reason, /OBS_SERVER_TOKEN/);
  });

  t("UNSAFE: non-loopback with weak token is refused", () => {
    for (const weak of ["short", "aaaaaaaaaaaaaaaa", "password12345678", null]) {
      const c = resolveStartupConfig({ host: "0.0.0.0", token: weak, allowedOrigins: "https://x.example" });
      assert.strictEqual(c.ok, false, String(weak));
    }
  });

  t("UNSAFE: non-loopback with token but no explicit origins is refused", () => {
    const c = resolveStartupConfig({ host: "0.0.0.0", token: "strong-token-0123456789-abcdef", allowedOrigins: "" });
    assert.strictEqual(c.ok, false);
    assert.match(c.reason, /origin allow-list/i);
  });

  t("UNSAFE: wildcard origin allow-list is refused", () => {
    const c = resolveStartupConfig({ host: "0.0.0.0", token: "x".repeat(32), allowedOrigins: "*" });
    assert.strictEqual(c.ok, false);
  });

  t("valid network config accepted", () => {
    const c = resolveStartupConfig({
      host: "0.0.0.0", token: "s3cure-token-value-32chars!", allowedOrigins: "https://a.example, https://b.example/",
    });
    assert.ok(c.ok, JSON.stringify(c));
    assert.deepStrictEqual(c.origins, ["https://a.example", "https://b.example"]);
  });

  t("loopback host detection covers 127.x/localhost/::1", () => {
    for (const h of ["127.0.0.1", "127.9.9.9", "localhost", "::1"]) assert.ok(isLoopbackHost(h), h);
    for (const h of ["0.0.0.0", "192.168.1.10", "example.com"]) assert.ok(!isLoopbackHost(h), h);
  });

  t("token strength: length + trivial-value rejection", () => {
    assert.ok(tokenIsStrong("s3cure-token-value-32chars!"));
    assert.ok(!tokenIsStrong("only16charsx"));
    assert.ok(!tokenIsStrong("password0123456789"));
  });
};

/* ── Pure: rate limiting / correlation / log hygiene ────────────────── */
const rateTests = (m) => {

  t("flooding: over-budget requests are refused with retry hint", () => {
    const rl = m.createRateLimiter({ windowMs: 1000, max: 3 });
    assert.ok(rl.check("ip1").allowed);
    assert.ok(rl.check("ip1").allowed);
    const third = rl.check("ip1");
    assert.ok(third.allowed, "3rd within budget");
    const fourth = rl.check("ip1");
    assert.strictEqual(fourth.allowed, false);
    assert.ok(fourth.retryAfterMs > 0);
  });

  t("window expiry restores budget", async () => {
    const rl = m.createRateLimiter({ windowMs: 20, max: 1 });
    assert.ok(rl.check("k").allowed);
    assert.strictEqual(rl.check("k").allowed, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(rl.check("k").allowed);
  });

  t("keys are isolated", () => {
    const rl = m.createRateLimiter({ windowMs: 1000, max: 1 });
    assert.ok(rl.check("a").allowed);
    assert.ok(rl.check("b").allowed);
    assert.strictEqual(rl.check("a").allowed, false);
  });

  t("correlation ids: honour safe incoming id, mint otherwise", () => {
    const good = m.correlationId({ headers: { "x-request-id": "abc-DEF_123.9" } });
    assert.strictEqual(good, "abc-DEF_123.9");
    const minted = m.correlationId({ headers: {} });
    assert.match(minted, /^req-[0-9a-z]+-[0-9a-f]+$/);
    assert.notStrictEqual(m.correlationId({ headers: { "x-request-id": "bad id with spaces!" } }), "bad id with spaces!");
  });

  t("security log never emits oversized raw values", () => {
    const lines = [];
    m.securityLog((l) => lines.push(l), "upload_stored", { name: "x".repeat(500), ok: true });
    const parsed = JSON.parse(lines[0]);
    assert.ok(parsed.name.length <= 120);
    assert.strictEqual(parsed.ok, true);
  });

  t("file names are redacted to extension + length in logs", () => {
    assert.strictEqual(m.redactFileName("confidential-tower-A.rvt"), ".rvt(len=24)");
    assert.strictEqual(m.redactFileName("noext"), "(none)(len=5)");
  });
};

/* ── Pure: signed SSE tokens (short-lived, replay/expiry) ───────────── */
const sseTests = (m) => {
  const secret = "test-secret-material-32-chars!!";

  t("issue → verify happy path (right room, within TTL)", () => {
    const tok = m.issueSseToken(secret, { room: "room1", ttlMs: 60_000, now: 1_000_000 });
    const v = m.verifySseToken(tok, secret, { room: "room1", now: 1_000_001 });
    assert.ok(v.ok, JSON.stringify(v));
    assert.strictEqual(v.payload.room, "room1");
  });

  t("EXPIRED credential rejected", () => {
    const tok = m.issueSseToken(secret, { room: "room1", ttlMs: 1_000, now: 1_000_000 });
    const v = m.verifySseToken(tok, secret, { room: "room1", now: 1_001_500 });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "expired");
  });

  t("REPLAY after expiry rejected", () => {
    const tok = m.issueSseToken(secret, { room: "r", ttlMs: 1_000, now: 0 });
    assert.ok(m.verifySseToken(tok, secret, { room: "r", now: 500 }).ok);
    const replay = m.verifySseToken(tok, secret, { room: "r", now: 5_000 });
    assert.strictEqual(replay.ok, false);
  });

  t("tampered payload → bad-signature", () => {
    const tok = m.issueSseToken(secret, { room: "r", ttlMs: 60_000 });
    const [p, sig] = tok.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ room: "admin-room", exp: Date.now() + 600_000 })).toString("base64url");
    const v = m.verifySseToken(`${forgedPayload}.${sig}`, secret, { room: "admin-room" });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "bad-signature");
  });

  t("wrong room rejected", () => {
    const tok = m.issueSseToken(secret, { room: "roomA", ttlMs: 60_000 });
    const v = m.verifySseToken(tok, secret, { room: "roomB" });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "wrong-room");
  });

  t("malformed tokens rejected", () => {
    for (const bad of ["", "abc", "a.b.c", "%%%.$$$", null, undefined]) {
      const v = m.verifySseToken(bad, secret, { room: "r" });
      assert.strictEqual(v.ok, false, String(bad));
    }
  });

  t("issuing without a secret is refused", () => {
    assert.throws(() => m.issueSseToken("", { room: "r" }), /secret/i);
  });
};

/* ── Pure: upload store (opaque ids, signatures, retention) ─────────── */
const uploadTests = (m) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-uploads-"));

  t("upload ids are opaque, server-generated and unique", () => {
    const a = m.createUploadId(), b = m.createUploadId();
    assert.notStrictEqual(a, b);
    assert.match(a, /^[0-9a-z0-9=+/_-]{10,32}$/i);
    assert.ok(!/[\\/]/.test(a));
  });

  t("signature sniff: IFC magic required", () => {
    assert.ok(m.sniffSignature(Buffer.from("ISO-10303-21;\nHEADER;"), ".ifc").ok);
    assert.strictEqual(m.sniffSignature(Buffer.from("not an ifc at all"), ".ifc").ok, false);
  });

  t("signature sniff: DXF text SECTION and binary sentinel", () => {
    assert.ok(m.sniffSignature(Buffer.from("0\nSECTION\n  2\nHEADER\n"), ".dxf").ok);
    assert.ok(m.sniffSignature(Buffer.from("AutoCAD Binary DXF\r\n\u001a\u0000"), ".dxf").ok);
    assert.strictEqual(m.sniffSignature(Buffer.from("<html>hello"), ".dxf").ok, false);
  });

  t("signature sniff: DWG AC10xx magic; RVT family accepted as unverifiable", () => {
    assert.ok(m.sniffSignature(Buffer.from("AC1032........"), ".dwg").ok);
    assert.strictEqual(m.sniffSignature(Buffer.from("MZ\x90\x00"), ".dwg").ok, false);
    const rvt = m.sniffSignature(Buffer.from("\x00\x01binary"), ".rvt");
    assert.ok(rvt.ok && rvt.signatureChecked === false, "closed format documented");
  });

  t("store/read/delete roundtrip under an opaque key (never the client name)", () => {
    const meta = m.storeUpload(tmp, { buffer: Buffer.from("ISO-10303-21;"), originalName: "../../etc/passwd.ifc", ext: ".ifc" });
    assert.ok(!meta.originalName.includes("/"), "name sanitized");
    const back = m.readUpload(tmp, meta.id);
    assert.ok(back && back.buffer.toString().startsWith("ISO-10303"));
    assert.ok(!fs.existsSync(path.join(tmp, "../../etc/passwd.ifc")));
    m.deleteUpload(tmp, meta.id);
    assert.strictEqual(m.readUpload(tmp, meta.id), null);
  });

  t("retention sweep removes only expired uploads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-sweep-"));
    m.storeUpload(dir, { buffer: Buffer.from("old"), originalName: "old.ifc", ext: ".ifc" });
    // age the file beyond retention
    const entries = fs.readdirSync(dir).filter((f) => !f.endsWith(".json"));
    const oldTime = new Date(Date.now() - 48 * 3600_000);
    for (const f of entries) fs.utimesSync(path.join(dir, f), oldTime, oldTime);
    const removed = m.sweepExpired(dir, 24 * 3600_000);
    assert.strictEqual(removed.length, 1);
    assert.strictEqual(fs.readdirSync(dir).length, 0);
    // fresh files survive
    m.storeUpload(dir, { buffer: Buffer.from("new"), originalName: "new.ifc", ext: ".ifc" });
    assert.deepStrictEqual(m.sweepExpired(dir, 24 * 3600_000), []);
  });
};

/* ── Integration: spawned server (fail-closed + auth + limits) ──────── */
const serverPath = path.join(__dirname, "..", "server", "index.mjs");

function startServer(env) {
  return new Promise((resolve, reject) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-data-"));
    const child = spawn(process.execPath, [serverPath], {
      env: {
        ...process.env,
        PORT: "0",
        OBS_DATA_DIR: dataDir,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => reject(new Error("server start timeout: " + out)), 10_000);
    const onData = (d) => {
      out += d.toString();
      const match = /\[collab\] PORT=(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]), dataDir, log: () => out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.on("exit", (code) => { clearTimeout(timer); resolve({ exited: true, code, log: () => out }); });
  });
}

const integrationTests = async () => {
  const TOKEN = "test-server-token-32-chars-secret!!";

  t("UNSAFE startup: HOST=0.0.0.0 without token refuses to start", async () => {
    const r = await startServer({ HOST: "0.0.0.0" });
    await new Promise((r2) => setTimeout(r2, 300));
    assert.ok(r.exited, "process should have exited");
    assert.notStrictEqual(r.code, 0);
    assert.match(r.log(), /STARTUP REFUSED/);
    if (r.child) r.child.kill();
  });

  t("missing token → 401 on projects; query-token refused on non-SSE route", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const noAuth = await fetch(`${base}/api/projects/p1`);
    assert.strictEqual(noAuth.status, 401);
    const queryTok = await fetch(`${base}/api/projects/p1?token=${encodeURIComponent(TOKEN)}`);
    assert.strictEqual(queryTok.status, 401, "query tokens must not authenticate non-SSE routes");
    const badAuth = await fetch(`${base}/api/projects/p1`, { headers: { Authorization: "Bearer wrong" } });
    assert.strictEqual(badAuth.status, 401);
    s.child.kill();
  });

  t("bearer token works; valid config serves requests", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const ok = await fetch(`${base}/api/projects/p1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(ok.status, 404); // authed, project absent
    s.child.kill();
  });

  t("origin mismatch → 403 (explicit allow-list)", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN, OBS_ALLOWED_ORIGINS: "http://allowed.example" });
    const base = `http://127.0.0.1:${s.port}`;
    const evil = await fetch(`${base}/api/rooms/r1`, { headers: { Origin: "http://evil.example" } });
    assert.strictEqual(evil.status, 403);
    const good = await fetch(`${base}/api/rooms/r1`, {
      headers: { Origin: "http://allowed.example", Authorization: `Bearer ${TOKEN}` },
    });
    assert.strictEqual(good.status, 200);
    s.child.kill();
  });

  t("malformed JSON → 400 generic (no parser internals leaked)", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const res = await fetch(`${base}/api/projects/p1`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: '{"name": broken,,',
    });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.error, "Invalid JSON body");
    assert.ok(!/unexpected/i.test(body.error));
    s.child.kill();
  });

  t("oversized body → 413 while streaming", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN, OBS_MAX_BODY: "1024" });
    const base = `http://127.0.0.1:${s.port}`;
    const big = "x".repeat(4096);
    const res = await fetch(`${base}/api/rooms/r1/change`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "c1", payload: { blob: big } }),
    });
    assert.strictEqual(res.status, 413);
    s.child.kill();
  });

  t("request flooding → 429 with Retry-After", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN, OBS_RATE_MAX: "3", OBS_RATE_WINDOW_MS: "60000" });
    const base = `http://127.0.0.1:${s.port}`;
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      codes.push(res.status);
      if (res.status === 429) assert.ok(res.headers.get("retry-after"));
    }
    assert.ok(codes.includes(429), "expected a 429 among: " + codes.join(","));
    s.child.kill();
  });

  t("SSE connection limit per IP enforced", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN, OBS_SSE_MAX_PER_IP: "2" });
    const base = `http://127.0.0.1:${s.port}`;
    const ac = new AbortController();
    const open = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/rooms/r1/events`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: ac.signal,
      });
      open.push(res);
    }
    assert.strictEqual(open[0].status, 200);
    assert.strictEqual(open[1].status, 200);
    assert.strictEqual(open[2].status, 429, "third stream must be limited");
    ac.abort();
    s.child.kill();
  });

  t("signed short-lived SSE token authenticates the events route", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const sseMod = require("./helpers/sse-tokens-loader.cjs");
    const tok = sseMod.issueSseToken(TOKEN, { room: "r1", ttlMs: 60_000 });
    const good = await fetch(`${base}/api/rooms/r1/events?sse=${encodeURIComponent(tok)}`);
    assert.strictEqual(good.status, 200);
    good.body?.cancel?.();
    const forged = await fetch(`${base}/api/rooms/r1/events?sse=${encodeURIComponent(tok.slice(0, -4) + "AAAA")}`);
    assert.strictEqual(forged.status, 401);
    forged.body?.cancel?.();
    s.child.kill();
  });

  t("upload hardening: bad signature rejected; opaque id returned; no path leak", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const fake = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "x-file-name": "model.ifc" },
      body: "definitely not an IFC file",
    });
    assert.strictEqual(fake.status, 400);
    const good = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "x-file-name": "tower.ifc" },
      body: "ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n",
    });
    assert.strictEqual(good.status, 200);
    const body = await good.json();
    assert.strictEqual(body.mode, "manual");
    assert.ok(body.uploadId && /^[0-9a-z]{10,32}$/i.test(body.uploadId), "opaque id");
    assert.strictEqual(body.savedPath, undefined, "no storage layout disclosure");
    assert.strictEqual(body.fileName, undefined, "client name not echoed as key");
    s.child.kill();
  });
};

/* Loader shims: the server modules are ESM; load once via dynamic import. */
require("fs").mkdirSync(path.join(__dirname, "helpers"), { recursive: true });
const shim = (name, modPath) => {
  fs.writeFileSync(
    path.join(__dirname, "helpers", name),
    `module.exports = import(${JSON.stringify(modPath)});\n`,
  );
};
shim("startup-config-loader.cjs", "../../server/startup-config.mjs");
shim("rate-limit-loader.cjs", "../../server/rate-limit.mjs");
shim("sse-tokens-loader.cjs", "../../server/sse-tokens.mjs");
shim("upload-store-loader.cjs", "../../server/upload-store.mjs");
const load = async (n) => {
  const mod = await import("./helpers/" + n);
  // shim: module.exports = import("<esm module>") → default is that promise
  const inner = await (mod.default ?? mod);
  return inner;
};

/* Run pure suites with pre-loaded modules, then integration. */
(async () => {
  cfgTests(await load("startup-config-loader.cjs"));
  rateTests(await load("rate-limit-loader.cjs"));
  sseTests(await load("sse-tokens-loader.cjs"));
  uploadTests(await load("upload-store-loader.cjs"));
  await new Promise((r) => setImmediate(r));
  await integrationTests();
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
