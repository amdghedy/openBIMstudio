/**
 * CAD native ENGINE geometry suite — pure modify-math helpers behind the
 * native-engine ribbon tools (TRIM / EXTEND / BREAK / FILLET / CHAMFER /
 * JOIN / STRETCH / SPLINE / POLYGON / ELLIPSE / DONUT).
 *
 * Runs the TypeScript module through the same compiled build the CI unit
 * scripts use (see scripts/ci-unit-tests.mjs) — modify-math.ts is DOM-free so
 * it can be required directly.
 */
const path = require("path");
const assert = require("assert");
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os");

const ROOT = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cadengine-"));
execSync(`npx tsc src/modules/cad-viewer/modify-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "pipe", cwd: ROOT });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const X = require(find(out, "modify-math.js"));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const ptClose = (p, q, eps = 1e-6) => close(p.x, q.x, eps) && close(p.y, q.y, eps);
const line = (x1, y1, x2, y2) => ({ type: "LINE", layer: "0", start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const pline = (pts, closed = false) => ({ type: "LWPOLYLINE", layer: "0", points: pts.map(([x, y]) => ({ x, y })), closed });

// ── 1. segSegX ──
t("segSegX finds the crossing of two segments", () => {
  const [p] = X.segSegX({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
  assert.ok(ptClose(p, { x: 5, y: 5 }));
});
t("segSegX rejects non-touching and parallel segments", () => {
  assert.strictEqual(X.segSegX({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }).length, 0);
  assert.strictEqual(X.segSegX({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: -1 }, { x: 2, y: 1 }).length, 0);
});

// ── 2. segCircleX ──
t("segCircleX finds both crossings of a chord", () => {
  const xs = X.segCircleX({ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 0 }, 1);
  assert.strictEqual(xs.length, 2);
  assert.ok(xs.some((p) => ptClose(p, { x: 1, y: 0 })));
  assert.ok(xs.some((p) => ptClose(p, { x: -1, y: 0 })));
});

// ── 3. entIntersections ──
t("entIntersections crosses a line with a circle", () => {
  const xs = X.entIntersections(line(-3, 0, 3, 0), { type: "CIRCLE", layer: "0", center: { x: 0, y: 0 }, radius: 1.5 });
  assert.strictEqual(xs.length, 2);
});
t("entIntersections crosses two polylines sharing a crossing", () => {
  const a = pline([[0, 0], [10, 10]]);
  const b = pline([[0, 10], [10, 0]]);
  const xs = X.entIntersections(a, b);
  assert.strictEqual(xs.length, 1);
  assert.ok(ptClose(xs[0], { x: 5, y: 5 }));
});
t("entIntersections respects arc sweeps", () => {
  // half-circle upper arc from 0° to 180°: the tangent line x=-2 touches at 180°
  const arc = { type: "ARC", layer: "0", center: { x: 0, y: 0 }, radius: 2, startAngle: 0, endAngle: 180 };
  assert.strictEqual(X.entIntersections(line(-2, -3, -2, 3), arc).length, 1);
  // an upper arc ending at 170° no longer reaches the x-axis
  const miss = { type: "ARC", layer: "0", center: { x: 0, y: 0 }, radius: 2, startAngle: 10, endAngle: 170 };
  assert.strictEqual(X.entIntersections(line(-2, -3, -2, 3), miss).length, 0);
});

// ── 4. paramAlong / pointOnEntity ──
t("paramAlong maps points to 0..1 along a line", () => {
  const l = line(0, 0, 10, 0);
  assert.ok(close(X.paramAlong(l, { x: 0, y: 0 }), 0));
  assert.ok(close(X.paramAlong(l, { x: 5, y: 0 }), 0.5));
  assert.ok(close(X.paramAlong(l, { x: 10, y: 0 }), 1));
});
t("pointOnEntity accepts on-curve and rejects off-curve points", () => {
  const l = line(0, 0, 10, 0);
  assert.ok(X.pointOnEntity(l, { x: 4, y: 0.01 }, 0.1));
  assert.ok(!X.pointOnEntity(l, { x: 4, y: 3 }, 0.1));
  const c = { type: "CIRCLE", layer: "0", center: { x: 0, y: 0 }, radius: 5 };
  assert.ok(X.pointOnEntity(c, { x: 5, y: 0 }, 0.1));
  assert.ok(!X.pointOnEntity(c, { x: 2, y: 0 }, 0.1));
});

// ── 5. trimEntity ──
t("trimEntity cuts the picked middle out of a line", () => {
  const cutter = line(5, -1, 5, 1);
  const pieces = X.trimEntity(line(0, 0, 10, 0), { x: 5.5, y: 0 }, [cutter]);
  // click right of the cutter → keep the left piece only (0..5)
  assert.strictEqual(pieces.length, 1);
  assert.ok(ptClose(pieces[0].start, { x: 0, y: 0 }));
  assert.ok(ptClose(pieces[0].end, { x: 5, y: 0 }));
});
t("trimEntity keeps both sides when the click is between two cutters", () => {
  const pieces = X.trimEntity(line(0, 0, 10, 0), { x: 5, y: 0 }, [line(3, -1, 3, 1), line(7, -1, 7, 1)]);
  assert.strictEqual(pieces.length, 2);
});

// ── 6. extendEntity ──
t("extendEntity stretches the clicked end to the boundary", () => {
  const boundary = line(12, -5, 12, 5);
  const out = X.extendEntity(line(0, 0, 10, 0), { x: 10.5, y: 0 }, [boundary]);
  assert.ok(out && ptClose(out.end, { x: 12, y: 0 }));
});

// ── 7. breakEntity ──
t("breakEntity removes the span between two points", () => {
  const out = X.breakEntity(line(0, 0, 10, 0), { x: 7, y: 0 }, { x: 3, y: 0 });
  assert.ok(out && out.length === 2);
  assert.ok(ptClose(out[0].end, { x: 3, y: 0 }));
  assert.ok(ptClose(out[1].start, { x: 7, y: 0 }));
});

// ── 8. filletTwoLines ──
t("filletTwoLines returns a tangent arc and trimmed lines (r/tan θ/2)", () => {
  const r = X.filletTwoLines(line(0, 0, 10, 0), line(0, 0, 0, 10), 2);
  assert.ok(r);
  // tangent points: (2,0) on the horizontal and (0,2) on the vertical; center (2,2)
  const [a, b] = r.lines;
  const ends = [a.end, b.end].sort((p, q) => p.x - q.x);
  assert.ok(ptClose(ends[0], { x: 0, y: 2 }) || ptClose(ends[0], { x: 2, y: 0 }));
  assert.ok(ptClose(ends[1], { x: 2, y: 0 }) || ptClose(ends[1], { x: 0, y: 2 }));
  assert.ok(ptClose(r.arc.center, { x: 2, y: 2 }));
  assert.ok(close(r.arc.radius, 2));
  // the trimmed lines keep everything beyond the tangent point
  assert.ok(ptClose(a.start, { x: 10, y: 0 }) || ptClose(b.start, { x: 10, y: 0 }));
  assert.ok(ptClose(a.start, { x: 0, y: 10 }) || ptClose(b.start, { x: 0, y: 10 }));
});
t("filletTwoLines refuses parallel lines", () => {
  assert.strictEqual(X.filletTwoLines(line(0, 0, 10, 0), line(0, 1, 10, 1), 2), null);
});

// ── 9. chamferTwoLines ──
t("chamferTwoLines bevels the corner at the given distances", () => {
  const r = X.chamferTwoLines(line(0, 0, 10, 0), line(0, 0, 0, 10), 2, 3);
  assert.ok(r);
  assert.ok(ptClose(r.bar.start, { x: 2, y: 0 }) || ptClose(r.bar.start, { x: 0, y: 3 }));
  assert.ok(ptClose(r.bar.end, { x: 0, y: 3 }) || ptClose(r.bar.end, { x: 2, y: 0 }));
});

// ── 10. chainPolyline ──
t("chainPolyline joins collinear line chains into one polyline", () => {
  const out = X.chainPolyline([line(0, 0, 5, 0), line(5, 0, 5, 4), line(5, 4, 9, 4)]);
  assert.ok(out && out.type === "LWPOLYLINE");
  assert.strictEqual(out.points.length, 4);
});
t("chainPolyline returns null for a broken chain", () => {
  assert.strictEqual(X.chainPolyline([line(0, 0, 5, 0), line(20, 0, 25, 0)]), null);
});

// ── 11. catmullRom ──
t("catmullRom interpolates through every input point", () => {
  const pts = [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 8, y: 0 }];
  const out = X.catmullRom(pts, 6);
  assert.ok(out.length > pts.length);
  for (const p of pts) assert.ok(out.some((q) => ptClose(p, q, 1e-9)));
});

// ── 12. shape loops ──
t("polygonLoop / ellipseLoop / donutLoops produce closed, sane loops", () => {
  const hex = X.polygonLoop(0, 0, 5, 6);
  assert.strictEqual(hex.length, 6);
  const step = Math.hypot(hex[1].x - hex[0].x, hex[1].y - hex[0].y);
  assert.ok(close(step, 5, 1e-6)); // equal sides
  const ell = X.ellipseLoop(1, 2, 4, 2);
  assert.strictEqual(ell.length, 48);
  const [o, i] = X.donutLoops(0, 0, 5, 2);
  assert.ok(o.length >= i.length);
});

// ── 13. stretchEnts ──
t("stretchEnts moves only vertices inside the crossing window", () => {
  const l = line(0, 0, 10, 0);
  const [out] = X.stretchEnts([l], { minX: -1, minY: -1, maxX: 4, maxY: 1 }, { x: 2, y: 3 });
  assert.ok(ptClose(out.start, { x: 2, y: 3 }));
  assert.ok(ptClose(out.end, { x: 10, y: 0 }));
});
t("stretchEnts drags whole point entities anchored inside", () => {
  const p = { type: "POINT", layer: "0", position: { x: 1, y: 1 } };
  const [out] = X.stretchEnts([p], { minX: 0, minY: 0, maxX: 2, maxY: 2 }, { x: 5, y: 0 });
  assert.ok(ptClose(out.position, { x: 6, y: 1 }));
});

// ── 14. transform helpers still intact ──
t("translate/rotate/scale/mirror entity transforms still work", () => {
  const l = line(0, 0, 1, 0);
  const mv = X.translateEnt(l, 2, 3);
  assert.ok(ptClose(mv.start, { x: 2, y: 3 }));
  const rot = X.rotateEnt(l, 0, 0, 90);
  assert.ok(ptClose(rot.end, { x: 0, y: 1 }));
  const sc = X.scaleEnt(l, 0, 0, 2);
  assert.ok(ptClose(sc.end, { x: 2, y: 0 }));
  const mi = X.mirrorEnt(l, { x: 0, y: 0 }, { x: 0, y: 1 });
  assert.ok(ptClose(mi.end, { x: -1, y: 0 }));
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
