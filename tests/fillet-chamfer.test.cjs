/*
 * Fillet / Chamfer in-tool prompts + arc/polyline support (AutoCAD parity A6).
 *
 * The CAD viewer used to fillet/chamfer two LINEs only, with the radius /
 * distances settable only from the command line (FILLET R / FILLETRAD,
 * CHAMFER / CHAMFERD), no trim/no-trim option, and arcs / circles /
 * polylines rejected. The fix generalises the trim math in
 * src/modules/cad-viewer/fillet-chamfer.ts to LINE, ARC and picked
 * LWPOLYLINE segments, adds a Trim/No trim mode (TRIMMODE), prompts for
 * the radius / distances in-tool through the existing pendingNumeric
 * machinery, and makes FILLETRAD / CHAMFERD share one source of truth with
 * the in-tool values instead of a second, unsynced localStorage store.
 *
 * Strategy (repo precedent: grid-snap.test.cjs):
 *   1. Compile the real fillet-chamfer.ts + modify-math.ts +
 *      cad-2d-critical-gaps.ts with tsc and test the real helpers
 *      behaviourally — no mocks of the decision logic.
 *   2. Source markers prove cad-viewer.ts actually wires the helpers into
 *      the live path (in-tool prompt, TRIMMODE, shared setters) and that
 *      the old LINE-only rejection is gone — these fail on the unfixed
 *      tree, where the module and the wiring do not exist.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-fillet-chamfer-"));
execSync(
  `npx tsc src/modules/cad-viewer/fillet-chamfer.ts src/modules/cad-viewer/modify-math.ts src/modules/cad-viewer/cad-2d-critical-gaps.ts --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib ES2022,DOM --skipLibCheck --noCheck`,
  { cwd: root, stdio: "inherit" },
);
const F = require(path.join(out, "cad-viewer", "fillet-chamfer.js"));
const X = require(path.join(out, "cad-viewer", "modify-math.js"));
const S = require(path.join(out, "cad-viewer", "cad-2d-critical-gaps.js"));
const viewer = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");
const gaps = fs.readFileSync(path.join(root, "src", "modules", "cad-viewer", "cad-2d-critical-gaps.ts"), "utf8");

let pass = 0,
  fail = 0;
const t = (n, f) => {
  try {
    f();
    pass++;
    console.log("  PASS " + n);
  } catch (e) {
    fail++;
    console.log("  FAIL " + n + ": " + e.message);
  }
};
const close = (a, b, eps = 1e-6) => {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be within ${eps} of ${b}`);
};
const closePt = (a, b, eps = 1e-6) => {
  close(a.x, b.x, eps);
  close(a.y, b.y, eps);
};
const line = (x1, y1, x2, y2, layer = "0") => ({ type: "LINE", layer, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const arc = (cx, cy, r, s, e, layer = "0") => ({ type: "ARC", layer, center: { x: cx, y: cy }, radius: r, startAngle: s, endAngle: e });
const circle = (cx, cy, r, layer = "0") => ({ type: "CIRCLE", layer, center: { x: cx, y: cy }, radius: r });
const poly = (pts, closed = false, layer = "0") => ({
  type: "LWPOLYLINE",
  layer,
  points: pts.map(([x, y]) => ({ x, y })),
  closed,
});
const op = (entity, pick, segmentIndex) => ({ entity, pick, segmentIndex });
const unwrap = (res) => {
  assert.equal(res.ok, true, `expected ok, got rejection: ${res.ok === false ? res.reason : "?"}`);
  return res;
};

/* ── line / line fillet: exact values + no regression vs the old math ── */

t("line-line fillet trims both lines to the tangent points and adds the arc", () => {
  const a = line(0, 0, 100, 0);
  const b = line(0, 0, 0, 100);
  const res = unwrap(F.filletEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 10, { trim: true }));
  assert.equal(res.addedKind, "ARC");
  assert.equal(res.before.length, 2);
  assert.equal(res.after.length, 3);
  const [l1, l2, fillet] = res.after;
  closePt(l1.start, { x: 100, y: 0 });
  closePt(l1.end, { x: 10, y: 0 });
  closePt(l2.start, { x: 0, y: 100 });
  closePt(l2.end, { x: 0, y: 10 });
  assert.equal(fillet.type, "ARC");
  closePt(fillet.center, { x: 10, y: 10 });
  assert.equal(fillet.radius, 10);
  assert.equal(fillet.startAngle, 180);
  assert.equal(fillet.endAngle, -90);
  assert.equal(fillet.layer, "0");
});

t("line-line fillet matches the old line-only math (no regression)", () => {
  const cases = [
    [line(0, 0, 100, 0), line(0, 0, 0, 100), 10],
    [line(0, 0, 100, 0), line(0, 0, 0, 100), 25],
    [line(10, 20, 110, 20), line(10, 20, 10, 120), 5],
    [line(0, 0, 50, 50), line(0, 0, 50, -50), 8],
  ];
  for (const [a, b, r] of cases) {
    const old = X.filletTwoLines(a, b, r);
    assert.ok(old, "old math should succeed for this case");
    const res = unwrap(
      F.filletEntities(op(a, { x: (a.start.x + a.end.x) / 2, y: (a.start.y + a.end.y) / 2 }), op(b, { x: (b.start.x + b.end.x) / 2, y: (b.start.y + b.end.y) / 2 }), r, { trim: true }),
    );
    const [l1, l2, fillet] = res.after;
    closePt(l1.start, old.lines[0].start);
    closePt(l1.end, old.lines[0].end);
    closePt(l2.start, old.lines[1].start);
    closePt(l2.end, old.lines[1].end);
    closePt(fillet.center, old.arc.center);
    assert.equal(fillet.radius, old.arc.radius);
    close(fillet.startAngle, old.arc.startAngle);
    close(fillet.endAngle, old.arc.endAngle);
  }
});

t("line-line fillet picks the corner the user picked (crossing lines)", () => {
  // Two crossing lines: picks near (0,100) select the top-left corner.
  const a = line(-100, 0, 100, 0);
  const b = line(0, -100, 0, 100);
  const res = unwrap(F.filletEntities(op(a, { x: -60, y: 0 }), op(b, { x: 0, y: 60 }), 10, { trim: true }));
  const [, , fillet] = res.after;
  closePt(fillet.center, { x: -10, y: 10 });
  // Picks near (100,-100) select the opposite corner instead.
  const res2 = unwrap(F.filletEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: -60 }), 10, { trim: true }));
  closePt(res2.after[2].center, { x: 10, y: -10 });
});

/* ── line / arc and arc / arc ── */

t("line-arc fillet: exact tangent points, trimmed arc keeps the far end", () => {
  const a = line(0, 0, 100, 0);
  const b = arc(0, 50, 50, -90, 0); // (0,0) -> (50,50), quarter circle
  const res = unwrap(F.filletEntities(op(a, { x: 60, y: 0 }), op(b, { x: 40, y: 20 }), 10, { trim: true }));
  const [l1, trimmedArc, fillet] = res.after;
  // Fillet centre is x = sqrt(60^2 - 40^2) = sqrt(2000) above the line.
  closePt(fillet.center, { x: Math.sqrt(2000), y: 10 });
  assert.equal(fillet.radius, 10);
  closePt(l1.end, { x: Math.sqrt(2000), y: 0 });
  closePt(l1.start, { x: 100, y: 0 });
  // The arc is trimmed at the tangent point and keeps its far end (50,50).
  assert.equal(trimmedArc.type, "ARC");
  close(trimmedArc.endAngle, 0);
  close(trimmedArc.startAngle, -41.8103148957786, 1e-6);
  const tArc = {
    x: 0 + 50 * Math.cos((trimmedArc.startAngle * Math.PI) / 180),
    y: 50 + 50 * Math.sin((trimmedArc.startAngle * Math.PI) / 180),
  };
  // The tangent point on the arc is at distance 10 from the fillet centre.
  close(Math.hypot(tArc.x - fillet.center.x, tArc.y - fillet.center.y), 10);
  // ...and the fillet arc's own endpoints sit on both curves.
  const fa0 = {
    x: fillet.center.x + 10 * Math.cos((fillet.startAngle * Math.PI) / 180),
    y: fillet.center.y + 10 * Math.sin((fillet.startAngle * Math.PI) / 180),
  };
  const fa1 = {
    x: fillet.center.x + 10 * Math.cos((fillet.endAngle * Math.PI) / 180),
    y: fillet.center.y + 10 * Math.sin((fillet.endAngle * Math.PI) / 180),
  };
  close(Math.hypot(fa0.x - tArc.x, fa0.y - tArc.y), 0);
  close(fa1.y, 0); // on the line y = 0
  close(fa1.x, Math.sqrt(2000));
});

t("arc-arc fillet: exact centre, both arcs trimmed to the tangent points", () => {
  const a = arc(0, 0, 100, 0, 90);
  const b = arc(200, 0, 100, 90, 180);
  const res = unwrap(F.filletEntities(op(a, { x: 80, y: 20 }), op(b, { x: 120, y: 20 }), 10, { trim: true }));
  const [t1, t2, fillet] = res.after;
  closePt(fillet.center, { x: 100, y: Math.sqrt(2100) });
  assert.equal(fillet.radius, 10);
  // Trimmed arcs keep their far ends: (0,100) and (200,100).
  close(t1.startAngle, 24.619977328657107);
  close(t1.endAngle, 90);
  close(t2.startAngle, 90);
  close(t2.endAngle, 155.3800226713429);
  // Tangent points lie on both the operand circles and the fillet circle.
  for (const [trimmed, cx, cy] of [
    [t1, 0, 0],
    [t2, 200, 0],
  ]) {
    const ang = trimmed.type === "ARC" && trimmed.center.x === 0 ? trimmed.startAngle : trimmed.endAngle;
    const p = { x: cx + 100 * Math.cos((ang * Math.PI) / 180), y: cy + 100 * Math.sin((ang * Math.PI) / 180) };
    close(Math.hypot(p.x - fillet.center.x, p.y - fillet.center.y), 10);
  }
});

t("concentric arcs are rejected: no tangent circle fits between them", () => {
  const a = arc(0, 0, 100, 0, 90);
  const b = arc(0, 0, 60, 0, 90); // concentric, smaller — no shared corner
  const res = F.filletEntities(op(a, { x: 80, y: 20 }), op(b, { x: 50, y: 10 }), 10, { trim: true });
  // Concentric arcs never meet and no tangent circle of r=10 fits between
  // them with both tangent points on the spans: a clean rejection, no crash.
  assert.equal(res.ok, false);
});

/* ── polylines ── */

t("polyline end segment behaves like its line: the corner vertex moves to the tangent point", () => {
  const p = poly([
    [0, 0],
    [100, 0],
  ]);
  const b = line(0, 0, 0, 100);
  const res = unwrap(F.filletEntities(op(p, { x: 60, y: 0 }, 0), op(b, { x: 0, y: 60 }), 10, { trim: true }));
  const [trimmed, l2, fillet] = res.after;
  assert.equal(trimmed.type, "LWPOLYLINE");
  assert.deepEqual(trimmed.points, [
    { x: 10, y: 0 },
    { x: 100, y: 0 },
  ]);
  closePt(l2.end, { x: 0, y: 10 });
  closePt(fillet.center, { x: 10, y: 10 });
});

t("polyline keeps its other vertices and drops the stale native-curve tag when trimmed", () => {
  const p = poly([
    [0, 0],
    [100, 0],
    [100, 80],
  ]);
  p.native = { kind: "ellipse" };
  p.nativeSig = "stale";
  const b = line(0, 0, 0, 100);
  const res = unwrap(F.filletEntities(op(p, { x: 60, y: 0 }, 0), op(b, { x: 0, y: 60 }), 10, { trim: true }));
  const [trimmed] = res.after;
  assert.deepEqual(trimmed.points, [
    { x: 10, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 80 },
  ]);
  assert.equal(trimmed.native, undefined);
  assert.equal(trimmed.nativeSig, undefined);
});

t("two adjacent segments of one open polyline split at the corner vertex", () => {
  const p = poly([
    [0, 100],
    [0, 0],
    [100, 0],
  ]);
  const res = unwrap(F.filletEntities(op(p, { x: 0, y: 60 }, 0), op(p, { x: 60, y: 0 }, 1), 10, { trim: true }));
  assert.equal(res.before.length, 1);
  assert.equal(res.after.length, 3);
  const [head, tail, fillet] = res.after;
  assert.deepEqual(head.points, [
    { x: 0, y: 100 },
    { x: 0, y: 10 },
  ]);
  assert.deepEqual(tail.points, [
    { x: 10, y: 0 },
    { x: 100, y: 0 },
  ]);
  closePt(fillet.center, { x: 10, y: 10 });
});

t("two non-adjacent segments of one polyline fold both trims onto one copy", () => {
  // A self-crossing polyline: segment 0 is the (0,0)-(100,100) diagonal and
  // segment 2 is the (100,0)-(0,100) diagonal; they cross at (50,50), so a
  // fillet there is valid, but the two segments share no vertex — each trim
  // moves a different vertex of the same polyline. The result must be ONE
  // polyline (not two copies) plus the arc.
  const p = poly([
    [0, 0],
    [100, 100],
    [100, 0],
    [0, 100],
  ]);
  const res = unwrap(F.filletEntities(op(p, { x: 30, y: 30 }, 0), op(p, { x: 70, y: 30 }, 2), 10, { trim: true }));
  assert.equal(res.before.length, 1);
  assert.equal(res.after.length, 2); // one folded polyline + the arc
  const [folded, fillet] = res.after;
  assert.equal(folded.type, "LWPOLYLINE");
  assert.equal(folded.points.length, 4);
  assert.equal(fillet.radius, 10);
  // Both moved vertices are tangent points: exactly one radius from the
  // fillet centre. (The untouched vertices are (100,100) and (0,100).)
  const moved = folded.points.filter((q) => Math.hypot(q.x - fillet.center.x, q.y - fillet.center.y) < 10 + 1e-6);
  assert.equal(moved.length, 2);
  for (const q of moved) close(Math.hypot(q.x - fillet.center.x, q.y - fillet.center.y), 10);
  assert.deepEqual(
    folded.points.filter((q) => Math.hypot(q.x - fillet.center.x, q.y - fillet.center.y) >= 10 + 1e-6),
    [
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
  );
});

t("nearestPolylineSegment finds the picked segment, including the closing segment", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  assert.equal(F.nearestPolylineSegment(pts, { x: 60, y: 2 }).index, 0);
  assert.equal(F.nearestPolylineSegment(pts, { x: 98, y: 60 }).index, 1);
  assert.equal(F.nearestPolylineSegment(pts, { x: 50, y: 2 }, true).index, 0);
  // Closed: the wrap segment (100,100)->(0,0) is pickable.
  assert.equal(F.nearestPolylineSegment(pts, { x: 55, y: 55 }, true).index, 2);
  assert.equal(F.nearestPolylineSegment(pts, { x: 55, y: 55 }, false).index, 1);
});

/* ── chamfer ── */

t("chamfer of two lines already trimmed past the corner measures from the extended corner", () => {
  // An earlier R=25 fillet left (100,0)-(25,0) and (0,100)-(0,25): the
  // corner (0,0) is beyond both segments, but the chamfer is still valid —
  // the cuts are measured from the corner where the extensions meet.
  const a = line(100, 0, 25, 0);
  const b = line(0, 100, 0, 25);
  const res = unwrap(F.chamferEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 30, 40, { trim: true }));
  const [l1, l2, bar] = res.after;
  closePt(l1.end, { x: 30, y: 0 });
  closePt(l2.end, { x: 0, y: 40 });
  closePt(bar.start, { x: 30, y: 0 });
  closePt(bar.end, { x: 0, y: 40 });
});

t("chamfer with a distance shorter than the trimmed-away part extends the line to the cut", () => {
  const a = line(100, 0, 25, 0);
  const b = line(0, 100, 0, 25);
  const res = unwrap(F.chamferEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 10, 10, { trim: true }));
  const [l1, l2] = res.after;
  // The cut (10,0) sits beyond the segment's near end (25,0): the line is
  // extended back out to it, as AutoCAD extends lines to a chamfer.
  closePt(l1.end, { x: 10, y: 0 });
  closePt(l2.end, { x: 0, y: 10 });
});

t("chamfer of an arc whose corner is past the arc's end is still rejected", () => {
  // The arc runs (0,0)->(50,50) but the line meets its extension at (0,0)
  // past the trimmed end: the corner is not on the arc, so the distance
  // along the sweep is undefined.
  const a = line(0, 0, 100, 0);
  const b = arc(0, 50, 50, -80, 0); // starts at ~(8.7, 1.5), not at the corner
  const res = F.chamferEntities(op(a, { x: 60, y: 0 }), op(b, { x: 40, y: 20 }), 15, 15, { trim: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /do not meet at a corner/i);
});

t("chamfer line-line measures d1/d2 from the corner and joins them with a bar", () => {
  const a = line(0, 0, 100, 0);
  const b = line(0, 0, 0, 100);
  const res = unwrap(F.chamferEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 15, 20, { trim: true }));
  assert.equal(res.addedKind, "LINE");
  const [l1, l2, bar] = res.after;
  closePt(l1.end, { x: 15, y: 0 });
  closePt(l2.end, { x: 0, y: 20 });
  closePt(bar.start, { x: 15, y: 0 });
  closePt(bar.end, { x: 0, y: 20 });
});

t("chamfer line-line matches the old line-only math", () => {
  const a = line(0, 0, 100, 0);
  const b = line(0, 0, 0, 100);
  const old = X.chamferTwoLines(a, b, 15, 20);
  assert.ok(old);
  const res = unwrap(F.chamferEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 15, 20, { trim: true }));
  const [l1, l2, bar] = res.after;
  closePt(l1.end, old.lines[0].end);
  closePt(l2.end, old.lines[1].end);
  closePt(bar.start, old.bar.start);
  closePt(bar.end, old.bar.end);
});

t("chamfer line-arc walks the distances along the arc sweep", () => {
  const a = line(0, 0, 100, 0);
  const b = arc(0, 50, 50, -90, 0);
  const res = unwrap(F.chamferEntities(op(a, { x: 60, y: 0 }), op(b, { x: 40, y: 20 }), 15, 15, { trim: true }));
  const [l1, trimmedArc, bar] = res.after;
  closePt(l1.end, { x: 15, y: 0 });
  // 15 units along the 50-radius arc from -90° is -90° + (15/50) rad.
  close(trimmedArc.startAngle, -90 + (15 / 50) * (180 / Math.PI));
  close(trimmedArc.endAngle, 0);
  closePt(bar.start, { x: 15, y: 0 });
  const cutArc = {
    x: 0 + 50 * Math.cos((trimmedArc.startAngle * Math.PI) / 180),
    y: 50 + 50 * Math.sin((trimmedArc.startAngle * Math.PI) / 180),
  };
  closePt(bar.end, cutArc);
});

t("chamfer on two adjacent segments of one polyline splits it with a bar", () => {
  const p = poly([
    [0, 100],
    [0, 0],
    [100, 0],
  ]);
  const res = unwrap(F.chamferEntities(op(p, { x: 0, y: 60 }, 0), op(p, { x: 60, y: 0 }, 1), 15, 15, { trim: true }));
  assert.equal(res.after.length, 3);
  assert.deepEqual(res.after[0].points, [
    { x: 0, y: 100 },
    { x: 0, y: 15 },
  ]);
  assert.deepEqual(res.after[1].points, [
    { x: 15, y: 0 },
    { x: 100, y: 0 },
  ]);
  closePt(res.after[2].start, { x: 0, y: 15 });
  closePt(res.after[2].end, { x: 15, y: 0 });
});

/* ── trim / no-trim and radius 0 ── */

t("no-trim fillet keeps both originals full-length and only adds the arc", () => {
  const a = line(0, 0, 100, 0);
  const b = line(0, 0, 0, 100);
  const res = unwrap(F.filletEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 10, { trim: false }));
  assert.equal(res.after.length, 3);
  assert.deepEqual(res.after[0], a);
  assert.deepEqual(res.after[1], b);
  assert.equal(res.after[2].type, "ARC");
  closePt(res.after[2].center, { x: 10, y: 10 });
});

t("no-trim chamfer keeps both originals full-length and only adds the bar", () => {
  const a = line(0, 0, 100, 0);
  const b = line(0, 0, 0, 100);
  const res = unwrap(F.chamferEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 15, 20, { trim: false }));
  assert.equal(res.after.length, 3);
  assert.deepEqual(res.after[0], a);
  assert.deepEqual(res.after[1], b);
  assert.equal(res.after[2].type, "LINE");
  closePt(res.after[2].start, { x: 15, y: 0 });
  closePt(res.after[2].end, { x: 0, y: 20 });
});

t("radius 0 trims both lines square to the corner and adds no arc", () => {
  const a = line(0, 0, 100, 0);
  const b = line(0, 0, 0, 100);
  const res = unwrap(F.filletEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 0, { trim: true }));
  assert.equal(res.addedKind, null);
  assert.equal(res.after.length, 2);
  closePt(res.after[0].end, { x: 0, y: 0 });
  closePt(res.after[1].end, { x: 0, y: 0 });
});

t("no-trim radius 0 is a no-op that still succeeds", () => {
  const a = line(0, 0, 100, 0);
  const b = line(0, 0, 0, 100);
  const res = unwrap(F.filletEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 0, { trim: false }));
  assert.equal(res.addedKind, null);
  assert.deepEqual(res.after, [a, b]);
});

/* ── graceful rejections ── */

t("parallel lines are rejected with a clear reason", () => {
  const res = F.filletEntities(op(line(0, 0, 100, 0), { x: 50, y: 0 }), op(line(0, 10, 100, 10), { x: 50, y: 10 }), 10, { trim: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /parallel|no tangent/i);
});

t("a radius too large for the objects is rejected, not silently clipped", () => {
  const res = F.filletEntities(op(line(0, 0, 5, 0), { x: 3, y: 0 }), op(line(0, 0, 0, 5), { x: 0, y: 3 }), 10, { trim: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /too large/i);
  const resArc = F.filletEntities(op(line(0, 0, 100, 0), { x: 60, y: 0 }), op(arc(0, 50, 50, -90, 0), { x: 40, y: 20 }), 60, { trim: true });
  assert.equal(resArc.ok, false);
});

t("circles are rejected with a message that says what to do instead", () => {
  const res = F.filletEntities(op(line(0, 0, 100, 0), { x: 60, y: 0 }), op(circle(0, 50, 50), { x: 0, y: 90 }), 10, { trim: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /circles are not supported/i);
  assert.match(res.reason, /ARC/i);
  const resC = F.chamferEntities(op(line(0, 0, 100, 0), { x: 60, y: 0 }), op(circle(0, 50, 50), { x: 0, y: 90 }), 5, 5, { trim: true });
  assert.equal(resC.ok, false);
});

t("unsupported entity types are rejected by name", () => {
  const text = { type: "TEXT", layer: "0", position: { x: 0, y: 0 }, height: 10, value: "hi" };
  const res = F.filletEntities(op(line(0, 0, 100, 0), { x: 60, y: 0 }), op(text, { x: 0, y: 0 }), 10, { trim: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /TEXT/);
});

t("picking the same line twice is rejected", () => {
  const a = line(0, 0, 100, 0);
  const res = F.filletEntities(op(a, { x: 20, y: 0 }), op(a, { x: 80, y: 0 }), 10, { trim: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /two different/i);
});

t("picking the same polyline segment twice is rejected", () => {
  const p = poly([
    [0, 0],
    [100, 0],
  ]);
  const res = F.filletEntities(op(p, { x: 20, y: 0 }, 0), op(p, { x: 80, y: 0 }, 0), 10, { trim: true });
  assert.equal(res.ok, false);
});

t("a closed polyline's shared vertex is rejected instead of splitting wrongly", () => {
  const p = poly(
    [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
    true,
  );
  const res = F.filletEntities(op(p, { x: 60, y: 0 }, 0), op(p, { x: 100, y: 60 }, 1), 10, { trim: true });
  assert.equal(res.ok, false);
});

t("chamfer distances too large are rejected", () => {
  const res = F.chamferEntities(op(line(0, 0, 5, 0), { x: 3, y: 0 }), op(line(0, 0, 0, 100), { x: 0, y: 60 }), 10, 10, { trim: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /too large/i);
});

t("chamfer of objects that do not meet is rejected", () => {
  const res = F.chamferEntities(op(line(0, 0, 100, 0), { x: 60, y: 0 }), op(line(0, 50, 100, 50), { x: 60, y: 50 }), 5, 5, { trim: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /do not meet/i);
});

t("invalid radii and distances are rejected", () => {
  const a = op(line(0, 0, 100, 0), { x: 60, y: 0 });
  const b = op(line(0, 0, 0, 100), { x: 0, y: 60 });
  assert.equal(F.filletEntities(a, b, -5, { trim: true }).ok, false);
  assert.equal(F.filletEntities(a, b, NaN, { trim: true }).ok, false);
  assert.equal(F.chamferEntities(a, b, 0, 5, { trim: true }).ok, false);
  assert.equal(F.chamferEntities(a, b, 5, -1, { trim: true }).ok, false);
});

t("inputs are never mutated", () => {
  const a = line(0, 0, 100, 0);
  const b = arc(0, 50, 50, -90, 0);
  const p = poly([
    [0, 0],
    [100, 0],
  ]);
  const before = JSON.stringify([a, b, p]);
  unwrap(F.filletEntities(op(a, { x: 60, y: 0 }), op(b, { x: 40, y: 20 }), 10, { trim: true }));
  unwrap(F.filletEntities(op(p, { x: 60, y: 0 }, 0), op(line(0, 0, 0, 100), { x: 0, y: 60 }), 10, { trim: true }));
  unwrap(F.chamferEntities(op(a, { x: 60, y: 0 }), op(b, { x: 40, y: 20 }), 15, 15, { trim: true }));
  assert.equal(JSON.stringify([a, b, p]), before);
});

t("the fillet arc inherits the first object's layer", () => {
  const a = line(0, 0, 100, 0, "Walls");
  const b = line(0, 0, 0, 100, "Doors");
  const res = unwrap(F.filletEntities(op(a, { x: 60, y: 0 }), op(b, { x: 0, y: 60 }), 10, { trim: true }));
  assert.equal(res.after[2].layer, "Walls");
});

/* ── in-tool option parsing (the prompting state machine) ── */

t("parseFilletChamferOption: fillet radius keywords", () => {
  assert.deepEqual(F.parseFilletChamferOption("R", "fillet"), { action: "promptRadius" });
  assert.deepEqual(F.parseFilletChamferOption("radius", "fillet"), { action: "promptRadius" });
  assert.deepEqual(F.parseFilletChamferOption("R 25", "fillet"), { action: "setRadius", value: 25 });
  assert.deepEqual(F.parseFilletChamferOption("r 0", "fillet"), { action: "setRadius", value: 0 });
  assert.deepEqual(F.parseFilletChamferOption("R -5", "fillet"), { action: "invalid", message: "FILLET: radius must be ≥ 0." });
  assert.deepEqual(F.parseFilletChamferOption("R abc", "fillet"), { action: "invalid", message: "FILLET: radius must be ≥ 0." });
});

t("parseFilletChamferOption: chamfer distance keywords", () => {
  assert.deepEqual(F.parseFilletChamferOption("D", "chamfer"), { action: "promptDistances" });
  assert.deepEqual(F.parseFilletChamferOption("DISTANCE", "chamfer"), { action: "promptDistances" });
  assert.deepEqual(F.parseFilletChamferOption("D 10", "chamfer"), { action: "setDistance1", value: 10 });
  assert.deepEqual(F.parseFilletChamferOption("D 10 20", "chamfer"), { action: "setDistances", d1: 10, d2: 20 });
  assert.deepEqual(F.parseFilletChamferOption("D 0 5", "chamfer"), { action: "invalid", message: "CHAMFER: distances must be greater than zero." });
  assert.deepEqual(F.parseFilletChamferOption("D 5 x", "chamfer"), { action: "invalid", message: "CHAMFER: distances must be greater than zero." });
});

t("parseFilletChamferOption: trim keywords work for both tools", () => {
  for (const kind of ["fillet", "chamfer"]) {
    assert.deepEqual(F.parseFilletChamferOption("T", kind), { action: "toggleTrim" });
    assert.deepEqual(F.parseFilletChamferOption("trim", kind), { action: "setTrim", value: true });
    assert.deepEqual(F.parseFilletChamferOption("NOTRIM", kind), { action: "setTrim", value: false });
  }
});

t("parseFilletChamferOption: anything else passes through to normal command dispatch", () => {
  assert.deepEqual(F.parseFilletChamferOption("ZOOM E", "fillet"), { action: "none" });
  assert.deepEqual(F.parseFilletChamferOption("", "fillet"), { action: "none" });
  assert.deepEqual(F.parseFilletChamferOption("D 5", "fillet"), { action: "none" });
  assert.deepEqual(F.parseFilletChamferOption("R 5", "chamfer"), { action: "none" });
});

/* ── shared source of truth: the radius / distance store ── */

t("getFilletRadiusStore honours its default when nothing was ever stored", () => {
  // In node there is no localStorage, so the store must fall back to the
  // caller's default instead of reporting 0 — the value the viewer used to
  // mistake for "the user set radius 0". In the browser the same path runs
  // when the key is absent (see the marker test below).
  assert.equal(S.getFilletRadiusStore(-1), -1);
  assert.equal(S.getFilletRadiusStore(10), 10);
  assert.doesNotThrow(() => S.setFilletRadiusStore(25));
  assert.doesNotThrow(() => S.setChamferDistStore(10, 20));
});

/* ── source markers: the viewer actually wires the new behaviour in ── */

t("cad-viewer wires the fillet/chamfer module into the live pick path", () => {
  for (const marker of [
    "fillet-chamfer", // the import
    "FC.filletEntities",
    "FC.chamferEntities",
    "FC.parseFilletChamferOption",
    "FC.nearestPolylineSegment",
    "trimMode", // TRIMMODE state
    "TRIMMODE",
    "applyFilletRadius", // shared setter: local + store
    "applyChamferDistances",
    "Select first object or [Radius/Trim]",
    "Select first object or [Distance/Trim]",
    "No trim",
  ]) {
    assert.ok(viewer.includes(marker), `cad-viewer.ts is missing wiring marker: ${marker}`);
  }
});

t("the old LINE-only rejection is gone from cad-viewer", () => {
  assert.ok(!viewer.includes("FILLET / CHAMFER supports two LINE entities."), "the LINE-only guard is still in cad-viewer.ts");
  assert.ok(!viewer.includes("X.filletTwoLines(a, b, filletR)"), "commitFilletChamfer still calls the line-only math");
  assert.ok(!viewer.includes("X.chamferTwoLines(a, b, chamferD[0], chamferD[1])"), "commitFilletChamfer still calls the line-only math");
});

t("the radius store returns the caller's default when the key is absent (browser path)", () => {
  assert.ok(
    gaps.includes('localStorage.getItem("obs.cad.filletR") === null') ||
      gaps.includes("getItem(\"obs.cad.filletR\") === null"),
    "getFilletRadiusStore still returns 0 for a missing key, so the viewer cannot tell 'unset' from 'radius 0'",
  );
});

console.log(`\nfillet-chamfer: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
