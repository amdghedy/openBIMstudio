/**
 * tests/sloped-floor-authoring.test.cjs
 *
 * Proves the sloped-floor engine is now AUTHORED (reachable from the
 * element model), not an isolated API:
 *   1. the pure sloped-floor math (per-corner elevations, validation,
 *      average elevation) against hand-verifiable numbers;
 *   2. authoring.ts routes sloped slabs to the engine via
 *      ctx.features.slopedFloors with the property-schema slope fields;
 *   3. ramp is a first-class authored type: Tool union + placement case
 *      + mesh builder registration + property schema — no equipment alias.
 *
 * Run: `node tests/sloped-floor-authoring.test.cjs`
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
function near(a, b, eps = 1e-9) { assert(Math.abs(a - b) < eps, `${a} != ${b}`); }

// 1. Pure sloped-floor math.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sf-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type": "commonjs"}');
execSync(
  `npx tsc --rootDir src --outDir ${out} --module commonjs --moduleResolution node --target es2020 --skipLibCheck --noCheck src/modules/floors/sloped-floor.ts`,
  { stdio: "pipe", cwd: path.join(__dirname, ".."), shell: true },
).toString();
const sf = require(path.join(out, "modules/floors/sloped-floor.js"));

t("2% slope over a 10×10 slab: rise 0.2 m along +X", () => {
  const poly = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const g = sf.slopedFloorGeometry({ polygon: poly, thickness: 0.25, slopePct: 2, directionDeg: 0, baseElevation: 3.0 });
  near(g.minElevation, 3.0);
  near(g.maxElevation, 3.2, 1e-6); // 10 m × 2% = 0.2 m fall
  near(g.elevations[0], 3.0);      // lowest corner at base
  near(g.elevations[1], 3.2, 1e-6);
  near(g.elevations[2], 3.2, 1e-6);
  near(g.elevations[3], 3.0);
  near(g.fall, 0.2, 1e-6);
});

t("direction 90° falls along +Z", () => {
  const poly = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const g = sf.slopedFloorGeometry({ polygon: poly, thickness: 0.2, slopePct: 1, directionDeg: 90, baseElevation: 0 });
  near(g.elevations[0], 0);
  near(g.elevations[2], 0.1, 1e-6);
});

t("validation rejects slope out of the 0.5–15% range", () => {
  const poly = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const bad = sf.validateSlopedFloor({ polygon: poly, thickness: 0.2, slopePct: 20, directionDeg: 0, baseElevation: 0 });
  assert(bad.some((i) => i.kind === "slope-out-of-range"), "expected slope-out-of-range issue");
  const zero = sf.validateSlopedFloor({ polygon: poly, thickness: 0.2, slopePct: 0, directionDeg: 0, baseElevation: 0 });
  assert(zero.some((i) => i.kind === "slope-out-of-range"), "0% must be rejected (use flat slabs)");
});

t("average top elevation is area-weighted (uniform slope → arithmetic mean of corners)", () => {
  const poly = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const avg = sf.averageTopElevation({ polygon: poly, thickness: 0.2, slopePct: 2, directionDeg: 0, baseElevation: 3.0 });
  near(avg, 3.1, 1e-6);
});

// 2. Static authoring wiring.
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

t("authoring slab branch routes sloped slabs to ctx.features.slopedFloors", () => {
  const src = read("src/features/authoring.ts");
  assert(/el\.type === "slab" && p\.polygon[\s\S]{0,400}slopedFloors/, "slab branch does not consult ctx.features.slopedFloors");
  assert(/buildSlopedFloorMesh/.test(src), "slab branch does not call buildSlopedFloorMesh");
  assert(/baseElevation: p\.elevation/.test(src), "slope-arrow tail convention (base at elevation) not honored");
  assert(/properties\?\.slope/.test(src), "slab branch ignores properties.slope");
});

t("property schema gives slabs editable slope fields (percent + direction)", () => {
  const src = read("src/features/property-schema.ts");
  const slabIdx = src.indexOf("// ── Slab slope fields");
  assert(slabIdx > 0, "slab slope schema injection missing");
  const block = src.slice(slabIdx, slabIdx + 700);
  assert(/key: "slope"/.test(block) && /unit: "%"/.test(block), "slab slope field missing or not percent-based");
  assert(/key: "slopeDirection"/.test(block), "slab slopeDirection field missing");
});

t("ramp is a first-class authored type (no equipment alias)", () => {
  const src = read("src/features/authoring.ts");
  assert(!/\n  ramp: "equipment",/.test(src), "TOOL_ALIASES still maps ramp to equipment");
  assert(/\|\s*"ramp";?\s*$|\| "ramp"\n/.test(src.split("interface GripSpec")[0]), "Tool union missing ramp");
  assert(/case "ramp":\s*\n\s*void createElement\("ramp"/, "placement switch has no ramp case");
  assert(/case "ramp":\s*\n\s*addNum\("Rise/, "options bar has no ramp defaults");
});

t("ramp builder registers into ctx.features.meshBuilders", () => {
  const src = read("src/features/ramp-builder.ts");
  assert(/registry\.ramp = rampMeshBuilder/, "mesh builder not registered under 'ramp'");
  assert(/buildRamp/, "builder does not use the ramps engine");
  const boot = read("src/critical-gaps-boot.ts");
  assert(/"ramp-builder"/.test(boot), "ramp-builder not booted");
});

t("ramp property schema exists with accessible 1:12 default slope", () => {
  const src = read("src/features/property-schema.ts");
  const idx = src.indexOf("SCHEMAS.ramp");
  assert(idx > 0, "SCHEMAS.ramp missing");
  const block = src.slice(idx, idx + 900);
  assert(/8\.333/.test(block), "default slope is not the 1:12 accessible value");
  assert(/key: "run"/.test(block) && /key: "angle"/.test(block), "run/angle fields missing");
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
