/* Browser IFC import timeout: bounds are pure and grounded, the watchdog fires
 * on stall or total time with real timers, and the timeout error can never be
 * mistaken for a user cancellation (its message contains no "cancel"). */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "itmo-"));
execSync(`npx tsc src/modules/ifc-semantics/import-timeout.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const { computeImportTimeoutMs, IfcImportTimeoutError, ImportTimeout } = require(find(out, "import-timeout.js"));

let pass = 0, fail = 0;
const failures = [];
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; failures.push(n + ": " + e.message); console.log("  FAIL " + n + ": " + e.message); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pending = [];
const ta = (n, f) => { pending.push((async () => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; failures.push(n + ": " + e.message); console.log("  FAIL " + n + ": " + e.message); } })()); };

/* ── Bounds ─────────────────────────────────────────────────────────── */
t("bounds: small file gets the 5 min floor (2.3 MB measured at 2.5 s)", () => {
  const b = computeImportTimeoutMs(2.3);
  assert.strictEqual(b.stallMs, 120_000);
  assert.strictEqual(b.totalMs, 300_000);
});
t("bounds: 20 MB scales at 30 s/MB", () => {
  assert.strictEqual(computeImportTimeoutMs(20).totalMs, 600_000);
});
t("bounds: 350 MB (largest the browser attempts) hits the 30 min ceiling", () => {
  assert.strictEqual(computeImportTimeoutMs(350).totalMs, 1_800_000);
  assert.strictEqual(computeImportTimeoutMs(1000).totalMs, 1_800_000);
});
t("bounds: NaN/negative size degrades to the floor, never to 0", () => {
  assert.strictEqual(computeImportTimeoutMs(NaN).totalMs, 300_000);
  assert.strictEqual(computeImportTimeoutMs(-4).totalMs, 300_000);
});
t("bounds: stall override honoured; 0 disables the stall bound", () => {
  assert.strictEqual(computeImportTimeoutMs(1, { stallMs: 60_000 }).stallMs, 60_000);
  assert.strictEqual(computeImportTimeoutMs(1, { stallMs: 0 }).stallMs, 0);
});
t("bounds: stall below the 10 s minimum is clamped up, not honoured", () => {
  assert.strictEqual(computeImportTimeoutMs(1, { stallMs: 1_000 }).stallMs, 10_000);
});
t("bounds: non-finite/negative stall falls back to the default", () => {
  assert.strictEqual(computeImportTimeoutMs(1, { stallMs: NaN }).stallMs, 120_000);
  assert.strictEqual(computeImportTimeoutMs(1, { stallMs: -5 }).stallMs, 120_000);
});
t("bounds: total override honoured; below-minimum override clamped to 1 s", () => {
  assert.strictEqual(computeImportTimeoutMs(1, { totalMs: 600_000 }).totalMs, 600_000);
  assert.strictEqual(computeImportTimeoutMs(1, { totalMs: 500 }).totalMs, 1_000);
});
t("bounds: total override 0 means auto-scaled, not disabled", () => {
  assert.strictEqual(computeImportTimeoutMs(20, { totalMs: 0 }).totalMs, 600_000);
});

/* ── Error ──────────────────────────────────────────────────────────── */
t("error: names the file and the bound that fired, with a recovery hint", () => {
  const e = new IfcImportTimeoutError("total", "Duplex_MEP_20110907.ifc", 300_000, 301_000);
  assert.ok(e.message.includes("Duplex_MEP_20110907.ifc"));
  assert.ok(e.message.includes("total limit"));
  assert.ok(e.message.includes("raise the import timeout"));
  assert.strictEqual(e.kind, "total");
  assert.strictEqual(e.limitMs, 300_000);
});
t("error: message never contains 'cancel' — the importer must classify it as failed, not user-cancelled", () => {
  for (const kind of ["stall", "total"]) {
    const e = new IfcImportTimeoutError(kind, "x.ifc", 60_000, 61_000);
    assert.ok(!/cancel/i.test(e.message), `${kind}: message contains "cancel": ${e.message}`);
  }
});

/* ── Watchdog (real timers) ─────────────────────────────────────────── */
ta("watchdog: stall fires after inactivity", async () => {
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 40, totalMs: 10_000 }, { onTimeout: (e) => { got = e; } });
  w.start();
  await sleep(120);
  assert.ok(got, "no timeout fired");
  assert.strictEqual(got.kind, "stall");
  assert.ok(w.timedOut);
  w.clear();
});
ta("watchdog: poke() postpones the stall; stopping pokes lets it fire", async () => {
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 50, totalMs: 10_000 }, { onTimeout: (e) => { got = e; } });
  w.start();
  for (let i = 0; i < 5; i++) { await sleep(20); w.poke(); }
  assert.strictEqual(got, null, "stall fired while progress was arriving");
  await sleep(120);
  assert.ok(got && got.kind === "stall", "stall did not fire after pokes stopped");
  w.clear();
});
ta("watchdog: total fires even while progress keeps arriving", async () => {
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 10_000, totalMs: 60 }, { onTimeout: (e) => { got = e; } });
  w.start();
  for (let i = 0; i < 6; i++) { await sleep(15); w.poke(); }
  assert.ok(got, "total did not fire despite pokes");
  assert.strictEqual(got.kind, "total");
  w.clear();
});

/* ── Watchdog: synchronous total enforcement on poke() ─────────────── */
/* The single-thread conversion runs on the main thread, so no timer can
 * fire mid-conversion; poke() is the heartbeat that enforces the total
 * bound. These tests use a fake clock and no sleeps at all, modelling a
 * blocked event loop — a real-timer test cannot catch this, because its
 * own event loop is free. */
t("watchdog: poke() fires the total bound synchronously once it elapses (no timer involved)", () => {
  let now = 0;
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 0, totalMs: 3000 }, { onTimeout: (e) => { got = e; } }, () => now);
  w.start();
  now = 2999;
  w.poke();
  assert.strictEqual(got, null, "total fired before the bound elapsed");
  now = 3000;
  w.poke();
  assert.ok(got, "total did not fire from poke() at the bound");
  assert.strictEqual(got.kind, "total");
  assert.strictEqual(got.limitMs, 3000);
  assert.ok(w.timedOut);
  w.clear();
});
t("watchdog: poke() before start() never fires the total bound", () => {
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 0, totalMs: 3000 }, { onTimeout: (e) => { got = e; } }, () => 1_000_000);
  w.poke();
  assert.strictEqual(got, null, "poke before start fired");
  w.clear();
});
t("watchdog: total fires from poke() at most once", () => {
  let now = 0;
  let n = 0;
  const w = new ImportTimeout("a.ifc", { stallMs: 0, totalMs: 3000 }, { onTimeout: () => { n++; } }, () => now);
  w.start();
  now = 5000;
  w.poke(); w.poke(); w.poke();
  assert.strictEqual(n, 1, `onTimeout called ${n} times`);
  w.clear();
});
t("watchdog: poke() with totalMs 0 never fires the total bound", () => {
  let now = 0;
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 0, totalMs: 0 }, { onTimeout: (e) => { got = e; } }, () => now);
  w.start();
  now = 999_999;
  w.poke();
  assert.strictEqual(got, null, "total fired with totalMs 0");
  w.clear();
});
ta("watchdog: clear() prevents any firing", async () => {
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 30, totalMs: 30 }, { onTimeout: (e) => { got = e; } });
  w.start();
  w.clear();
  await sleep(100);
  assert.strictEqual(got, null, "timeout fired after clear()");
  assert.strictEqual(w.timedOut, false);
});
ta("watchdog: fires at most once when both bounds elapse together", async () => {
  let n = 0;
  const w = new ImportTimeout("a.ifc", { stallMs: 30, totalMs: 30 }, { onTimeout: () => { n++; } });
  w.start();
  await sleep(120);
  assert.strictEqual(n, 1, `onTimeout called ${n} times`);
  w.clear();
});
ta("watchdog: poke() after clear() cannot re-arm it (abandoned conversion keeps calling back)", async () => {
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 30, totalMs: 10_000 }, { onTimeout: (e) => { got = e; } });
  w.start();
  w.clear();
  w.poke();
  w.poke();
  await sleep(100);
  assert.strictEqual(got, null, "late poke re-armed a cleared watchdog");
  assert.strictEqual(w.timedOut, false);
});
ta("watchdog: stallMs 0 disables the stall bound", async () => {
  let got = null;
  const w = new ImportTimeout("a.ifc", { stallMs: 0, totalMs: 10_000 }, { onTimeout: (e) => { got = e; } });
  w.start();
  await sleep(80);
  assert.strictEqual(got, null, "stall fired with stallMs 0");
  w.clear();
});

(async () => {
  await Promise.all(pending);
  console.log(`\nimport-timeout: ${pass} passed, ${fail} failed.`);
  if (fail) { console.error("failures:\n" + failures.map((f) => " - " + f).join("\n")); process.exit(1); }
})();
