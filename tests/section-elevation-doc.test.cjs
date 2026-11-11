/**
 * Section & elevation documentation unit tests — pure math from
 * src/modules/drawings/section-elevation-doc.ts (+ plan-poche.ts styles).
 * Compile the modules with tsc and require them (house test pattern).
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "secdoc-"));
execSync(
  `npx tsc src/modules/drawings/section-elevation-doc.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const m = require(path.join(out, "drawings", "section-elevation-doc.js"));
const poche = require(path.join(out, "drawings", "plan-poche.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < (eps ?? 1e-9), `${a} != ${b}`);
const CUT = { color: "#111827", widthPt: 0.5, dash: null };

// ── hostedOpeningsForWall ────────────────────────────────────────────────
t("door defaults: 0.9×2.1, sill 0, centred", () => {
  const ops = m.hostedOpeningsForWall([{ type: "door", params: {} }], 6, 3);
  assert.strictEqual(ops.length, 1);
  near(ops[0].u0, 3 - 0.45); near(ops[0].u1, 3 + 0.45);
  near(ops[0].y0, 0); near(ops[0].y1, 2.1);
  assert.strictEqual(ops[0].kind, "door");
});
t("window defaults: 1.2×1.4 at sill 0.9", () => {
  const ops = m.hostedOpeningsForWall([{ type: "window", params: {} }], 6, 3);
  near(ops[0].y0, 0.9); near(ops[0].y1, 2.3);
});
t("offset and clamping against the wall ends", () => {
  const ops = m.hostedOpeningsForWall(
    [{ type: "door", params: { offsetAlongHost: 0.2, width: 0.9 } }], 1.0, 3);
  near(ops[0].u0, 0); near(ops[0].u1, 0.65);
});
t("degenerate holes dropped (<2 cm)", () => {
  const ops = m.hostedOpeningsForWall(
    [{ type: "door", params: { offsetAlongHost: 6.44, width: 0.9 } }], 6, 3);
  assert.strictEqual(ops.length, 0);
});
t("near-full-face holes dropped (≥90% both dims)", () => {
  const ops = m.hostedOpeningsForWall(
    [{ type: "door", params: { width: 5.8, height: 2.95 } }], 6, 3);
  assert.strictEqual(ops.length, 0);
});
t("non-opening hosts ignored", () => {
  const ops = m.hostedOpeningsForWall([{ type: "chair", params: {} }], 6, 3);
  assert.strictEqual(ops.length, 0);
});
t("zero-length wall → no openings", () => {
  assert.deepStrictEqual(m.hostedOpeningsForWall([{ type: "door", params: {} }], 0, 3), []);
});

// ── openingAt ────────────────────────────────────────────────────────────
const OPS = [
  { u0: 1, u1: 1.9, y0: 0, y1: 2.1, kind: "door" },
  { u0: 3, u1: 4.2, y0: 0.9, y1: 2.3, kind: "window" },
];
t("openingAt: hit, tolerance edges, miss", () => {
  assert.strictEqual(m.openingAt(OPS, 1.5).kind, "door");
  assert.strictEqual(m.openingAt(OPS, 0.99, 0.02).kind, "door");   // inside tol
  assert.strictEqual(m.openingAt(OPS, 0.97), null);                // outside tol
  assert.strictEqual(m.openingAt(OPS, 3.6).kind, "window");
  assert.strictEqual(m.openingAt(OPS, 2.5), null);
});

// ── solidYSlices ─────────────────────────────────────────────────────────
t("no opening → full 0..H slice", () => {
  assert.deepStrictEqual(m.solidYSlices(null, 3), [[0, 3]]);
});
t("door → lintel slice only; full-height door → none", () => {
  assert.deepStrictEqual(m.solidYSlices(OPS[0], 3), [[2.1, 3]]);
  const full = { u0: 1, u1: 1.9, y0: 0, y1: 3, kind: "door" };
  assert.deepStrictEqual(m.solidYSlices(full, 3), []);
});
t("window → sill + head slices, slivers dropped", () => {
  assert.deepStrictEqual(m.solidYSlices(OPS[1], 3), [[0, 0.9], [2.3, 3]]);
  const tall = { u0: 3, u1: 4.2, y0: 0.9, y1: 2.985, kind: "window" };
  assert.deepStrictEqual(m.solidYSlices(tall, 3), [[0, 0.9]]); // 15 mm head is a sliver
});

// ── cutWallPieces ────────────────────────────────────────────────────────
const BRICK = { pattern: "brick", color: poche.PATTERN_TINT ? poche.PATTERN_TINT.brick : "#e7ded6" };
const SOLID = { pattern: null, color: "#c9cfd6" };

t("solid wall cut: outline + brick hatch, no fill on outline", () => {
  const es = m.cutWallPieces({
    x: 5, halfT: 0.1275, y0: 0, y1: 3, op: null,
    style: BRICK, hatchScale: 100, cutStyle: CUT,
  });
  assert.strictEqual(es.length, 2);
  const [rect, hatch] = es;
  assert.strictEqual(rect.kind, "polyline");
  assert.strictEqual(rect.fill, undefined);
  near(rect.points[1][1], 0);
  near(rect.points[2][1], 3);
  assert.strictEqual(hatch.kind, "hatch");
  assert.strictEqual(hatch.pattern, "brick");
  assert.strictEqual(hatch.scale, 100);
  assert.strictEqual(hatch.color, "#374151");
});
t("generic wall cut: single opaque solid-poche rect", () => {
  const es = m.cutWallPieces({
    x: 5, halfT: 0.1275, y0: 0, y1: 3, op: null,
    style: SOLID, hatchScale: 100, cutStyle: CUT,
  });
  assert.strictEqual(es.length, 1);
  assert.strictEqual(es[0].kind, "polyline");
  assert.strictEqual(es[0].fill.color, "#c9cfd6");
  assert.strictEqual(es[0].fill.opacity, 1);
});
t("cut through a door: lintel above, open passage, reveal lines", () => {
  const op = OPS[0];
  const es = m.cutWallPieces({
    x: 5, halfT: 0.1275, y0: 0, y1: 3, op,
    style: BRICK, hatchScale: 100, cutStyle: CUT,
  });
  const rects = es.filter((e) => e.kind === "polyline");
  assert.strictEqual(rects.length, 1);           // lintel only
  near(rects[0].points[0][1], 2.1); near(rects[0].points[2][1], 3);
  const lines = es.filter((e) => e.kind === "line");
  assert.strictEqual(lines.length, 2);           // two jambs, no glass
  const xs = lines.map((l) => l.x1).sort((a, b) => a - b);
  near(xs[0], 5 - 0.1275); near(xs[1], 5 + 0.1275);
  for (const l of lines) { near(l.z1, 0); near(l.z2, 2.1); }
});
t("cut through a window: sill + head slices, jamb lines, glass line", () => {
  const op = OPS[1];
  const es = m.cutWallPieces({
    x: 5, halfT: 0.1275, y0: 0, y1: 3, op,
    style: BRICK, hatchScale: 100, cutStyle: CUT,
  });
  const rects = es.filter((e) => e.kind === "polyline");
  assert.strictEqual(rects.length, 2);           // sill + head
  const ySets = rects.map((r) => [r.points[0][1], r.points[2][1]].sort((a, b) => a - b).join(","));
  assert.ok(ySets.includes("0,0.9"), "sill slice missing");
  assert.ok(ySets.includes("2.3,3"), "head slice missing");
  const lines = es.filter((e) => e.kind === "line");
  assert.strictEqual(lines.length, 3);           // two jambs + glazing
  const glass = lines.find((l) => l.stroke === m.GLASS_STROKE);
  assert.ok(glass, "glazing line missing");
  near(glass.z1, 0.9); near(glass.z2, 2.3);
});

// ── projectedTopEdge ─────────────────────────────────────────────────────
t("projected top edge emitted when nothing covers it", () => {
  const es = m.projectedTopEdge(2, 6, 4, [], { color: "#6b7280", widthPt: 0.2, dash: null });
  assert.strictEqual(es.length, 1);
  assert.strictEqual(es[0].kind, "line");
  near(es[0].z1, 4);
});
t("suppressed inside same-height cut cover, pokes out on both sides", () => {
  const cutTops = [{ x0: 0, x1: 5, top: 3 }];
  const es = m.projectedTopEdge(2, 6, 3, cutTops, CUT);
  assert.strictEqual(es.length, 1);            // 5..6 only
  near(es[0].x1, 5); near(es[0].x2, 6);
  const es2 = m.projectedTopEdge(-2, 6, 3, cutTops, CUT);
  assert.strictEqual(es2.length, 2);           // -2..0 and 5..6
  near(es2[0].x1, -2); near(es2[0].x2, 0);
  near(es2[1].x1, 5); near(es2[1].x2, 6);
});
t("fully covered edge emits nothing", () => {
  const cutTops = [{ x0: 0, x1: 10, top: 3 }];
  assert.deepStrictEqual(m.projectedTopEdge(2, 6, 3, cutTops, CUT), []);
  const taller = [{ x0: 0, x1: 10, top: 4 }];
  assert.deepStrictEqual(m.projectedTopEdge(2, 6, 3, taller, CUT), []);
});
t("lower cut geometry does not suppress the edge above it", () => {
  const cutTops = [{ x0: 0, x1: 5, top: 2 }];
  const es = m.projectedTopEdge(2, 6, 3, cutTops, CUT);
  assert.strictEqual(es.length, 1);
  near(es[0].x1, 2); near(es[0].x2, 6);
});
t("x-disjoint cut tops do not suppress", () => {
  const cutTops = [{ x0: 10, x1: 20, top: 3 }];
  assert.strictEqual(m.projectedTopEdge(2, 6, 3, cutTops, CUT).length, 1);
});

// ── projectedOpeningShapes ───────────────────────────────────────────────
t("projected door reads as one outline rect", () => {
  const es = m.projectedOpeningShapes([OPS[0]], 6, 0, 6, 0.5, CUT);
  assert.strictEqual(es.length, 1);
  assert.strictEqual(es[0].kind, "polyline");
  near(es[0].points[0][0], 1); near(es[0].points[2][0], 1.9);
  near(es[0].points[0][1], 0.5); near(es[0].points[2][1], 2.6);  // base 0.5 + 2.1
});
t("projected window adds a sill line", () => {
  const es = m.projectedOpeningShapes([OPS[1]], 6, 0, 6, 0, CUT);
  assert.strictEqual(es.length, 2);
  assert.ok(es.some((e) => e.kind === "line" && Math.abs(e.z1 - 0.9) < 1e-9));
});
t("reverse-direction wall maps openings through the same fractions", () => {
  const es = m.projectedOpeningShapes([{ u0: 0, u1: 1.5, y0: 0, y1: 2.1, kind: "door" }], 6, 6, 0, 0, CUT);
  const r = es.find((e) => e.kind === "polyline");
  const xs = [...new Set(r.points.map((p) => p[0]))].sort((a, b) => a - b);
  near(xs[0], 4.5); near(xs[1], 6);   // u=0 sits at wallX0=6, u=1.5 → 4.5
});
t("zero-length wall → nothing", () => {
  assert.deepStrictEqual(m.projectedOpeningShapes([OPS[0]], 0, 0, 6, 0, CUT), []);
});

// ── elevationOpeningShapes ───────────────────────────────────────────────
t("elevation door rect at the right position", () => {
  const es = m.elevationOpeningShapes({
    openings: [{ u0: 2.55, u1: 3.45, y0: 0, y1: 2.1, kind: "door" }],
    L: 6, wallX0: 0, wallX1: 6, wallY0: 0,
    outline: CUT, sillStroke: CUT,
  });
  assert.strictEqual(es.length, 1);
  near(es[0].points[0][0], 2.55); near(es[0].points[2][0], 3.45);
  near(es[0].points[2][1], 2.1);
});
t("elevation window: rect + sill line at sill height", () => {
  const es = m.elevationOpeningShapes({
    openings: [OPS[1]],
    L: 6, wallX0: 0, wallX1: 6, wallY0: 0.5,
    outline: CUT, sillStroke: CUT,
  });
  assert.strictEqual(es.length, 2);
  const rect = es.find((e) => e.kind === "polyline");
  near(rect.points[0][1], 1.4);   // 0.5 base + 0.9 sill
  near(rect.points[2][1], 2.8);   // 0.5 base + 2.3 head
});
t("sliver opening skipped in elevation", () => {
  const es = m.elevationOpeningShapes({
    openings: [{ u0: 3, u1: 3.005, y0: 0, y1: 2.1, kind: "door" }],
    L: 6, wallX0: 0, wallX1: 6, wallY0: 0,
    outline: CUT, sillStroke: CUT,
  });
  assert.strictEqual(es.length, 0);
});

// ── styleForNames passthrough ────────────────────────────────────────────
t("styleForNames: material signal, type fallback, solid fallback", () => {
  assert.strictEqual(m.styleForNames("wall", "Wall", "Brick Cavity", "").pattern, "brick");
  assert.strictEqual(m.styleForNames("column", "Column", "", "").pattern, "concrete");
  const generic = m.styleForNames("wall", "Wall", "", "");
  assert.strictEqual(generic.pattern, null);
  assert.strictEqual(generic.color, "#c9cfd6");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
