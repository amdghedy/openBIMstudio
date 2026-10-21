/**
 * tests/history.test.cjs
 *
 * Undo/redo stack: ordering, redo clearing, transactions, coalescing and,
 * importantly, that rapid overlapping undo()/redo() calls (key repeat) run
 * strictly one at a time.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-history-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
execSync(
  `npx tsc --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib es2022,dom --skipLibCheck --noCheck src/features/history.ts`,
  { cwd: root, stdio: "inherit" },
);

// history.ts touches window for toasts/timers only.
global.window = global;
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
global.dispatchEvent = () => true;

const { history } = require(path.join(out, "history.js"));

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}

(async () => {
  console.log("\n=== History tests ===\n");

  await t("exec / undo / redo restore state in order", async () => {
    history.clear();
    let v = 0;
    await history.exec({ label: "a", apply: () => { v += 1; }, revert: () => { v -= 1; } });
    await history.exec({ label: "b", apply: () => { v += 10; }, revert: () => { v -= 10; } });
    assert.strictEqual(v, 11);
    await history.undo(); assert.strictEqual(v, 1);
    await history.undo(); assert.strictEqual(v, 0);
    await history.redo(); assert.strictEqual(v, 1);
    assert.ok(history.canUndo() && history.canRedo());
  });

  await t("a new command clears the redo stack", async () => {
    history.clear();
    let v = 0;
    await history.exec({ label: "a", apply: () => { v = 1; }, revert: () => { v = 0; } });
    await history.undo();
    assert.ok(history.canRedo());
    await history.exec({ label: "b", apply: () => { v = 2; }, revert: () => { v = 0; } });
    assert.ok(!history.canRedo());
  });

  await t("transaction folds several commands into one undo step", async () => {
    history.clear();
    const log = [];
    await history.transaction("group", async () => {
      await history.exec({ label: "x", apply: () => log.push("x+"), revert: () => log.push("x-") });
      await history.exec({ label: "y", apply: () => log.push("y+"), revert: () => log.push("y-") });
    });
    assert.strictEqual(history.depth().undo, 1);
    log.length = 0;
    await history.undo();
    assert.deepStrictEqual(log, ["y-", "x-"]);
  });

  await t("rapid overlapping undo() calls never run concurrently", async () => {
    history.clear();
    let running = 0;
    let maxRunning = 0;
    const order = [];
    for (let i = 0; i < 5; i++) {
      await history.exec({
        label: "c" + i,
        apply: () => {},
        revert: async () => {
          running++; maxRunning = Math.max(maxRunning, running);
          await new Promise((r) => setTimeout(r, 5));
          order.push(i);
          running--;
        },
      });
    }
    await Promise.all([history.undo(), history.undo(), history.undo(), history.undo(), history.undo()]);
    assert.strictEqual(maxRunning, 1, "undo ran concurrently");
    assert.deepStrictEqual(order, [4, 3, 2, 1, 0]);
    assert.strictEqual(history.depth().undo, 0);
    assert.strictEqual(history.depth().redo, 5);
  });

  await t("a failing undo keeps the command and does not block later undos", async () => {
    history.clear();
    let ok = 0;
    let fail = true;
    await history.exec({ label: "good", apply: () => {}, revert: () => { ok++; } });
    await history.exec({ label: "flaky", apply: () => {}, revert: () => { if (fail) throw new Error("boom"); ok += 10; } });
    await assert.rejects(history.undo(), /boom/);
    assert.strictEqual(history.depth().undo, 2);
    fail = false;
    await history.undo();
    await history.undo();
    assert.strictEqual(ok, 11);
  });

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();
