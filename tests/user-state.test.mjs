// Per-account preferences + recents + Google OAuth hardening: behavioural test of worker/auth.ts
// (real AuthVault code on an in-memory storage) plus drift guards for the client wiring.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const auth = await import(path.join(root, "worker", "auth.ts"));
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

const mem = new Map();
const storage = {
  async get(k) { return mem.get(k); },
  async put(k, v) { mem.set(k, structuredClone(v)); },
  async delete(k) { return mem.delete(k); },
  async list({ prefix = "" } = {}) { return new Map([...mem].filter(([k]) => k.startsWith(prefix))); },
};
const vault = new auth.AuthVault({ storage });
const call = (method, p, body, cookie) => vault.fetch(new Request(`https://do${p}`, {
  method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
}));
async function signUp(email) {
  const res = await call("POST", "/api/auth/register", { email, password: "secret123", name: email.split("@")[0] });
  assert.equal(res.status, 200, "register " + email);
  return res.headers.get("set-cookie").split(";")[0];
}

const cookieA = await signUp("a@example.com");
const cookieB = await signUp("b@example.com");

await t("state requires sign-in", async () => {
  assert.equal((await call("GET", "/api/user/state")).status, 401);
  assert.equal((await call("PUT", "/api/user/state", { prefs: {} })).status, 401);
});
await t("new account has no saved state", async () => {
  const j = await (await call("GET", "/api/user/state", undefined, cookieA)).json();
  assert.equal(j.state, null);
});
await t("prefs save per account and never leak to another account", async () => {
  const put = await call("PUT", "/api/user/state", { prefs: { "obs.theme.mode": "dark", "obs.locale": "ar" } }, cookieA);
  assert.equal(put.status, 200);
  const a = await (await call("GET", "/api/user/state", undefined, cookieA)).json();
  assert.equal(a.state.prefs["obs.locale"], "ar");
  const b = await (await call("GET", "/api/user/state", undefined, cookieB)).json();
  assert.equal(b.state, null, "account B must not see A's prefs");
});
await t("only whitelisted keys are stored", async () => {
  await call("PUT", "/api/user/state", { prefs: { "obs.theme.mode": "light", "evil.key": "x", "obs.xref.cache": "y" } }, cookieB);
  const b = await (await call("GET", "/api/user/state", undefined, cookieB)).json();
  assert.deepEqual(Object.keys(b.state.prefs), ["obs.theme.mode"]);
});
await t("oversized or non-string values are rejected", async () => {
  assert.equal((await call("PUT", "/api/user/state", { prefs: { "obs.locale": "x".repeat(9000) } }, cookieA)).status, 413);
  assert.equal((await call("PUT", "/api/user/state", { prefs: { "obs.locale": 5 } }, cookieA)).status, 413);
  assert.equal((await call("PUT", "/api/user/state", { prefs: [] }, cookieA)).status, 400);
});
await t("recents: opened/saved metadata follows the account, sorted by last use", async () => {
  const p1 = await (await call("POST", "/api/projects", { name: "First", data: btoa("one") }, cookieA)).json();
  await new Promise((r) => setTimeout(r, 5));
  const p2 = await (await call("POST", "/api/projects", { name: "Second", data: btoa("two") }, cookieA)).json();
  let list = (await (await call("GET", "/api/projects", undefined, cookieA)).json()).projects;
  assert.equal(list[0].name, "Second");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await call("GET", `/api/projects/${p1.project.id}`, undefined, cookieA)).status, 200);
  list = (await (await call("GET", "/api/projects", undefined, cookieA)).json()).projects;
  assert.equal(list[0].name, "First", "opening a project moves it to the top");
  assert.ok(list[0].openedAt > 0);
  assert.equal(list.length, 2);
  const other = (await (await call("GET", "/api/projects", undefined, cookieB)).json()).projects;
  assert.equal(other.length, 0, "account B sees none of A's projects");
  void p2;
});
await t("re-saving keeps openedAt", async () => {
  const list = (await (await call("GET", "/api/projects", undefined, cookieA)).json()).projects;
  const first = list.find((p) => p.name === "First");
  await call("POST", "/api/projects", { name: "First", id: first.id, data: btoa("one-v2") }, cookieA);
  const after = (await (await call("GET", "/api/projects", undefined, cookieA)).json()).projects.find((p) => p.id === first.id);
  assert.equal(after.openedAt, first.openedAt);
});

// ── Google OAuth hardening ──
const mkReq = (state, cookie) => new Request(`https://x.test/api/auth/google/callback?code=c&state=${state}`, { headers: cookie ? { cookie } : {} });
await t("oauth state: matching nonce cookie passes, missing/mismatched fails", () => {
  const n = auth.newOauthNonce();
  assert.ok(n.length >= 16);
  assert.equal(auth.oauthStateValid(mkReq(`app.${n}`, `obs_oauth=${n}`)), true);
  assert.equal(auth.oauthStateValid(mkReq(`app.${n}`)), false, "no cookie");
  assert.equal(auth.oauthStateValid(mkReq(`app.${n}`, "obs_oauth=other")), false, "different cookie");
  assert.equal(auth.oauthStateValid(mkReq("app", `obs_oauth=${n}`)), false, "legacy state without nonce");
  assert.equal(auth.parseOauthState(`popup.${n}`).popup, true);
  assert.equal(auth.parseOauthState(`app.${n}`).popup, false);
});
await t("start url carries state mode + nonce and keeps select_account", () => {
  const url = auth.googleStartUrl(new Request("https://x.test/api/auth/google/start"), { GOOGLE_CLIENT_ID: "id" }, "NONCE1");
  const q = new URL(url).searchParams;
  assert.equal(q.get("state"), "app.NONCE1");
  assert.equal(q.get("prompt"), "select_account");
  assert.equal(q.get("scope"), "openid email profile");
});
await t("callback rejects unverified Google email", async () => {
  const realFetch = globalThis.fetch;
  const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" };
  try {
    globalThis.fetch = async (u) => String(u).includes("token")
      ? new Response(JSON.stringify({ access_token: "t" }))
      : new Response(JSON.stringify({ email: "u@example.com", email_verified: false, sub: "1" }));
    await assert.rejects(() => auth.googleCallback(mkReq("app.n"), env), /email-not-verified/);
    globalThis.fetch = async (u) => String(u).includes("token")
      ? new Response(JSON.stringify({ access_token: "t" }))
      : new Response(JSON.stringify({ email: "u@example.com", email_verified: true, name: "U", sub: "1" }));
    const info = await auth.googleCallback(mkReq("app.n"), env);
    assert.equal(info.email, "u@example.com");
  } finally { globalThis.fetch = realFetch; }
});

// ── client + worker wiring drift guards ──
await t("worker routes /api/user/* to the vault and checks state in the callback", () => {
  const w = read("worker", "index.ts");
  assert.ok(w.includes('startsWith("/api/user/")'));
  assert.ok(w.includes("oauthStateValid(request)"));
  assert.ok(w.includes("oauthNonceCookie(nonce)"));
});
await t("client key list matches the server whitelist and never includes file data", () => {
  const server = [...read("worker", "auth.ts").match(/USER_PREF_KEYS: readonly string\[\] = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const client = [...read("src", "features", "user-state.ts").match(/USER_PREF_KEYS: readonly string\[\] = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(client, server);
  assert.ok(server.length >= 10);
  assert.ok(!server.some((k) => /xref|dynblock|gbxml|\.local$|journal|recovery/.test(k)));
});
await t("user switch backs up before clearing; account wires sync + flush on sign-out", () => {
  const u = read("src", "features", "user-state.ts");
  assert.ok(u.indexOf("BACKUP_PREFIX + owner") < u.indexOf("clearPrefs();"), "backup must precede clear");
  const a = read("src", "features", "cloud-account.ts");
  assert.ok(a.includes("startUserStateSync(r.user.email)"));
  assert.ok(a.includes("await flushUserState()"));
});

console.log(`\nuser-state: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
