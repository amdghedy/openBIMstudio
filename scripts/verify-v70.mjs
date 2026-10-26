/**
 * verify-v70.mjs — v0.70 deep-modeling milestone checks.
 *
 * Asserts the general boolean kernel, shell/hollow technique and
 * multi-section loft landed with the expected shape:
 *   - src/modules/solid-kernel/general-csg.ts (non-convex booleans)
 *   - src/modules/solid-kernel/shell.ts       (miter offset + hollow)
 *   - src/modules/solid-kernel/loft.ts        (N-section loft)
 *   - UI wiring: engine-ui dialogs + ribbon buttons + __obsSolids
 *   - tests/v70-deep-modeling.test.cjs + CI wiring
 *
 * Run: `node scripts/verify-v70.mjs`
 * Exit code: 0 = pass, 1 = fail.
 */

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function check(label, file, regex) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { console.error(`  ✗ ${label}: file missing (${file})`); return false; }
  const content = fs.readFileSync(full, "utf8");
  if (!regex.test(content)) { console.error(`  ✗ ${label}: pattern not found in ${file}`); return false; }
  console.log(`  ✓ ${label}`); return true;
}

let pass = 0, fail = 0;
const track = (ok) => { ok ? pass++ : fail++; };

console.log("\n=== verify-v70 — deep modeling milestone ===\n");

console.log("version + scripts:");
track(check("version semver (>= 0.70)", "package.json", /"version":\s*"0\.(7[0-9]|[1-9][0-9]+)\./));
track(check("test:v70 script", "package.json", /test:v70/));
track(check("verify:v70 script", "package.json", /verify:v70/));

console.log("\nGeneral boolean kernel (non-convex CSG):");
track(check("generalBoolean entry", "src/modules/solid-kernel/general-csg.ts", /export function generalBoolean/));
track(check("global cut set", "src/modules/solid-kernel/general-csg.ts", /cutObjectsOf/));
track(check("edge-perp cutting objects", "src/modules/solid-kernel/general-csg.ts", /isFacePlane/));
track(check("coplanar coverage rules", "src/modules/solid-kernel/general-csg.ts", /coveringTriangle/));
track(check("robust probe classification", "src/modules/solid-kernel/general-csg.ts", /isInsideRobust/));
track(check("fuseAll n-ary union", "src/modules/solid-kernel/general-csg.ts", /export function fuseAll/));
track(check("weldMesh polygon-soup helper", "src/modules/solid-kernel/general-csg.ts", /export function weldMesh/));
track(check("barrel exports general-csg", "src/modules/solid-kernel/index.ts", /export \* from "\.\/general-csg"/));

console.log("\nShell / hollow:");
track(check("offsetClosedRing miter offset", "src/modules/solid-kernel/shell.ts", /export function offsetClosedRing/));
track(check("hollowExtrusion", "src/modules/solid-kernel/shell.ts", /export function hollowExtrusion/));
track(check("collapse/self-intersect validation", "src/modules/solid-kernel/shell.ts", /offset-self-intersects/));
track(check("barrel exports shell", "src/modules/solid-kernel/index.ts", /export \* from "\.\/shell"/));

console.log("\nMulti-section loft:");
track(check("loftSections", "src/modules/solid-kernel/loft.ts", /export function loftSections/));
track(check("explicit levels", "src/modules/solid-kernel/loft.ts", /levels\?/));
track(check("blend shares resampleByAngle", "src/modules/solid-kernel/forms.ts", /export function resampleByAngle/));
track(check("barrel exports loft", "src/modules/solid-kernel/index.ts", /export \* from "\.\/loft"/));

console.log("\nUI wiring (every engine has a button):");
track(check("general boolean dialog", "src/features/engine-ui.ts", /openGeneralBooleanDialog/));
track(check("shell dialog", "src/features/engine-ui.ts", /openShellDialog/));
track(check("loft dialog", "src/features/engine-ui.ts", /openLoftDialog/));
track(check("fuse dialog", "src/features/engine-ui.ts", /openFuseDialog/));
track(check("ribbon: Bool (Any) button", "src/shell/ribbon.ts", /openGeneralBooleanDialog/));
track(check("ribbon: Shell button", "src/shell/ribbon.ts", /openShellDialog/));
track(check("ribbon: Loft N button", "src/shell/ribbon.ts", /openLoftDialog/));
track(check("ribbon: Fuse button", "src/shell/ribbon.ts", /openFuseDialog/));
track(check("__obsSolids exposes general kernel", "src/modules/v68-register.ts", /generalBoolean, generalUnion, generalIntersect, generalSubtract/));
track(check("__obsSolids exposes shell + loft", "src/modules/v68-register.ts", /hollowExtrusion, hollowMetrics, offsetClosedRing, loftSections/));

console.log("\nTests + CI:");
track(check("v70 test suite", "tests/v70-deep-modeling.test.cjs", /general union: overlapping boxes with coplanar tops/));
track(check("unit-tests workflow runs test:v70", ".github/workflows/unit-tests.yml", /test:v70/));
track(check("unit-tests workflow runs verify:v70", ".github/workflows/unit-tests.yml", /verify:v70/));

console.log(`\n=== verify-v70: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
