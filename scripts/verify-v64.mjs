/**
 * verify-v64.mjs — Rebar Detailing milestone checks.
 *
 * Asserts the rebar module landed with the expected shape:
 *   - src/modules/rebar/types.ts (shapes, diameters, host, layout config)
 *   - src/modules/rebar/shapes.ts (straight, L-bend, double-L, U-bar, stirrup)
 *   - src/modules/rebar/layout.ts (beam + column layout engine)
 *   - src/modules/rebar/geometry.ts (3D mesh generator)
 *   - src/modules/rebar/index.ts (boot + service)
 *   - tests/rebar.test.cjs (21 tests)
 *
 * Run: `node scripts/verify-v64.mjs`
 * Exit code: 0 = pass, 1 = fail.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

function check(label, file, regex) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { console.error(`  ✗ ${label}: file missing (${file})`); return false; }
  const content = fs.readFileSync(full, "utf8");
  if (!regex.test(content)) { console.error(`  ✗ ${label}: pattern not found in ${file}`); return false; }
  console.log(`  ✓ ${label}`); return true;
}

let pass = 0, fail = 0;

console.log("\n=== verify-v64: Rebar Detailing ===\n");

console.log("Module structure (src/modules/rebar/):");
const exists = [
  ["types.ts", "src/modules/rebar/types.ts"],
  ["shapes.ts", "src/modules/rebar/shapes.ts"],
  ["layout.ts", "src/modules/rebar/layout.ts"],
  ["geometry.ts", "src/modules/rebar/geometry.ts"],
  ["index.ts", "src/modules/rebar/index.ts"],
];
for (const [label, file] of exists) {
  if (check(label, file, /.*/)) pass++; else fail++;
}

console.log("\nTypes (src/modules/rebar/types.ts):");
const typeChecks = [
  ["RebarShapeCode union", "src/modules/rebar/types.ts", /export type RebarShapeCode/],
  ["REBAR_DIAMETERS array", "src/modules/rebar/types.ts", /export const REBAR_DIAMETERS/],
  ["RebarHost interface", "src/modules/rebar/types.ts", /export interface RebarHost/],
  ["RebarLayoutConfig interface", "src/modules/rebar/types.ts", /export interface RebarLayoutConfig/],
  ["RebarLayout interface", "src/modules/rebar/types.ts", /export interface RebarLayout/],
  ["barArea function", "src/modules/rebar/types.ts", /export function barArea/],
  ["barMass function", "src/modules/rebar/types.ts", /export function barMass/],
  ["bendRadius function", "src/modules/rebar/types.ts", /export function bendRadius/],
  ["STEEL_DENSITY constant", "src/modules/rebar/types.ts", /export const STEEL_DENSITY/],
];
for (const [l, f, r] of typeChecks) { if (check(l, f, r)) pass++; else fail++; }

console.log("\nShapes (src/modules/rebar/shapes.ts):");
const shapeChecks = [
  ["straightBar export", "src/modules/rebar/shapes.ts", /export function straightBar/],
  ["lBendBar export", "src/modules/rebar/shapes.ts", /export function lBendBar/],
  ["doubleLBar export", "src/modules/rebar/shapes.ts", /export function doubleLBar/],
  ["uBar export", "src/modules/rebar/shapes.ts", /export function uBar/],
  ["rectangularStirrup export", "src/modules/rebar/shapes.ts", /export function rectangularStirrup/],
  ["openStirrup export", "src/modules/rebar/shapes.ts", /export function openStirrup/],
  ["totalBarLength export", "src/modules/rebar/shapes.ts", /export function totalBarLength/],
  ["translateBar export", "src/modules/rebar/shapes.ts", /export function translateBar/],
];
for (const [l, f, r] of shapeChecks) { if (check(l, f, r)) pass++; else fail++; }

console.log("\nLayout engine (src/modules/rebar/layout.ts):");
const layoutChecks = [
  ["layoutBeamRebar export", "src/modules/rebar/layout.ts", /export function layoutBeamRebar/],
  ["layoutColumnRebar export", "src/modules/rebar/layout.ts", /export function layoutColumnRebar/],
  ["layoutRebar unified dispatch", "src/modules/rebar/layout.ts", /export function layoutRebar/],
  ["Beam layout has main-bottom bars", "src/modules/rebar/layout.ts", /role: "main-bottom"/],
  ["Beam layout has main-top bars", "src/modules/rebar/layout.ts", /role: "main-top"/],
  ["Beam layout has stirrups", "src/modules/rebar/layout.ts", /role: "stirrup"/],
  ["Column layout has links", "src/modules/rebar/layout.ts", /role: "link"/],
  ["Steel ratio computed", "src/modules/rebar/layout.ts", /steelRatio/],
];
for (const [l, f, r] of layoutChecks) { if (check(l, f, r)) pass++; else fail++; }

console.log("\nGeometry generator (src/modules/rebar/geometry.ts):");
const geoChecks = [
  ["generateBarMesh export", "src/modules/rebar/geometry.ts", /export function generateBarMesh/],
  ["generateRebarMesh export", "src/modules/rebar/geometry.ts", /export function generateRebarMesh/],
  ["RebarGeoResult interface", "src/modules/rebar/geometry.ts", /export interface RebarGeoResult/],
  ["cylinderMesh helper", "src/modules/rebar/geometry.ts", /function cylinderMesh/],
];
for (const [l, f, r] of geoChecks) { if (check(l, f, r)) pass++; else fail++; }

console.log("\nBoot (src/modules/rebar/index.ts):");
const bootChecks = [
  ["setupRebar export", "src/modules/rebar/index.ts", /export function setupRebar/],
  ["RebarService interface", "src/modules/rebar/index.ts", /export interface RebarService/],
  ["__obsRebar global", "src/modules/rebar/index.ts", /__obsRebar/],
];
for (const [l, f, r] of bootChecks) { if (check(l, f, r)) pass++; else fail++; }

console.log("\nTests:");
const testChecks = [
  ["Tests file exists", "tests/rebar.test.cjs", /.*/],
  ["straightBar test", "tests/rebar.test.cjs", /straightBar produces 1 segment/],
  ["rectangularStirrup test", "tests/rebar.test.cjs", /rectangularStirrup produces closed loop/],
  ["beam layout test", "tests/rebar.test.cjs", /layoutBeamRebar produces bars for a beam/],
  ["column layout test", "tests/rebar.test.cjs", /column layout has vertical bars/],
  ["mesh generation test", "tests/rebar.test.cjs", /generateBarMesh produces triangle positions/],
  ["steel ratio test", "tests/rebar.test.cjs", /steel ratio is positive and reasonable/],
];
for (const [l, f, r] of testChecks) { if (check(l, f, r)) pass++; else fail++; }

console.log("\npackage.json:");
const pkgChecks = [
  ["test:rebar script", "package.json", /"test:rebar":\s*"node tests\/rebar\.test\.cjs"/],
  ["verify:v64 script", "package.json", /"verify:v64":\s*"node scripts\/verify-v64\.mjs"/],
  ["version 0.64", "package.json", /"version":\s*"0\.64\.0"/],
];
for (const [l, f, r] of pkgChecks) { if (check(l, f, r)) pass++; else fail++; }

console.log("\nTest execution:");
try {
  execSync("node tests/rebar.test.cjs > /dev/null 2>&1", { cwd: root, stdio: "inherit" });
  console.log("  ✓ Rebar tests pass (21/21)");
  pass++;
} catch {
  console.error("  ✗ Rebar tests failed");
  fail++;
}

console.log("\nRegression checks:");
for (const v of [55, 56, 57, 58, 59, 60, 61, 62]) {
  try {
    execSync(`node scripts/verify-v${v}.mjs > /dev/null 2>&1`, { cwd: root, stdio: "inherit" });
    console.log(`  ✓ verify-v${v} still passes`);
    pass++;
  } catch {
    console.error(`  ✗ verify-v${v} regressed`);
    fail++;
  }
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
