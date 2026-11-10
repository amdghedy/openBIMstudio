/**
 * tests/parametric-wiring.test.cjs
 *
 * Closes the parametric-constraint WIRING gap with proof:
 *   1. nearestEndpointDistance (the UI gap-capture helper) matches the
 *      solver bridge's locked-dimension semantics exactly;
 *   2. a stored locked-dimension actually heals geometry after one side
 *      moves (lock → move → solve → gap restored);
 *   3. the constraint store ops (toggle / remove / isLocked) behave;
 *   4. static wiring assertions: no require() in the ESM module, the
 *      toolbox exposes the constraint buttons, the silent-failure ribbon
 *      globals are gone, spot-elevation is addressed by its real name,
 *      the stale UI-registry rows are honest, the issues collapse button
 *      has a handler, and the boot registers the new features.
 *
 * Run: `node tests/parametric-wiring.test.cjs`
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
    console.log(`  FAIL ${name}: ${e.message}`);
    fail++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, eps = 1e-6) { assert(Math.abs(a - b) < eps, `${a} != ${b}`); }

// Compile the pure module slice (types + bridge + solver — no DOM).
const out = fs.mkdtempSync(path.join(os.tmpdir(), "pw-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type": "commonjs"}');
execSync(
  `npx tsc --rootDir src --outDir ${out} --module commonjs --moduleResolution node --target es2020 --skipLibCheck --noCheck` +
  ` src/modules/parametric-constraints/types.ts src/modules/parametric-constraints/solver-bridge.ts`,
  { stdio: "pipe", cwd: path.join(__dirname, ".."), shell: true },
).toString();
const types = require(path.join(out, "modules/parametric-constraints/types.js"));
const bridge = require(path.join(out, "modules/parametric-constraints/solver-bridge.js"));

function wall(id, ax, az, bx, bz, thickness = 0.2) {
  return { id, type: "wall", params: { start: [ax, az], end: [bx, bz], elevation: 0, height: 3, thickness } };
}
function column(id, x, z) {
  return { id, type: "column", params: { point: [x, z], elevation: 0, height: 3, thickness: 0.3 } };
}

t("nearestEndpointDistance: segment↔segment picks the NEAREST endpoint pair", () => {
  // Wall A along X at z=0; wall B along X at z=2, offset so nearest pair
  // is A.end ↔ B.start = sqrt(1² + 2²) = √5, NOT the parallel distance.
  const a = wall("a", 0, 0, 3, 0);
  const b = wall("b", 4, 2, 8, 2);
  near(bridge.nearestEndpointDistance(a, b), Math.sqrt(5));
});

t("nearestEndpointDistance: segment↔point", () => {
  const a = wall("a", 0, 0, 3, 0);
  const c = column("c", 5, 4);
  // Nearest: a.end (3,0) → column (5,4) = √(4+16) = √20
  near(bridge.nearestEndpointDistance(a, c), Math.sqrt(20));
});

t("nearestEndpointDistance: null when either element has no solver geometry", () => {
  const a = wall("a", 0, 0, 3, 0);
  const ghost = { id: "g", type: "generic", params: {} };
  assert(bridge.nearestEndpointDistance(a, ghost) === null, "expected null for geometry-less element");
  assert(bridge.nearestEndpointDistance(ghost, ghost) === null, "expected null for both geometry-less");
});

t("locked distance heals the gap after one side moves (dragged wall is the anchor)", () => {
  const a = wall("a", 0, 0, 4, 0);   // stays
  const b = wall("b", 8, 0, 12, 0);  // user drags it to x=10
  types.lockDimension("a", "b", 4);  // gap a.end↔b.start = 4 m
  // User drags wall b: gap becomes 6. The app passes the dragged id as the
  // solve anchor (scheduleAutoSolve(targets) → pinnedIds) — where the user
  // dropped it STAYS, and wall a... must stay too (it is the pinned side).
  b.params.start = [10, 0]; b.params.end = [14, 0];
  const els = [a, b];
  const out2 = bridge.solveStoredConstraints(els, types.getAllConstraints(), { pinnedIds: ["b"] });
  assert(out2.errors.length === 0, `solver errors: ${out2.errors.join("; ")}`);
  assert(out2.result && out2.result.status === "converged", "expected converged solve");
  // Wall b NEVER moved (anchor).
  near(els[1].params.start[0], 10, 1e-6);
  // Wall a healed: its free end slid to keep the 4 m gap (a.end 6↔b.start 10).
  near(els[0].params.end[0], 6, 1e-3);
  // Wall a kept its length.
  near(Math.hypot(els[0].params.end[0] - els[0].params.start[0], 0), 4, 1e-3);
  types.removeConstraint(types.getAllConstraints()[0].id);
});

t("locked distance WITHOUT an anchor distributes the correction (documented)", () => {
  const a = wall("a", 0, 0, 4, 0);
  const b = wall("b", 8, 0, 12, 0);
  types.lockDimension("a", "b", 4);
  b.params.start = [9, 0]; b.params.end = [13, 0];
  const els = [a, b];
  const out2 = bridge.solveStoredConstraints(els, types.getAllConstraints());
  assert(out2.errors.length === 0, `solver errors: ${out2.errors.join("; ")}`);
  // Gap restored to 4 m either way — the nearest endpoint pair is back at
  // the locked distance, even though both walls share the correction.
  const gapAfter = Math.min(
    Math.abs(els[0].params.start[0] - els[1].params.start[0]),
    Math.abs(els[0].params.start[0] - els[1].params.end[0]),
    Math.abs(els[0].params.end[0] - els[1].params.start[0]),
    Math.abs(els[0].params.end[0] - els[1].params.end[0]),
  );
  near(gapAfter, 4, 1e-3);
  types.removeConstraint(types.getAllConstraints()[0].id);
});

t("constraint store: toggle + isLocked + remove round-trip", () => {
  const c = types.lockDimension("w1", "w2", 2.5);
  assert(types.isLocked("w1", "w2") === true, "expected locked");
  assert(Math.abs(types.getLockedValue("w1", "w2") - 2.5) < 1e-9, "locked value mismatch");
  assert(types.toggleConstraint(c.id) === false, "toggle should deactivate");
  assert(types.isLocked("w1", "w2") === false, "inactive constraint must not report locked");
  assert(types.toggleConstraint(c.id) === true, "toggle back on");
  types.removeConstraint(c.id);
  assert(types.isLocked("w1", "w2") === false, "removed constraint must not report locked");
});

t("equality constraint equalizes two different-length walls (first is reference)", () => {
  const a = wall("a", 0, 0, 4, 0);   // reference, 4 m
  const b = wall("b", 0, 5, 2.5, 5); // 2.5 m → must grow to 4
  types.addEquality(["a", "b"], "length");
  const els = [a, b];
  const out2 = bridge.solveStoredConstraints(els, types.getAllConstraints());
  assert(out2.errors.length === 0, `solver errors: ${out2.errors.join("; ")}`);
  const len = Math.hypot(els[1].params.end[0] - els[1].params.start[0], els[1].params.end[1] - els[1].params.start[1]);
  near(len, 4, 1e-3);
  types.removeConstraint(types.getAllConstraints()[0].id);
});

// ── Static wiring assertions ─────────────────────────────────────────────
// Strip comments so prose that MENTIONS a removed global doesn't false-positive.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const ROOT = path.join(__dirname, "..");
const read = (p) => stripComments(fs.readFileSync(path.join(ROOT, p), "utf8"));

t("parametric-constraints/index.ts has NO require() (ESM-safe)", () => {
  const src = read("src/modules/parametric-constraints/index.ts");
  assert(!/require\(/.test(src), "require() found — breaks the Vite ESM bundle");
  assert(/addParallel/.test(src), "parallel missing from the console API");
  assert(/addPerpendicular/.test(src), "perpendicular missing from the console API");
});

t("BIM toolbox exposes the constraint creation buttons", () => {
  const src = read("src/features/bim-toolbox.ts");
  for (const label of ["Lock Distance", "Equal Length", "\"Parallel\"", "\"Perpendicular\"", "Align (Constraint)", "Manage Constraints", "Solve Constraints"]) {
    assert(src.includes(label), `missing toolbox action: ${label}`);
  }
  assert(!/Pick Work Plane/.test(src), "dead Pick Work Plane toast still present");
  assert(!/__obsRefPlanes/.test(src), "toolbox should use ctx.features.refPlanes, not a window global");
  assert(/refPlanes\?\.setActiveWorkPlane|refPlanes\?\.\s*$/.test(src) || /features\?\.\)?\.refPlanes/.test(src) || /refPlanes/.test(src), "work plane buttons not wired to refPlanes");
});

t("ribbon silent-failure globals are GONE (__obsEnergyAnalysis / __obsInPlaceMass)", () => {
  const src = read("src/shell/ribbon.ts");
  assert(!/__obsEnergyAnalysis/.test(src), "__obsEnergyAnalysis still referenced (never defined)");
  assert(!/__obsInPlaceMass/.test(src), "__obsInPlaceMass still referenced (never defined)");
  assert(/energy-ui/.test(src), "ribbon does not call the energy-ui feature");
  assert(/openInPlaceMassDialog/.test(src), "shared mass dialog missing");
});

t("spot-elevation addressed by its real plan-tool name (spot-elev)", () => {
  const tb = read("src/features/bim-toolbox.ts");
  const bx = read("src/features/bim-experience.ts");
  assert(!tb.includes('setPlanTool("spot-elevation")'), "toolbox still uses the dead tool name");
  assert(bx.includes('["spot-elev", "Spot Elevation"]'), "BIM command registry still uses the dead tool name");
  const pv = read("src/features/plan-view-panel.ts");
  assert(pv.includes('"spot-elev"'), "plan-view-panel lost its spot-elev branch");
});

t("UI registry rows are honest about implemented panels", () => {
  const src = read("src/features/ui-items-register.ts");
  // The three implemented-but-marked-unavailable rows must be available:true now.
  const stale = /available: false,\s*\n\s*unavailableHint/.test(src);
  assert(!stale, "stale available:false rows remain in ui-items-register.ts");
});

t("issues panel collapse button has a real handler", () => {
  const src = read("src/features/issues-panel.ts");
  assert(!/miniBtn\([^)]*, \(\) => \{\}, /.test(src), "empty () => {} collapse handler still present");
  assert(/bodyCollapsed/.test(src), "collapse state missing");
});

t("boot registers constraint-tools, federation-panel, ramp-builder and m4-view-dims", () => {
  const src = read("src/critical-gaps-boot.ts");
  for (const key of ["constraint-tools", "federation-panel", "ramp-builder", "m4-view-dims"]) {
    assert(src.includes(`"${key}"`), `boot missing safe("${key}")`);
  }
});

t("federation panel registers the exact key panel-wiring looks up", () => {
  const src = read("src/features/federation-panel.ts");
  assert(/federationPanel\s*=\s*\{/.test(src), "ctx.features.federationPanel not registered");
  const pw = read("src/features/panel-wiring.ts");
  assert(pw.includes('"federationPanel"'), "panel-wiring lost the federation spec");
});

t("dimension edits + dim-lock re-apply schedule the constraint auto-solve", () => {
  const src = read("src/features/authoring.ts");
  const commitIdx = src.indexOf("export function applyDimensionalConstraints");
  const head = src.slice(0, commitIdx);
  const commitPart = head.slice(head.indexOf("function commitEditableTempDim"));
  assert(/scheduleAutoSolve\(/.test(commitPart), "commitEditableTempDim does not schedule the auto-solve");
  const locksPart = head.slice(head.indexOf("function applyDimLocks"));
  assert(/scheduleAutoSolve\(/.test(locksPart), "applyDimLocks does not schedule the auto-solve");
  const commitAnchor = commitPart.slice(commitPart.indexOf("scheduleAutoSolve"), commitPart.indexOf("scheduleAutoSolve") + 60);
  assert(/spec\.elementId/.test(commitAnchor), "dim edit does not anchor the edited element");
  assert(/dimLocks\.map/.test(locksPart), "dim-lock re-apply does not anchor the locked elements");
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
