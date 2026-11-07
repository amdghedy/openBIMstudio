/**
 * tests/mep-run-tools.test.cjs
 *
 * Unit tests for the parametric run-editing tools
 * (justification, split/merge, taps, resize decisions, slope, noise).
 *
 * Run: `node tests/mep-run-tools.test.cjs`
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

function near(a, b, tol = 0.001) {
  if (Math.abs(a - b) > tol) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const repoRoot = path.resolve(__dirname, "..");
const tmpOut = path.join(os.tmpdir(), "obs-mep-runtools-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-runtools.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "commonjs", moduleResolution: "node",
      strict: true, skipLibCheck: true, esModuleInterop: true,
      outDir: tmpOut, rootDir: path.join(repoRoot, "src"),
    },
    include: [
      path.join(repoRoot, "src/modules/mep/types.ts"),
      path.join(repoRoot, "src/modules/mep/sizing.ts"),
      path.join(repoRoot, "src/modules/mep/run-tools.ts"),
    ],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const tools = require(path.join(tmpOut, "modules/mep/run-tools.js"));

  const flatLeg = (x1, z1, x2, z2, y = 0) => ({
    start: { x: x1, y, z: z1 },
    end: { x: x2, y, z: z2 },
    length: Math.hypot(x2 - x1, z2 - z1),
    planAngle: Math.atan2(z2 - z1, x2 - x1),
    isVertical: false,
  });

  // ── Justification ──
  t("center justification is the identity", () => {
    const r = tools.justifyRun({ x: 0, y: 2.7, z: 0 }, { x: 10, y: 2.7, z: 0 }, 0.5, "center");
    near(r.start.x, 0, 1e-9); near(r.end.z, 0, 1e-9);
  });
  t("left/right justification offsets half the width perpendicular to the run", () => {
    const left = tools.justifyRun({ x: 0, y: 2.7, z: 0 }, { x: 10, y: 2.7, z: 0 }, 0.5, "left");
    const right = tools.justifyRun({ x: 0, y: 2.7, z: 0 }, { x: 10, y: 2.7, z: 0 }, 0.5, "right");
    near(left.start.z, -0.25, 1e-9);
    near(right.start.z, 0.25, 1e-9);
    near(left.end.x, 10, 1e-9);
    near(left.start.y, 2.7, 1e-9);
    near(left.end.y, 2.7, 1e-9);
  });
  t("justification follows the run direction (diagonal run)", () => {
    const r = tools.justifyRun({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }, 1.0, "left");
    near(r.start.x, 0.5, 1e-9); // perpendicular of +Z is +X on the left side
  });
  t("zero-width and zero-length runs are untouched", () => {
    const a = tools.justifyRun({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0, "left");
    near(a.end.x, 10, 1e-9);
    const b = tools.justifyRun({ x: 3, y: 0, z: 3 }, { x: 3, y: 0, z: 3 }, 0.5, "right");
    near(b.start.x, 3, 1e-9);
  });

  // ── Split / merge ──
  t("splitLegAt 0.5 bisects a 10 m leg", () => {
    const [a, b] = tools.splitLegAt(flatLeg(0, 0, 10, 0), 0.5);
    near(a.length, 5, 1e-9);
    near(b.length, 5, 1e-9);
    near(a.end.x, 5, 1e-9);
    near(b.start.x, 5, 1e-9);
  });
  t("splitLegAt accepts metres", () => {
    const [a, b] = tools.splitLegAt(flatLeg(0, 0, 10, 0), 2.5, true);
    near(a.length, 2.5, 1e-9);
    near(b.length, 7.5, 1e-9);
  });
  t("splitLegAt clamps out-of-range parameters", () => {
    const [a, b] = tools.splitLegAt(flatLeg(0, 0, 10, 0), 15, true);
    near(a.length, 10, 1e-9);
    near(b.length, 0, 1e-9);
  });
  t("mergeCollinearLegs joins same-direction legs and sums length", () => {
    const merged = tools.mergeCollinearLegs([flatLeg(0, 0, 5, 0), flatLeg(5, 0, 10, 0)]);
    assert(merged.length === 1, "expected one leg");
    near(merged[0].length, 10, 1e-9);
    near(merged[0].end.x, 10, 1e-9);
  });
  t("mergeCollinearLegs keeps corners and slope changes", () => {
    const kept = tools.mergeCollinearLegs([flatLeg(0, 0, 5, 0), flatLeg(5, 0, 5, 5)]);
    assert(kept.length === 2, "corner must survive");
    // Rising run: same plan direction but the end climbs 0.5 m — must stay split.
    const rising = {
      start: { x: 5, y: 0, z: 0 },
      end: { x: 10, y: 0.5, z: 0 },
      length: Math.hypot(5, 0.5),
      planAngle: Math.atan2(0, 5),
      isVertical: false,
    };
    const sloped = tools.mergeCollinearLegs([flatLeg(0, 0, 5, 0), rising]);
    assert(sloped.length === 2, "slope change must survive");
  });

  // ── Tap / takeoff ──
  t("tapPoint lands at the requested distance with perpendiculars", () => {
    const tap = tools.tapPoint(flatLeg(0, 0, 10, 0), 3);
    near(tap.point.x, 3, 1e-9);
    near(tap.point.z, 0, 1e-9);
    near(tap.perpLeft.z - tap.point.z, 1, 1e-9);
    near(tap.perpRight.z - tap.point.z, -1, 1e-9);
    near(tap.hostAngle, 0, 1e-9);
  });

  // ── Resize decisions ──
  t("resize to a larger duct flags a transition", () => {
    const r = tools.resizeRunDecision("supply-air", { thickness: 0.4, height: 0.25 }, 0.5);
    assert(r.transitionNeeded, "0.5 m3/s needs more than 400x250");
    assert(r.size.thickness > 0.4 || r.size.height > 0.25, "size must grow");
    assert(r.notes.some((n) => n.includes("transition")), "expected transition note");
  });
  t("resize to the same size is transition-free", () => {
    const r = tools.resizeRunDecision("domestic-cold", { thickness: 0.025, height: 0.025 }, 0.5);
    near(r.size.thickness, 0.025, 1e-9);
    assert(!r.transitionNeeded, "DN25 at 0.5 L/s is already right");
  });
  t("resize honours maxVelocity overrides", () => {
    const tight = tools.resizeRunDecision("supply-air", { thickness: 2, height: 1 }, 0.5, 10);
    assert(tight.size.velocity > 4.5, "raised cap allows a smaller duct");
  });

  // ── Slope compliance ──
  t("sanitary at 1% passes; at 0.5% fails", () => {
    assert(tools.slopeCheck("sanitary", 2.4, 2.5, 10).ok, "1% must pass");
    const bad = tools.slopeCheck("sanitary", 2.5, 2.45, 10);
    assert(!bad.ok && bad.minPercent === 1.0, "0.5% must fail sanitary");
  });
  t("condensate minimum is 0.5%", () => {
    assert(tools.slopeCheck("condensate", 0, 0.06, 10).ok, "0.6% passes");
    assert(!tools.slopeCheck("condensate", 0, 0.04, 10).ok, "0.4% fails");
  });
  t("non-gravity systems have no minimum", () => {
    const r = tools.slopeCheck("supply-air", 2.7, 2.7, 10);
    assert(r.ok && r.minPercent === 0, "flat supply duct is fine");
  });

  // ── Noise banding ──
  t("velocity bands map to NC 25/35/45/55", () => {
    near(tools.noiseEstimate(3, "supply-air").ncApprox, 25, 1e-9);
    near(tools.noiseEstimate(5, "supply-air").ncApprox, 35, 1e-9);
    near(tools.noiseEstimate(7, "supply-air").ncApprox, 45, 1e-9);
    near(tools.noiseEstimate(9, "supply-air").ncApprox, 55, 1e-9);
    assert(tools.noiseEstimate(3, "supply-air").band === "quiet");
    assert(tools.noiseEstimate(9, "supply-air").band === "very noisy");
  });
  t("non-air systems return the quiet band with a note", () => {
    const r = tools.noiseEstimate(5, "chilled-water");
    assert(r.band === "quiet" && r.note.length > 0, "expected quiet + note");
  });

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;
} catch (e) {
  console.error("Test setup failed:", e.message);
  console.error(e.stack);
  process.exitCode = 2;
} finally {
  try {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  } catch { /* */ }
}
