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
/* Every test — sync or async — is collected as a promise and awaited by the
 * runner before it prints the result. (Previously this helper branched on
 * f.length, which is 0 for `async () => {}` callbacks, so every async
 * integration test "passed" before its body ran and the suite exited in
 * ~0.3 s without ever spawning a server. Do not reintroduce the arity
 * branch: a test that is not awaited is not a test.)
 * Tests run SEQUENTIALLY through one chain: each integration test spawns a
 * real server, and 20+ simultaneous servers on a small CI runner starve
 * each other (observed: connection resets and start timeouts under load). */
const pending = [];
let chain = Promise.resolve();
const t = (n, f) => {
  const p = chain.then(async () => {
    try { await f(); pass++; console.log("  PASS " + n); }
    catch (e) { fail++; console.log("  FAIL " + n + ": " + (e && e.message)); }
  });
  chain = p;
  pending.push(p);
};

/* Spawned servers + their data dirs. A test that fails mid-body skips its
 * own child.kill(), so the runner kills stragglers and removes their data
 * dirs after the run instead of leaking a server (and ~18 MB of /tmp)
 * per failure. */
const spawned = [];

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

  t("limiter keeps answering under a key flood (no backend to fail)", () => {
    // A key flood must not throw or wedge the limiter: it keeps deciding.
    // (maxKeys only sweeps expired entries, so this pins liveness, not a
    // hard memory bound — the per-IP general budget is what caps one client.)
    const rl = m.createRateLimiter({ windowMs: 1000, max: 2, maxKeys: 3 });
    for (let i = 0; i < 500; i++) assert.doesNotThrow(() => rl.check(`k${i}`));
    assert.strictEqual(rl.check("fresh").allowed, true);
    assert.strictEqual(rl.peek("fresh"), 1);
  });

  t("safeRateCheck fails CLOSED when the limiter throws (never un-limits)", () => {
    const throwing = { check() { throw new Error("backend down"); } };
    const r = m.safeRateCheck(throwing, "ip1");
    assert.strictEqual(r.allowed, false);
    assert.ok(r.retryAfterMs > 0);
    // A limiter returning garbage is also refused, not admitted.
    const garbage = { check() { return null; } };
    assert.strictEqual(m.safeRateCheck(garbage, "ip1").allowed, false);
    // And a healthy limiter passes straight through.
    const rl = m.createRateLimiter({ windowMs: 1000, max: 3 });
    assert.strictEqual(m.safeRateCheck(rl, "ip1").allowed, true);
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

  t("agent scope: issue → verify happy path; room scope cannot open it", () => {
    const tok = m.issueSseToken(secret, { room: m.AGENT_SSE_ROOM, scope: m.AGENT_SSE_SCOPE, ttlMs: 60_000, now: 1_000_000 });
    const v = m.verifySseToken(tok, secret, { room: m.AGENT_SSE_ROOM, scope: m.AGENT_SSE_SCOPE, now: 1_000_001 });
    assert.ok(v.ok, JSON.stringify(v));
    assert.strictEqual(v.payload.scope, "agent");
    // Same token presented as a room token is refused by scope …
    const asRoom = m.verifySseToken(tok, secret, { room: m.AGENT_SSE_ROOM, scope: "room", now: 1_000_001 });
    assert.strictEqual(asRoom.ok, false);
    assert.strictEqual(asRoom.reason, "wrong-scope");
    // … and a room token presented as an agent token is refused the same way.
    const roomTok = m.issueSseToken(secret, { room: "room1", ttlMs: 60_000, now: 1_000_000 });
    const asAgent = m.verifySseToken(roomTok, secret, { room: m.AGENT_SSE_ROOM, scope: m.AGENT_SSE_SCOPE, now: 1_000_001 });
    assert.strictEqual(asAgent.ok, false);
    assert.strictEqual(asAgent.reason, "wrong-room");
  });

  t("agent scope cannot be minted for a real room id", () => {
    // The reserved agent subject is not a valid room id, and the room mint
    // endpoint validates ids — but the pure issuer must also refuse a
    // scope/room combination that would cross the boundary.
    assert.throws(() => m.issueSseToken(secret, { room: "room1", scope: "agent" }), /room/i);
    assert.throws(() => m.issueSseToken(secret, { room: m.AGENT_SSE_ROOM, scope: "room" }), /room/i);
    assert.throws(() => m.issueSseToken(secret, { room: "room1", scope: "bogus" }), /scope/i);
  });

  t("legacy token without a scope field still verifies as room scope", () => {
    // Tokens minted before scopes existed carry {room, sub, exp} only.
    // They must keep working for their 5-minute lifetime on room routes
    // and must never open the agent route.
    const crypto = require("crypto");
    const payloadStr = JSON.stringify({ room: "room1", sub: "client", exp: Date.now() + 60_000 });
    const sig = crypto.createHmac("sha256", secret).update(payloadStr).digest().toString("base64url");
    const legacy = `${Buffer.from(payloadStr).toString("base64url")}.${sig}`;
    assert.ok(m.verifySseToken(legacy, secret, { room: "room1", scope: "room" }).ok);
    const asAgent = m.verifySseToken(legacy, secret, { room: m.AGENT_SSE_ROOM, scope: m.AGENT_SSE_SCOPE });
    assert.strictEqual(asAgent.ok, false);
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
    const signature = String.fromCharCode(65, 117, 116, 111, 67, 65, 68, 32, 66, 105, 110, 97, 114, 121, 32, 68, 88, 70);
    const binary = Buffer.from(signature + "\r\n\u001a\u0000");
    assert.ok(m.sniffSignature(binary, ".dxf").ok);
    assert.ok(m.sniffSignature(new Uint8Array(binary), ".dxf").ok, "binary typed-array input");
    assert.ok(m.sniffSignature(new Uint8Array(Buffer.from("0\nSECTION\n  2\nHEADER\n")), ".dxf").ok, "ASCII typed-array input");
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
    spawned.push({ child, dataDir });
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

  t("ROUTE MATRIX: every /api route (rooms, agent, convert, upload, unknown) is 401 without a token and with a wrong/query token", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const routes = [
      ["GET", "/api/projects/p1"], ["PUT", "/api/projects/p1"],
      ["GET", "/api/rooms/r1"], ["POST", "/api/rooms/r1/join"], ["POST", "/api/rooms/r1/heartbeat"],
      ["POST", "/api/rooms/r1/leave"], ["POST", "/api/rooms/r1/change"],
      ["POST", "/api/rooms/r1/sse-token"], ["GET", "/api/rooms/r1/sse-token"],
      ["GET", "/api/rooms/r1/events"],
      ["POST", "/api/agent/exec"], ["POST", "/api/agent/result"], ["GET", "/api/agent/status"],
      ["POST", "/api/agent/sse-token"], ["GET", "/api/agent/sse-token"], ["GET", "/api/agent/events"],
      ["POST", "/api/convert"], ["GET", "/api/convert/x/status"], ["GET", "/api/convert/x/download"],
      ["GET", "/api/does-not-exist"], ["POST", "/api/anything"], ["DELETE", "/api/projects/p1"],
    ];
    const leaks = [];
    for (const [method, route] of routes) {
      for (const hdr of [{}, { Authorization: "Bearer wrong" }, { Authorization: "Basic " + TOKEN }]) {
        const r = await fetch(base + route, { method, headers: hdr, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
        if (r.status !== 401) leaks.push(`${method} ${route} [${Object.keys(hdr).join("") || "no auth"}] → ${r.status}`);
      }
      const q = await fetch(`${base}${route}?token=${encodeURIComponent(TOKEN)}`, { method, body: method === "GET" || method === "DELETE" ? undefined : "{}" });
      if (q.status !== 401) leaks.push(`${method} ${route} [?token=] → ${q.status}`);
    }
    s.child.kill();
    assert.deepStrictEqual(leaks, [], "unauthenticated access:\n" + leaks.join("\n"));
  });

  t("unauthenticated request leaves server state untouched (no project written)", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    await fetch(`${base}/api/projects/evil`, { method: "PUT", body: JSON.stringify({ name: "x" }) });
    const ok = await fetch(`${base}/api/projects/evil`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(ok.status, 404, "unauthenticated PUT must not persist");
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
    const sseMod = await require("./helpers/sse-tokens-loader.cjs");
    const tok = sseMod.issueSseToken(TOKEN, { room: "r1", ttlMs: 60_000 });
    const good = await fetch(`${base}/api/rooms/r1/events?sse=${encodeURIComponent(tok)}`);
    assert.strictEqual(good.status, 200);
    good.body?.cancel?.();
    const forged = await fetch(`${base}/api/rooms/r1/events?sse=${encodeURIComponent(tok.slice(0, -4) + "AAAA")}`);
    assert.strictEqual(forged.status, 401);
    forged.body?.cancel?.();
    s.child.kill();
  });

  t("SSE: room events rejects ?token=; Bearer and ?sse= accepted", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const ac = new AbortController();
    // The long-lived token in the URL is refused even when it is valid.
    const q = await fetch(`${base}/api/rooms/r1/events?token=${encodeURIComponent(TOKEN)}`, { signal: ac.signal });
    assert.strictEqual(q.status, 401, "?token= must not open the room stream");
    q.body?.cancel?.();
    const sseMod = await require("./helpers/sse-tokens-loader.cjs");
    const tok = sseMod.issueSseToken(TOKEN, { room: "r1", ttlMs: 60_000 });
    const good = await fetch(`${base}/api/rooms/r1/events?sse=${encodeURIComponent(tok)}`, { signal: ac.signal });
    assert.strictEqual(good.status, 200);
    const bearer = await fetch(`${base}/api/rooms/r1/events`, {
      headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal,
    });
    assert.strictEqual(bearer.status, 200);
    ac.abort();
    s.child.kill();
  });

  t("SSE: expired, wrong-room, malformed and tampered ?sse= tokens rejected", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const sseMod = await require("./helpers/sse-tokens-loader.cjs");
    const valid = sseMod.issueSseToken(TOKEN, { room: "r1", ttlMs: 60_000 });
    const cases = [
      ["expired", sseMod.issueSseToken(TOKEN, { room: "r1", ttlMs: 1_000, now: 1_000_000 })],
      ["wrong-room", sseMod.issueSseToken(TOKEN, { room: "r2", ttlMs: 60_000 })],
      ["malformed", "not-a-token"],
      ["tampered", valid.slice(0, -4) + "AAAA"],
    ];
    for (const [name, tok] of cases) {
      const r = await fetch(`${base}/api/rooms/r1/events?sse=${encodeURIComponent(tok)}`);
      assert.strictEqual(r.status, 401, name);
      r.body?.cancel?.();
    }
    s.child.kill();
  });

  t("SSE: agent events rejects ?token=; Bearer and minted agent ?sse= accepted, room ?sse= refused", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}` };
    const ac = new AbortController();
    // The long-lived token in the URL is refused even when it is valid —
    // the agent relay was the last ?token= exception and is now closed.
    const q = await fetch(`${base}/api/agent/events?token=${encodeURIComponent(TOKEN)}`, { signal: ac.signal });
    assert.strictEqual(q.status, 401, "?token= must not open the agent stream");
    q.body?.cancel?.();
    // Bearer still opens it.
    const bearer = await fetch(`${base}/api/agent/events`, { headers: H, signal: ac.signal });
    assert.strictEqual(bearer.status, 200);
    // A minted agent-scoped token opens it …
    const sseMod = await require("./helpers/sse-tokens-loader.cjs");
    const agentTok = sseMod.issueSseToken(TOKEN, { room: sseMod.AGENT_SSE_ROOM, scope: sseMod.AGENT_SSE_SCOPE, ttlMs: 60_000 });
    const good = await fetch(`${base}/api/agent/events?sse=${encodeURIComponent(agentTok)}`, { signal: ac.signal });
    assert.strictEqual(good.status, 200);
    // … but a room-scoped token does not, and the agent token does not open
    // a room stream either (scopes never cross).
    const roomTok = sseMod.issueSseToken(TOKEN, { room: "r1", ttlMs: 60_000 });
    const cross1 = await fetch(`${base}/api/agent/events?sse=${encodeURIComponent(roomTok)}`);
    assert.strictEqual(cross1.status, 401, "room token must not open the agent stream");
    cross1.body?.cancel?.();
    const cross2 = await fetch(`${base}/api/rooms/r1/events?sse=${encodeURIComponent(agentTok)}`);
    assert.strictEqual(cross2.status, 401, "agent token must not open a room stream");
    cross2.body?.cancel?.();
    ac.abort();
    s.child.kill();
  });

  t("mint: POST /api/agent/sse-token mints an agent-scoped token (Bearer only)", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}` };
    const noAuth = await fetch(`${base}/api/agent/sse-token`, { method: "POST" });
    assert.strictEqual(noAuth.status, 401);
    const queryTok = await fetch(`${base}/api/agent/sse-token?token=${encodeURIComponent(TOKEN)}`, { method: "POST" });
    assert.strictEqual(queryTok.status, 401, "?token= must not mint");
    const wrongMethod = await fetch(`${base}/api/agent/sse-token`, { method: "GET", headers: H });
    assert.strictEqual(wrongMethod.status, 405);
    const ok = await fetch(`${base}/api/agent/sse-token`, { method: "POST", headers: H });
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert.strictEqual(body.scope, "agent");
    assert.strictEqual(body.ttlMs, 5 * 60_000);
    assert.ok(typeof body.sseToken === "string" && body.sseToken.includes("."));
    assert.ok(Math.abs(body.expiresAt - (Date.now() + 5 * 60_000)) < 5_000);
    // The minted token opens the agent stream.
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/agent/events?sse=${encodeURIComponent(body.sseToken)}`, { signal: ac.signal });
    assert.strictEqual(stream.status, 200);
    ac.abort();
    s.child.kill();
  });

  t("mint: tokenless (loopback) agent mint answers 503 — nothing to mint from", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const r = await fetch(`${base}/api/agent/sse-token`, { method: "POST" });
    assert.strictEqual(r.status, 503);
    s.child.kill();
  });

  t("mint: POST /api/rooms/:id/sse-token mints a room-bound token (Bearer only)", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}` };
    const noAuth = await fetch(`${base}/api/rooms/r1/sse-token`, { method: "POST" });
    assert.strictEqual(noAuth.status, 401);
    const queryTok = await fetch(`${base}/api/rooms/r1/sse-token?token=${encodeURIComponent(TOKEN)}`, { method: "POST" });
    assert.strictEqual(queryTok.status, 401, "?token= must not mint");
    const wrongMethod = await fetch(`${base}/api/rooms/r1/sse-token`, { method: "GET", headers: H });
    assert.strictEqual(wrongMethod.status, 405);
    const badRoom = await fetch(`${base}/api/rooms/__proto__/sse-token`, { method: "POST", headers: H });
    assert.strictEqual(badRoom.status, 400);
    const ok = await fetch(`${base}/api/rooms/r1/sse-token`, { method: "POST", headers: H });
    assert.strictEqual(ok.status, 200);
    const body = await ok.json();
    assert.strictEqual(body.room, "r1");
    assert.strictEqual(body.ttlMs, 5 * 60_000);
    assert.ok(typeof body.sseToken === "string" && body.sseToken.includes("."));
    assert.ok(Math.abs(body.expiresAt - (Date.now() + 5 * 60_000)) < 5_000);
    // The minted token opens the stream for its room and no other.
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/rooms/r1/events?sse=${encodeURIComponent(body.sseToken)}`, { signal: ac.signal });
    assert.strictEqual(stream.status, 200);
    const other = await fetch(`${base}/api/rooms/r2/events?sse=${encodeURIComponent(body.sseToken)}`);
    assert.strictEqual(other.status, 401, "room-bound token must not open another room");
    other.body?.cancel?.();
    ac.abort();
    s.child.kill();
  });

  t("mint: tokenless (loopback) server answers 503 — nothing to mint from", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const r = await fetch(`${base}/api/rooms/r1/sse-token`, { method: "POST" });
    assert.strictEqual(r.status, 503);
    // ...and the stream itself opens without any credential in that mode.
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/rooms/r1/events`, { signal: ac.signal });
    assert.strictEqual(stream.status, 200);
    ac.abort();
    s.child.kill();
  });

  t("failed-auth budget: repeated bad tokens on one route → 429, other routes unaffected", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN, OBS_AUTH_FAIL_MAX: "3" });
    const base = `http://127.0.0.1:${s.port}`;
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/api/projects/p1`, { headers: { Authorization: "Bearer wrong" } });
      codes.push(r.status);
    }
    assert.deepStrictEqual(codes, [401, 401, 401, 429]);
    const retry = await fetch(`${base}/api/projects/p1`, { headers: { Authorization: "Bearer wrong" } });
    assert.strictEqual(retry.status, 429);
    assert.ok(retry.headers.get("retry-after"), "429 carries Retry-After");
    // Per-route isolation: a different route still answers 401, not 429.
    const other = await fetch(`${base}/api/rooms/r1`, { headers: { Authorization: "Bearer wrong" } });
    assert.strictEqual(other.status, 401);
    s.child.kill();
  });

  t("UNSAFE startup variants refuse: weak token, missing origins, wildcard loopback origins", async () => {
    // Fail-closed proof (spawned server, not just the pure config helper):
    // every misconfiguration that would leave the server exposed refuses
    // to start, with a named reason on stderr.
    const cases = [
      [{ HOST: "0.0.0.0", OBS_SERVER_TOKEN: "short", OBS_ALLOWED_ORIGINS: "https://x.example" }, /weak/],
      [{ HOST: "0.0.0.0", OBS_SERVER_TOKEN: TOKEN }, /origin allow-list/i],
      [{ OBS_ALLOWED_ORIGINS: "*" }, /must not contain/],
    ];
    for (const [env, reason] of cases) {
      const r = await startServer(env);
      await new Promise((r2) => setTimeout(r2, 300));
      assert.ok(r.exited, `server must refuse to start with ${JSON.stringify(env)}`);
      assert.notStrictEqual(r.code, 0);
      assert.match(r.log(), /STARTUP REFUSED/);
      assert.match(r.log(), reason);
      if (r.child) r.child.kill();
    }
  });

  t("mutation budgets cover agent/result, convert uploads and project PUTs", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN, OBS_RATE_MAX_MUTATION: "3" });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    // agent/result had no budget at all before this change: flood it.
    const resultCodes = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/api/agent/result`, { method: "POST", headers: H, body: JSON.stringify({ orderId: "nope" }) });
      resultCodes.push(r.status);
    }
    assert.deepStrictEqual(resultCodes, [404, 404, 404, 429], "agent/result must be mutation-budgeted");
    // convert uploads: same budget class, its own key.
    const convertCodes = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/api/convert`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "x-file-name": "tower.ifc" },
        body: "ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n",
      });
      convertCodes.push(r.status);
    }
    assert.deepStrictEqual(convertCodes, [200, 200, 200, 429], "convert uploads must be mutation-budgeted");
    // project PUTs rewrite a whole file + backup per call: budget them too.
    const putCodes = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/api/projects/p1`, { method: "PUT", headers: H, body: JSON.stringify({ name: "T", data: {} }) });
      putCodes.push(r.status);
    }
    assert.deepStrictEqual(putCodes, [200, 200, 200, 429], "project PUTs must be mutation-budgeted");
    s.child.kill();
  });

  t("error responses never echo the token (no credential leakage in bodies)", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}` };
    const probes = [
      fetch(`${base}/api/projects/p1?token=${encodeURIComponent(TOKEN)}`),
      fetch(`${base}/api/rooms/r1/events?token=${encodeURIComponent(TOKEN)}`),
      fetch(`${base}/api/agent/events?token=${encodeURIComponent(TOKEN)}`),
      fetch(`${base}/api/agent/events?sse=bad.token.here`),
      fetch(`${base}/api/does-not-exist`, { headers: H }),
      fetch(`${base}/api/projects/p1`, { headers: { Authorization: "Bearer wrong" } }),
    ];
    for (const p of probes) {
      const r = await p;
      const text = await r.text();
      assert.ok(!text.includes(TOKEN), `response body leaks the token (${r.status}): ${text.slice(0, 120)}`);
      assert.ok(!text.includes(encodeURIComponent(TOKEN)), "encoded token leaked");
    }
    s.child.kill();
  });

  t("malformed percent-encoding in a path is a 400, not a crash", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}` };
    // decodeURIComponent throws URIError on these; the server must answer
    // a client error, not die (and still serve the next request).
    const bad = await fetch(`${base}/api/projects/%E0%A4%A`, { headers: H });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await bad.json()).error, "Invalid URL encoding");
    const good = await fetch(`${base}/api/rooms/r1`, { headers: H });
    assert.strictEqual(good.status, 200, "server must survive the malformed request");
    s.child.kill();
  });

  t("handler guard: an internal failure answers generic 500 and the server stays up", async () => {
    // Regression test for a live crash found by this work: a throw inside a
    // route handler (here, storeUpload's mkdir over a blocking file) used
    // to kill the whole process — one bad request was a DoS for everyone.
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}` };
    fs.writeFileSync(path.join(s.dataDir, "uploads"), "blocking file");
    const failed = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { ...H, "x-file-name": "tower.ifc" },
      body: "ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n",
    });
    assert.strictEqual(failed.status, 500);
    const body = await failed.json();
    assert.strictEqual(body.error, "Internal error");
    assert.ok(!/ReferenceError|mkdir|uploads|Error:/.test(JSON.stringify(body)), "no internals leaked");
    // Remove the block: the same server answers normally — it never died.
    fs.rmSync(path.join(s.dataDir, "uploads"), { force: true });
    const ok = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { ...H, "x-file-name": "tower.ifc" },
      body: "ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n",
    });
    assert.strictEqual(ok.status, 200);
    s.child.kill();
  });

  t("agent relay: pending-order cap (503) and duplicate orderId (409)", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN, OBS_AGENT_MAX_PENDING: "2", OBS_AGENT_ORDER_TIMEOUT_MS: "300" });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    // A studio must be connected or exec answers 503 no-studio before any
    // pending order exists.
    const ac = new AbortController();
    const studio = await fetch(`${base}/api/agent/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
    assert.strictEqual(studio.status, 200);
    // Three concurrent orders against a cap of 2: two pend (and time out
    // after 300 ms), the third is refused.
    const exec = (id) => fetch(`${base}/api/agent/exec`, { method: "POST", headers: H, body: JSON.stringify({ orderId: id, cmd: "LINE 0,0 1,1" }) });
    const [a, b, c] = await Promise.all([exec("cap-1"), exec("cap-2"), exec("cap-3")].map((p) => p.then((r) => r.status)));
    assert.deepStrictEqual([a, b, c].sort(), [200, 200, 503]);
    // A duplicate orderId cannot hijack the earlier waiter's result.
    const first = exec("dup-1");
    await new Promise((r) => setTimeout(r, 50)); // let the first register
    const dup = await exec("dup-1");
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(await first.then((r) => r.status), 200);
    ac.abort();
    s.child.kill();
  });

  t("project PUT: schema + size bound (bad shape → 400, oversize → 413, valid PUT persists)", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN, OBS_MAX_PROJECT_BODY: "1024" });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    const arrayBody = await fetch(`${base}/api/projects/p1`, { method: "PUT", headers: H, body: JSON.stringify([1, 2]) });
    assert.strictEqual(arrayBody.status, 400);
    const badName = await fetch(`${base}/api/projects/p1`, { method: "PUT", headers: H, body: JSON.stringify({ name: 42 }) });
    assert.strictEqual(badName.status, 400);
    const longName = await fetch(`${base}/api/projects/p1`, { method: "PUT", headers: H, body: JSON.stringify({ name: "x".repeat(201) }) });
    assert.strictEqual(longName.status, 400);
    const big = await fetch(`${base}/api/projects/p1`, { method: "PUT", headers: H, body: JSON.stringify({ data: { blob: "x".repeat(4096) } }) });
    assert.strictEqual(big.status, 413);
    const ok = await fetch(`${base}/api/projects/p1`, { method: "PUT", headers: H, body: JSON.stringify({ name: "Tower", data: { a: 1 } }) });
    assert.strictEqual(ok.status, 200);
    const got = await fetch(`${base}/api/projects/p1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.strictEqual(got.status, 200);
    const proj = await got.json();
    assert.strictEqual(proj.name, "Tower");
    assert.deepStrictEqual(proj.data, { a: 1 });
    s.child.kill();
  });

  t("room actions: non-object body → 400; oversized cursor → 413; valid join still works", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    const arr = await fetch(`${base}/api/rooms/r1/join`, { method: "POST", headers: H, body: JSON.stringify([1]) });
    assert.strictEqual(arr.status, 400);
    const bigCursor = await fetch(`${base}/api/rooms/r1/join`, {
      method: "POST", headers: H,
      body: JSON.stringify({ clientId: "c1", cursor: { blob: "x".repeat(100 * 1024) } }),
    });
    assert.strictEqual(bigCursor.status, 413);
    const ok = await fetch(`${base}/api/rooms/r1/join`, {
      method: "POST", headers: H,
      body: JSON.stringify({ clientId: "c1", name: "Ada" }),
    });
    assert.strictEqual(ok.status, 200);
    s.child.kill();
  });

  t("default MAX_BODY is 16 MB for JSON, uploads keep their own 200 MB bound", async () => {
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const H = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    const big = "x".repeat(17 * 1024 * 1024);
    const res = await fetch(`${base}/api/projects/p1`, {
      method: "PUT", headers: H,
      body: JSON.stringify({ data: { blob: big } }),
    });
    assert.strictEqual(res.status, 413, "17 MB JSON body exceeds the 16 MB default");
    // ...but a 17 MB file still uploads: the upload path is bounded separately.
    const up = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "x-file-name": "big.ifc" },
      body: "ISO-10303-21;\n" + " ".repeat(17 * 1024 * 1024),
    });
    assert.strictEqual(up.status, 200);
    const upBody = await up.json();
    assert.strictEqual(upBody.mode, "manual");
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
    assert.ok(body.uploadId && /^[0-9a-z_-]{10,32}$/i.test(body.uploadId), "opaque id");
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
  // Await every collected test — sync and async alike — before reporting.
  // Without this the process can exit while integration bodies are still
  // waiting on their spawned servers (see the `t` note above).
  await Promise.all(pending);
  // Backstop: kill any server a failing test left behind and remove its
  // data dir (a passing test already killed its own child; double-kill
  // and double-remove are harmless).
  for (const { child, dataDir } of spawned) {
    try { child.kill(); } catch { /* already dead */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR", e); process.exit(1); });
