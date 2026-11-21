/**
 * tests/snap-freshness.test.cjs
 *
 * Async snap race fix (follow-up 7 finding): the snap cache is updated
 * asynchronously on hover (rAF-throttled), while clicks dispatch
 * synchronously — so an instant click can commit the PREVIOUS hover's
 * snap result and two instances co-locate. The fix has two parts, both
 * proven here at the pure-helper level (the browser proof is
 * tests/e2e/snap-race.spec.ts):
 *
 *   F1. Freshness: `isSnapFreshForEvent` — a cached snap is usable only
 *       for a click at (nearly) the same pointer position it was
 *       computed for; anything else falls back to grid snap.
 *   F2. Generation guard: `SnapGeneration` — only the newest in-flight
 *       snap query may write the cache back, so an older query resolving
 *       late can never overwrite a newer result.
 *
 * The helpers live in src/features/snap-freshness.ts (dependency-free,
 * compiled in isolation below the same way the parametric tests compile
 * their module slice).
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const nassert = require("node:assert");

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}
const eq = (a, b, msg) => nassert.strictEqual(a, b, msg);

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".snap-freshness-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  } catch { /* */ }
});
execSync(
  "npx tsc src/features/snap-freshness.ts"
  + " --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck",
  { cwd: root, stdio: "inherit", shell: true },
);
const { isSnapFreshForEvent, SnapGeneration, SNAP_FRESHNESS_PX } = require(
  path.join(tmpOut, "snap-freshness.js"),
);

// ── F1. Freshness predicate ─────────────────────────────────────────────────
t("SNAP_FRESHNESS_PX is the input router drag threshold (4)", () => {
  eq(SNAP_FRESHNESS_PX, 4, "freshness tolerance must match DRAG_THRESHOLD");
});

t("null snap position is never fresh", () => {
  eq(isSnapFreshForEvent(null, { x: 100, y: 100 }), false);
});

t("identical pointer positions are fresh", () => {
  eq(isSnapFreshForEvent({ x: 100, y: 100 }, { x: 100, y: 100 }), true);
});

t("a click 3 px away is fresh (within tolerance)", () => {
  eq(isSnapFreshForEvent({ x: 100, y: 100 }, { x: 103, y: 100 }), true);
  eq(isSnapFreshForEvent({ x: 100, y: 100 }, { x: 102, y: 102 }), true);
});

t("a click exactly at the tolerance boundary is fresh", () => {
  eq(isSnapFreshForEvent({ x: 100, y: 100 }, { x: 104, y: 100 }), true);
  eq(isSnapFreshForEvent({ x: 100, y: 100 }, { x: 103, y: 103 }), false, "3,3 is ~4.24 px, beyond 4");
});

t("the race case: a click far from the snap position is stale", () => {
  // The follow-up 7 observation: second click at a different screen
  // position must NOT consume the first click's snap.
  eq(isSnapFreshForEvent({ x: 200, y: 150 }, { x: 600, y: 400 }), false);
  eq(isSnapFreshForEvent({ x: 200, y: 150 }, { x: 205, y: 150 }), false);
  eq(isSnapFreshForEvent({ x: 200, y: 150 }, { x: 200, y: 155 }), false);
});

t("non-finite coordinates are never fresh", () => {
  eq(isSnapFreshForEvent({ x: NaN, y: 100 }, { x: 100, y: 100 }), false);
  eq(isSnapFreshForEvent({ x: 100, y: Infinity }, { x: 100, y: 100 }), false);
  eq(isSnapFreshForEvent({ x: 100, y: 100 }, { x: NaN, y: 100 }), false);
  eq(isSnapFreshForEvent({ x: 100, y: 100 }, { x: 100, y: 100 }, -1), false, "negative tolerance");
});

t("an explicit tolerance is honoured", () => {
  eq(isSnapFreshForEvent({ x: 0, y: 0 }, { x: 8, y: 0 }, 10), true);
  eq(isSnapFreshForEvent({ x: 0, y: 0 }, { x: 8, y: 0 }, 5), false);
  eq(isSnapFreshForEvent({ x: 0, y: 0 }, { x: 0, y: 0 }, 0), true, "zero tolerance: identical only");
  eq(isSnapFreshForEvent({ x: 0, y: 0 }, { x: 1, y: 0 }, 0), false);
});

// ── F2. Generation guard ────────────────────────────────────────────────────
t("only the latest generation is current", () => {
  const g = new SnapGeneration();
  const first = g.next();
  eq(g.isCurrent(first), true, "first generation is current until superseded");
  const second = g.next();
  eq(g.isCurrent(first), false, "first generation is stale once a newer one exists");
  eq(g.isCurrent(second), true);
  const third = g.next();
  eq(g.isCurrent(second), false);
  eq(g.isCurrent(third), true);
  eq(g.isCurrent(999), false, "an unknown generation is never current");
});

t("out-of-order resolution: the stale write is dropped", () => {
  // Models updateSnapAsync's write-back: two hovers start queries A then
  // B; B resolves first and writes, A resolves later and must NOT write.
  const gen = new SnapGeneration();
  const cache = { point: null, valid: false };
  const writeBack = (generation, point) => {
    if (!gen.isCurrent(generation)) return false;
    cache.point = point;
    cache.valid = true;
    return true;
  };
  const genA = gen.next(); // hover at A
  const genB = gen.next(); // hover at B (newer)
  eq(writeBack(genB, "B"), true, "newest query writes");
  eq(cache.point, "B");
  eq(writeBack(genA, "A"), false, "older query resolving late must not overwrite");
  eq(cache.point, "B", "cache still holds the newest result");
  eq(cache.valid, true);
});

t("a fresh hover after a stale drop still writes", () => {
  const gen = new SnapGeneration();
  const cache = { point: null };
  const writeBack = (generation, point) => {
    if (!gen.isCurrent(generation)) return false;
    cache.point = point;
    return true;
  };
  const genA = gen.next();
  const genB = gen.next();
  writeBack(genB, "B");
  writeBack(genA, "A"); // dropped
  const genC = gen.next(); // next hover
  eq(writeBack(genC, "C"), true);
  eq(cache.point, "C");
});

console.log(`snap-freshness: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
