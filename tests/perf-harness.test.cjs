/**
 * Performance optimization regression tests (real production helpers):
 *   - core/raf-coalescer.ts        (2D plan render coalescing)
 *   - core/renderer-lifecycle.ts   (3D renderer pause under the plan overlay)
 *   - core/hover-gate.ts           (hover GPU pick suppression during drags)
 *
 * Run: node tests/perf-harness.test.cjs
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-perf-harness-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type":"commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/core/raf-coalescer.ts src/core/renderer-lifecycle.ts src/core/hover-gate.ts",
  { cwd: root, stdio: "pipe", shell: true },
);
const { createRafCoalescer } = require(path.join(tmpOut, "core/raf-coalescer.js"));
const { setOverlayRendererEnabled, pauseRenderLoop } = require(path.join(tmpOut, "core/renderer-lifecycle.js"));
const { hoverGate } = require(path.join(tmpOut, "core/hover-gate.js"));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  PASS", name); pass++; }
  catch (e) { console.error("  FAIL", name, e.message); fail++; }
}

// ── raf-coalescer ────────────────────────────────────────────────────────
t("coalescer: N requests within one frame → one callback (last wins)", () => {
  let frames = 0;
  const frameQueue = [];
  const c = createRafCoalescer((cb) => { frames++; frameQueue.push(cb); });
  let runs = 0;
  let last;
  c.request(() => { runs++; last = "a"; });
  c.request(() => { runs++; last = "b"; });
  c.request(() => { runs++; last = "c"; });
  assert.strictEqual(frames, 1, "one scheduled frame");
  assert.strictEqual(runs, 0, "nothing executed before the frame fires");
  frameQueue[0](); // the frame fires
  assert.strictEqual(runs, 1, "one executed callback");
  assert.strictEqual(last, "c", "the most recent request wins");
});

t("coalescer: callback runs exactly once across two frames", () => {
  const scheduled = [];
  const c = createRafCoalescer((cb) => scheduled.push(cb));
  let runs = 0;
  c.request(() => { runs++; });
  assert.strictEqual(c.pending, true);
  scheduled[0](); // frame 1 fires
  assert.strictEqual(runs, 1);
  assert.strictEqual(c.pending, false);
  scheduled[0](); // a late second fire must not re-run (no pending work)
  assert.strictEqual(runs, 1);
});

t("coalescer: flush() runs pending work immediately", () => {
  const frameQueue = [];
  const c = createRafCoalescer((cb) => frameQueue.push(cb));
  let ran = false;
  c.request(() => { ran = true; });
  c.flush();
  assert.ok(ran, "pending callback executed");
  assert.strictEqual(c.pending, false);
  frameQueue[0](); // the late frame must not re-run anything
  assert.ok(ran, "still executed exactly once");
});

// ── renderer-lifecycle ───────────────────────────────────────────────────
t("renderer pause: flips enabled and clears on resume with needsUpdate", () => {
  const r = { enabled: true, needsUpdate: false };
  assert.strictEqual(setOverlayRendererEnabled(r, false), true, "pause reports change");
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(setOverlayRendererEnabled(r, true), true, "resume reports change");
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.needsUpdate, true, "resume requests one frame");
});

t("renderer pause: redundant call reports no change", () => {
  const r = { enabled: false };
  assert.strictEqual(setOverlayRendererEnabled(r, false), false);
  assert.strictEqual(r.enabled, false);
});

t("renderer pause: missing/malformed target is a safe no-op", () => {
  assert.strictEqual(setOverlayRendererEnabled(null, false), false);
  assert.strictEqual(setOverlayRendererEnabled(undefined, true), false);
  assert.strictEqual(setOverlayRendererEnabled({}, false), false);
});

// ── pauseRenderLoop (composable import-queue × plan-overlay pause) ──────
t("pause guard: flips off and restores the exact prior state", () => {
  const r = { enabled: true, needsUpdate: false };
  const restore = pauseRenderLoop(r);
  assert.strictEqual(typeof restore, "function");
  assert.strictEqual(r.enabled, false, "paused while guard held");
  restore();
  assert.strictEqual(r.enabled, true, "restored to true");
  assert.strictEqual(r.needsUpdate, true, "resume requests one frame");
});

t("pause guard: restore puts back false when it was already off", () => {
  const r = { enabled: false };
  const restore = pauseRenderLoop(r);
  assert.strictEqual(r.enabled, false);
  restore();
  assert.strictEqual(r.enabled, false, "never re-enables someone else's pause");
});

t("pause guard: already-paused target returns a no-op restore", () => {
  const r = { enabled: false };
  const restore = pauseRenderLoop(r);
  assert.strictEqual(typeof restore, "function");
  restore();
  assert.strictEqual(r.enabled, false, "no-op restore does not flip the loop");
});

t("pause guard: import × plan composition — whoever paused last-in owns restore", () => {
  // Import queue pauses first (plan opens later).
  const r = { enabled: true, needsUpdate: false };
  const importRestore = pauseRenderLoop(r);
  assert.strictEqual(r.enabled, false);
  // Plan overlay opens: finds the loop already paused → its own flip is a no-op.
  const planRestore = pauseRenderLoop(r);
  assert.strictEqual(r.enabled, false);
  planRestore(); // plan closes first — must NOT re-enable mid-import
  assert.strictEqual(r.enabled, false, "plan restore does not fight the import pause");
  importRestore(); // queue finishes — restores the true prior state
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.needsUpdate, true);
});

t("pause guard: plan × import composition — plan pauses first, import finishes later", () => {
  const r = { enabled: true };
  const planRestore = pauseRenderLoop(r);
  assert.strictEqual(r.enabled, false);
  const importRestore = pauseRenderLoop(r); // import starts while plan is open
  assert.strictEqual(r.enabled, false);
  importRestore(); // queue done before plan closes — stays paused under the overlay
  assert.strictEqual(r.enabled, false, "import restore leaves the plan's pause alone");
  planRestore(); // plan closes
  assert.strictEqual(r.enabled, true);
});

t("pause guard: missing renderer returns null and callers skip restore", () => {
  assert.strictEqual(pauseRenderLoop(null), null);
  assert.strictEqual(pauseRenderLoop(undefined), null);
  assert.strictEqual(pauseRenderLoop({}), null);
});

// ── hover-gate ───────────────────────────────────────────────────────────
t("hover gate: free move (no buttons) → pick", () => {
  assert.deepStrictEqual(hoverGate(0, false, 0), { pick: true, clearStale: false });
});

t("hover gate: duplicate move while a pick is in flight → no re-pick", () => {
  assert.deepStrictEqual(hoverGate(0, true, 1), { pick: false, clearStale: false });
});

t("hover gate: button held (orbit/pan/drag) → no pick", () => {
  assert.strictEqual(hoverGate(1, false, 0).pick, false, "left button");
  assert.strictEqual(hoverGate(2, false, 0).pick, false, "right button");
  assert.strictEqual(hoverGate(4, false, 0).pick, false, "middle button");
});

t("hover gate: stale highlight cleared exactly once at drag start", () => {
  // Drag just started: highlight exists, no pick in flight → clear once.
  assert.deepStrictEqual(hoverGate(1, false, 1), { pick: false, clearStale: true });
  // Already cleared (hoveredCount 0) → do not clear again.
  assert.deepStrictEqual(hoverGate(1, false, 0), { pick: false, clearStale: false });
  // A pending pick still in flight → do not double-clear.
  assert.deepStrictEqual(hoverGate(1, true, 1), { pick: false, clearStale: false });
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
