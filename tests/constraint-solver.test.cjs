/**
 * tests/constraint-solver.test.cjs
 *
 * Unit tests for the numeric geometric constraint solver
 * (src/modules/constraints). Compiles the module slice with the project's
 * own TypeScript into a temp dir, then exercises the solver against
 * hand-verifiable geometry.
 *
 * Run: `node tests/constraint-solver.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

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

function near(a, b, tol = 1e-4) {
  if (!(Math.abs(a - b) <= tol)) {
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-constraints-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/constraints/solver.ts src/modules/constraints/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const solver = require(path.join(tmpOut, "modules/constraints/solver.js"));
const cmod = require(path.join(tmpOut, "modules/constraints/index.js"));

// ── 1. Distance constraint pulls two points to the locked length ───────────
t("distance constraint converges to locked value", () => {
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 3, y: 0 },
  ];
  const r = solver.solve(pts, [{ kind: "distance", pts: [0, 1], value: 5 }]);
  assert(r.status === "converged", `status ${r.status}, res=${r.maxResidual}`);
  near(Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y), 5, 1e-6);
});

// ── 2. Rectangle: distorted quad + full constraint set → perfect rectangle ──
t("rectangle restores from distorted quad", () => {
  // Distorted quad, corner 0 pinned, corner 1 pinned (top edge locked at 4).
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 4, y: 0, fixed: true },
    { x: 4.4, y: 2.8 },
    { x: 0.2, y: 3.3 },
  ];
  const cons = [
    { kind: "vertical", pts: [1, 2] },      // right edge vertical
    { kind: "horizontal", pts: [2, 3] },    // bottom horizontal
    { kind: "vertical", pts: [3, 0] },      // left edge vertical
    { kind: "distance", pts: [1, 2], value: 3 },
    { kind: "distance", pts: [2, 3], value: 4 },
    { kind: "distance", pts: [3, 0], value: 3 },
  ];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status ${r.status}, res=${r.maxResidual}`);
  // Corners now form an axis-aligned 4 x 3 rectangle.
  near(pts[2].x, 4, 1e-6);
  near(pts[2].y, 3, 1e-6);
  near(pts[3].x, 0, 1e-6);
  near(pts[3].y, 3, 1e-6);
});

// ── 3. Parallel + perpendicular relations ────────────────────────────────────
t("parallel and perpendicular relations hold after solve", () => {
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 2, y: 0.3 },            // slightly sloped segment
    { x: 1, y: 1, fixed: true },
    { x: 1.4, y: 3 },            // should become perpendicular to seg 0-1
  ];
  const cons = [
    { kind: "horizontal", pts: [0, 1] },               // fix seg 0-1 horizontal
    { kind: "perpendicular", pts: [0, 1, 2, 3] },      // seg 2-3 ⊥ seg 0-1
  ];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status ${r.status}, res=${r.maxResidual}`);
  near(pts[1].y - pts[0].y, 0, 1e-6);
  near(pts[3].x - pts[2].x, 0, 1e-6); // vertical = perpendicular to horizontal
});

t("parallel keeps two walls co-directional", () => {
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 4, y: 0, fixed: true },
    { x: 0.5, y: 3 },
    { x: 4.2, y: 3.6 }, // skewed
  ];
  const cons = [{ kind: "parallel", pts: [0, 1, 2, 3] }];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status ${r.status}, res=${r.maxResidual}`);
  const cross = (4 - 0) * (pts[3].y - pts[2].y) - (0 - 0) * (pts[3].x - pts[2].x);
  near(cross, 0, 1e-6);
});

// ── 4. Equal-length + midpoint + point-on-line ──────────────────────────────
t("equal-length makes bays identical", () => {
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 3, y: 0, fixed: true },   // bay 1 reference: 3 m
    { x: 6.5, y: 0 },
    { x: 11, y: 0 },               // bay 2 too long
  ];
  const cons = [
    { kind: "horizontal", pts: [0, 1] },
    { kind: "horizontal", pts: [2, 3] },
    { kind: "equal-length", pts: [0, 1, 2, 3] },
  ];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status ${r.status}, res=${r.maxResidual}`);
  near(Math.hypot(pts[3].x - pts[2].x, 0), 3, 1e-6);
});

t("midpoint pins to segment centre", () => {
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 8, y: 4, fixed: true },
    { x: 1, y: 3 }, // free point → midpoint
  ];
  const cons = [{ kind: "midpoint", pts: [2, 0, 1] }];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status ${r.status}, res=${r.maxResidual}`);
  near(pts[2].x, 4, 1e-6);
  near(pts[2].y, 2, 1e-6);
});

t("point-on-line keeps point on infinite line", () => {
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 6, y: 6, fixed: true },
    { x: 2, y: 4 }, // off the diagonal
  ];
  const cons = [
    { kind: "point-on-line", pts: [2, 0, 1] },
    { kind: "distance", pts: [0, 2], value: Math.sqrt(8) },
  ];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status ${r.status}, res=${r.maxResidual}`);
  near(pts[2].x, 2, 1e-5);
  near(pts[2].y, 2, 1e-5);
});

// ── 5. Over-constrained detection ────────────────────────────────────────────
t("over-constrained system is reported, not silently mis-solved", () => {
  // Contradictory distances on one free point: no solution exists, the
  // naive dof count is 0 but the solver must still refuse to claim success.
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 1, y: 1 }, // free
  ];
  const cons = [
    { kind: "distance", pts: [0, 1], value: 5 },
    { kind: "distance", pts: [0, 1], value: 7 }, // contradictory
  ];
  const r = solver.solve(pts, cons);
  assert(r.status !== "converged", "should not report success");

  // Count-over-constrained: two pinned points + coincident between them.
  const pts2 = [
    { x: 0, y: 0, fixed: true },
    { x: 1, y: 1, fixed: true },
  ];
  const r2 = solver.solve(pts2, [{ kind: "coincident", pts: [0, 1] }]);
  assert(r2.status === "over-constrained", `status ${r2.status}`);
  assert(r2.dof < 0, `dof should be negative, got ${r2.dof}`);
});

// ── 6. Angle constraint ──────────────────────────────────────────────────────
t("angle constraint enforces the requested radians", () => {
  const pts = [
    { x: 0, y: 0, fixed: true },
    { x: 4, y: 0, fixed: true },
    { x: 2, y: -1, fixed: true },
    { x: 5, y: -2 }, // segment 2→3 should end at +35° from segment 0→1
  ];
  const target = (35 * Math.PI) / 180;
  const cons = [{ kind: "angle", pts: [0, 1, 2, 3], value: target }];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status ${r.status}, res=${r.maxResidual}`);
  const got = Math.atan2(pts[3].y - pts[2].y, pts[3].x - pts[2].x);
  near(got, target, 1e-6);
});

// ── 7. Wall integration: joined chain follows a dragged endpoint ─────────────
t("wall chain: coincident endpoints survive a drag", () => {
  const walls = [
    { id: "w1", type: "wall", params: { start: { x: 0, z: 0 }, end: { x: 6, z: 0 } } },
    { id: "w2", type: "wall", params: { start: { x: 6, z: 0 }, end: { x: 6, z: 4 } } },
    { id: "w3", type: "wall", params: { start: { x: 6, z: 4 }, end: { x: 0, z: 4 } } },
  ];
  // Drag w2/w3 shared corner by 0.5 m.
  walls[1].params.end = { x: 6.5, z: 4 };
  walls[2].params.start = { x: 6.5, z: 4 };
  const { result, updated } = cmod.solveWalls(walls, { joinTolerance: 1e-6 });
  assert(result.status === "converged", `status ${result.status}, res=${result.maxResidual}`);
  // w2 end and w3 start remain coincident.
  near(updated[1].end.x, updated[2].start.x, 1e-6);
  near(updated[1].end.z, updated[2].start.z, 1e-6);
  // Every wall kept its declared length.
  const len = (w, u) =>
    Math.hypot(u.end.x - u.start.x, u.end.z - u.start.z);
  near(len(walls[0], updated[0]), 6, 1e-4);
  near(len(walls[1], updated[1]), Math.hypot(0.5, 4), 1e-4);
});

// ── 8. Pinned solveAndApply: pinned walls never move, neighbours re-attach ──
t("solveAndApply: pinned wall stays, free wall heals to it", () => {
  const walls = [
    { id: "a", type: "wall", params: { start: { x: 0, z: 0 }, end: { x: 10, z: 0 } } },
    { id: "b", type: "wall", params: { start: { x: 10, z: 0 }, end: { x: 10.3, z: 5 } } },
  ];
  const { changed, result } = cmod.solveAndApply(walls, ["a"], {
    joinTolerance: 1e-6,
    extra: [{ kind: "vertical", pts: [2, 3] }], // wall b vertical in plan (x const)
  });
  assert(result.status === "converged", `status ${result.status}`);
  assert(changed >= 1, "wall b should have moved");
  near(walls[0].params.start.x, 0, 1e-9);
  near(walls[0].params.end.x, 10, 1e-9);
  near(walls[1].params.start.x, 10, 1e-3); // snapped onto pinned end
  near(walls[1].params.end.x, 10, 1e-3);   // vertical respected
});

// ── 9. applyWallOutcome is a no-op when nothing moves ───────────────────────
t("applyWallOutcome returns 0 changes for identical geometry", () => {
  const walls = [
    { id: "a", type: "wall", params: { start: { x: 0, z: 0 }, end: { x: 5, z: 0 } } },
  ];
  const { result, updated } = cmod.solveWalls(walls, { keepLengths: false, extra: [
    { kind: "fixed", pts: [0] },
  ] });
  assert(result.status === "converged");
  const changed = cmod.applyWallOutcome(walls, { result, updated });
  near(changed, 0, 0);
});

// ── 10. Equation bookkeeping ────────────────────────────────────────────────
t("equation counting: coincident=2, distance=1, fixed points=2", () => {
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2, fixed: true }];
  const cons = [
    { kind: "coincident", pts: [0, 1] },
    { kind: "distance", pts: [1, 2], value: 1 },
  ];
  near(solver.countEquations(pts, cons), 2 + 1 + 2, 0);
  near(solver.equationsFor({ kind: "midpoint", pts: [0, 1, 2] }), 2, 0);
  near(solver.equationsFor({ kind: "angle", pts: [0, 1, 2, 3] }), 1, 0);
});

// ── 11. Perf sanity: a 20-wall grid solves fast ──────────────────────────────
t("20-wall grid solves under 2 s", () => {
  const walls = [];
  // 10 columns x 2 rows grid of connected walls.
  for (let i = 0; i < 10; i++) {
    walls.push({ id: `c${i}`, type: "wall", params: {
      start: { x: i, z: 0 }, end: { x: i + 1, z: 0 },
    } });
  }
  for (let i = 0; i < 10; i++) {
    walls.push({ id: `r${i}`, type: "wall", params: {
      start: { x: i, z: 0.001 }, end: { x: i, z: 5 },
    } });
  }
  const t0 = Date.now();
  const { result } = cmod.solveWalls(walls, { joinTolerance: 1e-3 });
  const dt = Date.now() - t0;
  assert(result.status === "converged", `status ${result.status}, res=${result.maxResidual}`);
  assert(dt < 2000, `took ${dt} ms`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
