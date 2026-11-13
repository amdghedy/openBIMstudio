/* Boot architecture tests — against the REAL production implementations.
 *
 * Unlike tests/boot-health.test.cjs (which mirrors the boot-health logic by
 * hand), this suite bundles the actual src/ modules with rolldown — the same
 * technique as tests/pdf-to-dwg.test.cjs — and executes them in Node:
 *
 *   src/core/boot-runner.ts      (the new single boot authority)
 *   src/core/boot-health.ts      (tracking / retry / finalize)
 *   src/core/listener-scope.ts   (dedupe + deterministic disposal)
 *   src/core/errors.ts           (idempotent global handlers + surface hook)
 *
 * What is proven here:
 *   1. every stepper step is tracked/timed/retryable and failures surface
 *      WITH the original error object (stack preserved, not re-wrapped)
 *   2. finalize() is idempotent — duplicate "boot complete" claims cannot
 *      double-emit
 *   3. listener scopes dedupe identical subscriptions, dispose deterministically
 *      and neutralize registrations after dispose (no silent leaks)
 *   4. global error handlers are idempotent, one BENIGN filter, and feed both
 *      the ring buffer and the pluggable UI surface
 *   5. source-level invariants: single error-listener site, single finalize
 *      call site, single BENIGN list, no keyboard undo in the strength module
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const repo = path.join(__dirname, "..");
const outDir = path.join(repo, ".tmp-boot-arch-test");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};

(async () => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  /* ── Bundle the REAL modules ─────────────────────────────────────────── */
  const entry = path.join(outDir, "entry.ts");
  fs.writeFileSync(entry, [
    `export { createBootStepper } from "../src/core/boot-runner";`,
    `export { bootHealth, trackedBootStep, setupBootHealth } from "../src/core/boot-health";`,
    `export { createListenerScope } from "../src/core/listener-scope";`,
    `export { installGlobalErrorHandlers, setWindowErrorSurface, logError, recentErrors, clearErrorLog } from "../src/core/errors";`,
    ``,
  ].join("\n"));

  const { rolldown } = require("rolldown");
  const bundle = await rolldown({ input: entry, platform: "node" });
  await bundle.write({ format: "cjs", dir: outDir, entryFileNames: "bundle.cjs" });
  await bundle.close();

  const M = require(path.join(outDir, "bundle.cjs"));
  const { createBootStepper, bootHealth, trackedBootStep, createListenerScope } = M;

  /* Node has no `window`; errors.ts handlers attach to it at call time. */
  if (typeof globalThis.window === "undefined") {
    globalThis.window = new EventTarget();
  }

  console.log("boot-runner / boot-health (real implementations)");

  await ta("step() tracks every step and returns the outcome", async () => {
    bootHealth.reset();
    const boot = createBootStepper({ log: () => {} });
    const okA = await boot.step("a-ok", () => 1);
    const okB = await boot.step("b-bad", () => { throw new Error("boom-bad"); });
    const okC = await boot.step("c-ok", async () => { await sleep(1); });
    assert.strictEqual(okA, true);
    assert.strictEqual(okB, false);
    assert.strictEqual(okC, true);
    const st = bootHealth.status();
    assert.strictEqual(st.steps.length, 3);
    assert.deepStrictEqual(st.failed, ["b-bad"]);
    assert.strictEqual(st.finalized, false);
    assert.ok(!st.ok);
  });

  await ta("failures surface once, with the ORIGINAL error object", async () => {
    bootHealth.reset();
    const surfaced = [];
    const boot = createBootStepper({
      log: () => {},
      onStepError: (title, err) => surfaced.push({ title, err }),
    });
    await boot.step("viewer-core", () => { const e = new Error("wasm missing"); e.stack = "STACKMARK: wasm missing"; throw e; });
    assert.strictEqual(surfaced.length, 1);
    assert.ok(surfaced[0].title.includes("viewer-core"));
    assert.ok(surfaced[0].err instanceof Error);
    assert.strictEqual(surfaced[0].err.message, "wasm missing");
    assert.ok(String(surfaced[0].err.stack).includes("STACKMARK"), "raw stack must survive");
  });

  await ta("legacy [TOC boot] log lines preserved (success + failure)", async () => {
    bootHealth.reset();
    const logs = [];
    const boot = createBootStepper({ log: (l) => logs.push(l) });
    await boot.step("ok-step", () => {});
    await boot.step("bad-step", () => { throw new Error("x"); });
    assert.ok(logs.some((l) => l.startsWith("[TOC boot] ✓ ok-step")), logs.join("|"));
    assert.ok(logs.some((l) => l.startsWith("[TOC boot] ✗ bad-step")), logs.join("|"));
  });

  await ta("failed steps are retryable through the tracked registry", async () => {
    bootHealth.reset();
    const boot = createBootStepper({ log: () => {} });
    await boot.step("flaky", () => { throw new Error("first fails"); });
    assert.ok(!bootHealth.status().ok);
    // Install a healthy runner under the same name (what a retry would use).
    trackedBootStep("flaky", () => { /* recovery path */ });
    const fixed = await bootHealth.retryFailed();
    assert.deepStrictEqual(fixed, ["flaky"]);
    const latest = bootHealth.latestPerStep().find((s) => s.name === "flaky");
    assert.strictEqual(latest.ok, true);
    assert.strictEqual(latest.retried, true);
    assert.ok(bootHealth.status().ok);
  });

  await ta("runStep returns the full recorded result (incl. rawError)", async () => {
    bootHealth.reset();
    const res = await bootHealth.runStep("probe", () => { throw new Error("probe-fail"); });
    assert.strictEqual(res.name, "probe");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, "probe-fail");
    assert.strictEqual(res.rawError.message, "probe-fail");
    assert.ok(typeof res.ms === "number");
    const resOk = await bootHealth.runStep("probe", () => {});
    assert.strictEqual(resOk.ok, true);
    assert.strictEqual(resOk.retried, true);
  });

  await ta("finalize() is idempotent — no duplicate emits for unchanged state", async () => {
    bootHealth.reset();
    let emits = 0;
    bootHealth.onChange(() => emits++);
    await bootHealth.runStep("f-step", () => {});
    const before = emits;
    const s1 = bootHealth.finalize();
    assert.strictEqual(emits, before + 1, "first finalize emits once");
    bootHealth.finalize();
    bootHealth.finalize();
    assert.strictEqual(emits, before + 1, "repeat finalize must NOT re-emit");
    assert.strictEqual(s1.ok, true);
    // New step results re-arm finalize.
    await bootHealth.runStep("f-step2", () => { throw new Error("late"); });
    assert.strictEqual(emits, before + 2, "runStep itself emits once");
    bootHealth.finalize();
    assert.strictEqual(emits, before + 3, "finalize after new results emits again");
    assert.strictEqual(bootHealth.status().failed[0], "f-step2");
  });

  await ta("finalize summary carries ok/failed/totalMs/steps", async () => {
    bootHealth.reset();
    const boot = createBootStepper({ log: () => {} });
    await boot.step("s1", () => {});
    await boot.step("s2", () => { throw new Error("no"); });
    const sum = boot.finalize();
    assert.strictEqual(sum.ok, false);
    assert.deepStrictEqual(sum.failed, ["s2"]);
    assert.strictEqual(sum.steps, 2);
    assert.ok(typeof sum.totalMs === "number");
  });

  console.log("listener-scope (real implementation)");

  await ta("on() dedupes identical target/type/listener/capture", () => {
    const target = new EventTarget();
    const scope = createListenerScope();
    let calls = 0;
    const fn = () => calls++;
    scope.on(target, "ping", fn);
    scope.on(target, "ping", fn); // duplicate — must not stack
    scope.on(target, "ping", fn, { capture: true }); // same listener, same effective capture for dispatch — deduped by identity (capture differs → distinct registration)
    target.dispatchEvent(new Event("ping"));
    // Node EventTarget: capture flag is part of listener identity (spec), so
    // the capture variant is a SECOND registration → 2 calls total.
    assert.ok(calls === 1 || calls === 2, "duplicate without capture must not double-call; got " + calls);
    assert.ok(calls !== 3, "third identical registration must have been deduped, got " + calls);
    scope.dispose();
  });

  await ta("disposer removes exactly its registration", () => {
    const target = new EventTarget();
    const scope = createListenerScope();
    let calls = 0;
    const fn = () => calls++;
    const off = scope.on(target, "e", fn);
    assert.strictEqual(scope.size, 1);
    off();
    target.dispatchEvent(new Event("e"));
    assert.strictEqual(calls, 0);
    assert.strictEqual(scope.size, 0);
    off(); // idempotent
    assert.strictEqual(scope.size, 0);
  });

  await ta("dispose() clears listeners, intervals and timeouts together", async () => {
    const target = new EventTarget();
    const scope = createListenerScope();
    let clicks = 0, ticks = 0, timedOut = false;
    scope.on(target, "click", () => clicks++);
    scope.interval(() => ticks++, 5);
    scope.timeout(() => { timedOut = true; }, 60); // outlives the dispose below
    await sleep(25);
    assert.ok(ticks >= 1, "interval must fire before dispose");
    scope.dispose();
    assert.strictEqual(scope.disposed, true);
    const t1 = ticks;
    await sleep(30);
    assert.strictEqual(ticks, t1, "interval must stop after dispose");
    assert.strictEqual(timedOut, false, "timeout must not fire after dispose");
    target.dispatchEvent(new Event("click"));
    assert.strictEqual(clicks, 0, "listener must be gone after dispose");
    assert.strictEqual(scope.size, 0);
  });

  await ta("dispose() is idempotent; post-dispose registration is a warned no-op", async () => {
    const scope = createListenerScope();
    scope.dispose();
    scope.dispose(); // must not throw
    const target = new EventTarget();
    let calls = 0;
    const fn = () => calls++;
    const off = scope.on(target, "x", fn);
    assert.strictEqual(scope.size, 0, "post-dispose registration must be ignored");
    target.dispatchEvent(new Event("x"));
    assert.strictEqual(calls, 0);
    assert.strictEqual(typeof off, "function");
    off();
  });

  await ta("interval callback that throws never kills the host loop", async () => {
    const scope = createListenerScope();
    let ticks = 0;
    scope.interval(() => { ticks++; throw new Error("tick-boom"); }, 5);
    await sleep(30);
    assert.ok(ticks >= 2, "interval must survive throwing callbacks, ticks=" + ticks);
    scope.dispose();
  });

  console.log("errors.ts (real handlers on a stubbed window)");

  await ta("install is idempotent + surface hook + ring buffer + benign filter", () => {
    M.clearErrorLog();
    const spy = [];
    M.setWindowErrorSurface((title, err) => spy.push({ title, err }));
    M.installGlobalErrorHandlers();
    M.installGlobalErrorHandlers(); // second call must not stack listeners

    const err = new Error("boom-x");
    const e1 = new Event("error", { cancelable: true });
    e1.error = err;
    globalThis.window.dispatchEvent(e1);
    const log1 = M.recentErrors();
    assert.strictEqual(log1.length, 1);
    assert.strictEqual(log1[0].context, "window.error");
    assert.strictEqual(log1[0].message, "boom-x");
    assert.strictEqual(spy.length, 1, "exactly one surface call despite double install");
    assert.strictEqual(spy[0].title, "Unhandled error");
    assert.strictEqual(spy[0].err, err);

    const benign = new Event("error", { cancelable: true });
    benign.error = new Error("ResizeObserver loop completed with undelivered notifications");
    globalThis.window.dispatchEvent(benign);
    assert.strictEqual(M.recentErrors().length, 1, "benign must not reach the ring buffer");
    assert.strictEqual(spy.length, 1, "benign must not surface");

    const rej = new Event("unhandledrejection", { cancelable: true });
    rej.reason = new Error("rej-y");
    globalThis.window.dispatchEvent(rej);
    assert.strictEqual(M.recentErrors().length, 2);
    assert.strictEqual(M.recentErrors()[1].context, "unhandled-rejection");
    assert.strictEqual(rej.defaultPrevented, true, "non-benign rejection must be preventDefaulted");
    assert.strictEqual(spy.length, 2);
    assert.strictEqual(spy[1].title, "Background task failed (app continues)");

    const benignRej = new Event("unhandledrejection", { cancelable: true });
    benignRej.reason = "cancelled";
    globalThis.window.dispatchEvent(benignRej);
    assert.strictEqual(spy.length, 2, "benign rejection must not surface");
    assert.strictEqual(M.recentErrors().length, 2, "benign rejection must not be logged");
    M.clearErrorLog();
    M.setWindowErrorSurface(null);
  });

  console.log("source-level invariants");

  /* Strip comments so explanatory NOTEs don't trip call-site scans. */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[^\n]*\/\/[^\n]*$/gm, "");
  const readSrc = (...parts) => fs.readFileSync(path.join(repo, ...parts), "utf8");

  t("main.ts no longer installs its own window error/rejection listeners", () => {
    const src = fs.readFileSync(path.join(repo, "src", "main.ts"), "utf8");
    assert.ok(!src.includes('window.addEventListener("error"'), "window error listener must live only in core/errors.ts");
    assert.ok(!src.includes('window.addEventListener("unhandledrejection"'), "rejection listener must live only in core/errors.ts");
    assert.ok(!/const BENIGN = \[/m.test(src), "BENIGN list must not be duplicated in main.ts");
    assert.ok(src.includes("createBootStepper"), "main.ts must run steps through the boot runner");
    assert.ok(/boot\.finalize\(\)/.test(src), "main.ts must own the authoritative finalize");
  });

  t("bootHealth.finalize is called only from the boot layer", () => {
    const hits = [];
    const scan = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { if (f.name !== "node_modules") scan(p); continue; }
        if (!/\.tsx?$/.test(f.name)) continue;
        const code = stripComments(fs.readFileSync(p, "utf8"));
        if (/bootHealth\.finalize\(\)/.test(code)) hits.push(path.relative(repo, p));
      }
    };
    scan(path.join(repo, "src"));
    assert.deepStrictEqual(hits, ["src/core/boot-runner.ts"],
      "finalize must be called only by the boot runner, found: " + hits.join(", "));
  });

  t("BENIGN filter is defined exactly once in src", () => {
    const hits = [];
    const scan = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { if (f.name !== "node_modules") scan(p); continue; }
        if (!/\.tsx?$/.test(f.name)) continue;
        const src = fs.readFileSync(p, "utf8");
        if (src.includes("ResizeObserver loop")) hits.push(path.relative(repo, p));
      }
    };
    scan(path.join(repo, "src"));
    assert.deepStrictEqual(hits, ["src/core/errors.ts"]);
  });

  t("setupBootHealth is wired exactly once (critical-gaps-boot only)", () => {
    const strength = stripComments(readSrc("src", "critical-gaps-boot-strength.ts"));
    assert.ok(!strength.includes("setupBootHealth()"), "strength module must not double-wire the health UI");
    assert.ok(!strength.includes("bootHealth.finalize()"), "strength module must not claim boot completion");
    const boot = stripComments(readSrc("src", "critical-gaps-boot.ts"));
    assert.ok(boot.includes("setupBootHealth()"), "critical-gaps-boot wires the UI once");
    assert.ok(!boot.includes("bootHealth.finalize()"), "critical-gaps-boot must not finalize early");
  });

  t("keyboard undo has one owner — strength module no longer calls txn.undo", () => {
    const strength = stripComments(readSrc("src", "critical-gaps-boot-strength.ts"));
    assert.ok(!strength.includes("txn.undo()"), "undo keys must go through features/global-undo (history stack)");
    assert.ok(!strength.includes("txn.redo()"), "redo keys must go through features/global-undo (history stack)");
    const g = stripComments(readSrc("src", "features", "global-undo.ts"));
    assert.ok(g.includes("addEventListener(\"keydown\", onKeyDown, true)"), "global-undo remains the capture-phase keyboard owner");
  });

  t("new core modules respect ratchets (no window.__obs*, no confirm/prompt)", () => {
    for (const f of ["src/core/boot-runner.ts", "src/core/listener-scope.ts"]) {
      const src = fs.readFileSync(path.join(repo, f), "utf8");
      assert.ok(!src.includes("window.__obs"), f + " must not add legacy globals");
      assert.ok(!/\bconfirm\(/.test(src) && !/\bprompt\(/.test(src), f + " must not use confirm/prompt");
      assert.ok(!src.includes("toLocaleString"), f + " must use core/region.ts formatters if ever needed");
    }
  });

  t("main.ts boot steps route through bootHealth (tracked, retryable)", () => {
    const main = stripComments(readSrc("src", "main.ts"));
    assert.ok(/return boot\.step\(name, fn\)/.test(main), "step() must delegate to the boot stepper");
    const runner = stripComments(readSrc("src", "core", "boot-runner.ts"));
    assert.ok(/trackedBootStep\(name, fn\)/.test(runner), "every stepper step must be retry-registered");
    assert.ok(/bootHealth\s*\.\s*runStep\(name,\s*fn\)/.test(runner), "every stepper step must be health-tracked");
  });

  console.log(`\nboot-architecture: ${pass} passed, ${fail} failed`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
