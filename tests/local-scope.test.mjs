// Real-browser test (Chromium + IndexedDB): per-account local-store scope and the explicit,
// non-destructive copy of unassigned local files. Skips when no Chromium is available.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("playwright-core")); } catch { /* */ }
const exe = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p))
  ?? (() => { try { const p = chromium?.executablePath(); return p && fs.existsSync(p) ? p : null; } catch { return null; } })();
if (!chromium || !exe) { console.log("  SKIP local-scope: no Chromium available"); process.exit(0); }

const bundle = await build({
  stdin: { contents: `export * from "./src/core/account-scope.ts"; export * from "./src/features/local-import.ts";`, resolveDir: root, loader: "ts" },
  bundle: true, format: "iife", globalName: "T", write: false, platform: "browser",
});
const code = bundle.outputFiles[0].text;

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.route("https://app.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>t</title>" }));
await page.goto("https://app.test/");
await page.addScriptTag({ content: code });

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// Seed the unassigned (pre-accounts) stores exactly as the app creates them.
await page.evaluate(async () => {
  const open = (name, ver, up) => new Promise((res, rej) => { const r = indexedDB.open(name, ver); r.onupgradeneeded = () => up(r.result); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const put = (db, s, v, k) => new Promise((res, rej) => { const tx = db.transaction(s, "readwrite"); const q = k === undefined ? tx.objectStore(s).put(v) : tx.objectStore(s).put(v, k); q.onsuccess = () => res(); q.onerror = () => rej(q.error); });
  const main = await open("open-bim-studio", 4, (db) => {
    db.createObjectStore("projects", { keyPath: "id" });
    db.createObjectStore("modelBlobs").createIndex("projectId", "projectId", { unique: false });
    db.createObjectStore("projectJournal", { keyPath: "id", autoIncrement: true });
  });
  await put(main, "projects", { id: "p1", name: "Guest tower" });
  await put(main, "modelBlobs", { projectId: "p1", bytes: new Uint8Array([1, 2, 3, 4]) }, "p1:1");
  await put(main, "projectJournal", { projectId: "p1", note: "journal stays behind" });
  main.close();
  const rec = await open("obs-cad-recent", 1, (db) => db.createObjectStore("drawings", { keyPath: "name" }));
  await put(rec, "drawings", { name: "plan.dxf", size: 10 });
  rec.close();
  localStorage.removeItem("obs.acct.owner");
});
const call = (expr) => page.evaluate(expr);

await t("guest scope keeps the original database names", async () => {
  assert.equal(await call(`T.scopedDbName("open-bim-studio")`), "open-bim-studio");
});
await t("each account gets its own database names; accounts differ", async () => {
  const [a, b] = await call(`[T.scopedDbName("open-bim-studio","a@x.com"), T.scopedDbName("open-bim-studio","b@x.com")]`);
  assert.notEqual(a, "open-bim-studio"); assert.notEqual(a, b);
  assert.equal(await call(`T.scopedDbName("open-bim-studio","A@X.com")`), a, "case-insensitive");
});
await t("signed-in account starts with empty local lists (nothing claimed automatically)", async () => {
  await call(`localStorage.setItem("obs.acct.owner","a@x.com")`);
  const names = await call(`indexedDB.databases().then(d=>d.map(x=>x.name))`);
  const aName = await call(`T.scopedDbName("open-bim-studio")`);
  assert.ok(!names.includes(aName), "account database must not exist until used or copied");
  assert.ok(names.includes("open-bim-studio"), "guest data still there");
});
await t("explicit copy: user-visible records copied, journals left behind, guest untouched", async () => {
  assert.equal(await call(`T.hasUnassignedLocalFiles()`), true);
  const copied = await call(`T.importUnassignedLocalFiles()`);
  assert.equal(copied, 3, "project + blob + drawing");
  const inspect = await call(`(async () => {
    const read = (db, s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
    const open = (n) => new Promise((res) => { const r = indexedDB.open(n); r.onsuccess = () => res(r.result); });
    const a = await open(T.scopedDbName("open-bim-studio")); const g = await open("open-bim-studio"); const d = await open(T.scopedDbName("obs-cad-recent"));
    const out = {
      aProjects: await read(a, "projects"), aBlobs: (await read(a, "modelBlobs")).map(b => Array.from(b.bytes)), aJournal: await read(a, "projectJournal"),
      aIdx: Array.from(a.transaction("modelBlobs").objectStore("modelBlobs").indexNames), aVer: a.version,
      gProjects: await read(g, "projects"), gJournal: await read(g, "projectJournal"), drawings: await read(d, "drawings"),
    };
    a.close(); g.close(); d.close(); return out; })()`);
  assert.deepEqual(inspect.aProjects, [{ id: "p1", name: "Guest tower" }]);
  assert.deepEqual(inspect.aBlobs, [[1, 2, 3, 4]]);
  assert.deepEqual(inspect.aJournal, [], "journal data is not copied");
  assert.deepEqual(inspect.aIdx, ["projectId"]); assert.equal(inspect.aVer, 4);
  assert.equal(inspect.gProjects.length, 1); assert.equal(inspect.gJournal.length, 1, "guest store untouched");
  assert.deepEqual(inspect.drawings, [{ name: "plan.dxf", size: 10 }]);
});
await t("re-running the copy never overwrites the account's own changes", async () => {
  await call(`(async () => { const r = await new Promise((res) => { const q = indexedDB.open(T.scopedDbName("open-bim-studio")); q.onsuccess = () => res(q.result); });
    await new Promise((res) => { const tx = r.transaction("projects", "readwrite"); tx.objectStore("projects").put({ id: "p1", name: "Edited by A" }); tx.oncomplete = res; }); r.close(); })()`);
  assert.equal(await call(`T.importUnassignedLocalFiles()`), 0);
  const name = await call(`new Promise((res) => { const q = indexedDB.open(T.scopedDbName("open-bim-studio")); q.onsuccess = () => { const g = q.result.transaction("projects").objectStore("projects").get("p1"); g.onsuccess = () => { q.result.close(); res(g.result.name); }; }; })`);
  assert.equal(name, "Edited by A");
});
await t("another account on the same browser sees none of it", async () => {
  await call(`localStorage.setItem("obs.acct.owner","b@x.com")`);
  const names = await call(`indexedDB.databases().then(d=>d.map(x=>x.name))`);
  assert.ok(!names.includes(await call(`T.scopedDbName("open-bim-studio")`)));
  assert.equal(await call(`T.importUnassignedLocalFiles().then(()=>"x")`), "x"); // explicit action only; B has chosen it here
  await call(`localStorage.setItem("obs.acct.owner","c@x.com")`);
  assert.ok(!(await call(`indexedDB.databases().then(d=>d.map(x=>x.name))`)).includes(await call(`T.scopedDbName("obs-cad-recent")`)));
});
await t("guest cannot import (needs an account)", async () => {
  await call(`localStorage.removeItem("obs.acct.owner")`);
  assert.equal(await call(`T.hasUnassignedLocalFiles()`), false);
  await assert.rejects(() => call(`T.importUnassignedLocalFiles()`));
});

await browser.close();
console.log(`\nlocal-scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
