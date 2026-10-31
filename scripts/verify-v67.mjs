/**
 * verify-v67.mjs — v0.67 milestone checks (engineering engine package).
 *
 * Asserts the four "Revit-killer" engines landed with the expected shape:
 *   - src/modules/constraints        (numeric geometric constraint solver)
 *   - src/modules/analytical-model   (2D frame FEM + steel/RC code checks)
 *   - src/modules/mep/pressure.ts    (duct/pipe hydraulics, worst path)
 *   - src/modules/adaptive           (adaptive components)
 *   - tests: constraint-solver, structural, mep-pressure, adaptive
 *   - Boot wiring via v67-register + critical-gaps-boot
 *
 * Run: `node scripts/verify-v67.mjs`
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

console.log("\n=== verify-v67 — engineering engine milestone ===\n");

console.log("version + scripts:");
track(check("version 0.67", "package.json", /"version":\s*"(?:0\.(?:6[7-9]|[7-9]\d|\d{3,})|[1-9]\d*)\./));
track(check("test:constraints script", "package.json", /test:constraints/));
track(check("test:structural script", "package.json", /test:structural/));
track(check("test:mep-pressure script", "package.json", /test:mep-pressure/));
track(check("test:adaptive script", "package.json", /test:adaptive/));
track(check("verify:v67 script", "package.json", /verify:v67/));

console.log("\nEngine 1 — numeric constraint solver:");
track(check("solver LM core", "src/modules/constraints/solver.ts", /Levenberg-Marquardt/));
track(check("constraint kinds", "src/modules/constraints/solver.ts", /"perpendicular"/));
track(check("wall integration", "src/modules/constraints/index.ts", /export function solveAndApply/));
track(check("solver test", "tests/constraint-solver.test.cjs", /rectangle restores from distorted quad/));

console.log("\nEngine 2 — structural FEM + code checks:");
track(check("frame solver", "src/modules/analytical-model/fem.ts", /export function solveFrame/));
track(check("deflection profile", "src/modules/analytical-model/fem.ts", /export function memberDeflectionProfile/));
track(check("steel checks", "src/modules/analytical-model/checks.ts", /export function checkSteel/));
track(check("RC checks", "src/modules/analytical-model/checks.ts", /export function checkRcBeam/));
track(check("section catalog", "src/modules/analytical-model/sections.ts", /STEEL_SECTIONS/));
track(check("structural test", "tests/structural.test.cjs", /SS beam UDL: reactions, midspan moment and deflection match closed form/));

console.log("\nEngine 3 — MEP pressure hydraulics:");
track(check("colebrook", "src/modules/mep/pressure.ts", /export function colebrook/));
track(check("duct drop", "src/modules/mep/pressure.ts", /export function ductPressureDrop/));
track(check("worst path", "src/modules/mep/pressure.ts", /export function worstPath/));
track(check("pressure test", "tests/mep-pressure.test.cjs", /ASHRAE chart band/));

console.log("\nEngine 4 — adaptive components:");
track(check("family registry", "src/modules/adaptive/index.ts", /export function registerFamily/));
track(check("sweep", "src/modules/adaptive/index.ts", /export function sweepProfile/));
track(check("mesh volume", "src/modules/adaptive/index.ts", /export function meshVolume/));
track(check("repeater", "src/modules/adaptive/index.ts", /export function repeatAlongPath/));
track(check("adaptive test", "tests/adaptive.test.cjs", /volume equals area × polyline length/));

console.log("\nBoot wiring:");
track(check("v67 register", "src/modules/v67-register.ts", /export function setupV67Engines/));
track(check("boot import", "src/critical-gaps-boot.ts", /v67-register/));
track(check("CI wiring", "scripts/ci-unit-tests.mjs", /test:structural/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
