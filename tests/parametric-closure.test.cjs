/**
 * tests/parametric-closure.test.cjs
 *
 * Gap-closure suite for the parametric modeling engine:
 *   - stored constraints (locked dims / equality / alignment / parallel /
 *     perpendicular) are actually SOLVED via the solver bridge, not dead
 *     metadata;
 *   - dim-constraints angle/elevation params work (were declared, unimplemented);
 *   - parallel/perpendicular constraint creators exist;
 *   - family constraint-graph detects cycles BEFORE solving, reports
 *     unconstrained parameters, and supports symmetric;
 *   - wiring + CI registration drift guards.
 *
 * Run: `node tests/parametric-closure.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
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
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-paramclosure-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/constraints/solver.ts src/modules/constraints/index.ts" +
  " src/modules/parametric-constraints/types.ts src/modules/parametric-constraints/solver-bridge.ts" +
  " src/modules/native-bim/dim-constraints.ts src/modules/families/constraint-graph.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const bridge = require(path.join(tmpOut, "modules/parametric-constraints/solver-bridge.js"));
const ptypes = require(path.join(tmpOut, "modules/parametric-constraints/types.js"));
const dim = require(path.join(tmpOut, "modules/native-bim/dim-constraints.js"));
const graph = require(path.join(tmpOut, "modules/families/constraint-graph.js"));

// ── 1. Locked dimension survives moving a wall (the Revit hallmark) ─────────
t("locked-dimension restored after a wall is dragged", () => {
  const walls = [
    { id: "a", type: "wall", params: { start: [0, 0], end: [4, 0] } },
    { id: "b", type: "wall", params: { start: [6, 0], end: [10, 0] } },
  ];
  const stored = [
    { id: "lock-1", type: "locked-dimension", elementIds: ["a", "b"], value: 2, active: true, createdAt: 0 },
  ];
  // User drags wall b 3 m to the right: gap grows to 5. Wall a is the
  // anchor (Revit semantics: the locked-to host stays, the follower heals).
  walls[1].params.start = [9, 0];
  walls[1].params.end = [13, 0];
  const out = bridge.solveStoredConstraints(walls, stored, { pinnedIds: ["a"] });
  assert(out.result && out.result.status === "converged", `status ${out.result && out.result.status}`);
  // The anchor never moved.
  nassert.deepStrictEqual(walls[0].params.start, [0, 0]);
  nassert.deepStrictEqual(walls[0].params.end, [4, 0]);
  const gap = walls[1].params.start[0] - walls[0].params.end[0];
  near(gap, 2, 1e-3);
  // Follower's length stays pinned.
  near(Math.hypot(walls[1].params.end[0] - walls[1].params.start[0], 0), 4, 1e-3);
  assert(out.changed >= 1, "at least one wall should move");
});

// ── 2. Locked dimension between two point elements (columns) ────────────────
t("locked-dimension between point elements holds", () => {
  const cols = [
    { id: "c1", type: "column", params: { point: [0, 0] } },
    { id: "c2", type: "column", params: { point: [3.5, 0] } },
  ];
  const stored = [
    { id: "lock-2", type: "locked-dimension", elementIds: ["c1", "c2"], value: 5, active: true, createdAt: 0 },
  ];
  const out = bridge.solveStoredConstraints(cols, stored);
  assert(out.result && out.result.status === "converged", `status ${out.result && out.result.status}`);
  const d = Math.hypot(cols[1].params.point[0] - cols[0].params.point[0], cols[1].params.point[1] - cols[0].params.point[1]);
  near(d, 5, 1e-3);
});

// ── 3. Equality constraint equalises column gaps ────────────────────────────
t("equality equalises consecutive point gaps", () => {
  const cols = [
    { id: "p1", type: "column", params: { point: [0, 0] } },
    { id: "p2", type: "column", params: { point: [4.2, 0] } },
    { id: "p3", type: "column", params: { point: [10, 0] } },
  ];
  const stored = [
    { id: "eq-1", type: "equality", elementIds: ["p1", "p2", "p3"], dimensionLabel: "spacing", active: true, createdAt: 0 },
  ];
  const out = bridge.solveStoredConstraints(cols, stored);
  assert(out.result && out.result.status === "converged", `status ${out.result && out.result.status}`);
  const xs = cols.map((c) => c.params.point[0]).sort((x, y) => x - y);
  const g1 = xs[1] - xs[0];
  const g2 = xs[2] - xs[1];
  near(g1, g2, 1e-3);
});

// ── 4. Equality on walls → equal-length bays ────────────────────────────────
t("equality makes wall lengths identical", () => {
  const walls = [
    { id: "w1", type: "wall", params: { start: [0, 0], end: [3, 0] } },
    { id: "w2", type: "wall", params: { start: [5, 5], end: [11, 5] } },
  ];
  const stored = [
    { id: "eq-2", type: "equality", elementIds: ["w1", "w2"], dimensionLabel: "length", active: true, createdAt: 0 },
  ];
  const out = bridge.solveStoredConstraints(walls, stored);
  assert(out.result && out.result.status === "converged", `status ${out.result && out.result.status}`);
  const l1 = Math.hypot(3 - 0, 0);
  const l2 = Math.hypot(walls[1].params.end[0] - walls[1].params.start[0], 0);
  near(l2, l1, 1e-3);
});

// ── 5. Alignment: point element snaps onto a wall's axis ────────────────────
t("alignment puts a point element onto the wall line", () => {
  const els = [
    { id: "wall", type: "wall", params: { start: [0, 0], end: [10, 0] } },
    { id: "col", type: "column", params: { point: [2, 5] } },
  ];
  const stored = [
    { id: "align-1", type: "alignment", elementIds: ["wall", "col"], active: true, createdAt: 0 },
  ];
  const out = bridge.solveStoredConstraints(els, stored, { pinnedIds: ["wall"] });
  assert(out.result && out.result.status === "converged", `status ${out.result && out.result.status}`);
  near(els[1].params.point[1], 0, 1e-3);
  near(els[1].params.point[0], 2, 1e-3); // slides along the line, x preserved
});

// ── 6. Parallel restores co-direction after a skew edit ─────────────────────
t("parallel makes two walls co-directional", () => {
  const walls = [
    { id: "w1", type: "wall", params: { start: [0, 0], end: [10, 0] } },
    { id: "w2", type: "wall", params: { start: [0.5, 3], end: [4.5, 4] } },
  ];
  const stored = [
    { id: "par-1", type: "parallel", elementIds: ["w1", "w2"], active: true, createdAt: 0 },
  ];
  const out = bridge.solveStoredConstraints(walls, stored, { pinnedIds: ["w1"] });
  assert(out.result && out.result.status === "converged", `status ${out.result && out.result.status}`);
  const p = walls[1].params;
  // w2 became horizontal (co-directional with the anchored w1).
  near(p.end[1] - p.start[1], 0, 1e-3);
  // Length preserved.
  near(Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]), Math.hypot(4, 1), 1e-3);
});

// ── 7. Perpendicular locks a 90° junction ───────────────────────────────────
t("perpendicular squares a wall onto another", () => {
  const walls = [
    { id: "w1", type: "wall", params: { start: [0, 0], end: [10, 0] } },
    { id: "w2", type: "wall", params: { start: [2, 0], end: [4, 3] } },
  ];
  const stored = [
    { id: "perp-1", type: "perpendicular", elementIds: ["w1", "w2"], active: true, createdAt: 0 },
  ];
  const out = bridge.solveStoredConstraints(walls, stored, { pinnedIds: ["w1"] });
  assert(out.result && out.result.status === "converged", `status ${out.result && out.result.status}`);
  const p = walls[1].params;
  near(p.end[0] - p.start[0], 0, 1e-3); // vertical in plan = ⊥ to horizontal wall
  near(Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]), Math.hypot(2, 3), 1e-3);
});

// ── 8. Contradictory locked dims are reported, never applied ────────────────
t("contradictory locked dimensions refuse to mangle geometry", () => {
  const walls = [
    { id: "a", type: "wall", params: { start: [0, 0], end: [4, 0] } },
    { id: "b", type: "wall", params: { start: [6, 0], end: [10, 0] } },
  ];
  const before = JSON.stringify(walls.map((w) => w.params));
  const stored = [
    { id: "lock-a", type: "locked-dimension", elementIds: ["a", "b"], value: 2, active: true, createdAt: 0 },
    { id: "lock-b", type: "locked-dimension", elementIds: ["a", "b"], value: 5, active: true, createdAt: 0 },
  ];
  const out = bridge.solveStoredConstraints(walls, stored);
  assert(out.changed === 0, `changed should be 0, got ${out.changed}`);
  assert(out.errors.length > 0, "an error must be reported");
  assert(JSON.stringify(walls.map((w) => w.params)) === before, "geometry must be untouched");
});

// ── 9. Idempotence: solving twice changes nothing the second time ───────────
t("second solve is a no-op", () => {
  const walls = [
    { id: "a", type: "wall", params: { start: [0, 0], end: [4, 0] } },
    { id: "b", type: "wall", params: { start: [8, 0], end: [12, 0] } },
  ];
  const stored = [
    { id: "lock-9", type: "locked-dimension", elementIds: ["a", "b"], value: 4, active: true, createdAt: 0 },
  ];
  const first = bridge.solveStoredConstraints(walls, stored);
  assert(first.result.status === "converged");
  const second = bridge.solveStoredConstraints(walls, stored);
  near(second.changed, 0, 0);
});

// ── 10. buildSystem layout invariant: segments own 2i / 2i+1 ────────────────
t("buildSystem matches solveAndApply's 2i/2i+1 segment layout", () => {
  const els = [
    { id: "w1", type: "wall", params: { start: [0, 0], end: [1, 0] } },
    { id: "w2", type: "wall", params: { start: [2, 0], end: [3, 0] } },
    { id: "col", type: "column", params: { point: [4, 4] } },
  ];
  const sys = bridge.buildSystem(els);
  nassert.deepStrictEqual(sys.indexOf.get("w1"), [0, 1]);
  nassert.deepStrictEqual(sys.indexOf.get("w2"), [2, 3]);
  nassert.deepStrictEqual(sys.indexOf.get("col"), [4]);
});

// ── 11. parallel/perpendicular creators exist and register active rows ──────
t("addParallel / addPerpendicular register active constraints", () => {
  const c1 = ptypes.addParallel("e1", "e2");
  assert(c1.type === "parallel" && c1.active && c1.elementIds.join() === "e1,e2");
  const c2 = ptypes.addPerpendicular("e3", "e4");
  assert(c2.type === "perpendicular" && c2.active);
  assert(ptypes.getConstraints("e1").some((c) => c.id === c1.id));
  ptypes.removeConstraint(c1.id);
  ptypes.removeConstraint(c2.id);
});

// ── 12. dim-constraints: locked angle rotates the end, preserving length ────
t("dim-constraint angle rotates end about start", () => {
  const els = [{ id: "w", params: { start: [0, 0], end: [4, 3] } }];
  const target = Math.PI / 2;
  const r = dim.applyDimConstraints(els, [
    { id: "d1", elementId: "w", kind: "angle", param: "angle", value: target, locked: true },
  ]);
  assert(r.failures.length === 0, `failures: ${JSON.stringify(r.failures)}`);
  const [ex, ez] = els[0].params.end;
  near(ex, 0, 1e-6);
  near(ez, 5, 1e-6); // length 5 preserved, now at 90°
});

// ── 13. dim-constraints: elevation sets the value ────────────────────────────
t("dim-constraint elevation applies", () => {
  const els = [{ id: "f", params: { elevation: 0 } }];
  const r = dim.applyDimConstraints(els, [
    { id: "d2", elementId: "f", kind: "elevation", param: "elevation", value: 3.5, locked: true },
  ]);
  assert(r.failures.length === 0, `failures: ${JSON.stringify(r.failures)}`);
  near(els[0].params.elevation, 3.5, 0);
});

// ── 14. Family constraint-graph: symmetric kind ──────────────────────────────
t("symmetric constraint holds a + b = 2·centre without oscillation", () => {
  const r = graph.solveConstraints(
    { left: 90, right: 130, mid: 100 },
    [{ kind: "symmetric", a: "left", b: "right", center: "mid" }],
  );
  assert(r.errors.length === 0, `errors: ${r.errors.join("; ")}`);
  // The symmetric PROPERTY must hold exactly — and the solver must not
  // oscillate (a two-sided drive would toggle forever and hit the iter cap).
  near(r.values.left + r.values.right, 2 * r.values.mid, 1e-9);
});

// ── 15. Cycle detection names the parameters BEFORE solving ─────────────────
t("cyclic dependencies are named, not iteration-limit surprises", () => {
  const r = graph.solveConstraints(
    { a: 1, b: 2, c: 3 },
    [
      { kind: "equality", a: "a", b: "b" },
      { kind: "equality", a: "b", b: "a" }, // a → b → a
      { kind: "fixed", a: "c", value: 3 },
    ],
  );
  const cyc = r.errors.find((e) => e.startsWith("cyclic constraint dependency"));
  assert(cyc, `expected cycle error, got: ${r.errors.join("; ")}`);
  assert(cyc.includes("a") && cyc.includes("b"), "cycle must name its parameters");

  // Regression: a legitimate drive chain and distance constraints are NOT cycles.
  const ok = graph.findConstraintCycles([
    { kind: "equality", a: "a", b: "b" },
    { kind: "equality", a: "b", b: "c" },
    { kind: "distance", a: "c", b: "c", distance: 1 },
  ]);
  nassert.deepStrictEqual(ok, []);
});

// ── 16. Under-constrained diagnostics ────────────────────────────────────────
t("unconstrained parameters are reported", () => {
  const r = graph.solveConstraints(
    { a: 1, b: 2, free1: 5 },
    [{ kind: "equality", a: "a", b: "b" }],
  );
  nassert.deepStrictEqual(r.unconstrained, ["free1"]);
});

// ── 17. Wiring guards: the feature layer must run the bridge ────────────────
t("constraint-solver feature wires stored constraints into the solve", () => {
  const src = fs.readFileSync(path.join(root, "src/features/constraint-solver.ts"), "utf8");
  assert(src.includes("solveStoredConstraints"), "feature must call solveStoredConstraints");
  assert(src.includes("getAllConstraints"), "feature must read the constraint store");
  assert(src.includes("solveAll: solveHostedConstraints"), "features.constraintSolver.solveAll must exist");
  assert(!src.includes("__obsSolveAllConstraints"), "no new window.__obs* globals (ui-honesty budget)");
  assert(src.includes("clampHostedOpenings"), "opening clamp must remain part of the pass");
});

t("engineering-engines solveWalls merges stored constraints", () => {
  const src = fs.readFileSync(path.join(root, "src/modules/engineering-engines.ts"), "utf8");
  assert(src.includes("storedToSolverConstraints"), "solveWalls must convert stored constraints");
  assert(src.includes("getAllConstraints"), "solveWalls must read the constraint store");
});

t("parametric-constraints module exports the bridge", () => {
  const idx = fs.readFileSync(path.join(root, "src/modules/parametric-constraints/index.ts"), "utf8");
  assert(idx.includes('export * from "./solver-bridge"'), "index must re-export solver-bridge");
});

// ── 18. Registration guards: test wired into package.json + CI manifest ─────
t("test registered in package.json and CI manifest", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert(pkg.scripts["test:parametric-closure"] === "node tests/parametric-closure.test.cjs");
  const manifest = fs.readFileSync(path.join(root, "scripts/ci-unit-tests.mjs"), "utf8");
  assert(manifest.includes('"test:parametric-closure"'), "CI manifest must run this suite");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
