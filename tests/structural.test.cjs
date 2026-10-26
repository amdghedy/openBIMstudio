/**
 * tests/structural.test.cjs
 *
 * Unit tests for the structural engines: 2D frame FEM solver
 * (analytical-model/fem.ts), steel section catalog, and member code checks
 * (checks.ts). Every FEM case is verified against a closed-form solution.
 *
 * Run: `node tests/structural.test.cjs`
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
  // NaN-guard: a NaN result used to slip through (NaN > x === false) and
  // made the whole FEM suite pass vacuously when the transform broke.
  if (!Number.isFinite(d) || d > tolPct / 100) {
    throw new Error(`Expected ${a} ~ ${b} (±${tolPct}%), off by ${(d * 100).toFixed(2)}%`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-structural-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/analytical-model/fem.ts src/modules/analytical-model/checks.ts src/modules/analytical-model/sections.ts src/modules/analytical-model/types.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const fem = require(path.join(tmpOut, "modules/analytical-model/fem.js"));
const checks = require(path.join(tmpOut, "modules/analytical-model/checks.js"));
const sections = require(path.join(tmpOut, "modules/analytical-model/sections.js"));

const E = 200e9; // steel Pa

// ── 1. Simply supported beam, UDL — exact closed form ───────────────────────
t("SS beam UDL: reactions, midspan moment and deflection match closed form", () => {
  const L = 6, w = 10000; // N/m
  const I = 1e-4;         // m^4
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, ux: true, uy: true },   // pin
      { id: "M", x: 3, y: 0 },
      { id: "B", x: 6, y: 0, uy: true },             // roller
    ],
    members: [
      { id: "e1", nodeA: "A", nodeB: "M", E, A: 1e-2, I },
      { id: "e2", nodeA: "M", nodeB: "B", E, A: 1e-2, I },
    ],
    memberUdls: [
      { memberId: "e1", wy: -w },
      { memberId: "e2", wy: -w },
    ],
  };
  const r = fem.solveFrame(model);

  // Reactions wL/2 = 30 kN up each.
  const rA = r.reactions.find((x) => x.nodeId === "A");
  const rB = r.reactions.find((x) => x.nodeId === "B");
  rel(rA.fy, w * L / 2, 0.01);
  rel(rB.fy, w * L / 2, 0.01);

  // Midspan deflection 5wL⁴/384EI.
  const dM = r.displacements.get("M");
  rel(Math.abs(dM[1]), (5 * w * Math.pow(L, 4)) / (384 * E * I), 0.1);

  // Member end forces: e1 shear at A = +wL/2, midspan shear = 0,
  // end moments 0 at supports, midspan moment wL²/8 sagging.
  const f1 = r.memberForces.get("e1");
  const f2 = r.memberForces.get("e2");
  rel(f1.V1, w * L / 2, 0.01);
  near(Math.abs(f1.V2), 0, 1e-3);
  near(Math.abs(f1.M1), 0, 1.0);
  rel(f1.M2, (w * L * L) / 8, 0.5);
  rel(f2.M1, (w * L * L) / 8, 0.5);
  near(Math.abs(f2.M2), 0, 1.0);
  rel(f2.V2, -w * L / 2, 0.01); // standard convention: right-end shear negative
});

// ── 2. Cantilever with tip load — exact ─────────────────────────────────────
t("cantilever tip load: tip deflection PL³/3EI, base moment −PL", () => {
  const L = 4, P = 10000, I = 1e-4;
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, ux: true, uy: true, rz: true }, // fixed
      { id: "B", x: L, y: 0 },
    ],
    members: [{ id: "c", nodeA: "A", nodeB: "B", E, A: 1e-2, I }],
    nodalLoads: [{ nodeId: "B", fy: -P }],
  };
  const r = fem.solveFrame(model);
  const dB = r.displacements.get("B");
  rel(Math.abs(dB[1]), (P * Math.pow(L, 3)) / (3 * E * I), 0.1);
  const f = r.memberForces.get("c");
  rel(f.M1, -P * L, 0.01);   // hogging at base, sagging-positive convention
  rel(f.V1, P, 0.01);        // upward reaction at base
  // Deflection profile matches the exact elastic curve v(x) = P·x²(3L−x)/(6EI).
  const prof = fem.memberDeflectionProfile(model, r, "c", 11);
  const mid = prof[5]; // x = L/2 = 2 m
  const xMid = 2;
  rel(Math.abs(mid.v), (P * xMid * xMid * (3 * L - xMid)) / (6 * E * I), 2);
});

// ── 3. Axial truss member ───────────────────────────────────────────────────
t("axial member: parallel bars share load, N = P/2 each", () => {
  const P = 50000;
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, ux: true, uy: true },
      { id: "B", x: 3, y: 0, uy: true },   // roller: x free
      { id: "C", x: 6, y: 0, ux: true, uy: true },
    ],
    members: [
      { id: "t1", nodeA: "A", nodeB: "B", E, A: 2e-3, I: 0, truss: true },
      { id: "t2", nodeA: "B", nodeB: "C", E, A: 2e-3, I: 0, truss: true },
    ],
    nodalLoads: [{ nodeId: "B", fx: P }],
  };
  const r = fem.solveFrame(model);
  // Same tension P/2 in both bars; end-force signs flip with member axis.
  rel(r.memberForces.get("t1").N2, P / 2, 0.01);
  rel(r.memberForces.get("t2").N2, -P / 2, 0.01);
  // Elongation of each bar: PL/(2AE)
  const dB = r.displacements.get("B");
  rel(dB[0], (P * 3) / (2 * 2e-3 * E), 0.5);
});

// ── 4. Inclined member: load transformed through member axis ────────────────
t("inclined brace: joint equilibrium N = P/cosθ", () => {
  // 3-4-5 brace, roller at B: vertical load creates axial force N = P·sinθ
  const P = 20000;
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, ux: true, uy: true },
      { id: "B", x: 4, y: 3, uy: true }, // roller vertically restrained only? roller restrains uy
    ],
    members: [{ id: "b", nodeA: "A", nodeB: "B", E, A: 2e-3, I: 0, truss: true }],
    nodalLoads: [{ nodeId: "B", fx: P }],
  };
  const r = fem.solveFrame(model);
  const f = r.memberForces.get("b");
  rel(f.N2, P / 0.8, 1); // N = P / cosθ, cosθ = 4/5
});

// ── 5. Frame member rotation: 90° column with lateral load ──────────────────
t("column with top point load shears and bends", () => {
  const L = 3, P = 8000, I = 5e-5;
  const model = {
    nodes: [
      { id: "base", x: 0, y: 0, ux: true, uy: true, rz: true },
      { id: "top", x: 0, y: L },
    ],
    members: [{ id: "col", nodeA: "base", nodeB: "top", E, A: 1e-2, I }],
    nodalLoads: [{ nodeId: "top", fx: P }],
  };
  const r = fem.solveFrame(model);
  const f = r.memberForces.get("col");
  rel(f.V1, P, 0.01);            // shear = P
  rel(f.M1, -P * L, 0.01);       // base hogging PL
  // Tip deflection PL³/3EI
  const dTop = r.displacements.get("top");
  rel(Math.abs(dTop[0]), (P * Math.pow(L, 3)) / (3 * E * I), 0.1);
});

// ── 6. Steel catalog sanity ─────────────────────────────────────────────────
t("steel catalog: lookup, units, plastic/elastic modulus consistency", () => {
  const s = sections.findSection("w14x22");
  assert(s, "W14X22 lookup failed");
  rel(s.d, 13.7 * 0.0254, 0.01);
  rel(s.Zx, 33.1 * Math.pow(0.0254, 3), 0.01);
  rel(s.Ix, 199 * Math.pow(0.0254, 4), 0.01);
  // Shape factor Zx / Wel where Wel ≈ Ix/(d/2) must be ~1.1 for I-shapes.
  const Wel = s.Ix / (s.d / 2);
  const shape = s.Zx / Wel;
  assert(shape > 1.05 && shape < 1.25, `shape factor ${shape.toFixed(2)} out of range`);
  // Metric IPE/HEA values
  const ipe = sections.findSection("IPE300");
  rel(ipe.Ix, 8356e-8, 0.01);
  rel(ipe.Zx, 628.4e-6, 0.01);
  const hea = sections.findSection("HEA300");
  rel(hea.Zx, 1383.2e-6, 0.01);
});

// ── 7. Steel check math with synthetic section ──────────────────────────────
t("steel check: utilization math and pass/fail", () => {
  const sec = {
    id: "TEST", family: "W", d: 0.5, tw: 0.01, bf: 0.2,
    A: 9e-3, Ix: 3e-4, Zx: 1.3e-3, Fy: 345e6,
  };
  const phiMp = 0.9 * 345e6 * 1.3e-3; // 403,650 N·m
  const phiVn = 1.0 * 0.6 * 345e6 * (0.5 * 0.01); // 1,035,000 N

  const r1 = checks.checkSteel(sec, { Mu: 200000, Vu: 500000, deflection: 0.01, span: 6 });
  rel(r1.flexUtil, 200000 / phiMp, 0.1);
  rel(r1.shearUtil, 500000 / phiVn, 0.1);
  rel(r1.deflUtil, 0.01 / (6 / 240), 0.1);
  assert(r1.pass, "should pass");
  rel(r1.utilization, Math.max(200000 / phiMp, 500000 / phiVn, 0.01 / (6 / 240)), 0.1);

  const r2 = checks.checkSteel(sec, { Mu: 500000, Vu: 100000, deflection: 0.001, span: 6 });
  assert(!r2.pass, "should fail on moment");
  assert(r2.notes.some((n) => n.includes("flexural")), "should flag flexural over-stress");
});

// ── 8. RC check: As sizing against hand calculation ─────────────────────────
t("RC beam: As required matches hand calc, shear stirrups sized", () => {
  // b=300, h=600, d=540, f'c=25 MPa, fy=420 MPa, Mu=200 kN·m, Vu=120 kN
  const input = { b: 0.3, h: 0.6, d: 0.54, fc: 25e6, fy: 420e6 };
  const Mu = 200e3, Vu = 120e3;
  const r = checks.checkRcBeam(input, { Mu, Vu });

  // Hand calc: Rn = Mu/(φ b d²) = 200e6/(0.9·300·540²) = 2.543...
  const Rn = 200e3 / (0.9 * 0.3 * 0.54 * 0.54); // Pa
  const k = 0.85 * 25e6 / 420e6; // ρ coefficient, consistent SI units
  const rho = k * (1 - Math.sqrt(1 - (2 * Rn) / (0.85 * 25e6)));
  const AsHand = rho * 0.3 * 0.54;
  rel(r.AsReq, AsHand, 0.5);
  assert(r.AsReq > 900e-6 && r.AsReq < 1300e-6, `AsReq ${r.AsReq * 1e6} mm² out of plausible range`);

  // φMn with AsReq reproduces Mu
  rel(r.phiMn, Mu, 0.5);
  rel(r.a, (AsHand * 420e6) / (0.85 * 25e6 * 0.3), 0.5);

  // Shear: φVc = 0.75·0.17·√25·300·540 = 103.3 kN; Vu=120 > φVc/2 → stirrups
  const phiVcHand = 0.75 * 0.17 * 5 * 1e6 * 0.3 * 0.54;
  rel(r.phiVc, phiVcHand, 0.5);
  assert(r.stirrupSpacing !== null, "stirrups should be required");
  assert(r.stirrupSpacing <= 0.54 / 2 + 1e-9, "spacing capped at d/2");
});

// ── 9. RC: small demand → no stirrups, As small but ≥ 0 ────────────────────
t("RC beam: light load needs no stirrups", () => {
  const r = checks.checkRcBeam(
    { b: 0.3, h: 0.6, d: 0.54, fc: 25e6, fy: 420e6 },
    { Mu: 50e3, Vu: 20e3 },
  );
  assert(r.stirrupSpacing === null, "no stirrups expected");
  assert(r.pass, "should pass");
  rel(r.phiVc, 0.75 * 0.17 * 5 * 1e6 * 0.3 * 0.54, 0.5);
});

// ── 10. Unstable model detection ────────────────────────────────────────────
t("unstable model throws", () => {
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, uy: true }, // only vertical restraint — laterally unstable
      { id: "B", x: 3, y: 0 },
    ],
    members: [{ id: "m", nodeA: "A", nodeB: "B", E, A: 1e-2, I: 1e-4 }],
    nodalLoads: [{ nodeId: "B", fy: -1000 }],
  };
  let threw = false;
  try { fem.solveFrame(model); } catch { threw = true; }
  assert(threw, "expected throw for unstable structure");
});

// ── 11. Zero-length member rejected ─────────────────────────────────────────
t("zero-length member throws", () => {
  const model = {
    nodes: [
      { id: "A", x: 0, y: 0, ux: true, uy: true, rz: true },
      { id: "B", x: 0, y: 0 },
    ],
    members: [{ id: "m", nodeA: "A", nodeB: "B", E, A: 1e-2, I: 1e-4 }],
  };
  let threw = false;
  try { fem.solveFrame(model); } catch (e) { threw = true; }
  assert(threw, "expected throw for zero-length member");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
