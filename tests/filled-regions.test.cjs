/**
 * tests/filled-regions.test.cjs
 *
 * Unit tests for filled/masking regions: polygon clipping math, region store
 * CRUD + persistence, pattern-backed entity generation (paper-mm scaling).
 *
 * Compile strategy: tsc the pure modules (filled-regions + hatch-patterns)
 * into a temp dir, require them, run assertions. No DOM needed.
 *
 * Run: `node tests/filled-regions.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "fr-"));
execSync(
  `npx tsc src/modules/filled-regions/types.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop --ignoreDeprecations 5.0`,
  { stdio: "inherit", cwd: path.resolve(__dirname, "..") },
);
const store = require(path.join(out, "filled-regions/types.js"));
const poly = require(path.join(out, "filled-regions/polygon.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const P = (x, y) => ({ x, y });

// ── Polygon math ────────────────────────────────────────────────────────
const square = [P(0, 0), P(4, 0), P(4, 4), P(0, 4)];
const concave = [P(0, 0), P(6, 0), P(6, 6), P(3, 2), P(0, 6)]; // notch cut into the top edge

t("pointInPolygon: inside/outside/on-vertex", () => {
  assert.ok(poly.pointInPolygon(2, 2, square));
  assert.ok(!poly.pointInPolygon(5, 2, square));
  assert.ok(!poly.pointInPolygon(2, -1, square));
});
t("pointInPolygon: concave notch is outside", () => {
  assert.ok(poly.pointInPolygon(1, 4, concave));
  assert.ok(!poly.pointInPolygon(3, 4.5, concave), "notch area must be outside");
  assert.ok(poly.pointInPolygon(3, 1, concave));
});
t("polygonBBox", () => {
  const bb = poly.polygonBBox(concave);
  near(bb.minX, 0); near(bb.minY, 0); near(bb.maxX, 6); near(bb.maxY, 6);
});
t("polygonBBox of empty poly is zeroed", () => {
  const bb = poly.polygonBBox([]);
  near(bb.minX, 0); near(bb.maxX, 0);
});
t("polygonSignedArea: 4x4 square = 16 (CCW), CW = -16", () => {
  near(poly.polygonSignedArea(square), 16, 1e-9);
  near(poly.polygonSignedArea([...square].reverse()), -16, 1e-9);
});
t("translatePolygon shifts every vertex", () => {
  const moved = poly.translatePolygon(square, 10, -2);
  near(moved[0].x, 10); near(moved[0].y, -2); near(moved[2].x, 14);
});
t("clipSegmentToPolygonIntervals: fully inside", () => {
  const iv = poly.clipSegmentToPolygonIntervals(P(1, 1), P(2, 1), square);
  assert.strictEqual(iv.length, 1);
  near(iv[0][0], 0); near(iv[0][1], 1);
});
t("clipSegmentToPolygonIntervals: fully outside", () => {
  const iv = poly.clipSegmentToPolygonIntervals(P(5, 1), P(9, 1), square);
  assert.strictEqual(iv.length, 0);
});
t("clipSegmentToPolygonIntervals: crossing line clips at the boundary", () => {
  const iv = poly.clipSegmentToPolygonIntervals(P(-1, 2), P(9, 2), square); // crosses 0..4
  assert.strictEqual(iv.length, 1);
  near(iv[0][0], 0.1); near(iv[0][1], 0.5);
});
t("clipSegmentToPolygonIntervals: concave notch yields two spans", () => {
  // Line through the notch: enters left lobe, exits into notch, re-enters right lobe
  const iv = poly.clipSegmentToPolygonIntervals(P(-1, 4.5), P(7, 4.5), concave);
  assert.strictEqual(iv.length, 2, `expected 2 spans, got ${JSON.stringify(iv)}`);
});
t("clipLinesToPolygon keeps only inside parts", () => {
  const lines = [{ x1: -1, y1: 2, x2: 9, y2: 2 }, { x1: 1, y1: 1, x2: 2, y2: 1 }];
  const out = poly.clipLinesToPolygon(lines, square);
  assert.strictEqual(out.length, 2);
  near(out[0].x1, 0); near(out[0].x2, 4);
  near(out[1].x1, 1); near(out[1].x2, 2);
});

// ── Store ───────────────────────────────────────────────────────────────
t("addRegion/getRegions roundtrip", () => {
  const r = store.addRegion({
    viewId: "plan:L0", type: "filled",
    boundary: [[0, 0], [2, 0], [2, 2], [0, 2]],
    pattern: "ANSI31", patternScale: 1, patternRotation: 0,
    color: "#000000", background: "rgba(148,163,184,0.16)",
    lineWeightMm: 0.35, lineColor: "#000000",
  });
  assert.ok(r.id);
  assert.strictEqual(store.getRegions("plan:L0").length, 1);
  assert.strictEqual(store.getRegions("plan:other").length, 0);
});
t("updateRegion patches pattern", () => {
  const r = store.getRegions("plan:L0")[0];
  const u = store.updateRegion("plan:L0", r.id, { pattern: "CONCRETE", patternScale: 2.5, patternRotation: 90 });
  assert.strictEqual(u.pattern, "CONCRETE");
  near(u.patternScale, 2.5); near(u.patternRotation, 90);
  assert.strictEqual(store.updateRegion("plan:L0", "nope", {}), null);
});
t("moveRegion translates the boundary", () => {
  const r = store.getRegions("plan:L0")[0];
  store.moveRegion("plan:L0", r.id, 1, -1);
  const b = store.getRegions("plan:L0")[0].boundary;
  near(b[0][0], 1); near(b[0][1], -1); near(b[2][0], 3);
});
t("hitTestRegion finds by containment and boundary tolerance", () => {
  const r = store.getRegions("plan:L0")[0];
  assert.strictEqual(store.hitTestRegion("plan:L0", 2, 0).id, r.id); // inside
  assert.strictEqual(store.hitTestRegion("plan:L0", 2, 0.05, 0.1).id, r.id); // near edge
  assert.strictEqual(store.hitTestRegion("plan:L0", 50, 50), null);
});
t("removeRegion removes and reports", () => {
  const r = store.getRegions("plan:L0")[0];
  assert.ok(store.removeRegion("plan:L0", r.id));
  assert.strictEqual(store.getRegions("plan:L0").length, 0);
  assert.ok(!store.removeRegion("plan:L0", r.id));
});

t("regionsToEntities: filled with clipped pattern lines (paper-mm scaling)", () => {
  // 4 m square at 1:100 → paper 40 mm; ANSI31 spacing 3 mm (paper).
  store.addRegion({
    viewId: "plan:V1", type: "filled",
    boundary: [[0, 0], [4, 0], [4, 4], [0, 4]],
    pattern: "ANSI31", patternScale: 1, patternRotation: 0,
    color: "#111111", background: "rgba(148,163,184,0.16)",
    lineWeightMm: 0.35, lineColor: "#111111",
  });
  // unitPerMm = planViewScale/1000 = 0.1 world-units per paper-mm at 1:100
  const ents = store.regionsToEntities("plan:V1", 0.1);
  assert.strictEqual(ents.length, 1);
  const e = ents[0];
  assert.ok(e.fillColor, "filled region has background tint");
  assert.ok(e.patternLines && e.patternLines.length > 0, "pattern lines generated");
  // every clipped line must lie inside the 4x4 boundary
  for (const l of e.patternLines) {
    assert.ok(l.x1 >= -1e-6 && l.x1 <= 4 + 1e-6 && l.y1 >= -1e-6 && l.y1 <= 4 + 1e-6);
    assert.ok(l.x2 >= -1e-6 && l.x2 <= 4 + 1e-6 && l.y2 >= -1e-6 && l.y2 <= 4 + 1e-6);
  }
  // paper-true spacing: perpendicular distance between 45° lines stays 3 mm paper
  // = 0.3 world units at 1:100. Measure via signed distance along the (1,1)/√2 normal.
  const ds = e.patternLines
    .map((l) => (l.x1 + l.y1) / Math.SQRT2)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ds.length; i++) if (ds[i] - ds[i - 1] > 1e-4) gaps.push(ds[i] - ds[i - 1]);
  assert.ok(gaps.length > 3, `expected several distinct hatch lines, got ${gaps.length + 1}`);
  const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  near(avgGap, 3 * 0.1, 0.02); // perpendicular spacing 0.3 world units
});
t("regionsToEntities: masking region is a white mask without pattern", () => {
  store.addRegion({
    viewId: "plan:V2", type: "masking",
    boundary: [[1, 1], [3, 1], [3, 3], [1, 3]],
    maskOpacity: 1, lineWeightMm: 0.35, lineColor: "#e2e8f0",
  });
  const e = store.regionsToEntities("plan:V2", 0.1)[0];
  assert.strictEqual(e.maskOpacity, 1);
  assert.ok(!e.patternLines, "masking has no pattern lines");
});
t("regionsToEntities skips degenerate boundaries", () => {
  store.addRegion({ viewId: "plan:V3", type: "filled", boundary: [[0, 0], [1, 1]], lineWeightMm: 0.35, lineColor: "#000" });
  assert.strictEqual(store.regionsToEntities("plan:V3", 0.1).length, 0);
});

t("serialize/load roundtrip preserves regions and resumes id counter", () => {
  const before = store.countRegions();
  const data = store.serializeRegions();
  assert.strictEqual(data.length, before);
  const json = JSON.parse(JSON.stringify(data));
  store.loadRegions([]);
  assert.strictEqual(store.countRegions(), 0);
  store.loadRegions(json);
  assert.strictEqual(store.countRegions(), before);
  // new id must not collide with restored ids
  const r = store.addRegion({ viewId: "plan:R", type: "masking", boundary: [[0, 0], [1, 0], [1, 1]], lineWeightMm: 0.35, lineColor: "#fff" });
  for (const reg of store.getRegions("plan:V1").concat(store.getRegions("plan:V2"))) {
    assert.notStrictEqual(reg.id, r.id);
  }
});
t("loadRegions skips malformed entries", () => {
  store.loadRegions([{ viewId: "plan:OK", boundary: [[0, 0], [1, 0], [1, 1]], type: "masking", lineWeightMm: 0.3, lineColor: "#fff" }, null, { nope: 1 }, { viewId: 5 }]);
  assert.strictEqual(store.getRegions("plan:OK").length, 1);
  store.loadRegions([]);
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
