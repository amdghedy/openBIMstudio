// Rectangle variants (AutoCAD RECTANG parity, 2D-8) — node test.
//
// Proves, in Node (no browser):
//  1. Plain rectangle: 4 vertices, closed, no bulges/width — the
//     pre-2D-8 path is unchanged.
//  2. Fillet: 8 vertices with a tan(22.5°) bulge on each arc segment;
//     the arc-aware area is w*h − (4−π)r², the bbox is unchanged, and
//     an oversized radius clamps to half the shorter side.
//  3. Chamfer: 8 vertices, straight cuts, area w*h − 2*d1*d2, and each
//     distance clamps to half its side.
//  4. Width: the constant width (DXF 43) survives write + read.
//  5. Elevation/thickness: DXF groups 38/39 are written and read back,
//     the vertices carry the elevation Z (the reader's convention),
//     and the PE-20 schema gate accepts the fields.
//  6. Area mode: area + length (or width) derives the other dimension,
//     and the second pick fixes only the direction.
//  7. The option parser: every keyword, inline values, and bad input.
//  8. The viewer wiring: the RECTANG command offers the options at the
//     first-corner prompt and builds through cad-rect (source markers —
//     the viewer is DOM-heavy and cannot be compiled headlessly, the
//     A7 pattern).
//  9. A filleted rectangle round-trips through DXF as arcs (bulges),
//     not tessellated chords.
//
// No mocks: the geometry, writer, reader and schema gate under test
// are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cad-rect-2d8-"));
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad */ }
execSync(
  `npx tsc src/modules/cad-viewer/cad-rect.ts src/modules/drawings/dxf-geometry.ts src/modules/drawings/dxf-reader.ts ` +
  `src/modules/drawings/dxf-writer.ts src/modules/cad-viewer/cad-polyline.ts src/modules/cad-viewer/cad-annotation.ts ` +
  `src/modules/cad-viewer/viewer-math.ts src/modules/cad-viewer/modify-math.ts src/modules/drawings/cad-table.ts ` +
  `src/core/safeLoad.ts src/modules/drawings/acad-engine.ts ` +
  `--outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const R = require(find(out, "cad-rect.js"));
const G = require(find(out, "dxf-geometry.js"));
const { parseDxf } = require(find(out, "dxf-reader.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));
const { validateDxfDocument } = require(find(out, "safeLoad.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, a + " != " + b);
const nearPt = (a, b, e = 1e-6) => { near(a.x, b.x, e); near(a.y, b.y, e); };
const BULGE90 = Math.tan(Math.PI / 8); // tan(22.5°) — a 90° arc
const docWith = (e) => ({ layers: [{ name: "0", color: 7 }], entities: [e] });
const roundTrip = (e) => {
  const back = parseDxf(writeDxf(docWith(e)));
  assert.strictEqual(back.skipped, undefined, "nothing skipped: " + JSON.stringify(back.skipped));
  const pls = back.entities.filter((x) => x.type === "LWPOLYLINE");
  assert.strictEqual(pls.length, 1, "exactly one LWPOLYLINE back, got " + back.entities.map((x) => x.type).join(","));
  return pls[0];
};
const asEntity = (b) => ({
  type: "LWPOLYLINE", layer: "0", points: b.points, closed: true,
  ...(b.bulges ? { bulges: b.bulges } : {}),
  ...(b.width ? { width: b.width } : {}),
  ...(b.elevation ? { elevation: b.elevation } : {}),
  ...(b.thickness ? { thickness: b.thickness } : {}),
});
const areaOf = (b) => G.polylineArea(b.points, b.bulges, true);
const bboxOf = (b) => G.polylineBBox(b.points, b.bulges, true);
const corners = (x0, y0, x1, y1) => R.axisCorners({ x: x0, y: y0 }, { x: x1, y: y1 });

t("plain rectangle: 4 vertices, no bulges, no width — the old path", () => {
  const b = R.buildRect(corners(0, 0, 40, 25), {});
  assert.strictEqual(b.points.length, 4);
  assert.strictEqual(b.bulges, undefined);
  assert.strictEqual(b.width, undefined);
  nearPt(b.points[0], { x: 0, y: 0 });
  nearPt(b.points[1], { x: 40, y: 0 });
  nearPt(b.points[2], { x: 40, y: 25 });
  nearPt(b.points[3], { x: 0, y: 25 });
  near(areaOf(b), 1000);
});

t("fillet r=5 on 40×25: 8 vertices, tan(22.5°) bulges, area w*h − (4−π)r²", () => {
  const b = R.buildRect(corners(0, 0, 40, 25), { fillet: 5 });
  assert.strictEqual(b.points.length, 8);
  assert.strictEqual(b.appliedFillet, 5);
  assert.strictEqual(b.bulges.length, 8);
  for (let i = 0; i < 8; i++) near(b.bulges[i], i % 2 === 0 ? BULGE90 : 0);
  nearPt(b.points[0], { x: 0, y: 5 });
  nearPt(b.points[1], { x: 5, y: 0 });
  nearPt(b.points[2], { x: 35, y: 0 });
  nearPt(b.points[3], { x: 40, y: 5 });
  nearPt(b.points[4], { x: 40, y: 20 });
  nearPt(b.points[5], { x: 35, y: 25 });
  nearPt(b.points[6], { x: 5, y: 25 });
  nearPt(b.points[7], { x: 0, y: 20 });
  near(areaOf(b), 40 * 25 - (4 - Math.PI) * 25, 1e-6);
  const bb = bboxOf(b);
  near(bb.minX, 0); near(bb.maxX, 40); near(bb.minY, 0); near(bb.maxY, 25);
  // The second arc really is a radius-5 arc centred on the corner's inset.
  const arc = G.bulgeArc(b.points[2], b.points[3], b.bulges[2]);
  assert.ok(arc, "bulge segment must resolve to an arc");
  near(arc.radius, 5);
  nearPt(arc.center, { x: 35, y: 5 });
});

t("fillet clamps to half the shorter side (r=20 on 40×25 → 12.5)", () => {
  const b = R.buildRect(corners(0, 0, 40, 25), { fillet: 20 });
  assert.strictEqual(b.appliedFillet, 12.5);
  assert.strictEqual(b.points.length, 8);
  nearPt(b.points[0], { x: 0, y: 12.5 });
  nearPt(b.points[1], { x: 12.5, y: 0 });
  near(areaOf(b), 40 * 25 - (4 - Math.PI) * 12.5 * 12.5, 1e-6);
});

t("chamfer 6×4 on 40×25: 8 vertices, straight cuts, area w*h − 2*d1*d2", () => {
  const b = R.buildRect(corners(0, 0, 40, 25), { chamfer: { d1: 6, d2: 4 } });
  assert.strictEqual(b.points.length, 8);
  assert.strictEqual(b.bulges, undefined);
  assert.deepStrictEqual(b.appliedChamfer, { d1: 6, d2: 4 });
  nearPt(b.points[0], { x: 0, y: 4 });
  nearPt(b.points[1], { x: 6, y: 0 });
  nearPt(b.points[2], { x: 34, y: 0 });
  nearPt(b.points[3], { x: 40, y: 4 });
  nearPt(b.points[4], { x: 40, y: 21 });
  nearPt(b.points[5], { x: 34, y: 25 });
  nearPt(b.points[6], { x: 6, y: 25 });
  nearPt(b.points[7], { x: 0, y: 21 });
  near(areaOf(b), 1000 - 2 * 6 * 4, 1e-6);
});

t("chamfer clamps each distance to half its side (d1=30 on 40-wide → 20)", () => {
  const b = R.buildRect(corners(0, 0, 40, 25), { chamfer: { d1: 30, d2: 4 } });
  assert.deepStrictEqual(b.appliedChamfer, { d1: 20, d2: 4 });
  nearPt(b.points[0], { x: 0, y: 4 });
  nearPt(b.points[1], { x: 20, y: 0 }); // both cuts meet mid-edge — degenerate but exact
});

t("width: constant width rides the entity and survives DXF round-trip", () => {
  const b = R.buildRect(corners(0, 0, 40, 25), { width: 2 });
  assert.strictEqual(b.width, 2);
  const back = roundTrip(asEntity(b));
  assert.strictEqual(back.width, 2);
  assert.ok(writeDxf(docWith(asEntity(b))).includes("\n43\n"), "writer must emit group 43");
});

t("elevation/thickness: groups 38/39 written and read back, vertices carry Z", () => {
  const b = R.buildRect(corners(0, 0, 40, 25), { elevation: 5, thickness: 3 });
  assert.strictEqual(b.elevation, 5);
  assert.strictEqual(b.thickness, 3);
  assert.ok(b.points.every((p) => p.z === 5), "every vertex carries the elevation Z");
  const dxf = writeDxf(docWith(asEntity(b)));
  assert.ok(dxf.includes("\n38\n"), "writer must emit group 38");
  assert.ok(dxf.includes("\n39\n"), "writer must emit group 39");
  const back = roundTrip(asEntity(b));
  assert.strictEqual(back.elevation, 5);
  assert.strictEqual(back.thickness, 3);
  assert.ok(back.points.every((p) => p.z === 5), "read-back vertices carry Z 5");
  assert.deepStrictEqual(validateDxfDocument(docWith(asEntity(b))), { ok: true });
});

t("filleted rectangle round-trips through DXF as arcs, not chords", () => {
  const b = R.buildRect(corners(0, 0, 40, 25), { fillet: 5 });
  const back = roundTrip(asEntity(b));
  assert.strictEqual(back.points.length, 8, "still 8 vertices, not tessellated");
  assert.strictEqual(back.bulges.length, 8);
  for (let i = 0; i < 8; i++) near(back.bulges[i], i % 2 === 0 ? BULGE90 : 0);
  near(G.polylineArea(back.points, back.bulges, true), 40 * 25 - (4 - Math.PI) * 25, 1e-6);
});

t("area mode: area 1000 + length 50 → width 20, axis-aligned", () => {
  const r = R.buildRectArea({ x: 0, y: 0 }, { x: 100, y: 0 }, 1000, { kind: "length", value: 50 }, {});
  assert.strictEqual(r.length, 50);
  assert.strictEqual(r.width, 20);
  nearPt(r.corners[1], { x: 50, y: 0 });
  nearPt(r.corners[2], { x: 50, y: 20 });
  nearPt(r.corners[3], { x: 0, y: 20 });
  near(areaOf(r.build), 1000);
});

t("area mode: width form + rotated direction — second pick fixes direction only", () => {
  const r = R.buildRectArea({ x: 0, y: 0 }, { x: 30, y: 40 }, 1000, { kind: "width", value: 20 }, {});
  assert.strictEqual(r.width, 20);
  assert.strictEqual(r.length, 50);
  // Direction (30,40)/50 = (0.6,0.8); the 100-unit pick distance is ignored.
  nearPt(r.corners[1], { x: 30, y: 40 });
  nearPt(r.corners[2], { x: 14, y: 52 });
  nearPt(r.corners[3], { x: -16, y: 12 });
  near(areaOf(r.build), 1000);
  assert.throws(() => R.buildRectArea({ x: 0, y: 0 }, { x: 1, y: 0 }, 0, { kind: "length", value: 50 }, {}), /greater than zero/);
  assert.throws(() => R.buildRectArea({ x: 0, y: 0 }, { x: 1, y: 0 }, 1000, { kind: "length", value: -5 }, {}), /greater than zero/);
});

t("area mode: fillet/chamfer/width still apply on top of the derived size", () => {
  const r = R.buildRectArea({ x: 0, y: 0 }, { x: 1, y: 0 }, 1000, { kind: "length", value: 50 }, { fillet: 5, width: 2 });
  assert.strictEqual(r.build.points.length, 8);
  assert.strictEqual(r.build.width, 2);
  near(areaOf(r.build), 1000 - (4 - Math.PI) * 25, 1e-6);
});

t("option parser: keywords, inline values, bad input", () => {
  const eq = (raw, want) => assert.deepStrictEqual(R.parseRectOption(raw), want, raw);
  eq("F", { action: "promptFillet" });
  eq("FILLET 5", { action: "setFillet", value: 5 });
  eq("F 0", { action: "setFillet", value: 0 });
  eq("F -1", { action: "invalid", message: "RECT: fillet radius must be zero or greater." });
  eq("C", { action: "promptChamfer" });
  eq("C 6", { action: "setChamfer1", value: 6 });
  eq("CHAMFER 6 4", { action: "setChamfer", d1: 6, d2: 4 });
  eq("C 0 4", { action: "invalid", message: "RECT: chamfer distances must be greater than zero." });
  eq("E 5", { action: "setElevation", value: 5 });
  eq("ELEVATION", { action: "promptElevation" });
  eq("E -2.5", { action: "setElevation", value: -2.5 });
  eq("T 3", { action: "setThickness", value: 3 });
  eq("THICKNESS", { action: "promptThickness" });
  eq("W 2", { action: "setWidth", value: 2 });
  eq("WIDTH", { action: "promptWidth" });
  eq("A", { action: "promptArea" });
  eq("A 1000", { action: "setArea", value: 1000 });
  eq("A 0", { action: "invalid", message: "RECT: area must be greater than zero." });
  eq("X", { action: "none" });
  eq("", { action: "none" });
});

t("viewer wiring: RECT offers the variants and builds through cad-rect", () => {
  const src = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  for (const marker of [
    "Specify first corner point or [Chamfer/Elevation/Fillet/Thickness/Width/Area]:",
    "handleRectOption",
    "onRectFilletTyped",
    "onRectChamferD1Typed",
    "onRectAreaLengthTyped",
    "onRectAreaWidthTyped",
    "Rect.buildRect(Rect.axisCorners(p1, p2), opts)",
    "Rect.buildRectArea(p1, p2, area.area, fixed, opts)",
    "Rectangle added:",
  ]) assert.ok(src.includes(marker), "viewer missing marker: " + marker);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
