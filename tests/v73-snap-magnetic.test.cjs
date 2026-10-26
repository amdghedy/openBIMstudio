/**
 * tests/v73-snap-magnetic.test.cjs
 *
 * MASTER PROMPT §4/§5 — magnetic alignment math + snap candidate
 * ranking / hysteresis / cycling. Closed-form checks on the pure
 * modules/snapping/magnetic.ts (no DOM, no three.js).
 *
 * Run: node tests/v73-snap-magnetic.test.cjs
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function deepEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
function near(a, b, tol = 1e-9) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`);
}
function nearXY(p, x, z, tol = 1e-9) {
  near(p[0], x, tol); near(p[1], z, tol);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v73-mag-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/snapping/magnetic.ts",
  { cwd: root, stdio: "inherit", shell: true },
);
const M = require(path.join(tmpOut, "modules/snapping/magnetic.js"));

// ── Perpendicular (§4.1) ────────────────────────────────────────────────
t("perpendicular foot of a point above a line", () => {
  nearXY(M.perpendicularFoot([3, 5], [0, 0], [10, 0]), 3, 0);
});
t("perpendicular foot on a rotated line", () => {
  // line through (0,0)→(3,4); start (3,0). Projection of (3,0) onto dir (3/5,4/5):
  // t = (3·3 + 0·4)/5 = 9/5 → foot (27/25, 36/25).
  nearXY(M.perpendicularFoot([3, 0], [0, 0], [3, 4]), 27 / 25, 36 / 25);
});
t("degenerate line has no perpendicular foot", () => {
  assert(M.perpendicularFoot([0, 0], [2, 2], [2, 2]) === null);
});

// ── Parallel (§4.1/§5) ──────────────────────────────────────────────────
t("parallel companion projects the cursor onto the base-parallel line", () => {
  nearXY(M.parallelPoint([0, 0], [1, 0], [7, 3]), 7, 0);
});
t("parallel works on rotated directions", () => {
  const d = [3 / 5, 4 / 5];
  const p = M.parallelPoint([1, 1], d, [4, 5]);
  // t = ((4−1)·3 + (5−1)·4)/5 = (9+16)/5 = 5 → (1+3, 1+4)
  nearXY(p, 4, 5, 1e-9);
});

// ── Intersection (§4.1) ─────────────────────────────────────────────────
t("segments cross at the expected point", () => {
  nearXY(M.segmentIntersection([0, 0], [10, 10], [0, 10], [10, 0]), 5, 5);
});
t("parallel segments do not intersect", () => {
  assert(M.segmentIntersection([0, 0], [10, 0], [0, 1], [10, 1]) === null);
});
t("non-crossing segments return null", () => {
  assert(M.segmentIntersection([0, 0], [1, 0], [5, 5], [9, 9]) === null);
});
t("endpoint-touching segments intersect inclusively", () => {
  const x = M.segmentIntersection([0, 0], [2, 2], [2, 2], [4, 0]);
  assert(x !== null);
  nearXY(x, 2, 2);
});

// ── Nearest-on-segment ──────────────────────────────────────────────────
t("nearest point clamps to the segment", () => {
  nearXY(M.nearestOnSegment([5, 1], [0, 0], [10, 0]), 5, 0);
  nearXY(M.nearestOnSegment([-3, 1], [0, 0], [10, 0]), 0, 0);
  nearXY(M.nearestOnSegment([15, 1], [0, 0], [10, 0]), 10, 0);
});

// ── Ranking (§4.3 priority) ─────────────────────────────────────────────
const PRIORITY = { endpoint: 100, intersection: 95, midpoint: 90, face: 60, nearest: 55, grid: 15 };
t("higher priority wins over a closer low-priority snap", () => {
  const ranked = M.rankCandidates([
    { kind: "grid", screenDist: 1 },
    { kind: "endpoint", screenDist: 12 },
  ], PRIORITY);
  assert(ranked[0].kind === "endpoint");
});
t("equal priority sorts by screen distance", () => {
  const ranked = M.rankCandidates([
    { kind: "endpoint", screenDist: 9 },
    { kind: "endpoint", screenDist: 3 },
  ], PRIORITY);
  assert(ranked[0].screenDist === 3);
});
t("full snap chain orders endpoint → intersection → midpoint → face → grid", () => {
  const ranked = M.rankCandidates([
    { kind: "grid", screenDist: 0.1 },
    { kind: "face", screenDist: 0.2 },
    { kind: "midpoint", screenDist: 0.3 },
    { kind: "intersection", screenDist: 0.4 },
    { kind: "endpoint", screenDist: 0.5 },
  ], PRIORITY);
  deepEq(ranked.map((r) => r.kind),
    ["endpoint", "intersection", "midpoint", "face", "grid"]);
});

// ── Hysteresis (spec 2B.2) ──────────────────────────────────────────────
const same = (a, b) => a.kind === b.kind && a.elementId === b.elementId;
t("previous target is kept within the hysteresis band", () => {
  const last = { kind: "midpoint", screenDist: 15, point: [0, 0], elementId: "a" };
  const picked = M.pickWithHysteresis([
    { kind: "endpoint", screenDist: 13, point: [1, 0], elementId: "b" },
    { kind: "midpoint", screenDist: 15, point: [0, 0], elementId: "a" },
  ], last, 14, same, 1.15);
  assert(picked.kind === "midpoint");
});
t("previous target is dropped beyond the band", () => {
  const last = { kind: "midpoint", screenDist: 20, point: [0, 0], elementId: "a" };
  const picked = M.pickWithHysteresis([
    { kind: "endpoint", screenDist: 13, point: [1, 0], elementId: "b" },
    { kind: "midpoint", screenDist: 20, point: [0, 0], elementId: "a" },
  ], last, 14, same, 1.15);
  assert(picked.kind === "endpoint");
});
t("without history the top-ranked candidate wins", () => {
  const ranked = M.rankCandidates([
    { kind: "grid", screenDist: 1, point: [0, 0] },
    { kind: "endpoint", screenDist: 10, point: [1, 0] },
  ], PRIORITY);
  const picked = M.pickWithHysteresis(ranked, null, 14, same);
  assert(picked.kind === "endpoint");
});

// ── Cycling (§4.3 Tab) ──────────────────────────────────────────────────
t("cycle advances and wraps forward", () => {
  const list = ["a", "b", "c"];
  let idx = 0;
  idx = M.cycleCandidate(list, idx, 1).index;
  assert(idx === 1);
  idx = M.cycleCandidate(list, idx, 1).index;
  assert(idx === 2);
  idx = M.cycleCandidate(list, idx, 1).index; // wraps to 0
  assert(idx === 0);
});
t("cycle steps backwards and wraps negatively", () => {
  const list = ["a", "b", "c"];
  const r = M.cycleCandidate(list, 0, -1);
  assert(r.index === 2 && r.item === "c");
});
t("cycle on an empty list returns null", () => {
  assert(M.cycleCandidate([], 0, 1) === null);
});

// ── Screen↔world tolerance (§4.2) ───────────────────────────────────────
t("worldPerPixel matches the pinhole projection", () => {
  // 2·d·tan(fov/2)/h — fov 60°, d 10, h 1000 ⇒ ≈ 0.011547
  near(M.worldPerPixel(10, Math.PI / 3, 1000), 2 * 10 * Math.tan(Math.PI / 6) / 1000, 1e-12);
});
t("worldPerPixel grows with distance and shrinks with resolution", () => {
  assert(M.worldPerPixel(20, Math.PI / 3, 1000) > M.worldPerPixel(10, Math.PI / 3, 1000));
  assert(M.worldPerPixel(10, Math.PI / 3, 2000) < M.worldPerPixel(10, Math.PI / 3, 1000));
});

// ── AABB prefilter (§4.2 performance) ───────────────────────────────────
t("aabb prefilter admits near and rejects far elements", () => {
  const min = [0, 0], max = [10, 10];
  assert(M.aabbNearCursor([5, 5], 0.2, min, max) === true);
  assert(M.aabbNearCursor([10.5, 5], 0.2, min, max) === true);  // within slack
  assert(M.aabbNearCursor([50, 5], 0.2, min, max) === false);  // far away
});

console.log(`\nv73-snap-magnetic: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
