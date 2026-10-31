/**
 * verify-v58.mjs - MEP Auto-Routing + ASHRAE Sizing milestone checks.
 *
 * Asserts the MEP module landed with the expected shape:
 *   - src/modules/mep/types.ts: shared types (MepSystem, RouteRequest, etc.)
 *   - src/modules/mep/router.ts: A* pathfinder over 3D voxel grid
 *   - src/modules/mep/sizing.ts: ASHRAE sizing rules for ducts + pipes
 *   - src/modules/mep/index.ts: boot wiring + public service interface
 *   - critical-gaps-boot.ts: setupMep wired into boot
 *   - features/mep-fabrication.ts: "MEP Auto-Route..." UI command
 *   - tests/mep-router.test.cjs: A* + sizing correctness tests
 *
 * Run: `node scripts/verify-v58.mjs`
 * Exit code: 0 = pass, 1 = fail.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

function check(label, file, regex) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ ${label}: file missing (${file})`);
    return false;
  }
  const content = fs.readFileSync(full, "utf8");
  if (!regex.test(content)) {
    console.error(`  ✗ ${label}: pattern not found in ${file}`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

function checkExists(label, file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ ${label}: file/directory missing (${file})`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

let pass = 0;
let fail = 0;

console.log("\n=== verify-v58: MEP Auto-Routing + ASHRAE Sizing ===\n");

// ─── Module structure ─────────────────────────────────────────────────
console.log("Module structure:");
const existsChecks = [
  ["src/modules/mep/ directory", "src/modules/mep"],
  ["types.ts", "src/modules/mep/types.ts"],
  ["router.ts", "src/modules/mep/router.ts"],
  ["sizing.ts", "src/modules/mep/sizing.ts"],
  ["index.ts", "src/modules/mep/index.ts"],
  ["tests/mep-router.test.cjs", "tests/mep-router.test.cjs"],
];
for (const [label, file] of existsChecks) {
  if (checkExists(label, file)) pass++; else fail++;
}

// ─── Types ───────────────────────────────────────────────────────────
console.log("\nTypes (src/modules/mep/types.ts):");
const typesChecks = [
  ["MepSystem union", "src/modules/mep/types.ts", /export type MepSystem\b/],
  ["MepElementType union", "src/modules/mep/types.ts", /export type MepElementType\b/],
  ["RouteRequest interface", "src/modules/mep/types.ts", /export interface RouteRequest\b/],
  ["RouteResult interface", "src/modules/mep/types.ts", /export interface RouteResult\b/],
  ["RouteLeg interface", "src/modules/mep/types.ts", /export interface RouteLeg\b/],
  ["MepSize interface", "src/modules/mep/types.ts", /export interface MepSize\b/],
  ["SizingResult interface", "src/modules/mep/types.ts", /export interface SizingResult\b/],
  ["AABB interface", "src/modules/mep/types.ts", /export interface AABB\b/],
  ["Vec3 interface", "src/modules/mep/types.ts", /export interface Vec3\b/],
  ["elementTypeFor helper", "src/modules/mep/types.ts", /export function elementTypeFor\b/],
  ["ifcEntityFor helper", "src/modules/mep/types.ts", /export function ifcEntityFor\b/],
  ["colorFor helper", "src/modules/mep/types.ts", /export function colorFor\b/],
  ["supply-air system", "src/modules/mep/types.ts", /"supply-air"/],
  ["chilled-water system", "src/modules/mep/types.ts", /"chilled-water"/],
  ["medical-oxygen system", "src/modules/mep/types.ts", /"medical-oxygen"/],
];
for (const [label, file, regex] of typesChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Router (A*) ─────────────────────────────────────────────────────
console.log("\nRouter (src/modules/mep/router.ts):");
const routerChecks = [
  ["route export", "src/modules/mep/router.ts", /export function route\b/],
  ["routeSimple export", "src/modules/mep/router.ts", /export function routeSimple\b/],
  ["A* search function", "src/modules/mep/router.ts", /function aStar\b/],
  ["6-connected neighbours", "src/modules/mep/router.ts", /\[\s*1,\s*0,\s*0\s*\]/],
  ["Blocked voxel set builder", "src/modules/mep/router.ts", /function buildBlockedSet\b/],
  ["Path simplification", "src/modules/mep/router.ts", /function simplifyPath\b/],
  ["Leg-from-path converter", "src/modules/mep/router.ts", /function legsFromPath\b/],
  ["Bend penalty in A*", "src/modules/mep/router.ts", /bendPenalty/],
  ["Pressure drop estimation", "src/modules/mep/router.ts", /function estimatePressureDrop\b/],
  ["Obstacle inflation (clearance)", "src/modules/mep/router.ts", /clearance/],
];
for (const [label, file, regex] of routerChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Sizing (ASHRAE) ─────────────────────────────────────────────────
console.log("\nSizing (src/modules/mep/sizing.ts):");
const sizingChecks = [
  ["sizeForSystem export", "src/modules/mep/sizing.ts", /export function sizeForSystem\b/],
  ["validateSize export", "src/modules/mep/sizing.ts", /export function validateSize\b/],
  ["defaultVelocityFor export", "src/modules/mep/sizing.ts", /export function defaultVelocityFor\b/],
  ["maxVelocityFor export", "src/modules/mep/sizing.ts", /export function maxVelocityFor\b/],
  ["Duct sizing function", "src/modules/mep/sizing.ts", /function sizeDuct\b/],
  ["Pipe sizing function", "src/modules/mep/sizing.ts", /function sizePipe\b/],
  ["Cable tray sizing function", "src/modules/mep/sizing.ts", /function sizeCableTray\b/],
  ["Conduit sizing function", "src/modules/mep/sizing.ts", /function sizeConduit\b/],
  ["Standard duct widths table", "src/modules/mep/sizing.ts", /DUCT_WIDTHS\s*=/],
  ["Standard pipe DN table", "src/modules/mep/sizing.ts", /PIPE_DN\s*=/],
  ["ASHRAE reference comment", "src/modules/mep/sizing.ts", /ASHRAE/i],
];
for (const [label, file, regex] of sizingChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Boot wiring ─────────────────────────────────────────────────────
console.log("\nBoot wiring:");
const bootChecks = [
  ["setupMep export", "src/modules/mep/index.ts", /export function setupMep\b/],
  ["MepService interface", "src/modules/mep/index.ts", /export interface MepService\b/],
  ["isMepReady export", "src/modules/mep/index.ts", /export function isMepReady\b/],
  ["critical-gaps-boot.ts wires mep", "src/critical-gaps-boot.ts", /await safe\("mep"/],
  ["critical-gaps-boot.ts imports mep module", "src/critical-gaps-boot.ts", /import\(.*modules\/mep.*\)/],
];
for (const [label, file, regex] of bootChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── UI wiring ───────────────────────────────────────────────────────
console.log("\nUI wiring (features/mep-fabrication.ts):");
const uiChecks = [
  ["Imports addLinearElement", "src/features/mep-fabrication.ts", /import.*addLinearElement.*from.*authoring/],
  ["MEP Auto-Route button", "src/features/mep-fabrication.ts", /MEP Auto-Route/],
  ["Auto-route modal function", "src/features/mep-fabrication.ts", /function openAutoRouteModal\b/],
  ["SYSTEMS catalog", "src/features/mep-fabrication.ts", /const SYSTEMS/],
  ["Route result placement loop", "src/features/mep-fabrication.ts", /for \(const leg of result\.legs\)/],
  ["addLinearElement call in route", "src/features/mep-fabrication.ts", /await addLinearElement\(/],
];
for (const [label, file, regex] of uiChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Tests ───────────────────────────────────────────────────────────
console.log("\nTests:");
const testChecks = [
  ["Tests file exists", "tests/mep-router.test.cjs", /.*/],
  ["Sizing test: low flow duct", "tests/mep-router.test.cjs", /sizeForSystem\("supply-air"/],
  ["Sizing test: high flow duct", "tests/mep-router.test.cjs", /1\.0, 4\.5/],
  ["Routing test: straight line", "tests/mep-router.test.cjs", /straight-line path/],
  ["Routing test: obstacle avoidance", "tests/mep-router.test.cjs", /L-shaped path around an obstacle/],
  ["Routing test: via waypoints", "tests/mep-router.test.cjs", /via waypoints/],
];
for (const [label, file, regex] of testChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Regression ──────────────────────────────────────────────────────
console.log("\nRegression checks:");
try {
  execSync("node scripts/verify-v55.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v55 still passes (Plugin SDK intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v55 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v56.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v56 still passes (Family Library intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v56 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v57.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v57 still passes (Hosted recut fix intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v57 regressed");
  fail++;
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
