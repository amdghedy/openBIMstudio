/**
 * tests/structural-3d.test.cjs
 *
 * Unit tests for the 3D frame FEM solver (analytical-model/fem3d.ts), the
 * analytical-model generator (analytical-model.ts) and the load-combination
 * sweep (combo-sweep.ts). Every solver case is verified against a
 * closed-form solution.
 *
 * Run: `node tests/structural-3d.test.cjs`
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
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), got ${a}`);
  }
}

function rel(a, b, tolPct = 0.5) {
  const d = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  if (!Number.isFinite(d) || d > tolPct / 100) {
    throw new Error(`Expected ${a} ~ ${b} (±${tolPct}%), off by ${(d * 100).toFixed(2)}%`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-structural3d-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/analytical-model/fem3d.ts src/modules/analytical-model/analytical-model.ts src/modules/analytical-model/combo-sweep.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const { solveFrame3D, memberDeflectionProfile3D } = require(path.join(tmpOut, "modules/analytical-model/fem3d.js"));
const { generateAnalyticalModel, rectTorsionConstant, selfWeightUdls } = require(path.join(tmpOut, "modules/analytical-model/analytical-model.js"));
const { sweepCombinations } = require(path.join(tmpOut, "modules/analytical-model/combo-sweep.js"));

const E = 30e9;
const nu = 0.2;
const G = E / (2 * (1 + nu));

// ═══════════════════════════════════════════════════════════════════════════
// 3D solver — closed-form verification
// ═══════════════════════════════════════════════════════════════════════════

console.log("3D frame solver:");

t("axial bar: u = PL/EA along the axis", () => {
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true, ry: true, rz: true },
      { id: "B", x: 2, y: 0, z: 0 },
    ],
    members: [{ id: "m1", nodeA: "A", nodeB: "B", E, A: 0.01, Izz: 1e-6, Iyy: 1e-6, J: 1e-6 }],
    nodalLoads: [{ nodeId: "B", fx: 1000 }],
  };
  const r = solveFrame3D(model);
  rel(r.displacements.get("B")[0], 1000 * 2 / (E * 0.01), 0.01);
  near(r.reactions[0].fx, -1000, 1e-6);
});

t("cantilever tip load: deflection PL³/3EIzz (strong axis)", () => {
  // Beam along X: local y = global Z → vertical load bends about local z (Izz).
  const b = 0.2, d = 0.4;
  const Izz = b * Math.pow(d, 3) / 12;
  const L = 2;
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true, ry: true, rz: true },
      { id: "B", x: L, y: 0, z: 0 },
    ],
    members: [{ id: "m1", nodeA: "A", nodeB: "B", E, A: b * d, Izz, Iyy: d * b * b * b / 12, J: rectTorsionConstant(b, d) }],
    nodalLoads: [{ nodeId: "B", fz: -1000 }],
  };
  const r = solveFrame3D(model);
  rel(r.displacements.get("B")[2], -1000 * Math.pow(L, 3) / (3 * E * Izz), 0.01);
  rel(r.reactions[0].fz, 1000, 0.01);
  rel(Math.abs(r.reactions[0].my), 1000 * L, 0.01); // fixed-end moment P·L
  near(r.reactions[0].fx, 0, 1e-9);
});

t("simply supported UDL: 5wL⁴/384EI at midspan", () => {
  const b = 0.2, d = 0.5;
  const Izz = b * Math.pow(d, 3) / 12;
  const L = 4;
  const w = 1000; // N/m downward
  const model = {
    nodes: [
      // rx restrained at A: a 3D beam with both ends free to spin about its
      // own axis has a rigid-body torsion mode (no 2D analog).
      { id: "A", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true },
      { id: "B", x: L, y: 0, z: 0, uy: true, uz: true },
    ],
    members: [{ id: "m1", nodeA: "A", nodeB: "B", E, A: b * d, Izz, Iyy: d * b * b * b / 12, J: rectTorsionConstant(b, d) }],
    memberUdls: [{ memberId: "m1", wz: -w }],
  };
  const r = solveFrame3D(model);
  const prof = memberDeflectionProfile3D(model, r, "m1", 3);
  const mid = prof[1];
  rel(mid.v, -5 * w * Math.pow(L, 4) / (384 * E * Izz), 0.1);
  // Reactions share the load equally and point up.
  const rz = r.reactions.map((x) => x.fz).sort((a, b2) => a - b2);
  rel(rz[0], w * L / 2, 0.01);
  rel(rz[1], w * L / 2, 0.01);
});

t("torsion: θ = TL/GJ", () => {
  const b = 0.2, d = 0.3;
  const J = rectTorsionConstant(b, d);
  assert(J > 0, "rect torsion constant must be positive");
  const L = 2;
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true, ry: true, rz: true },
      { id: "B", x: L, y: 0, z: 0 },
    ],
    members: [{ id: "m1", nodeA: "A", nodeB: "B", E, G, A: b * d, Izz: 1e-4, Iyy: 1e-4, J }],
    // For a beam along X, torsion = rotation about global X (local x).
    nodalLoads: [{ nodeId: "B", mx: 500 }],
  };
  const r = solveFrame3D(model);
  rel(r.displacements.get("B")[3], 500 * L / (G * J), 0.01);
  rel(r.reactions[0].mx, -500, 0.01);
});

t("shear frame sway: Δ ≈ H·h³/(24·EI_col) for fixed-fixed columns", () => {
  const b = 0.3;
  const Icol = b * b * b * b / 12;
  const h = 3;
  const H = 5000;
  const model = {
    nodes: [
      { id: "c1", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true, ry: true, rz: true },
      { id: "c2", x: 6, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true, ry: true, rz: true },
      { id: "t1", x: 0, y: 0, z: h },
      { id: "t2", x: 6, y: 0, z: h },
    ],
    members: [
      { id: "col1", nodeA: "c1", nodeB: "t1", E, A: b * b, Izz: Icol, Iyy: Icol, J: rectTorsionConstant(b, b) },
      { id: "col2", nodeA: "c2", nodeB: "t2", E, A: b * b, Izz: Icol, Iyy: Icol, J: rectTorsionConstant(b, b) },
      // Rigid diaphragm: 1000× stiffer than the columns.
      { id: "beam", nodeA: "t1", nodeB: "t2", E: E * 1000, A: 0.5, Izz: Icol * 1000, Iyy: Icol * 1000, J: 1e-3 },
    ],
    nodalLoads: [{ nodeId: "t1", fx: H / 2 }, { nodeId: "t2", fx: H / 2 }],
  };
  const r = solveFrame3D(model);
  const sway = r.displacements.get("t1")[0];
  rel(sway, H * Math.pow(h, 3) / (24 * E * Icol), 1.0);
  const fsum = r.reactions.reduce((s, x) => s + x.fx, 0);
  rel(Math.abs(fsum), H, 0.01); // reactions oppose the applied load exactly
});

t("skewed member: axial along arbitrary 3D direction", () => {
  const L = Math.sqrt(17); // (2,2,3)
  const d = [2 / L, 2 / L, 3 / L];
  const P = 1000;
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true, ry: true, rz: true },
      { id: "B", x: 2, y: 2, z: 3 },
    ],
    members: [{ id: "m1", nodeA: "A", nodeB: "B", E, A: 0.01, Izz: 1e-5, Iyy: 1e-5, J: 1e-5 }],
    nodalLoads: [{ nodeId: "B", fx: P * d[0], fy: P * d[1], fz: P * d[2] }],
  };
  const r = solveFrame3D(model);
  const uB = r.displacements.get("B");
  rel(Math.hypot(uB[0], uB[1], uB[2]), P * L / (E * 0.01), 0.01);
  // Displacement is parallel to the member axis.
  const dot = uB[0] * d[0] + uB[1] * d[1] + uB[2] * d[2];
  rel(dot, Math.hypot(uB[0], uB[1], uB[2]), 0.5);
});

t("biaxial bending superposes (Izz ≠ Iyy)", () => {
  const b = 0.2, d = 0.4;
  const Izz = b * Math.pow(d, 3) / 12;
  const Iyy = d * Math.pow(b, 3) / 12;
  const L = 2;
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true, ry: true, rz: true },
      { id: "B", x: L, y: 0, z: 0 },
    ],
    members: [{ id: "m1", nodeA: "A", nodeB: "B", E, A: b * d, Izz, Iyy, J: rectTorsionConstant(b, d) }],
    nodalLoads: [{ nodeId: "B", fz: -1000, fy: 500 }],
  };
  const r = solveFrame3D(model);
  const uB = r.displacements.get("B");
  rel(uB[2], -1000 * Math.pow(L, 3) / (3 * E * Izz), 0.01);
  rel(uB[1], 500 * Math.pow(L, 3) / (3 * E * Iyy), 0.01);
});

t("tripod truss: pin joints auto-restrained, statics-exact axial forces", () => {
  // Apex B above interior point; supports A, C, D. Closed form from 3D
  // equilibrium: T12 = P·√14/9 (two symmetric bars), T3 = P·√13/9.
  const P = 10000;
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true },
      { id: "C", x: 4, y: 0, z: 0, ux: true, uy: true, uz: true },
      { id: "D", x: 2, y: 3, z: 0, ux: true, uy: true, uz: true },
      { id: "B", x: 2, y: 1, z: 3 },
    ],
    members: [
      { id: "ab", nodeA: "A", nodeB: "B", E, A: 0.01, Izz: 0, Iyy: 0, J: 0, truss: true },
      { id: "cb", nodeA: "C", nodeB: "B", E, A: 0.01, Izz: 0, Iyy: 0, J: 0, truss: true },
      { id: "db", nodeA: "D", nodeB: "B", E, A: 0.01, Izz: 0, Iyy: 0, J: 0, truss: true },
    ],
    nodalLoads: [{ nodeId: "B", fz: -P }],
  };
  const r = solveFrame3D(model);
  // Legs push up on the apex → compression (negative = compression here).
  const T12 = -P * Math.sqrt(14) / 9;
  const T3 = -P * Math.sqrt(13) / 9;
  rel(r.memberForces.get("ab").N1, T12, 0.5);
  rel(r.memberForces.get("cb").N1, T12, 0.5);
  rel(r.memberForces.get("db").N1, T3, 0.5);
  const fzSum = r.reactions.reduce((s2, x) => s2 + x.fz, 0);
  rel(fzSum, P, 0.01); // reactions balance the load
});

t("unstable model throws (no supports)", () => {
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, z: 0 },
      { id: "B", x: 2, y: 0, z: 0 },
    ],
    members: [{ id: "m1", nodeA: "A", nodeB: "B", E, A: 0.01, Izz: 1e-5, Iyy: 1e-5, J: 1e-5 }],
    nodalLoads: [{ nodeId: "B", fz: -100 }],
  };
  let threw = false;
  try { solveFrame3D(model); } catch { threw = true; }
  assert(threw, "expected instability error");
});

// ═══════════════════════════════════════════════════════════════════════════
// Analytical model generation
// ═══════════════════════════════════════════════════════════════════════════

console.log("Analytical model generation:");

t("portal frame: 2 columns + beam weld to 4 nodes, bases fixed", () => {
  const els = [
    { id: "c1", type: "column", params: { point: [0, 0], elevation: 0, height: 3, thickness: 0.3 } },
    { id: "c2", type: "column", params: { point: [6, 0], elevation: 0, height: 3, thickness: 0.3 } },
    { id: "b1", type: "beam", params: { start: [0, 0], end: [6, 0], elevation: 3, height: 0.5, thickness: 0.25 } },
  ];
  const gen = generateAnalyticalModel(els);
  near(gen.diagnostics.nodes, 4, 0);
  near(gen.model.members.length, 3, 0);
  near(gen.diagnostics.columns, 2, 0);
  near(gen.diagnostics.beams, 1, 0);
  near(gen.diagnostics.weldedAdjustments, 2, 0); // beam ends weld onto column tops
  near(gen.diagnostics.maxWeldDz, 0, 1e-9);
  const bases = gen.model.nodes.filter((n) => n.ux && n.uz);
  near(bases.length, 2, 0);
  for (const n of bases) near(n.z, 0, 1e-9);
  // Fixed base fixity: rotations restrained too.
  assert(bases.every((n) => n.rz === true), "fixed base must restrain rotations");
  // The generated model solves.
  const topNode = gen.model.nodes.find((n) => n.z > 2);
  const r = solveFrame3D({ ...gen.model, nodalLoads: [{ nodeId: topNode.id, fz: -20000 }] });
  assert(Number.isFinite(r.maxDeflection) && r.maxDeflection > 0);
  // Vertical equilibrium: ΣRz = applied load.
  const rzSum = r.reactions.reduce((s2, x) => s2 + x.fz, 0);
  rel(Math.abs(rzSum), 20000, 0.01);
});

t("beam drawn below column top snaps up (analytical adjustment)", () => {
  const els = [
    { id: "c1", type: "column", params: { point: [0, 0], elevation: 0, height: 3, thickness: 0.3 } },
    { id: "c2", type: "column", params: { point: [6, 0], elevation: 0, height: 3, thickness: 0.3 } },
    // Beam bottom at 2.8 — 0.2 m below the column tops at 3.0.
    { id: "b1", type: "beam", params: { start: [0, 0], end: [6, 0], elevation: 2.8, height: 0.5, thickness: 0.25 } },
  ];
  const gen = generateAnalyticalModel(els);
  near(gen.diagnostics.nodes, 4, 0);
  near(gen.diagnostics.weldedAdjustments, 2, 0);
  rel(gen.diagnostics.maxWeldDz, 0.2, 1e-6);
  // Welded to the higher z (column tops at 3.0).
  const topZs = gen.model.nodes.map((n) => n.z).filter((z) => z > 2).sort();
  rel(topZs[0], 3.0, 1e-9);
});

t("stacked columns share one node through the level, only base is fixed", () => {
  const els = [
    { id: "c1", type: "column", params: { point: [0, 0], elevation: 0, height: 3, thickness: 0.3 } },
    { id: "c2", type: "column", params: { point: [0, 0], elevation: 3, height: 3, thickness: 0.3 } },
  ];
  const gen = generateAnalyticalModel(els);
  near(gen.diagnostics.nodes, 3, 0); // 0, 3 (shared), 6
  near(gen.model.members.length, 2, 0);
  const fixed = gen.model.nodes.filter((n) => n.ux);
  near(fixed.length, 1, 0);
  near(fixed[0].z, 0, 1e-9);
});

t("brace that does not land on the frame is diagnosed", () => {
  const els = [
    { id: "c1", type: "column", params: { point: [0, 0], elevation: 0, height: 3, thickness: 0.3 } },
    { id: "br1", type: "brace", params: { start: [0, 0], end: [3, 0], elevation: 0, height: 1.5, thickness: 0.15 } },
  ];
  const gen = generateAnalyticalModel(els);
  assert(
    gen.diagnostics.warnings.some((w) => w.includes("brace") && w.includes("does not land")),
    `expected brace landing warning, got: ${JSON.stringify(gen.diagnostics.warnings)}`,
  );
});

t("section inference: beam depth vs column square", () => {
  const els = [
    { id: "c1", type: "column", params: { point: [0, 0], elevation: 0, height: 3, thickness: 0.3 } },
  ];
  const gen = generateAnalyticalModel(els);
  const m = gen.model.members[0];
  rel(m.A, 0.3 * 0.3, 1e-9);
  rel(m.Izz, 0.3 * Math.pow(0.3, 3) / 12, 1e-9);
  const elsBeam = [
    { id: "b1", type: "beam", params: { start: [0, 0], end: [4, 0], elevation: 0, height: 0.5, thickness: 0.25 } },
  ];
  const genB = generateAnalyticalModel(elsBeam);
  rel(genB.model.members[0].Izz, 0.25 * Math.pow(0.5, 3) / 12, 1e-9);
});

t("self-weight UDLs: density · A downward on every member", () => {
  const els = [
    { id: "b1", type: "beam", params: { start: [0, 0], end: [4, 0], elevation: 0, height: 0.5, thickness: 0.25 } },
  ];
  const gen = generateAnalyticalModel(els);
  const sw = selfWeightUdls(gen, 24000);
  near(sw.length, gen.model.members.length, 0);
  rel(sw[0].wz, -24000 * 0.25 * 0.5, 1e-9);
});

// ═══════════════════════════════════════════════════════════════════════════
// Combination sweep
// ═══════════════════════════════════════════════════════════════════════════

console.log("Combination sweep:");

const sweepModel = () => ({
  nodes: [
    { id: "A", x: 0, y: 0, z: 0, ux: true, uy: true, uz: true, rx: true },
    { id: "B", x: 4, y: 0, z: 0, uy: true, uz: true },
  ],
  members: [{ id: "beam-b1", nodeA: "A", nodeB: "B", E, A: 0.125, Izz: 0.00208333, Iyy: 5.2e-4, J: 1e-4 }],
});

t("envelope picks the governing combination for bending", () => {
  const model = sweepModel();
  const cases = [
    { id: "lc-d", name: "Dead", category: "dead", selfWeightMultiplier: 0, type: "line", magnitude: 5000 },
    { id: "lc-l", name: "Live", category: "live", selfWeightMultiplier: 0, type: "line", magnitude: 2500 },
  ];
  const combos = [
    { id: "k1", name: "1.4D", cases: [{ caseId: "lc-d", factor: 1.4 }] },
    { id: "k2", name: "1.2D + 1.6L", cases: [{ caseId: "lc-d", factor: 1.2 }, { caseId: "lc-l", factor: 1.6 }] },
  ];
  const rep = sweepCombinations(model, cases, combos);
  near(rep.results.length, 2, 0);
  const env = rep.envelope.get("beam-b1");
  // 1.4D: w = 7000 → M = 14 kN·m. 1.2D+1.6L: w = 10000 → M = 20 kN·m.
  rel(env.MzMax.value, 20000, 0.5);
  assert(env.MzMax.combo === "1.2D + 1.6L", `governing combo should be 1.2D+1.6L, got ${env.MzMax.combo}`);
  const eq = rep.equilibrium[1];
  assert(eq.ok, `equilibrium must hold: Rz=${eq.reactionSumZ} vs W=${eq.loadSumZ}`);
  rel(Math.abs(eq.reactionSumZ), 10000 * 4, 0.5); // ΣR = −ΣF
});

t("self-weight multiplier feeds the sweep", () => {
  const model = sweepModel();
  const cases = [
    { id: "lc-d", name: "Dead", category: "dead", selfWeightMultiplier: 1, type: "line", magnitude: 0 },
  ];
  const combos = [{ id: "k1", name: "1.4D", cases: [{ caseId: "lc-d", factor: 1.4 }] }];
  const rep = sweepCombinations(model, cases, combos);
  const eq = rep.equilibrium[0];
  // 1.4 · density · A · L = 1.4 · 24000 · 0.125 · 4 = 16800 N.
  rel(eq.reactionSumZ, 1.4 * 24000 * 0.125 * 4, 0.5);
  assert(eq.ok, "self-weight equilibrium must hold");
});

t("untargeted wind line case lands on columns by category", () => {
  // Portal: two columns fixed at base + rigid beam.
  const gen = generateAnalyticalModel([
    { id: "c1", type: "column", params: { point: [0, 0], elevation: 0, height: 3, thickness: 0.3 } },
    { id: "c2", type: "column", params: { point: [6, 0], elevation: 0, height: 3, thickness: 0.3 } },
    { id: "b1", type: "beam", params: { start: [0, 0], end: [6, 0], elevation: 3, height: 0.5, thickness: 0.25 } },
  ]);
  const cases = [
    { id: "lc-w", name: "Wind X", category: "wind", selfWeightMultiplier: 0, type: "line", magnitude: 2000, direction: { x: 1, y: 0, z: 0 } },
    { id: "lc-d", name: "Dead", category: "dead", selfWeightMultiplier: 0, type: "line", magnitude: 0 },
  ];
  const combos = [{ id: "k1", name: "1.0W", cases: [{ caseId: "lc-w", factor: 1.0 }] }];
  const rep = sweepCombinations(gen.model, cases, combos);
  near(rep.results.length, 1, 0);
  // Sway must be non-zero and finite — wind actually pushed the columns.
  const top = [...rep.results[0].result.displacements.entries()].find(([id]) => (gen.model.nodes.find((n) => n.id === id) || {}).z > 2)[1];
  assert(Number.isFinite(top[0]) && Math.abs(top[0]) > 1e-9, `wind must sway the frame, got ${top[0]}`);
  const fxSum = rep.results[0].result.reactions.reduce((s, r) => s + r.fx, 0);
  rel(Math.abs(fxSum), 2000 * 3 * 2, 1); // w·h per column × 2 columns, opposed
});

// ── Registration check (drift guard): both registries must list this test ──
t("CI registration: test listed in package.json and ci-unit-tests.mjs", () => {
  const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");
  assert(pkg.includes("test:structural-3d"), "package.json must register test:structural-3d");
  const ci = fs.readFileSync(path.join(root, "scripts/ci-unit-tests.mjs"), "utf8");
  assert(ci.includes("test:structural-3d"), "ci-unit-tests.mjs must register test:structural-3d");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
