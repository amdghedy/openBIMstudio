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

// ── client behaviour: account switching, backups, failures (real user-state.ts, fake browser) ──
function makeBrowser(serverByUser) {
  const store = new Map(), session = new Map();
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
  const ss = { getItem: (k) => (session.has(k) ? session.get(k) : null), setItem: (k, v) => void session.set(k, String(v)), removeItem: (k) => void session.delete(k) };
  const net = { up: true, puts: [], user: null };
  globalThis.localStorage = ls; globalThis.sessionStorage = ss;
  globalThis.window = { addEventListener() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.fetch = async (url, init = {}) => {
    if (!net.up) throw new Error("offline");
    if (init.method === "PUT") {
      const prefs = JSON.parse(init.body).prefs; net.puts.push({ user: net.user, prefs });
      serverByUser[net.user] = { prefs }; return new Response("{}");
    }
    return new Response(JSON.stringify({ state: serverByUser[net.user] ?? null }));
  };
  return { store, session, net };
}
let n = 0;
const { build } = await import("esbuild");
const os = await import("node:os");
const bundled = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "obs-us-")), "user-state.mjs");
await build({ entryPoints: [path.join(root, "src", "features", "user-state.ts")], bundle: true, format: "esm", outfile: bundled, logLevel: "silent" });
const fresh = async () => import(bundled + `?v=${++n}`);
const prefsOf = (store) => Object.fromEntries([...store].filter(([k]) => ["obs.theme.mode", "obs.locale", "obs.projects.lastId", "obs.nativeIfc.history.v1"].includes(k)));

await t("guest -> A -> B -> A: every set of preferences returns, local files/recents untouched", async () => {
  const server = {};
  const b = makeBrowser(server);
  const localFiles = { "obs.projects.docs": "guest-and-A-local-project-list", "obs.drawings.history": "recent-drawings", "obs.xref.cache": "x" };
  for (const [k, v] of Object.entries(localFiles)) b.store.set(k, v);
  b.store.set("obs.theme.mode", "light"); b.store.set("obs.projects.lastId", "proj-guest"); b.store.set("obs.nativeIfc.history.v1", "guest-ifc-list");
  let m = await fresh();
  b.net.user = "a@x.com";
  assert.equal(await m.startUserStateSync("a@x.com"), true, "first sign-in reloads so the account's local-store scope applies");
  assert.equal(server["a@x.com"].prefs["obs.theme.mode"], "light", "appearance carries over");
  assert.equal(server["a@x.com"].prefs["obs.projects.lastId"], undefined, "guest's last-project pointer is not claimed by the account");
  assert.equal(b.store.get("obs.nativeIfc.history.v1"), undefined, "guest's local lists are not shown to the account");
  assert.equal(JSON.parse(b.store.get("obs.acct.backup.__guest__"))["obs.nativeIfc.history.v1"], "guest-ifc-list", "guest copy kept");
  assert.equal(JSON.parse(b.store.get("obs.acct.backup.__guest__"))["obs.theme.mode"], "light", "guest copy kept");
  b.store.set("obs.theme.mode", "dark"); b.store.set("obs.locale", "ar"); b.store.set("obs.projects.lastId", "proj-A"); b.store.set("obs.nativeIfc.history.v1", "A-ifc-list");
  await m.flushUserState();                                     // A's edits (same session) are uploaded
  assert.equal(server["a@x.com"].prefs["obs.locale"], "ar");

  m = await fresh(); b.net.user = "b@x.com";                    // B arrives on the same browser
  const reloadB = await m.startUserStateSync("b@x.com");
  assert.equal(reloadB, true);
  assert.deepEqual(prefsOf(b.store), {}, "B does not see A's preferences or last project");
  assert.equal(JSON.parse(b.store.get("obs.acct.backup.a@x.com"))["obs.projects.lastId"], "proj-A", "A's keys backed up, not deleted");
  b.store.set("obs.theme.mode", "blue"); await m.flushUserState();
  assert.equal(server["b@x.com"].prefs["obs.theme.mode"], "blue");
  assert.equal(server["a@x.com"].prefs["obs.theme.mode"], "dark", "B's changes never reach A");

  m = await fresh(); b.net.user = "a@x.com";                    // A returns
  await m.startUserStateSync("a@x.com");
  assert.deepEqual(prefsOf(b.store), { "obs.theme.mode": "dark", "obs.locale": "ar", "obs.projects.lastId": "proj-A", "obs.nativeIfc.history.v1": "A-ifc-list" });
  for (const [k, v] of Object.entries(localFiles)) assert.equal(b.store.get(k), v, k + " (local files/recents) untouched");
});
await t("sign-out returns the browser to the original guest preferences (and keeps the account backup)", async () => {
  const server = {};
  const b = makeBrowser(server);
  b.store.set("obs.theme.mode", "light"); b.store.set("obs.nativeIfc.history.v1", "guest-ifc-list"); b.store.set("obs.projects.lastId", "proj-guest");
  let m = await fresh(); b.net.user = "a@x.com";
  await m.startUserStateSync("a@x.com");
  b.store.set("obs.theme.mode", "dark");
  const changed = await m.signOutRestoreGuest();
  assert.equal(changed, true);
  assert.equal(b.store.get("obs.theme.mode"), "light", "guest preference restored");
  assert.equal(b.store.get("obs.nativeIfc.history.v1"), "guest-ifc-list", "guest local list restored");
  assert.equal(b.store.get("obs.projects.lastId"), "proj-guest", "guest last-project pointer restored");
  assert.equal(b.store.get("obs.acct.owner"), null, "browser is back in the guest scope");
  assert.equal(server["a@x.com"].prefs["obs.theme.mode"], "dark", "account settings were synced before sign-out");
  assert.equal(JSON.parse(b.store.get("obs.acct.backup.a@x.com"))["obs.theme.mode"], "dark");
});
await t("sync failure never applies or uploads another account's state", async () => {
  const server = { "b@x.com": { prefs: { "obs.theme.mode": "blue" } } };
  const b = makeBrowser(server);
  b.store.set("obs.acct.owner", "a@x.com"); b.store.set("obs.theme.mode", "dark"); b.store.set("obs.projects.lastId", "proj-A");
  b.net.up = false;
  let m = await fresh(); b.net.user = "b@x.com";
  await m.startUserStateSync("b@x.com");
  assert.deepEqual(prefsOf(b.store), {}, "A's state is gone from B's session even though the server is unreachable");
  assert.equal(b.net.puts.length, 0, "nothing uploaded while offline");
  assert.equal(JSON.parse(b.store.get("obs.acct.backup.a@x.com"))["obs.theme.mode"], "dark");
  // A comes back while still offline: only A's own backup is applied
  m = await fresh(); b.net.user = "a@x.com";
  await m.startUserStateSync("a@x.com");
  assert.equal(b.store.get("obs.theme.mode"), "dark");
  assert.equal(b.net.puts.length, 0);
});
await t("a failed read never overwrites the saved server settings with local ones", async () => {
  const server = { "a@x.com": { prefs: { "obs.theme.mode": "dark" } } };
  const b = makeBrowser(server);
  b.store.set("obs.theme.mode", "light");     // guest prefs
  b.net.up = false;
  const m = await fresh(); b.net.user = "a@x.com";
  await m.startUserStateSync("a@x.com");
  b.net.up = true; await m.flushUserState();
  assert.equal(b.net.puts.length, 0, "no upload after a failed read");
  assert.equal(server["a@x.com"].prefs["obs.theme.mode"], "dark", "saved account settings intact");
});
await t("expired session: server says signed out -> account scope ends, guest restored, nothing lost", async () => {
  const b = makeBrowser({});
  b.store.set("obs.theme.mode", "light"); b.store.set("obs.nativeIfc.history.v1", "guest-ifc-list");
  let m = await fresh(); b.net.user = "a@x.com";
  await m.startUserStateSync("a@x.com");
  b.store.set("obs.nativeIfc.history.v1", "A-ifc-list");
  m = await fresh();
  assert.equal(m.endStaleAccountScope(), true);
  assert.equal(b.store.get("obs.nativeIfc.history.v1"), "guest-ifc-list");
  assert.equal(JSON.parse(b.store.get("obs.acct.backup.a@x.com"))["obs.nativeIfc.history.v1"], "A-ifc-list");
  assert.equal(m.endStaleAccountScope(), false, "idempotent for a plain guest");
});
await t("oversized values stay local and never break the sync of the other settings", async () => {
  const server = {};
  const b = makeBrowser(server);
  b.store.set("obs.theme.mode", "dark"); b.store.set("obs.options.v1", "x".repeat(9000)); b.store.set("obs.cad.drawingSession.v1", "per-drawing-sessions");
  const m = await fresh(); b.net.user = "a@x.com";
  await m.startUserStateSync("a@x.com"); await m.flushUserState();
  assert.equal(server["a@x.com"].prefs["obs.theme.mode"], "dark");
  assert.equal(server["a@x.com"].prefs["obs.options.v1"], undefined);
  assert.equal(server["a@x.com"].prefs["obs.cad.drawingSession.v1"], undefined, "2D per-drawing sessions are account-scoped locally, not uploaded");
  assert.equal(b.store.get("obs.options.v1").length, 9000, "local value untouched");
});
await t("user-state never touches IndexedDB or local file stores", () => {
  const u = read("src", "features", "user-state.ts").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/indexedDB/.test(u));
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
  assert.ok(a.includes("signOutRestoreGuest()"));
  assert.ok(a.indexOf("signOutRestoreGuest()") < a.indexOf('api("/api/auth/logout"'), "sync must happen before the session ends");
});

console.log(`\nuser-state: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
