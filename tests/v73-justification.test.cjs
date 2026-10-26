/**
 * tests/v73-justification.test.cjs
 *
 * MASTER PROMPT §3 — Justification & location-line engine.
 * Closed-form checks: face shifts (finish/core, exterior/interior),
 * path preservation under mode switching, compound-core parsing,
 * and the wall location-line → endpoint shift contract shared by the
 * plan and 3D draw paths.
 *
 * Run: node tests/v73-justification.test.cjs
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, tol = 1e-9) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v73-just-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/justification/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);
const J = require(path.join(tmpOut, "modules/justification/index.js"));

// ── Generic justification shifts ────────────────────────────────────────
t("center shift is zero", () => {
  near(J.justificationShiftMeters("center", 0.4), 0);
});
t("outer edge shift is +w/2", () => {
  near(J.justificationShiftMeters("outer", 0.4), 0.2);
});
t("inner edge shift is −w/2", () => {
  near(J.justificationShiftMeters("inner", 0.4), -0.2);
});
t("degenerate width yields zero shift", () => {
  near(J.justificationShiftMeters("outer", 0), 0);
  near(J.justificationShiftMeters("outer", NaN), 0);
});

// ── Segment application (axis-aligned) ──────────────────────────────────
t("axis-aligned outer edge puts the right face on the reference", () => {
  // Direction +X ⇒ left normal = +Z. Body must extend to +Z; the −Z-side
  // (right/exterior) face sits exactly on the reference line.
  const r = J.applyJustificationToSegment({
    start: [0, 0], end: [10, 0], shift: J.justificationShiftMeters("outer", 0.2),
  });
  near(r.start[1], 0.1);
  near(r.end[1], 0.1);
  near(r.start[0], 0);
  near(r.end[0], 10);
});
t("axis-aligned inner edge mirrors the offset", () => {
  const r = J.applyJustificationToSegment({
    start: [0, 0], end: [10, 0], shift: J.justificationShiftMeters("inner", 0.2),
  });
  near(r.start[1], -0.1);
  near(r.end[1], -0.1);
});
t("center leaves the segment untouched", () => {
  const r = J.applyJustificationToSegment({ start: [1, 2], end: [4, 6], shift: 0 });
  near(r.start[0], 1); near(r.start[1], 2);
  near(r.end[0], 4); near(r.end[1], 6);
});

// ── Rotated frame (no hardcoded axes — §3.2) ────────────────────────────
t("rotated frames shift along the true left normal", () => {
  const start = [2, 3], end = [5, 7]; // direction (3,4)/5, left normal (−4/5, 3/5)
  const shift = 0.25;
  const r = J.applyJustificationToSegment({ start, end, shift });
  const L0 = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const L1 = Math.hypot(r.end[0] - r.start[0], r.end[1] - r.start[1]);
  near(L0, L1, 1e-9);                      // reference path length preserved
  near(r.start[0] - start[0], -0.8 * shift, 1e-9);
  near(r.start[1] - start[1], 0.6 * shift, 1e-9);
});
t("mode switching preserves the reference path", () => {
  const start = [0, 0], end = [7, 0];
  const outer = J.applyJustificationToSegment({ start, end, shift: J.justificationShiftMeters("outer", 0.3) });
  const inner = J.applyJustificationToSegment({ start, end, shift: J.justificationShiftMeters("inner", 0.3) });
  // Same reference input ⇒ same length, mirrored lateral offsets.
  near(Math.hypot(outer.end[0] - outer.start[0], outer.end[1] - outer.start[1]),
       Math.hypot(inner.end[0] - inner.start[0], inner.end[1] - inner.start[1]));
  near(outer.start[1], -inner.start[1], 1e-12);
});

// ── Wall location lines (§3.1) ──────────────────────────────────────────
t("wall location-line shifts (finish faces)", () => {
  near(J.wallShiftForLocationLine("finish-exterior", 0.3, 0.2), 0.15);
  near(J.wallShiftForLocationLine("finish-interior", 0.3, 0.2), -0.15);
});
t("wall location-line shifts (core faces use core thickness)", () => {
  near(J.wallShiftForLocationLine("core-exterior", 0.3, 0.2), 0.1);
  near(J.wallShiftForLocationLine("core-interior", 0.3, 0.2), -0.1);
});
t("centerlines do not shift", () => {
  near(J.wallShiftForLocationLine("wall-centerline", 0.3, 0.2), 0);
  near(J.wallShiftForLocationLine("core-centerline", 0.3, 0.2), 0);
});
t("unsupported core degrades core faces to finish faces", () => {
  const r = J.resolveWallJustification({
    start: [0, 0], end: [10, 0],
    locationLine: "core-exterior", thickness: 0.3, coreThickness: null,
  });
  near(r.shift, 0.15);
});

// ── Compound core parsing (§3.1 gate) ───────────────────────────────────
t("core thickness parsed from a layers string", () => {
  near(J.coreThicknessFromLayers("Finish:0.025, Core:0.2, Finish:0.025", 0.25), 0.2);
});
t("single-leaf walls have no core support", () => {
  assert(J.coreThicknessFromLayers("Core:0.2", 0.2) === null);
  assert(J.coreThicknessFromLayers(undefined, 0.2) === null);
  assert(J.coreThicknessFromLayers("", 0.2) === null);
});
t("layers without a core layer are unsupported", () => {
  assert(J.coreThicknessFromLayers("Gypsum:0.012, Brick:0.2", 0.212) === null);
});
t("layer thicknesses are normalised to the wall total", () => {
  // "A:1, Core:1" sums to 2 but the wall is 0.3 ⇒ each layer 0.15.
  near(J.coreThicknessFromLayers("A:1, Core:1", 0.3), 0.15);
});
t("malformed layers are rejected, not guessed", () => {
  assert(J.coreThicknessFromLayers("Core:abc, X:0.1", 0.3) === null);
  assert(J.coreThicknessFromLayers("Core", 0.3) === null);
});

// ── resolveWallJustification end-to-end ─────────────────────────────────
t("finish-exterior keeps the exterior face on the drawn line", () => {
  const r = J.resolveWallJustification({
    start: [0, 0], end: [10, 0],
    locationLine: "finish-exterior", thickness: 0.2, coreThickness: null, extraOffset: 0,
  });
  // Wall centre at +0.1 ⇒ right face (centre − t/2·n) at z = 0.
  near(r.start[1], 0.1);
  near(r.end[1], 0.1);
});
t("user offset composes with the face shift", () => {
  const r = J.resolveWallJustification({
    start: [0, 0], end: [10, 0],
    locationLine: "wall-centerline", thickness: 0.2, coreThickness: null, extraOffset: 0.4,
  });
  near(r.shift, 0.4);
  near(r.start[1], 0.4);
});

// ── Legends / gating helpers ────────────────────────────────────────────
t("location-line legends are user-facing", () => {
  assert(J.describeLocationLine("finish-exterior") === "Finish Face: Exterior");
  assert(J.describeLocationLine("core-interior") === "Core Face: Interior");
  assert(J.describeJustification("outer") === "Outer Edge");
  assert(J.describeJustification("center") === "Center");
});
t("core gating flags only core-dependent lines", () => {
  assert(J.locationLineNeedsCore("core-exterior") === true);
  assert(J.locationLineNeedsCore("core-centerline") === true);
  assert(J.locationLineNeedsCore("finish-exterior") === false);
  assert(J.locationLineNeedsCore("wall-centerline") === false);
});

console.log(`\nv73-justification: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
