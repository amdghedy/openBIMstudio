/* Share links — differentiation item 1.
 *
 * Covers the signed, single-room, role-scoped share tokens
 * (server/share-tokens.mjs) as pure functions, and the server end-to-end
 * against a spawned server on an ephemeral loopback port with an isolated
 * data dir: create/list/revoke, role enforcement on the project snapshot
 * and room changes, SSE authentication with ?share=, and revocation.
 *
 * Run: npm run test:share-links
 */
const assert = require("assert");
const { spawn } = require("child_process");
const crypto = require("node:crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0;
let fail = 0;
const children = [];

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + ": " + (e && e.message));
  }
}

/* Loader shim: the server module is ESM; load once via dynamic import. */
fs.mkdirSync(path.join(__dirname, "helpers"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "helpers", "share-tokens-loader.cjs"),
  `module.exports = import(${JSON.stringify("../../server/share-tokens.mjs")});\n`,
);
const loadShareTokens = async () => {
  const mod = await import("./helpers/share-tokens-loader.cjs");
  return await (mod.default ?? mod);
};

const serverPath = path.join(__dirname, "..", "server", "index.mjs");

function startServer(env) {
  return new Promise((resolve, reject) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-share-"));
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: "0", OBS_DATA_DIR: dataDir, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
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

function stopAll() {
  for (const c of children) {
    try { c.kill(); } catch { /* already dead */ }
  }
}

async function createShare(base, headers, body) {
  const res = await fetch(`${base}/api/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

/* ── Pure: share tokens ─────────────────────────────────────────────── */

async function pureTests(m) {
  const {
    issueShareToken,
    verifyShareToken,
    isShareRole,
    clampShareTtlMs,
    SHARE_TOKEN_DEFAULT_TTL_MS,
    SHARE_TOKEN_MAX_TTL_MS,
    SHARE_TOKEN_MIN_TTL_MS,
  } = m;
  const SECRET = "test-share-secret-32-chars-long!!";

  await t("issue + verify round-trips the payload", () => {
    const tok = issueShareToken(SECRET, { room: "r1", role: "view", sid: "sid-1", now: 1_000_000 });
    const v = verifyShareToken(tok, SECRET, { room: "r1", now: 1_000_001 });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.payload.room, "r1");
    assert.strictEqual(v.payload.role, "view");
    assert.strictEqual(v.payload.sid, "sid-1");
    assert.strictEqual(v.payload.exp, 1_000_000 + SHARE_TOKEN_DEFAULT_TTL_MS);
  });

  await t("tampered payload → bad-signature", () => {
    const tok = issueShareToken(SECRET, { room: "r1", role: "view", sid: "sid-1", now: 1_000_000 });
    const [head, sig] = tok.split(".");
    const payload = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    payload.role = "edit"; // escalate: re-encode without re-signing
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    const v = verifyShareToken(forged, SECRET, { room: "r1", now: 1_000_001 });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "bad-signature");
  });

  await t("wrong secret → bad-signature", () => {
    const tok = issueShareToken(SECRET, { room: "r1", role: "view", sid: "sid-1", now: 1_000_000 });
    const v = verifyShareToken(tok, "a-different-secret-32-chars!!", { room: "r1", now: 1_000_001 });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "bad-signature");
  });

  await t("expired token → expired", () => {
    const tok = issueShareToken(SECRET, { room: "r1", role: "view", sid: "sid-1", ttlMs: 60_000, now: 1_000_000 });
    const v = verifyShareToken(tok, SECRET, { room: "r1", now: 1_000_000 + 60_001 });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "expired");
  });

  await t("wrong room → wrong-room", () => {
    const tok = issueShareToken(SECRET, { room: "r1", role: "view", sid: "sid-1", now: 1_000_000 });
    const v = verifyShareToken(tok, SECRET, { room: "r2", now: 1_000_001 });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "wrong-room");
  });

  await t("forged role in a correctly signed token → bad-role", () => {
    // Sign a payload with an invented role using the known secret: the
    // signature is valid, so the role check itself must refuse it.
    const payloadStr = JSON.stringify({ room: "r1", role: "admin", sid: "sid-1", exp: 9_999_999_999 });
    const sig = crypto.createHmac("sha256", SECRET).update(payloadStr).digest().toString("base64url");
    const tok = `${Buffer.from(payloadStr).toString("base64url")}.${sig}`;
    const v = verifyShareToken(tok, SECRET, { room: "r1", now: 1_000_000 });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "bad-role");
  });

  await t("malformed tokens → malformed", () => {
    for (const bad of ["", "no-dot-here", "a.b.c", "!!!.AAA"]) {
      const v = verifyShareToken(bad, SECRET, { room: "r1", now: 1_000_000 });
      assert.strictEqual(v.ok, false, bad);
      assert.strictEqual(v.reason, "malformed", bad);
    }
    // Well-formed JSON payload, but unsigned: that is a signature failure,
    // not a malformed token.
    const unsigned = verifyShareToken("e30.AAA", SECRET, { room: "r1", now: 1_000_000 });
    assert.strictEqual(unsigned.ok, false);
    assert.strictEqual(unsigned.reason, "bad-signature");
  });

  await t("TTL clamping: default / min / max", () => {
    assert.strictEqual(clampShareTtlMs(undefined), SHARE_TOKEN_DEFAULT_TTL_MS);
    assert.strictEqual(clampShareTtlMs(NaN), SHARE_TOKEN_DEFAULT_TTL_MS);
    assert.strictEqual(clampShareTtlMs(1), SHARE_TOKEN_MIN_TTL_MS);
    assert.strictEqual(clampShareTtlMs(10 ** 12), SHARE_TOKEN_MAX_TTL_MS);
    assert.strictEqual(clampShareTtlMs(3_600_000), 3_600_000);
  });

  await t("issue validates its inputs", () => {
    assert.throws(() => issueShareToken("", { room: "r1", role: "view", sid: "s" }), /secret/);
    assert.throws(() => issueShareToken(SECRET, { room: "", role: "view", sid: "s" }), /room/);
    assert.throws(() => issueShareToken(SECRET, { room: "r1", role: "admin", sid: "s" }), /role/);
    assert.throws(() => issueShareToken(SECRET, { room: "r1", role: "view", sid: "" }), /sid/);
    assert.strictEqual(isShareRole("view"), true);
    assert.strictEqual(isShareRole("edit"), true);
    assert.strictEqual(isShareRole("admin"), false);
  });
}

/* ── Integration: spawned server ─────────────────────────────────────── */

async function integrationTests() {
  // Loopback mode (no server token): shares work with an ephemeral secret.
  await t("loopback: create view + edit shares → 201 with token; list → 2", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const view = await createShare(base, {}, { room: "proj-1", role: "view" });
    if (view.status !== 201) assert.fail(`create view share → ${view.status}: ${await view.text()}`);
    const viewBody = await view.json();
    assert.ok(viewBody.token && viewBody.sid && viewBody.expiresAt > Date.now());
    assert.strictEqual(viewBody.room, "proj-1");
    assert.strictEqual(viewBody.role, "view");
    const edit = await createShare(base, {}, { room: "proj-1", role: "edit" });
    assert.strictEqual(edit.status, 201);
    const list = await fetch(`${base}/api/shares`);
    assert.strictEqual(list.status, 200);
    const listed = (await list.json()).shares;
    assert.strictEqual(listed.length, 2);
    assert.ok(!("token" in listed[0]), "list must never return tokens");
    s.child.kill();
  });

  await t("loopback: create validates room + role → 400", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    assert.strictEqual((await createShare(base, {}, { room: "proj-1", role: "admin" })).status, 400);
    assert.strictEqual((await createShare(base, {}, { room: "../evil", role: "view" })).status, 400);
    assert.strictEqual((await createShare(base, {}, { room: "", role: "view" })).status, 400);
    s.child.kill();
  });

  await t("loopback: role enforcement on the project snapshot (view 403 / edit 200)", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const viewTok = (await (await createShare(base, {}, { room: "proj-1", role: "view" })).json()).token;
    const editTok = (await (await createShare(base, {}, { room: "proj-1", role: "edit" })).json()).token;
    const vh = { Authorization: `Bearer ${viewTok}` };
    const eh = { Authorization: `Bearer ${editTok}` };
    // View may read (project absent → 404 proves authentication passed).
    assert.strictEqual((await fetch(`${base}/api/projects/proj-1`, { headers: vh })).status, 404);
    // View may NOT overwrite the snapshot.
    const putView = await fetch(`${base}/api/projects/proj-1`, {
      method: "PUT", headers: { ...vh, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", data: "e30=" }),
    });
    assert.strictEqual(putView.status, 403);
    // Edit may publish; view may then read it back byte-identical.
    const putEdit = await fetch(`${base}/api/projects/proj-1`, {
      method: "PUT", headers: { ...eh, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", data: "aGVsbG8=" }),
    });
    assert.strictEqual(putEdit.status, 200);
    const got = await fetch(`${base}/api/projects/proj-1`, { headers: vh });
    assert.strictEqual(got.status, 200);
    assert.strictEqual((await got.json()).data, "aGVsbG8=");
    s.child.kill();
  });

  await t("loopback: role enforcement on room changes (view 403 except locks; edit 200)", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const viewTok = (await (await createShare(base, {}, { room: "proj-1", role: "view" })).json()).token;
    const editTok = (await (await createShare(base, {}, { room: "proj-1", role: "edit" })).json()).token;
    const vh = { Authorization: `Bearer ${viewTok}`, "Content-Type": "application/json" };
    const eh = { Authorization: `Bearer ${editTok}`, "Content-Type": "application/json" };
    const change = (headers, type) => fetch(`${base}/api/rooms/proj-1/change`, {
      method: "POST", headers,
      body: JSON.stringify({ clientId: "u1", type, payload: {} }),
    });
    assert.strictEqual((await change(vh, "wall-add")).status, 403);
    assert.strictEqual((await change(vh, "snapshot")).status, 403);
    assert.strictEqual((await change(vh, "lock")).status, 200, "viewers may still send selection locks");
    assert.strictEqual((await change(vh, "unlock")).status, 200);
    assert.strictEqual((await change(eh, "wall-add")).status, 200);
    // The room read shows the edit change and the lock, in order.
    const room = await (await fetch(`${base}/api/rooms/proj-1`, { headers: vh })).json();
    const types = room.changes.map((c) => c.type);
    assert.deepStrictEqual(types, ["lock", "unlock", "wall-add"]);
    s.child.kill();
  });

  await t("loopback: share token is single-room (other room → 401)", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const viewTok = (await (await createShare(base, {}, { room: "proj-1", role: "view" })).json()).token;
    const vh = { Authorization: `Bearer ${viewTok}`, "Content-Type": "application/json" };
    assert.strictEqual((await fetch(`${base}/api/projects/proj-2`, { headers: vh })).status, 401);
    const change = await fetch(`${base}/api/rooms/proj-2/change`, {
      method: "POST", headers: vh,
      body: JSON.stringify({ clientId: "u1", type: "lock", payload: {} }),
    });
    assert.strictEqual(change.status, 401);
    s.child.kill();
  });

  await t("loopback: SSE authenticates with ?share= (view + edit 200; garbage 401)", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const viewTok = (await (await createShare(base, {}, { room: "proj-1", role: "view" })).json()).token;
    const editTok = (await (await createShare(base, {}, { room: "proj-1", role: "edit" })).json()).token;
    const goodView = await fetch(`${base}/api/rooms/proj-1/events?share=${encodeURIComponent(viewTok)}`);
    assert.strictEqual(goodView.status, 200);
    goodView.body?.cancel?.();
    const goodEdit = await fetch(`${base}/api/rooms/proj-1/events?share=${encodeURIComponent(editTok)}`);
    assert.strictEqual(goodEdit.status, 200);
    goodEdit.body?.cancel?.();
    const bad = await fetch(`${base}/api/rooms/proj-1/events?share=garbage.token`);
    assert.strictEqual(bad.status, 401);
    bad.body?.cancel?.();
    s.child.kill();
  });

  await t("loopback: revoke kills the token everywhere (project, change, SSE, list)", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const view = await (await createShare(base, {}, { room: "proj-1", role: "view" })).json();
    const edit = await (await createShare(base, {}, { room: "proj-1", role: "edit" })).json();
    const vh = { Authorization: `Bearer ${view.token}` };
    const unknown = await fetch(`${base}/api/shares/nope/revoke`, { method: "POST" });
    assert.strictEqual(unknown.status, 404);
    const revoked = await fetch(`${base}/api/shares/${view.sid}/revoke`, { method: "POST" });
    assert.strictEqual(revoked.status, 200);
    assert.strictEqual((await fetch(`${base}/api/projects/proj-1`, { headers: vh })).status, 401);
    const change = await fetch(`${base}/api/rooms/proj-1/change`, {
      method: "POST", headers: { ...vh, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "u1", type: "lock", payload: {} }),
    });
    assert.strictEqual(change.status, 401);
    const sse = await fetch(`${base}/api/rooms/proj-1/events?share=${encodeURIComponent(view.token)}`);
    assert.strictEqual(sse.status, 401);
    sse.body?.cancel?.();
    const listed = (await (await fetch(`${base}/api/shares`)).json()).shares;
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].sid, edit.sid);
    s.child.kill();
  });

  await t("loopback: share token cannot touch non-room routes (agent exec → 401)", async () => {
    const s = await startServer({});
    const base = `http://127.0.0.1:${s.port}`;
    const viewTok = (await (await createShare(base, {}, { room: "proj-1", role: "view" })).json()).token;
    const res = await fetch(`${base}/api/agent/exec`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewTok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "wall" }),
    });
    assert.strictEqual(res.status, 401);
    s.child.kill();
  });

  // Token mode: the master token is the signing secret, so the test can
  // craft an expired token and prove the server refuses it.
  await t("token mode: master creates shares; share roles enforced; expired token → 401", async () => {
    const TOKEN = "test-server-token-32-chars-secret!!";
    const s = await startServer({ OBS_SERVER_TOKEN: TOKEN });
    const base = `http://127.0.0.1:${s.port}`;
    const mh = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
    assert.strictEqual((await fetch(`${base}/api/shares`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room: "proj-1", role: "view" }) })).status, 401);
    const view = await (await createShare(base, mh, { room: "proj-1", role: "view" })).json();
    const edit = await (await createShare(base, mh, { room: "proj-1", role: "edit" })).json();
    const vh = { Authorization: `Bearer ${view.token}`, "Content-Type": "application/json" };
    const eh = { Authorization: `Bearer ${edit.token}`, "Content-Type": "application/json" };
    assert.strictEqual((await fetch(`${base}/api/projects/proj-1`, {
      method: "PUT", headers: vh, body: JSON.stringify({ name: "x", data: "e30=" }),
    })).status, 403);
    assert.strictEqual((await fetch(`${base}/api/projects/proj-1`, {
      method: "PUT", headers: eh, body: JSON.stringify({ name: "x", data: "e30=" }),
    })).status, 200);
    // Expired token, signed with the known master secret.
    const shareMod = await loadShareTokens();
    const expired = shareMod.issueShareToken(TOKEN, {
      room: "proj-1", role: "view", sid: view.sid, ttlMs: 60_000, now: Date.now() - 120_000,
    });
    assert.strictEqual((await fetch(`${base}/api/projects/proj-1`, {
      headers: { Authorization: `Bearer ${expired}` },
    })).status, 401);
    s.child.kill();
  });
}

(async () => {
  const shareMod = await loadShareTokens();
  await pureTests(shareMod);
  await integrationTests();
  stopAll();
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR", e);
  stopAll();
  process.exit(1);
});
