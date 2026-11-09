/**
 * tests/vertical-openings.test.cjs
 *
 * Unit tests for the vertical-openings module (Revit Shaft / Vertical
 * opening / Skylight parity). Validates:
 *   - rectFootprint placement and rotation
 *   - pointInFootprint / footprintsOverlap / clipFootprint geometry
 *   - cutSlabHoles: inside → hole, edge-crossing → clipped hole + warning,
 *     outside → no hole + warning, degenerate → skipped
 *   - winding contract (outline CCW, holes CW in XZ)
 *   - netSlabArea subtraction
 *   - cuttingSlabs Z-span + plan-overlap semantics (shaft through 3 of 4 floors)
 *   - suggestShaftSpan covers the highest level
 *   - auditVerticalOpenings: ORPHAN / DEGENERATE / SPAN_MISS
 *
 * Compile strategy: single-file tsc like the MEP suites (no DOM/three deps).
 */

const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "vo-"));
execSync(`npx tsc src/modules/vertical-openings/vertical-openings.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const m = require(find(out, "vertical-openings.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };

/* ── footprints ── */

t("rectFootprint centres a 1x1 rect at the click point", () => {
  const fp = m.rectFootprint(10, 5, 1, 1, 0);
  const xs = fp.map(p => p[0]), zs = fp.map(p => p[1]);
  assert.ok(Math.min(...xs) === 9.5 && Math.max(...xs) === 10.5);
  assert.ok(Math.min(...zs) === 4.5 && Math.max(...zs) === 5.5);
  assert.equal(fp.length, 4);
});

t("rectFootprint rotation moves corners and preserves area", () => {
  const a = m.rectFootprint(0, 0, 2, 1, 0);
  const b = m.rectFootprint(0, 0, 2, 1, 90);
  assert.ok(Math.abs(m.footprintArea(a) - 2) < 1e-9);
  assert.ok(Math.abs(m.footprintArea(b) - 2) < 1e-9);
  const bx = b.map(p => Math.round(p[0] * 1e6) / 1e6);
  assert.ok(Math.abs(Math.max(...bx) - 0.5) < 1e-6, "90° rotation swaps width/depth extents");
});

t("pointInFootprint and overlap detection", () => {
  const sq = m.rectFootprint(0, 0, 4, 4, 0);
  assert.ok(m.pointInFootprint(0, 0, sq));
  assert.ok(!m.pointInFootprint(3, 3, sq));
  const inside = m.rectFootprint(0.5, 0.5, 1, 1, 0);
  const touching = m.rectFootprint(2.5, 0, 2, 2, 0); // crosses the x=2 edge
  const apart = m.rectFootprint(10, 10, 1, 1, 0);
  assert.ok(m.footprintsOverlap(inside, sq));
  assert.ok(m.footprintsOverlap(touching, sq), "edge-crossing rects overlap");
  assert.ok(!m.footprintsOverlap(apart, sq));
  assert.ok(!m.footprintsOverlap([[0, 0], [1, 1]], sq), "degenerate ring never overlaps");
});

/* ── clipping ── */

t("clipFootprint returns the intersection for an edge-crossing opening", () => {
  const slab = [[0, 0], [10, 0], [10, 10], [0, 10]]; // CCW in XZ? compute: area2 > 0
  const op = m.rectFootprint(9.5, 5, 2, 2, 0);       // sticks out past x=10
  const clipped = m.clipFootprint(op, slab);
  assert.ok(clipped.length >= 3, "clip must keep a polygon");
  // expected: x from 8.5..10, z 4..6 → 1.5 * 2 = 3 m²
  assert.ok(Math.abs(m.footprintArea(clipped) - 3) < 1e-6, `clipped area ${m.footprintArea(clipped)} must be 3`);
  const miss = m.clipFootprint(m.rectFootprint(50, 50, 1, 1, 0), slab);
  assert.equal(miss.length, 0, "fully outside → empty clip");
});

/* ── hole cutting ── */

t("cutSlabHoles: inside → hole, crossing → clipped + warning, outside → no hole", () => {
  const slab = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const inside = m.rectFootprint(2, 2, 1, 1, 0);
  const crossing = m.rectFootprint(9.5, 5, 2, 2, 0);
  const outside = m.rectFootprint(50, 50, 1, 1, 0);
  const r = m.cutSlabHoles(slab, [
    { id: "in", fp: inside },
    { id: "cross", fp: crossing },
    { id: "out", fp: outside },
  ]);
  assert.equal(r.holes.length, 2, "inside + crossing produce holes");
  assert.ok(r.warnings.some(w => w.includes("cross")), "crossing reported");
  assert.ok(r.warnings.some(w => w.includes("out")), "outside reported");
});

t("cutSlabHoles honours the winding contract (outline CCW, holes CW)", () => {
  const slab = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const cwSlab = slab.slice().reverse();
  const op = m.rectFootprint(5, 5, 2, 2, 0); // CCW
  const r1 = m.cutSlabHoles(slab, [{ id: "a", fp: op }]);
  const r2 = m.cutSlabHoles(cwSlab, [{ id: "a", fp: op }]);
  for (const r of [r1, r2]) {
    assert.equal(r.holes.length, 1);
    assert.ok(m.footprintArea2(r.holes[0]) < 0, "hole must be CW in XZ");
  }
  assert.ok(Math.abs(m.footprintArea(r1.holes[0]) - 4) < 1e-9);
});

t("cutSlabHoles rejects degenerate openings with a clear warning", () => {
  const slab = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const tiny = [[5, 5], [5.02, 5], [5.02, 5.02]]; // ~0.0004 m² < 0.01 minimum
  const r = m.cutSlabHoles(slab, [{ id: "tiny", fp: tiny }]);
  assert.equal(r.holes.length, 0);
  assert.ok(r.warnings.some(w => w.includes("minimum")));
});

t("netSlabArea subtracts holes and never goes negative", () => {
  const slab = [[0, 0], [10, 0], [10, 10], [0, 10]]; // 100 m²
  const holes = [m.rectFootprint(5, 5, 2, 2, 0), m.rectFootprint(1, 1, 1, 1, 0)];
  assert.ok(Math.abs(m.netSlabArea(slab, holes) - 95) < 1e-9);
  assert.equal(m.netSlabArea(slab, [slab, slab]), 0, "holes ≥ gross clamp to 0");
});

/* ── shaft semantics ── */

const mkSlab = (id, elevation, height = 0.2) => ({
  id, type: "slab",
  params: { polygon: [[0, 0], [20, 0], [20, 20], [0, 20]], elevation, height },
});

t("cuttingSlabs: shaft base L1 spans 3 of 4 floors", () => {
  const slabs = [mkSlab("L1", 0), mkSlab("L2", 3.2), mkSlab("L3", 6.4), mkSlab("roof", 9.6)];
  const shaft = { id: "s1", type: "vertical-opening", params: { point: [5, 5], width: 2, depth: 1.5, elevation: 0, height: 6.5 } };
  const cut = m.cuttingSlabs(shaft, slabs);
  assert.deepEqual(cut, ["L1", "L2", "L3"], "z span [0, 6.5] reaches L1..L3, not the roof");
  const short = { ...shaft, params: { ...shaft.params, height: 0.1 } };
  assert.deepEqual(m.cuttingSlabs(short, slabs), ["L1"], "short opening cuts only its own slab");
});

t("cuttingSlabs honours plan overlap", () => {
  const slabs = [mkSlab("L1", 0)];
  const on = { id: "s1", type: "vertical-opening", params: { point: [5, 5], width: 1, depth: 1, elevation: 0, height: 0.5 } };
  const off = { ...on, params: { ...on.params, point: [50, 50] } };
  assert.deepEqual(m.cuttingSlabs(on, slabs), ["L1"]);
  assert.deepEqual(m.cuttingSlabs(off, slabs), []);
});

t("suggestShaftSpan embeds below base and covers the highest level", () => {
  const [b, tp] = m.suggestShaftSpan(0, [0, 3.2, 6.4, 9.6]);
  assert.ok(b < 0, "must embed below the base slab");
  assert.ok(tp > 9.6, "must reach past the top level");
  const [b2, t2] = m.suggestShaftSpan(3.2, []);
  assert.ok(t2 > 3.2, "no levels → sensible default above base");
});

/* ── audit ── */

t("audit flags ORPHAN, DEGENERATE and SPAN_MISS", () => {
  const slabs = [mkSlab("L1", 0), mkSlab("L2", 3.2)];
  const good = { id: "g", type: "vertical-opening", params: { point: [5, 5], width: 1, depth: 1, elevation: 0, height: 0.1 } };
  const orphan = { id: "o", type: "vertical-opening", params: { point: [90, 90], width: 1, depth: 1, elevation: 0, height: 0.1 } };
  const degenerate = { id: "d", type: "vertical-opening", params: { point: [5, 5], width: 0.01, depth: 0.01, elevation: 0, height: 0.1 } };
  const spanMiss = { id: "m", type: "vertical-opening", params: { point: [8, 8], width: 1, depth: 1, elevation: 10, height: 0.5 } };
  const a = m.auditVerticalOpenings([good, orphan, degenerate, spanMiss], slabs);
  assert.deepEqual(a.cuts["g"], ["L1"]);
  assert.ok(a.orphaned.includes("o"));
  assert.ok(a.orphaned.includes("m"), "cutting nothing lands in orphaned too");
  const codes = Object.fromEntries(a.issues.map(i => [i.id, i.code]));
  assert.equal(codes["o"], "ORPHAN", "far away → ORPHAN");
  assert.equal(codes["d"], "DEGENERATE");
  assert.equal(codes["m"], "SPAN_MISS", "overlapping in plan but unreached → SPAN_MISS");
  assert.ok(!a.issues.some(i => i.id === "g"), "healthy opening has no issues");
});

t("audit: single-floor hole under a taller span is healthy (partial cuts are not errors)", () => {
  const slabs = [mkSlab("L1", 0), mkSlab("L2", 3.2)];
  const op = { id: "x", type: "vertical-opening", params: { point: [5, 5], width: 1, depth: 1, elevation: 3.2, height: 0.5 } };
  const a = m.auditVerticalOpenings([op], slabs);
  assert.deepEqual(a.cuts["x"], ["L2"]);
  assert.ok(!a.orphaned.includes("x"));
  assert.ok(!a.issues.length, "no false positives for a normal single-floor hole");
});

console.log(`\nvertical-openings: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
