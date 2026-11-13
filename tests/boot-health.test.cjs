/**
 * Unit tests for the boot-health layer and the service lifecycle additions.
 * No DOM — mirrors src/core/boot-health.ts and the lifecycle part of
 * src/core/services.ts (register/registeredAt/lifecycle/missing).
 */
const assert = require("assert");

/* ── mirrors: boot health ──────────────────────────────────────────────── */
function createBootHealth(persistStore) {
  let steps = [];
  let finalized = false;
  const registry = new Map();
  const listeners = new Set();
  const emit = () => { for (const l of listeners) { try { l(); } catch { /* */ } } };
  const latestPerStep = () => {
    const map = new Map();
    for (const s of steps) map.set(s.name, s);
    return [...map.values()];
  };

  async function runStep(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      const hadFailure = steps.some((s) => s.name === name && !s.ok);
      steps.push({ name, ok: true, ms: Date.now() - t0, at: Date.now(), ...(hadFailure ? { retried: true } : {}) });
      emit();
      return true;
    } catch (err) {
      steps.push({ name, ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err), at: Date.now() });
      emit();
      return false;
    }
  }

  function persist() {
    const latest = latestPerStep();
    const failed = latest.filter((s) => !s.ok).map((s) => s.name);
    persistStore.push({ at: 1, ok: failed.length === 0, totalMs: latest.reduce((a, s) => a + s.ms, 0), failed });
  }

  return {
    runStep,
    register(name, fn) { registry.set(name, fn); },
    status() {
      const latest = latestPerStep();
      const failed = latest.filter((s) => !s.ok).map((s) => s.name);
      return {
        steps: steps.slice(),
        failed,
        ok: failed.length === 0,
        totalMs: latest.reduce((a, s) => a + s.ms, 0),
        finalized,
      };
    },
    latestPerStep,
    async retryFailed() {
      const failedNames = latestPerStep().filter((s) => !s.ok).map((s) => s.name);
      const fixed = [];
      for (const name of failedNames) {
        const runner = registry.get(name);
        if (!runner) continue;
        if (await runStep(name, runner)) fixed.push(name);
      }
      if (failedNames.length) { persist(); emit(); }
      return fixed;
    },
    finalize() { finalized = true; persist(); emit(); return true; },
    get finalized() { return finalized; },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

/* ── mirrors: services lifecycle ───────────────────────────────────────── */
function createRegistry() {
  const registry = new Map();
  const registeredAt = new Map();
  const readyResolvers = new Map();
  return {
    register(key, value) {
      if (!registry.has(key)) registeredAt.set(key, 1000 + registry.size);
      registry.set(key, value);
      const waiters = readyResolvers.get(key);
      if (waiters) { readyResolvers.delete(key); for (const cb of waiters) cb(value); }
    },
    lifecycle() {
      return [...registry.keys()].map((key) => ({
        key,
        registeredAt: registeredAt.get(key) ?? 0,
        pendingWaiters: readyResolvers.get(key)?.length ?? 0,
      }));
    },
    missing(keys) { return keys.filter((k) => !registry.has(k)); },
  };
}

(async () => {
  // Success + failure recording
  {
    const bh = createBootHealth([]);
    bh.register("ok-step", () => 1);
    bh.register("bad-step", () => { throw new Error("boom"); });
    assert.strictEqual(await bh.runStep("ok-step", () => 1), true);
    assert.strictEqual(await bh.runStep("bad-step", () => { throw new Error("boom"); }), false);
    const st = bh.status();
    assert.strictEqual(st.ok, false);
    assert.deepStrictEqual(st.failed, ["bad-step"]);
    assert.ok(st.steps[0].ok && typeof st.steps[0].ms === "number");
    assert.strictEqual(st.steps[1].error, "boom");
    assert.strictEqual(bh.finalized, false);
  }

  // Retry: only failed steps re-run, retried flag set, success flips status
  {
    const bh = createBootHealth([]);
    let calls = 0;
    bh.register("flaky", () => { calls++; if (calls === 1) throw new Error("first"); });
    await bh.runStep("flaky", () => { calls++; if (calls === 1) throw new Error("first"); });
    assert.strictEqual(bh.status().ok, false);
    const fixed = await bh.retryFailed();
    assert.deepStrictEqual(fixed, ["flaky"]);
    assert.strictEqual(bh.status().ok, true);
    const latest = bh.latestPerStep().find((s) => s.name === "flaky");
    assert.strictEqual(latest.retried, true);
  }

  // Retry with no runner registered is a no-op (step not retryable)
  {
    const bh = createBootHealth([]);
    await bh.runStep("orphan", () => { throw new Error("x"); });
    assert.deepStrictEqual(await bh.retryFailed(), []);
  }

  // finalize persists + status flips finalized
  {
    const store = [];
    const bh = createBootHealth(store);
    await bh.runStep("a", () => {});
    await bh.runStep("b", () => { throw new Error("y"); });
    bh.finalize();
    assert.strictEqual(bh.finalized, true);
    assert.strictEqual(store.length, 1);
    assert.deepStrictEqual(store[0].failed, ["b"]);
    assert.strictEqual(store[0].ok, false);
  }

  // failed list reflects the newest outcome per step (dedup across repeats)
  {
    const bh = createBootHealth([]);
    const fail = () => { throw new Error("z"); };
    await bh.runStep("dup", fail);
    await bh.runStep("dup", fail);
    assert.deepStrictEqual(bh.status().failed, ["dup"]);
    assert.strictEqual(bh.status().steps.length, 2);
  }

  // onChange fires per step outcome
  {
    const bh = createBootHealth([]);
    let events = 0;
    bh.onChange(() => events++);
    await bh.runStep("e", () => {});
    assert.strictEqual(events, 1);
  }

  // Services: registeredAt only on first register (re-register keeps origin)
  {
    const r = createRegistry();
    r.register("selection", { a: 1 });
    const firstAt = r.lifecycle().find((e) => e.key === "selection").registeredAt;
    r.register("selection", { a: 2 });
    assert.strictEqual(r.lifecycle().find((e) => e.key === "selection").registeredAt, firstAt);
    assert.deepStrictEqual(r.missing(["selection", "authoring"]), ["authoring"]);
    r.register("authoring", {});
    assert.deepStrictEqual(r.missing(["selection", "authoring"]), []);
  }

  // Services: pendingWaiters surface
  {
    const r = createRegistry();
    r.register("camera", {});
    const entry = r.lifecycle().find((e) => e.key === "camera");
    assert.strictEqual(entry.pendingWaiters, 0);
    assert.ok(entry.registeredAt > 0);
  }

  console.log("boot-health.test.cjs: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
