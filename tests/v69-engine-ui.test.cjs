/**
 * tests/v69-engine-ui.test.cjs
 *
 * Unit tests for the v69 engine-UI module (src/features/engine-ui.ts).
 * The dialogs themselves need a browser; what is testable in Node are
 * the pure helpers the dialogs are built on:
 *
 *   - point/profile/duct-line parsing (exact, error cases)
 *   - frame model construction + FEM equilibrium + closed-form beam math
 *   - two-branch network building + worst-path selection
 *   - solid diagnostics summarisation (watertight box vs degenerate mesh)
 *   - project parameter registration (formula -> read-only, symbol rules)
 *   - Node-safe loading (no window/document at module scope)
 *
 * Run: `node tests/v69-engine-ui.test.cjs`
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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function near(a, b, tol = 1e-6) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
}

function throws(fn, frag) {
  try {
    fn();
  } catch (e) {
    if (frag && !String(e.message).includes(frag)) {
      throw new Error(`Expected error containing "${frag}", got: ${e.message}`);
    }
    return;
  }
  throw new Error("expected function to throw");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-engine-ui-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/features/engine-ui.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const ui = require(path.join(tmpOut, "features", "engine-ui.js"));

console.log("== tests/v69-engine-ui.test.cjs");

// ── 1. Parsing helpers ──────────────────────────────────────────────────────

t("parsePointList: 2D points get z=0", () => {
  const pts = ui.parsePointList("0,0; 6,0; 6,0.3");
  assert(pts.length === 3, "3 points");
  near(pts[0].x, 0); near(pts[0].y, 0); near(pts[0].z, 0);
  near(pts[2].x, 6); near(pts[2].y, 0.3); near(pts[2].z, 0);
});

t("parsePointList: 3D points preserved", () => {
  const pts = ui.parsePointList("0,0,0\n6,0,2.5");
  near(pts[1].z, 2.5);
});

t("parsePointList: rejects garbage", () => {
  throws(() => ui.parsePointList("0,0; abc"), "bad point");
});

t("parseProfile: needs >= 3 points, auto-closes the ring", () => {
  const ring = ui.parseProfile("0,0; 4,0; 4,0.2; 0,0.2");
  assert(ring.length === 5, "4 pts + closure = 5");
  near(ring[4].u, 0); near(ring[4].v, 0);
  throws(() => ui.parseProfile("0,0; 1,0"), "at least 3");
});

t("parseDuctLines: valid lines + error case", () => {
  const segs = ui.parseDuctLines("0.8,10,0.4\n0.5,8,0.3");
  assert(segs.length === 2, "two segments");
  near(segs[0].flow, 0.8); near(segs[1].diameter, 0.3);
  throws(() => ui.parseDuctLines("0.8,10"), "bad line");
  throws(() => ui.parseDuctLines(""), "at least one");
});

// ── 2. Frame model + FEM equilibrium + closed forms ────────────────────────

t("buildFrameModel: node/member counts", () => {
  const m = ui.buildFrameModel({ bays: 3, bayWidth: 6, height: 3.5, udlKnm: 20, sectionId: "W14X22" });
  assert(m.nodes.length === 8, "2 rows x (bays+1) = 8 nodes");
  assert(m.members.length === 7, "4 columns + 3 beams");
  assert((m.memberUdls ?? []).length === 3, "UDL on each beam");
});

t("frameSummary: global vertical equilibrium of the solved frame", () => {
  const m = ui.buildFrameModel({ bays: 3, bayWidth: 6, height: 3.5, udlKnm: 20, sectionId: "W14X22" });
  const { solveFrame } = require(path.join(tmpOut, "modules", "analytical-model", "fem.js"));
  const res = solveFrame(m);
  const s = ui.frameSummary(m, res);
  near(s.totalLoadKkN, 20 * 18, 1e-6); // 20 kN/m over 3 x 6 m
  assert(s.equilibrium, "sum of reactions must balance total load");
  assert(s.maxDeflectionMm > 0, "deflection positive");
  assert(s.maxMomentKnm > 0, "moments present (frame behaviour)");
});

t("truss-beam variant carries load as nodal loads", () => {
  const m = ui.buildFrameModel({ bays: 2, bayWidth: 5, height: 3, udlKnm: 10, sectionId: "W14X22", trussBeams: true });
  assert((m.memberUdls ?? []).length === 0, "no member UDLs in truss mode");
  assert((m.nodalLoads ?? []).length === 3, "one nodal load per top node");
  const { solveFrame } = require(path.join(tmpOut, "modules", "analytical-model", "fem.js"));
  const res = solveFrame(m);
  const s = ui.frameSummary(m, res);
  near(s.totalLoadKkN, 10 * 10, 1e-6);
  assert(s.equilibrium, "truss variant also balances");
});

t("simpleBeam closed forms: wL²/8, wL/2, 5wL⁴/384EI", () => {
  const w = 10000, L = 6, E = 200e9, I = 3.02e-4; // W14X22-ish Ix
  near(ui.simpleBeamMu(w, L), (w * L * L) / 8);
  near(ui.simpleBeamVu(w, L), (w * L) / 2);
  near(ui.simpleBeamDeflection(w, L, E, I), (5 * w * Math.pow(L, 4)) / (384 * E * I), 1e-12);
});

// ── 3. Hydraulics network + worst path ─────────────────────────────────────

t("buildBranchNetwork: real engine drops on every edge", () => {
  const a = ui.parseDuctLines("0.8,10,0.4");
  const b = ui.parseDuctLines("0.6,14,0.35\n0.4,6,0.25");
  const { network } = ui.buildBranchNetwork(a, b);
  assert(network.edges.length === 5, "A + A_out + B1 + B2 + B_out");
  for (const e of network.edges) {
    if (!e.id.endsWith("_out")) assert(e.dp > 0, `edge ${e.id} has positive drop`);
  }
});

t("worstPath: picks the higher-loss branch", () => {
  const a = ui.parseDuctLines("1.2,12,0.25"); // small duct, big flow -> high loss
  const b = ui.parseDuctLines("0.3,12,0.5");  // easy branch
  const { network } = ui.buildBranchNetwork(a, b);
  const { worstPath } = require(path.join(tmpOut, "modules", "mep", "pressure.js"));
  const worst = worstPath(network);
  assert(worst.edgeIds.includes("A1"), "critical path goes through branch A");
  assert(worst.totalDp > 0, "positive fan duty");
});

t("pressureSummaryLine: includes drop and a rate class", () => {
  const { ductPressureDrop } = require(path.join(tmpOut, "modules", "mep", "pressure.js"));
  const res = ductPressureDrop({ length: 10, flow: 0.5, diameter: 0.4 });
  const line = ui.pressureSummaryLine(res, 10);
  assert(line.includes("ΔP"), "has ΔP");
  assert(/low|recommended|high/.test(line), "has rate class");
});

// ── 4. Solid diagnostics summary ───────────────────────────────────────────

t("summarizeDiagnostics: watertight extrusion is commit-eligible", () => {
  const { extrude, validateMeshDiagnostics } = require(path.join(tmpOut, "modules", "solid-kernel", "index.js"));
  const mesh = extrude({ profile: ui.rectProfile(2, 0.1), depth: 3 });
  const s = ui.summarizeDiagnostics(validateMeshDiagnostics(mesh));
  assert(s.watertight, "box is watertight");
  assert(s.commitOk, "box has no errors");
  assert(s.errors === 0 && s.edgeIssues === 0, "clean");
});

t("summarizeDiagnostics: degenerate face is caught", () => {
  const { validateMeshDiagnostics } = require(path.join(tmpOut, "modules", "solid-kernel", "index.js"));
  const mesh = {
    vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
    faces: [[0, 1, 2], [0, 1, 1]], // second face is degenerate
  };
  const s = ui.summarizeDiagnostics(validateMeshDiagnostics(mesh));
  assert(s.degenerate >= 1, "degenerate face counted");
  assert(!s.commitOk, "errors block commit");
});

// ── 5. Project parameters ──────────────────────────────────────────────────

t("addProjectParameter: registers a value parameter", () => {
  const before = ui.documentParameters.allDefinitions().length;
  const def = ui.addProjectParameter({
    id: "test.floor-height", name: "Floor height", symbol: "floorHeight",
    dataType: "number", unit: "m", defaultValue: "3.2", formula: "",
  });
  assert(def.symbol === "floorHeight", "symbol kept");
  assert(def.defaultValue === 3.2, "numeric default parsed");
  assert(!def.readOnly, "value parameter is editable");
  assert(ui.documentParameters.allDefinitions().length === before + 1, "registered");
});

t("addProjectParameter: formula makes it read-only, symbol sanitised", () => {
  const def = ui.addProjectParameter({
    id: "test.double", name: "Double", symbol: "has space",
    dataType: "number", unit: "none", defaultValue: "", formula: "floorHeight * 2",
  });
  assert(def.readOnly === true, "formula parameter read-only");
  assert(def.formula === "floorHeight * 2", "formula kept");
  assert(def.symbol === "has_space", "symbol whitespace replaced");
});

// ── 6. Node-safe module surface ────────────────────────────────────────────

t("module loads without DOM: adapter + last solid safe", () => {
  assert(typeof ui.authoredElementStore === "function");
  const store = ui.authoredElementStore(); // window is {} in Node
  assert(store.get("nope") === undefined, "get on empty model");
  assert(store.all().length === 0, "no elements");
  assert(store.apply("nope", { position: [0, 0] }) === false, "apply on missing id");
  assert(ui.getLastSolid() === null, "no solid yet");
});

t("circleProfile: points on the circle", () => {
  const pts = ui.circleProfile(0.05, 16);
  assert(pts.length === 16, "segment count");
  for (const p of pts) near(Math.hypot(p.u, p.v), 0.05, 1e-9);
});

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
