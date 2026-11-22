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

  await t("a failed transaction rolls back every buffered command and records nothing", async () => {
    history.clear();
    const log = [];
    await assert.rejects(history.transaction("will fail", async () => {
      await history.exec({ label: "first", apply: () => log.push("first+"), revert: () => log.push("first-") });
      await history.exec({ label: "second", apply: () => log.push("second+"), revert: () => log.push("second-") });
      throw new Error("injected commit-stage failure");
    }), /injected commit-stage failure/);
    assert.deepStrictEqual(log, ["first+", "second+", "second-", "first-"]);
    assert.deepStrictEqual(history.depth(), { undo: 0, redo: 0 });
  });

  await t("a failed nested transaction rolls back to its savepoint without discarding outer work", async () => {
    history.clear();
    const log = [];
    await history.transaction("outer", async () => {
      await history.exec({ label: "before", apply: () => log.push("before+"), revert: () => log.push("before-") });
      await assert.rejects(history.transaction("inner", async () => {
        await history.exec({ label: "inner", apply: () => log.push("inner+"), revert: () => log.push("inner-") });
        throw new Error("inner failure");
      }), /inner failure/);
      await history.exec({ label: "after", apply: () => log.push("after+"), revert: () => log.push("after-") });
    });
    assert.deepStrictEqual(log, ["before+", "inner+", "inner-", "after+"]);
    assert.strictEqual(history.depth().undo, 1);
    await history.undo();
    assert.deepStrictEqual(log.slice(-2), ["after-", "before-"]);
  });

  await t("a command that throws during apply attempts its inverse and is not recorded", async () => {
    history.clear();
    let value = 0;
    await assert.rejects(history.exec({
      label: "partial",
      apply: () => { value = 7; throw new Error("apply failed"); },
      revert: () => { value = 0; },
    }), /apply failed/);
    assert.strictEqual(value, 0);
    assert.deepStrictEqual(history.depth(), { undo: 0, redo: 0 });
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


  await t("project transition clears undo and redo history and blocks commands until the new scene is ready", async () => {
    history.clear();
    let projectA = 0;
    let projectB = 0;
    await history.exec({ label: "Project A edit", apply: () => { projectA = 1; }, revert: () => { projectA = 0; } });
    await history.undo();
    assert.strictEqual(projectA, 0);
    assert.strictEqual(history.canRedo(), true);

    const resume = await history.beginDocumentTransition();
    assert.deepStrictEqual(history.depth(), { undo: 0, redo: 0 });
    assert.strictEqual(history.canUndo(), false);
    assert.strictEqual(history.canRedo(), false);

    await assert.rejects(history.exec({
      label: "edit during load",
      apply: () => { projectB = 5; },
      revert: () => { projectB = 0; },
    }), /project\/document transition/);
    history.push({ label: "stale direct push", apply: () => { projectA = 9; }, revert: () => { projectA = 1; } });
    await history.undo();
    await history.redo();
    assert.strictEqual(projectA, 0);
    assert.strictEqual(projectB, 0);
    assert.deepStrictEqual(history.depth(), { undo: 0, redo: 0 });

    resume();
    await history.exec({ label: "Project B edit", apply: () => { projectB = 2; }, revert: () => { projectB = 0; } });
    await history.undo();
    assert.strictEqual(projectA, 0);
    assert.strictEqual(projectB, 0);
  });

  await t("project transition waits for an in-flight undo before clearing the old document history", async () => {
    history.clear();
    let value = 1;
    let started;
    let release;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    await history.exec({
      label: "slow old-project edit",
      apply: () => { value = 1; },
      revert: async () => { started(); await gate; value = 0; },
    });

    const undo = history.undo();
    await startedPromise;
    let transitionReady = false;
    const transition = history.beginDocumentTransition().then((resume) => {
      transitionReady = true;
      return resume;
    });
    await Promise.resolve();
    assert.strictEqual(transitionReady, false, "transition must wait for the active undo");
    release();
    await undo;
    const resume = await transition;
    assert.strictEqual(value, 0);
    assert.deepStrictEqual(history.depth(), { undo: 0, redo: 0 });
    resume();
  });


  await t("project transition waits for an in-flight command execution before clearing history", async () => {
    history.clear();
    let value = 0;
    let started;
    let release;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const execution = history.exec({
      label: "slow old-project creation",
      apply: async () => { started(); await gate; value = 1; },
      revert: () => { value = 0; },
    });
    await startedPromise;
    let transitionReady = false;
    const transition = history.beginDocumentTransition().then((resume) => {
      transitionReady = true;
      return resume;
    });
    await Promise.resolve();
    assert.strictEqual(transitionReady, false, "transition must wait for in-flight command execution");
    release();
    await execution;
    const resume = await transition;
    assert.strictEqual(value, 1);
    assert.deepStrictEqual(history.depth(), { undo: 0, redo: 0 });
    resume();
  });

  // ── onMutation (item 5): every recorded model change notifies ─────────
  // The bus is microtask-deferred, so tests await a tick before asserting.
  const tick = () => new Promise((resolve) => queueMicrotask(resolve));

  await t("onMutation fires once per exec (after the mutation, not before)", async () => {
    history.clear();
    let v = 0;
    let calls = 0;
    const unsub = history.onMutation(() => { calls++; });
    try {
      let seenDuringApply = -1;
      await history.exec({
        label: "a",
        apply: () => { v = 1; seenDuringApply = calls; },
        revert: () => { v = 0; },
      });
      assert.strictEqual(v, 1);
      assert.strictEqual(seenDuringApply, 0, "no notification while apply is running");
      await tick();
      assert.strictEqual(calls, 1);
    } finally { unsub(); }
  });

  await t("onMutation fires for push, undo and redo", async () => {
    history.clear();
    let v = 0;
    let calls = 0;
    const unsub = history.onMutation(() => { calls++; });
    try {
      history.push({ label: "p", apply: () => { v = 1; }, revert: () => { v = 0; } });
      await tick();
      assert.strictEqual(calls, 1, "push notifies");
      await history.undo();
      await tick();
      assert.strictEqual(calls, 2, "undo notifies");
      await history.redo();
      await tick();
      assert.strictEqual(calls, 3, "redo notifies");
    } finally { unsub(); }
  });

  await t("onMutation fires once per transaction commit, not per inner push", async () => {
    history.clear();
    let calls = 0;
    const unsub = history.onMutation(() => { calls++; });
    try {
      await history.transaction("group", async () => {
        history.push({ label: "x", apply: () => {}, revert: () => {} });
        history.push({ label: "y", apply: () => {}, revert: () => {} });
        await tick();
        assert.strictEqual(calls, 0, "buffered inner pushes must not notify");
      });
      await tick();
      assert.strictEqual(calls, 1, "commit notifies once");
    } finally { unsub(); }
  });

  await t("onMutation does not fire for a refused push or a bare clear", async () => {
    history.clear();
    let calls = 0;
    const unsub = history.onMutation(() => { calls++; });
    try {
      history.clear();
      await tick();
      assert.strictEqual(calls, 0, "clear is not a model mutation");
      // A push refused mid-undo must not notify either: start an undo and
      // push once its revert is actually in flight (undo() is chained, so
      // the revert only starts on a later tick — wait for its signal).
      let started;
      const startedPromise = new Promise((resolve) => { started = resolve; });
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      await history.exec({
        label: "slow",
        apply: () => {},
        revert: async () => { started(); await gate; },
      });
      await tick();
      calls = 0; // the exec above notified; reset before the undo half
      const undo = history.undo();
      await startedPromise;
      const refused = history.push({ label: "too-early", apply: () => {}, revert: () => {} });
      assert.strictEqual(refused, false, "push during undo is refused");
      release();
      await undo;
      await tick();
      assert.strictEqual(calls, 1, "only the undo itself notifies");
    } finally { unsub(); }
  });

  await t("rapid pushes collapse into one notification per task", async () => {
    history.clear();
    let calls = 0;
    const unsub = history.onMutation(() => { calls++; });
    try {
      history.push({ label: "a", apply: () => {}, revert: () => {} });
      history.push({ label: "b", apply: () => {}, revert: () => {} });
      history.push({ label: "c", apply: () => {}, revert: () => {} });
      await tick();
      assert.strictEqual(calls, 1, "three synchronous pushes notify once");
      history.push({ label: "d", apply: () => {}, revert: () => {} });
      await tick();
      assert.strictEqual(calls, 2, "a later push notifies again");
    } finally { unsub(); }
  });

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})();
