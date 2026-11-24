// Per-account secrets (AI keys) + no remembered emails + unsaved-work guard: behavioural test of the real
// core/secure-store.ts (bundled for node, no WebCrypto/IndexedDB so secrets use the in-memory fallback)
// plus drift guards for the client wiring.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sec-")), "ss.mjs");
await build({ entryPoints: [path.join(root, "src/core/secure-store.ts")], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
const ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k),
  key: (i) => [...ls.keys()][i] ?? null, get length() { return ls.size; },
};
let n = 0;
async function load(owner) {
  if (owner) ls.set("obs.acct.owner", owner); else ls.delete("obs.acct.owner");
  const m = await import(pathToFileURL(out).href + "?v=" + ++n);
  await m.initSecureStore();
  return m;
}
// Secrets as the no-WebCrypto fallback stores them (plain test values, never real keys).
const hashA = "x"; // any tag: the scoped name only needs to differ from the guest name
ls.set("obs.secure.ai.key", "GUEST-KEY");

await t("signed out: the existing device key is still there", async () => {
  const m = await load(null);
  assert.equal(m.secureGet("ai.key"), "GUEST-KEY");
});
await t("account A starts with no key (no inheritance) and its key is stored under a separate name", async () => {
  const m = await load("a@example.com");
  assert.equal(m.secureGet("ai.key"), null);
  m.secureSet("ai.key", "A-KEY");
  const names = [...ls.keys()].filter((k) => k.startsWith("obs.secure."));
  assert.ok(names.includes("obs.secure.ai.key"), "guest entry untouched");
  assert.equal(ls.get("obs.secure.ai.key"), "GUEST-KEY");
});
await t("account B cannot see A's or the guest's key", async () => {
  const m = await load("b@example.com");
  assert.equal(m.secureGet("ai.key"), null);
  assert.deepEqual(m.secureNames(""), []);
});
await t("signed out again: guest key back, A's key not visible", async () => {
  const m = await load(null);
  assert.equal(m.secureGet("ai.key"), "GUEST-KEY");
  assert.deepEqual(m.secureNames(""), ["ai.key"]);
});
await t("legacy plaintext is adopted only by the signed-out scope", async () => {
  ls.set("legacy.k", "OLD");
  const g = await load("c@example.com");
  assert.equal(g.migrateLegacy("ai.key2", "legacy.k"), null);
  assert.equal(ls.get("legacy.k"), "OLD", "legacy value left in place for the device scope");
  const d = await load(null);
  assert.equal(d.migrateLegacy("ai.key2", "legacy.k"), "OLD");
});

const acct = read("src/features/cloud-account.ts");
const prov = read("src/features/ai-providers.ts");
await t("remembered emails are not stored and the old list is deleted", () => {
  assert.ok(acct.includes('localStorage.removeItem(REMEMBER_KEY)'));
  assert.ok(!/localStorage\.setItem\(REMEMBER_KEY/.test(acct));
});
await t("AI provider never adopts a legacy key inside an account", () => {
  assert.ok(prov.includes("!currentScopeOwner()"));
});
await t("account switch / sign-out never reload silently over open work", () => {
  assert.ok(acct.includes("function confirmScopeSwitch"));
  assert.ok(acct.includes("anyUnsavedWork()"));
  assert.ok(!/performance\.now\(\) - pageLoadedAt/.test(acct), "no time-based shortcut over unsaved work");
  assert.ok(read("src/features/cad-viewer.ts").includes("registerDirtyCheck(() => tabs.some((t) => t.engine.isDirty()))"), "2D drawings must report unsaved work");
  assert.ok(acct.includes('confirmDialog("Sign out?'));
  assert.ok(acct.includes("justLanded = true"));
  assert.ok(acct.includes("accountScopeDiffers("));
});
await t("declined reload fails closed: lock, no cloud calls, no sync, escape hatches", () => {
  assert.ok(acct.includes("lockForIdentityMismatch(email)"));
  const lock = acct.slice(acct.indexOf("function lockForIdentityMismatch"), acct.indexOf("/** Ask the server who we are"));
  assert.ok(lock.includes("identityLocked = true") && lock.includes("stopUserStateSync()"));
  assert.ok(lock.includes("position:fixed;inset:0"), "full-page blocker");
  assert.ok(lock.includes("/api/auth/logout"), "can sign the new account out and keep working");
  assert.ok(acct.includes('identityLocked && !path.startsWith("/api/auth/")'), "api must refuse non-auth calls while locked");
  const me = acct.slice(acct.indexOf("export function refreshAccountState"), acct.indexOf("function ensureStyle"));
  const iDecl = me.indexOf("lockForIdentityMismatch(email)"), iSync = me.indexOf("await startUserStateSync(email)");
  assert.ok(iDecl > 0 && iDecl < iSync, "a declined switch must never reach startUserStateSync");
  assert.ok(me.includes("!scopeDeclined"), "declined session-end prompt is not repeated");
});
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
