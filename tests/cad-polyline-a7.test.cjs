// Polyline width / Close / bulge preservation (AutoCAD parity A7) — node test.
//
// Three sub-items, each proved fail-without-fix against the base:
//   1. Width — LWPOLYLINE carries a constant width (DXF 43) and per-vertex
//      start/end widths (DXF 40/41); the writer emits them, the reader
//      restores them, and the in-memory trip preserves them.
//   2. In-tool Close — the PLINE option handler and finishMeasure commit
//      a closed polyline (proved by source markers: the viewer is
//      DOM-heavy and cannot be compiled headlessly); the pure
//      withClosed bookkeeping is proved here directly.
//   3. Bulge preservation — the reader no longer expands bulges to
//      tessellated points and the writer emits group 42, so a bulged
//      polyline round-trips as the same arc segments; surgery (TRIM /
//      EXTEND / BREAK / OFFSET / FILLET) expands first so the rebuilt
//      vertex list never misaligns the bulge/width arrays.
//
// No mocks: the geometry, entity helpers, writer, reader, modify math
// and gap helpers under test are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-polyline-a7-"));
fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, a + "!=" + b);
const nearPt = (a, b, e = 1e-6) => { near(a.x, b.x, e); near(a.y, b.y, e); };
try {
  execSync(
    "npx tsc src/modules/drawings/dxf-geometry.ts src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts " +
      "src/modules/cad-viewer/cad-polyline.ts src/modules/cad-viewer/cad-annotation.ts src/modules/cad-viewer/viewer-math.ts " +
      "src/modules/cad-viewer/modify-math.ts src/modules/cad-viewer/cad-2d-critical-gaps.ts src/modules/cad-viewer/fillet-chamfer.ts " +
      "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
    { cwd: root, stdio: "pipe" },
  );
  const locate = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = locate(p, name); if (found) return found; }
      else if (entry.name === name) return p;
    }
    return null;
  };
  const geom = require(locate(out, "dxf-geometry.js"));
  const poly = require(locate(out, "cad-polyline.js"));
  const { writeDxf } = require(locate(out, "dxf-writer.js"));
  const { parseDxf } = require(locate(out, "dxf-reader.js"));
  const M = require(locate(out, "viewer-math.js"));
  const X = require(locate(out, "modify-math.js"));
  const G = require(locate(out, "cad-2d-critical-gaps.js"));
  const FC = require(locate(out, "fillet-chamfer.js"));

  const L = (layer = "0") => ({ layer });
  // A semicircle from (0,0) to (2,0) through (1,1): bulge -1 (clockwise
  // from start to end, the arc runs over the top of the chord).
  const semiUp = (extra = {}) => ({
    type: "LWPOLYLINE", layer: "0",
    points: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
    bulges: [-1], closed: false, ...extra,
  });
  const line = (x1, y1, x2, y2, layer = "0") => ({
    type: "LINE", layer, start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  });

  // ── Geometry core (dxf-geometry) ──
  t("bulgeArc: semicircle bulge -1 is the arc through (1,1)", () => {
    const a = geom.bulgeArc({ x: 0, y: 0 }, { x: 2, y: 0 }, -1);
    assert.ok(a);
    near(a.center.x, 1); near(a.center.y, 0); near(a.radius, 1);
    near(a.startAngleDeg, 0); near(a.endAngleDeg, 180); near(a.sweepDeg, 180);
  });
  t("bulgeArc: semicircle bulge +1 is the arc through (1,-1)", () => {
    const a = geom.bulgeArc({ x: 0, y: 0 }, { x: 2, y: 0 }, 1);
    assert.ok(a);
    near(a.center.x, 1); near(a.center.y, 0); near(a.radius, 1);
    near(a.startAngleDeg, 180); near(a.endAngleDeg, 0); near(a.sweepDeg, 180);
  });
  t("polylineLength: semicircle + straight counts as pi + 2, not chord + 2", () => {
    near(geom.polylineLength([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }], [-1, 0], false), Math.PI + 2);
  });
  t("polylineArea: square with a semicircular top edge adds pi/2", () => {
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
    near(geom.polylineArea(pts, [0, 0, 1, 0], true), 4 + Math.PI / 2);
  });
  t("polylineBBox: bulge reaches past its chord; halfWidth expands the box", () => {
    const b = geom.polylineBBox([{ x: 0, y: 0 }, { x: 2, y: 0 }], [-1], false, 0);
    near(b.minX, 0); near(b.maxX, 2); near(b.minY, 0); near(b.maxY, 1);
    const w = geom.polylineBBox([{ x: 0, y: 0 }, { x: 2, y: 0 }], [-1], false, 2);
    near(w.minX, -2); near(w.maxX, 4); near(w.minY, -2); near(w.maxY, 3);
  });
  t("tessellatePolyline: bulged segment passes through the arc midpoint", () => {
    const pts = geom.tessellatePolyline([{ x: 0, y: 0 }, { x: 2, y: 0 }], [-1], false);
    assert.ok(pts.length > 2, "expected tessellation, got " + pts.length);
    nearPt(pts[0], { x: 0, y: 0 });
    nearPt(pts[pts.length - 1], { x: 2, y: 0 });
    assert.ok(pts.some((p) => Math.abs(p.x - 1) < 1e-9 && Math.abs(p.y - 1) < 1e-9), "no point at the arc crown (1,1)");
    assert.ok(pts.every((p) => p.y >= -1e-9), "tessellation dips below the chord");
  });
  t("normalizePolyline: pads arrays, drops all-zero bulges, keeps explicit zero widths", () => {
    const n = geom.normalizePolyline({
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
      bulges: [1], width: -5, startWidths: [2, NaN], endWidths: [0, 0],
    });
    assert.deepStrictEqual(n.bulges, [1, 0, 0]);
    assert.strictEqual(n.width, undefined);
    assert.deepStrictEqual(n.startWidths, [2, 0, 0]);
    // An explicit all-zero width array is meaningful (taper to a point),
    // so it is kept rather than dropped.
    assert.deepStrictEqual(n.endWidths, [0, 0, 0]);
    const z = geom.normalizePolyline({
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
      bulges: [0, 0],
    });
    assert.strictEqual(z.bulges, undefined);
  });

  // ── Entity helpers (cad-polyline) ──
  t("arcSegmentBulge: clockwise arc (through above) is negative, ccw is positive", () => {
    near(poly.arcSegmentBulge({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }), -1);
    near(poly.arcSegmentBulge({ x: 0, y: 0 }, { x: 1, y: -1 }, { x: 2, y: 0 }), 1);
    assert.strictEqual(poly.arcSegmentBulge({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }), null);
  });
  t("buildPolylineEntity: uniform widths collapse to a constant width", () => {
    const e = poly.buildPolylineEntity({
      layer: "0", props: {}, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }],
      startWidths: [5, 5], endWidths: [5, 5], closed: false,
    });
    assert.strictEqual(e.width, 5);
    assert.strictEqual(e.startWidths, undefined);
    assert.strictEqual(e.endWidths, undefined);
  });
  t("buildPolylineEntity: varying widths stay per-vertex", () => {
    const e = poly.buildPolylineEntity({
      layer: "0", props: {}, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }],
      startWidths: [5, 2], endWidths: [5, 2], closed: false,
    });
    assert.strictEqual(e.width, undefined);
    assert.deepStrictEqual(e.startWidths, [5, 2, 0]);
    assert.deepStrictEqual(e.endWidths, [5, 2, 0]);
  });
  t("reversePolylineEntity: bulge negates, widths swap, same geometric arc", () => {
    const e = {
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }],
      bulges: [-1, 0], startWidths: [5, 0], endWidths: [2, 0], closed: false,
    };
    const r = poly.reversePolylineEntity(e);
    assert.deepStrictEqual(r.points, [{ x: 2, y: 2 }, { x: 2, y: 0 }, { x: 0, y: 0 }]);
    // New segment 1 is the old segment 0 walked backwards: bulge negates.
    assert.deepStrictEqual(r.bulges, [0, 1, 0]);
    // New segment 1's widths are the old segment 0's, swapped.
    near(poly.segmentWidths(r, 1).start, 2);
    near(poly.segmentWidths(r, 1).end, 5);
    // The reversed arc is the same geometric arc (through (1,1)).
    const arc = geom.bulgeArc(r.points[1], r.points[2], r.bulges[1]);
    assert.ok(arc);
    near(arc.center.x, 1); near(arc.center.y, 0); near(arc.radius, 1);
  });
  t("withClosed: closing forces the closing bulge to 0 and continues widths last->first", () => {
    const e = {
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }],
      bulges: [0.5, 0], startWidths: [5, 3], endWidths: [4, 2], closed: false,
    };
    const c = poly.withClosed(e, true);
    assert.strictEqual(c.closed, true);
    assert.strictEqual(c.bulges[2], 0);
    near(poly.segmentWidths(c, 2).start, 2);
    near(poly.segmentWidths(c, 2).end, 5);
    const o = poly.withClosed(c, false);
    assert.strictEqual(o.closed, false);
  });
  t("withConstantWidth: drops per-vertex widths, sets the constant", () => {
    const e = {
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
      startWidths: [5, 0], endWidths: [2, 0], closed: false,
    };
    const w = poly.withConstantWidth(e, 7);
    assert.strictEqual(w.width, 7);
    assert.strictEqual(w.startWidths, undefined);
    const z = poly.withConstantWidth(e, 0);
    assert.strictEqual(z.width, undefined);
  });
  t("expandPolylineBulges: arc shape kept as tessellation, widths interpolated", () => {
    const e = semiUp({ width: 5 });
    const x = poly.expandPolylineBulges(e);
    assert.strictEqual(x.bulges, undefined);
    assert.ok(x.points.length > 2);
    assert.ok(x.points.some((p) => Math.abs(p.x - 1) < 1e-9 && Math.abs(p.y - 1) < 1e-9));
    assert.strictEqual(x.width, 5);
    const tapered = poly.expandPolylineBulges({
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }],
      bulges: [-1], startWidths: [10, 0], endWidths: [0, 0], closed: false,
    });
    // The tessellation midpoint (the arc crown) carries the lerped width ~5.
    const mid = tapered.points.reduce((best, p, i) => (Math.abs(p.y - 1) < Math.abs(tapered.points[best].y - 1) ? i : best), 0);
    near(poly.segmentWidths(tapered, Math.min(mid, tapered.points.length - 2)).start, 5, 0.6);
    // A bulge-free polyline is returned unchanged (same points, same width).
    const straight = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], width: 3, closed: false };
    const s2 = poly.expandPolylineBulges(straight);
    assert.deepStrictEqual(s2.points, straight.points);
    assert.strictEqual(s2.width, 3);
  });
  t("segmentWidths: vertex width wins over the constant width", () => {
    const e = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], width: 5, startWidths: [9, 0], closed: false };
    assert.deepStrictEqual(poly.segmentWidths(e, 0), { start: 9, end: 5 });
    assert.ok(poly.polylineHasWidth(e));
    near(poly.polylineMaxWidth(e), 9);
  });
  t("displaySegments: bulged segment tessellates, widths ride along", () => {
    const segs = poly.displaySegments(semiUp({ width: 4 }));
    assert.strictEqual(segs.length, 1);
    assert.ok(segs[0].points.length > 2);
    near(segs[0].startWidth, 4);
    near(segs[0].endWidth, 4);
  });
  t("bulgeSegmentArc: semicircle explodes to a real ARC, not its chord", () => {
    const a = poly.bulgeSegmentArc({ x: 0, y: 0 }, { x: 2, y: 0 }, -1, "0");
    assert.ok(a);
    assert.strictEqual(a.type, "ARC");
    near(a.center.x, 1); near(a.center.y, 0); near(a.radius, 1);
    near(a.startAngle, 0); near(a.endAngle, 180);
    assert.strictEqual(poly.bulgeSegmentArc({ x: 0, y: 0 }, { x: 2, y: 0 }, 0, "0"), null);
  });

  // ── DXF round-trip (writer + reader) ──
  const docOf = (entities) => ({
    layers: [{ name: "0" }],
    entities,
    blocks: {},
    layouts: [],
    units: "unitless",
  });
  t("DXF round-trip: bulged polyline keeps its bulge (group 42)", () => {
    const text = writeDxf(docOf([semiUp()]));
    assert.ok(/42\n-1\n/.test(text), "group 42 bulge missing from written DXF");
    const back = parseDxf(text);
    assert.strictEqual(back.entities.length, 1);
    const e = back.entities[0];
    assert.strictEqual(e.type, "LWPOLYLINE");
    assert.deepStrictEqual(e.bulges, [-1, 0]);
    assert.deepStrictEqual(e.points, [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]);
    // And writing it again produces the same bulge.
    assert.ok(/42\n-1\n/.test(writeDxf(back)), "bulge lost on the second write");
  });
  t("DXF round-trip: constant width (43) and taper (40/41) survive", () => {
    const wide = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], width: 2.5, closed: false };
    const tapered = {
      type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }],
      startWidths: [4, 1], endWidths: [2, 0], closed: false,
    };
    const text = writeDxf(docOf([wide, tapered]));
    assert.ok(/43\n2.5\n/.test(text), "group 43 constant width missing");
    assert.ok(/40\n4\n/.test(text) && /41\n2\n/.test(text), "group 40/41 taper missing");
    const back = parseDxf(text);
    const [w2, t2] = back.entities;
    near(w2.width, 2.5);
    near(t2.startWidths[0], 4); near(t2.endWidths[0], 2);
    near(t2.startWidths[1], 1); near(t2.endWidths[1], 0);
  });
  t("DXF round-trip: closed bulged polyline keeps its closing bulge slot", () => {
    const ring = {
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
      bulges: [0, 0, 1, 0], closed: true,
    };
    const back = parseDxf(writeDxf(docOf([ring])));
    const e = back.entities[0];
    assert.strictEqual(e.closed, true);
    near(e.bulges[2], 1);
  });
  t("DXF round-trip: a plain straight polyline emits no new groups", () => {
    const plain = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 3, y: 0 }], closed: false };
    const text = writeDxf(docOf([plain]));
    // Scope the check to the LWPOLYLINE entity block itself: the file's
    // STYLE table legitimately carries groups 40/41/42 (text height,
    // width factor, text size), so a whole-file regex would false-positive.
    const start = text.indexOf("LWPOLYLINE");
    const end = text.indexOf("0\nENDSEC", start);
    const block = text.slice(start, end === -1 ? undefined : end);
    assert.ok(!/^42$/m.test(block) && !/^43$/m.test(block) && !/^40$/m.test(block) && !/^41$/m.test(block),
      "plain polyline emitted a width/bulge group:\n" + block);
  });

  // ── Viewer math (viewer-math) ──
  t("entityMetrics: polyline length is arc-aware, area counts the bulge", () => {
    const m = M.entityMetrics({
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }],
      bulges: [-1, 0], closed: false,
    });
    near(m.length, Math.PI + 2);
    const ring = M.entityMetrics({
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
      bulges: [0, 0, 1, 0], closed: true,
    });
    near(ring.area, 4 + Math.PI / 2);
  });
  t("entityBBox: bulge + width reach past the chord box", () => {
    const b = M.entityBBox(semiUp({ width: 2 }));
    near(b.minX, -1); near(b.maxX, 3); near(b.minY, -1); near(b.maxY, 2);
  });
  t("findSnap: midpoint of a bulged segment is the arc crown, not the chord midpoint", () => {
    const e = semiUp();
    const idx = M.buildIndex([e], { minX: -1, minY: -1, maxX: 3, maxY: 3 });
    const s = M.findSnap(idx, [e], 1.05, 1.05, 1, ["midpoint"]);
    assert.ok(s, "no midpoint snap found");
    assert.strictEqual(s.kind, "midpoint");
    nearPt(s, { x: 1, y: 1 }, 1e-6);
  });
  t("entitySegments: bulged polyline segments follow the arc", () => {
    const segs = M.entitySegments(semiUp());
    assert.ok(segs.length > 2, "expected tessellated segments, got " + segs.length);
    // Every segment endpoint lies on the circle (centre (1,0), radius 1).
    for (const [a, b] of segs) {
      near(Math.hypot(a.x - 1, a.y - 0), 1, 1e-9);
      near(Math.hypot(b.x - 1, b.y - 0), 1, 1e-9);
    }
  });

  // ── Surgery (modify-math) ──
  t("trimEntity: trimming a bulged polyline keeps the arc shape, drops the bulge", () => {
    // A vertical cutter crossing the arc crown at (1,1): the kept pieces
    // follow the arc (every point on the circle about (1,0), radius 1,
    // up to tessellation tolerance) instead of falling back to the chord.
    const cutter = line(1, -1, 1, 3);
    const pieces = X.trimEntity(semiUp(), { x: 1, y: 1 }, [cutter]);
    assert.ok(pieces.length >= 1, "expected at least one piece");
    for (const p of pieces) {
      assert.strictEqual(p.bulges, undefined);
      assert.ok(p.points.length >= 2);
      for (const q of p.points) near(Math.hypot(q.x - 1, q.y), 1, 1e-2);
    }
    assert.ok(pieces.flatMap((p) => p.points).some((q) => q.y > 0.9), "trimmed pieces lost the arc crown");
  });
  t("extendEntity: extending a bulged polyline follows the arc tangent, drops the bulge", () => {
    // The arc's end tangent at (2,0) is vertical, so the boundary is the
    // horizontal line y=-1, which the tangent meets at x≈2.1.
    const boundary = line(1, -1, 3, -1);
    const out = X.extendEntity(semiUp(), { x: 2, y: 0 }, [boundary]);
    assert.ok(out, "extend returned null");
    assert.strictEqual(out.bulges, undefined);
    // The end moved past x=2 toward the boundary (along the arc tangent,
    // not along the chord).
    const last = out.points[out.points.length - 1];
    assert.ok(last.x > 2, "end did not extend: " + JSON.stringify(last));
    near(last.y, -1, 0.05);
  });
  t("breakEntity: breaking a bulged polyline yields bulge-free pieces", () => {
    const pieces = X.breakEntity(semiUp(), { x: 0.5, y: 0.5 }, { x: 1.5, y: 0.5 });
    assert.ok(pieces && pieces.length >= 1);
    for (const p of pieces) assert.strictEqual(p.bulges, undefined);
  });
  t("offsetEnt: offsetting a semicircle changes its radius by the offset, drops the bulge", () => {
    const out = X.offsetEnt(semiUp(), 1, { x: 1, y: 2 });
    assert.ok(out, "offset returned null");
    assert.strictEqual(out.bulges, undefined);
    // Outward offset of the upper semicircle: radius 1 -> 2, crown at y=2.
    const top = out.points.reduce((best, p) => (p.y > best.y ? p : best), out.points[0]);
    near(top.y, 2, 0.05);
  });
  t("entIntersections: a bulged polyline as cutter intersects on its arc, not its chord", () => {
    // A vertical line at x=1 crosses the arc crown (1,1) but the chord
    // only at (1,0) — the chord-only answer would be a single point.
    const xs = X.entIntersections(semiUp(), line(1, -1, 1, 3));
    assert.ok(xs.some((p) => Math.abs(p.y - 1) < 1e-6), "arc crown intersection missing: " + JSON.stringify(xs));
  });
  t("chainPolyline: JOIN keeps bulges and widths across the join", () => {
    const a = semiUp({ startWidths: [5, 0], endWidths: [2, 0] });
    const b = { type: "LWPOLYLINE", layer: "0", points: [{ x: 2, y: 0 }, { x: 4, y: 0 }], closed: false };
    const m = X.chainPolyline([a, b]);
    assert.ok(m, "join returned null");
    assert.strictEqual(m.points.length, 3);
    near(m.bulges[0], -1);
    near(poly.segmentWidths(m, 0).start, 5);
    near(poly.segmentWidths(m, 0).end, 2);
    // Joining in the other order prepends the bulged polyline, so the
    // merged chain still runs (0,0)->(2,0)->(4,0) with the arc first —
    // the bulge and widths keep their original orientation.
    const m2 = X.chainPolyline([b, a]);
    assert.ok(m2, "reversed join returned null");
    assert.deepStrictEqual(m2.points, [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }]);
    near(m2.bulges[0], -1);
    near(poly.segmentWidths(m2, 0).start, 5);
    near(poly.segmentWidths(m2, 0).end, 2);
  });
  t("entitySpanLength: open bulged polyline counts arcs", () => {
    near(X.entitySpanLength(semiUp()), Math.PI);
  });

  // ── Gap helpers (cad-2d-critical-gaps) ──
  t("reversePolyline: in-place reversal negates the bulge", () => {
    const ents = [semiUp()];
    assert.strictEqual(G.reversePolyline(ents, [0]), 1);
    assert.deepStrictEqual(ents[0].points, [{ x: 2, y: 0 }, { x: 0, y: 0 }]);
    near(ents[0].bulges[0], 1);
  });
  t("setPolylineClosed: closing writes the closing-edge bookkeeping", () => {
    const ents = [{
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }],
      startWidths: [5, 3], endWidths: [4, 2], closed: false,
    }];
    assert.strictEqual(G.setPolylineClosed(ents, [0], true), 1);
    assert.strictEqual(ents[0].closed, true);
    near(poly.segmentWidths(ents[0], 2).start, 2);
    near(poly.segmentWidths(ents[0], 2).end, 5);
  });
  t("explodePolylines: bulged segment becomes an ARC, straight stays a LINE", () => {
    const out = G.explodePolylines([semiUp()], [0]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].type, "ARC");
    near(out[0].radius, 1);
  });
  t("midpointMarkers: arc midpoint is the crown, closing edge gets a marker", () => {
    const ring = {
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
      bulges: [0, 0, 1, 0], closed: true,
    };
    const pts = G.midpointMarkers([ring], [0], "0");
    assert.strictEqual(pts.length, 4, "expected one marker per edge, got " + pts.length);
    assert.ok(pts.some((p) => Math.abs(p.position.x - 1) < 1e-9 && Math.abs(p.position.y - 3) < 1e-9),
      "no marker at the top arc crown (1,3): " + JSON.stringify(pts.map((p) => p.position)));
  });
  t("selectionArea/totalLinearLength: arc-aware", () => {
    const ring = {
      type: "LWPOLYLINE", layer: "0",
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }],
      bulges: [0, 0, 1, 0], closed: true,
    };
    near(G.selectionArea([ring], [0]), 4 + Math.PI / 2);
    near(G.totalLinearLength([semiUp()], [0]), Math.PI);
  });
  t("PLINEWID store: node-safe defaults (no localStorage here)", () => {
    assert.strictEqual(G.getPlineWidthStore(0), 0);
    G.setPlineWidthStore(5); // must not throw without localStorage
    assert.strictEqual(G.getPlineWidthStore(0), 0);
  });

  // ── Fillet composition (the viewer expands, then fillets) ──
  t("filletEntities on the expanded polyline: the guard's building blocks compose", () => {
    // A polyline with a straight first segment and a bulged second
    // segment, expanded: the guard hands FILLET the expanded polyline
    // with the segment index computed on the tessellation. Filleting the
    // straight first segment against a perpendicular line is a real
    // fillet (radius 2, corner (10,0), tangent points (8,0) and (10,2)).
    const src = { type: "LWPOLYLINE", layer: "0", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], bulges: [0, -1], closed: false };
    const a = poly.expandPolylineBulges(src);
    const b = { type: "LINE", layer: "0", start: { x: 10, y: 0 }, end: { x: 10, y: 20 } };
    const segA = FC.nearestPolylineSegment(a.points, { x: 9, y: 0 }, false).index;
    assert.strictEqual(segA, 0, "expected the straight first segment, got " + segA);
    const res = FC.filletEntities(
      { entity: a, pick: { x: 9, y: 0 }, segmentIndex: segA },
      { entity: b, pick: { x: 10, y: 1 } },
      2, { trim: true },
    );
    assert.ok(res.ok, "fillet failed: " + (res.ok ? "" : res.reason));
    assert.ok(res.after.some((e) => e.type === "ARC"), "no fillet arc in the result");
    // The fillet's before/after brackets the EXPANDED entity; the viewer
    // rewrites `before` to the original, so one UNDO restores the bulge.
    assert.ok(res.before.includes(a));
  });

  // ── Viewer wiring (source markers — the viewer is DOM-heavy) ──
  const viewerSrc = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  t("viewer: PLINE has an in-tool Close/Undo/Arc/Width handler (C no longer falls through to CIRCLE)", () => {
    assert.ok(/function handlePolyOption/.test(viewerSrc), "handlePolyOption missing");
    assert.ok(/if \(tool === "poly" && handlePolyOption\(trimmed\)\)/.test(viewerSrc), "handlePolyOption not hooked into the command dispatch");
    assert.ok(/k === "C" \|\| k === "CLOSE"/.test(viewerSrc), "Close option missing");
    assert.ok(/finishMeasure\(true\)/.test(viewerSrc), "Close does not finish closed");
  });
  t("viewer: PLINEWID command and LISP variable exist", () => {
    assert.ok(/cmd === "PLINEWID"/.test(viewerSrc), "PLINEWID command missing");
    assert.ok(/k === "PLINEWID"\) return getPlineWidthStore\(0\)/.test(viewerSrc), "PLINEWID getvar missing");
    assert.ok(/k === "PLINEWID" && Number\(v\) >= 0\) setPlineWidthStore/.test(viewerSrc), "PLINEWID setvar missing");
  });
  t("viewer: PEDIT gains W and uses the bulge-aware helpers for C/O/R", () => {
    assert.ok(/Poly\.withClosed\(e, true\)/.test(viewerSrc), "PEDIT C does not use withClosed");
    assert.ok(/Poly\.reversePolylineEntity\(e\)/.test(viewerSrc), "PEDIT R does not use reversePolylineEntity");
    assert.ok(/Poly\.withConstantWidth\(e, w\)/.test(viewerSrc), "PEDIT W missing");
  });
  t("viewer: Properties panel has a Width control for polylines", () => {
    assert.ok(/data-props-width/.test(viewerSrc), "Width control missing from showProps");
    assert.ok(/Poly\.withConstantWidth\(cur, v\)/.test(viewerSrc), "Width control does not commit via withConstantWidth");
  });
  t("viewer: FILLET/CHAMFER expands bulged operands and folds it into one undo step", () => {
    assert.ok(/expandOperand/.test(viewerSrc), "fillet expand guard missing");
    assert.ok(/res\.before\.map\(\(e\) => \(e === aX \? a : e === bX \? b : e\)\)/.test(viewerSrc), "before-rewrite missing");
  });
  t("viewer: polyline renders tessellated arcs at per-segment widths", () => {
    assert.ok(/Poly\.displaySegments\(e\)/.test(viewerSrc), "renderer does not use displaySegments");
    assert.ok(/Poly\.displayPoints\(e\)/.test(viewerSrc), "hairline path does not use displayPoints");
  });
  t("viewer: in-progress PLINE preview tessellates arcs", () => {
    assert.ok(/polyPreviewPoints\(cursor\)/.test(viewerSrc), "preview does not use polyPreviewPoints");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("SETUP FAILED: " + (e && e.message));
  if (e && e.stdout) console.error(String(e.stdout).slice(-4000));
  if (e && e.stderr) console.error(String(e.stderr).slice(-4000));
  process.exit(1);
}
