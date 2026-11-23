/**
 * Unit tests for CAD snap + dimension engines.
 * Run: node --experimental-strip-types tests/cad-snap-dimension.test.mjs
 */
import assert from "assert";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const snap = await import(pathToFileURL(path.join(root, "src/modules/cad-viewer/cad-snap-engine.ts")).href);
const dim = await import(pathToFileURL(path.join(root, "src/modules/cad-viewer/cad-dimension-engine.ts")).href);

let pass = 0, fail = 0;
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
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

console.log("\n── CAD Snap Engine ──");

t("endpoint / midpoint on line", () => {
  const ents = [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }];
  const s = snap.findCadSnap({ entities: ents, x: 0.1, y: 0.1, tol: 1, modes: ["endpoint", "midpoint"] });
  assert.ok(s);
  assert.strictEqual(s.kind, "endpoint");
  near(s.x, 0);
  near(s.y, 0);
  const m = snap.findCadSnap({ entities: ents, x: 5, y: 0.2, tol: 1, modes: ["midpoint"] });
  assert.strictEqual(m.kind, "midpoint");
  near(m.x, 5);
});

t("center and quadrant on circle", () => {
  const ents = [{ type: "CIRCLE", layer: "0", center: { x: 0, y: 0 }, radius: 5 }];
  const c = snap.findCadSnap({ entities: ents, x: 0.2, y: 0.1, tol: 1, modes: ["center"] });
  assert.strictEqual(c.kind, "center");
  const q = snap.findCadSnap({ entities: ents, x: 5, y: 0.2, tol: 1, modes: ["quadrant"] });
  assert.strictEqual(q.kind, "quadrant");
  near(q.x, 5);
  near(q.y, 0);
});

t("intersection of two lines", () => {
  const ents = [
    { type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 10, y: 10 } },
    { type: "LINE", layer: "0", start: { x: 0, y: 10 }, end: { x: 10, y: 0 } },
  ];
  const s = snap.findCadSnap({ entities: ents, x: 5, y: 5.1, tol: 1, modes: ["intersection"] });
  assert.ok(s);
  assert.strictEqual(s.kind, "intersection");
  near(s.x, 5);
  near(s.y, 5);
});

t("perpendicular from fromPt", () => {
  const ents = [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }];
  const s = snap.findCadSnap({
    entities: ents,
    x: 3,
    y: 0.2,
    tol: 1,
    modes: ["perpendicular"],
    fromPt: { x: 3, y: 4 },
  });
  assert.ok(s);
  assert.strictEqual(s.kind, "perpendicular");
  near(s.x, 3);
  near(s.y, 0);
});

t("extension past endpoint", () => {
  const ents = [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }];
  const s = snap.findCadSnap({
    entities: ents,
    x: 15,
    y: 0.1,
    tol: 1,
    modes: ["extension"],
  });
  assert.ok(s);
  assert.strictEqual(s.kind, "extension");
  near(s.y, 0);
  assert.ok(s.x > 10);
});

t("tangent from external point", () => {
  const ents = [{ type: "CIRCLE", layer: "0", center: { x: 0, y: 0 }, radius: 5 }];
  const s = snap.findCadSnap({
    entities: ents,
    x: 5,
    y: 5,
    tol: 3,
    modes: ["tangent"],
    fromPt: { x: 20, y: 0 },
  });
  assert.ok(s);
  assert.strictEqual(s.kind, "tangent");
  near(Math.hypot(s.x, s.y), 5, 1e-4);
});

t("parallel keeps direction", () => {
  const ents = [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }];
  const s = snap.findCadSnap({
    entities: ents,
    x: 4,
    y: 3,
    tol: 2,
    modes: ["parallel"],
    fromPt: { x: 0, y: 3 },
  });
  assert.ok(s);
  assert.strictEqual(s.kind, "parallel");
  near(s.y, 3);
});

t("ortho constraint", () => {
  const p = snap.applyOrtho({ x: 0, y: 0 }, { x: 5, y: 1 });
  near(p.y, 0);
  near(p.x, 5);
});

t("polar locks to 90°", () => {
  const settings = { ...snap.DEFAULT_CAD_SNAP_SETTINGS, polarOn: true, polarAngleDeg: 90, modes: new Set() };
  const p = snap.applyPolar({ x: 0, y: 0 }, { x: 0.1, y: 10 }, settings);
  near(p.x, 0, 0.2);
  assert.ok(p.y > 9);
});

t("grid snap", () => {
  const p = snap.applyGridSnap({ x: 12.4, y: 7.6 }, 5);
  near(p.x, 10);
  near(p.y, 10);
});

t("settings serialize round-trip", () => {
  const s0 = { ...snap.DEFAULT_CAD_SNAP_SETTINGS, modes: new Set(snap.DEFAULT_CAD_SNAP_MODES) };
  const json = snap.serializeSnapSettings(s0);
  const s1 = snap.parseSnapSettings(json);
  assert.strictEqual(s1.osnapOn, true);
  assert.ok(s1.modes.has("endpoint"));
});

t("toggle mode", () => {
  let s = { ...snap.DEFAULT_CAD_SNAP_SETTINGS, modes: new Set(snap.DEFAULT_CAD_SNAP_MODES) };
  s = snap.toggleSnapMode(s, "tangent");
  assert.ok(s.modes.has("tangent"));
  s = snap.toggleSnapMode(s, "tangent");
  assert.ok(!s.modes.has("tangent"));
});

console.log("\n── CAD Dimension Engine ──");

t("aligned dimension value", () => {
  const style = dim.DEFAULT_CAD_DIM_STYLE;
  const m = dim.buildLinearMarkup({ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 10 }, style, "aligned");
  near(m.value, 50);
  assert.ok(m.text.includes("50"));
  assert.strictEqual(m.kind, "aligned");
});

t("linear horizontal / vertical", () => {
  const style = dim.DEFAULT_CAD_DIM_STYLE;
  const hx = dim.buildLinearMarkup({ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 20 }, style, "x");
  near(hx.value, 10);
  const hy = dim.buildLinearMarkup({ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 2 }, style, "y");
  near(hy.value, 5);
});

t("angular 90°", () => {
  const m = dim.buildAngularMarkup({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, dim.DEFAULT_CAD_DIM_STYLE);
  near(m.value, 90);
  assert.ok(m.text.includes("90"));
});

t("radius / diameter", () => {
  const r = dim.buildRadiusMarkup({ x: 0, y: 0 }, { x: 5, y: 0 }, dim.DEFAULT_CAD_DIM_STYLE);
  near(r.value, 5);
  assert.ok(r.text.startsWith("R"));
  const d = dim.buildDiameterMarkup({ x: 0, y: 0 }, { x: 5, y: 0 }, dim.DEFAULT_CAD_DIM_STYLE);
  near(d.value, 10);
});

t("arc length quarter circle", () => {
  const m = dim.buildArcLengthMarkup({ x: 0, y: 0 }, 10, 0, 90, dim.DEFAULT_CAD_DIM_STYLE);
  near(m.value, (Math.PI * 10) / 2, 1e-6);
});

t("ordinate", () => {
  const m = dim.buildOrdinateMarkup({ x: 0, y: 0 }, { x: 12, y: 7 }, "x", dim.DEFAULT_CAD_DIM_STYLE);
  near(m.value, 12);
  assert.strictEqual(m.ordinateAxis, "x");
});

t("center mark has four pts", () => {
  const m = dim.buildCenterMarkMarkup({ x: 1, y: 2 }, 10, dim.DEFAULT_CAD_DIM_STYLE);
  assert.strictEqual(m.pts.length, 4);
  assert.strictEqual(m.kind, "center-mark");
});

t("continue chains from second point", () => {
  const style = dim.DEFAULT_CAD_DIM_STYLE;
  const last = dim.buildLinearMarkup({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, style, "aligned");
  const cont = dim.continueDimension(last, { x: 25, y: 0 }, { x: 15, y: 5 }, style);
  assert.ok(cont);
  near(cont.markup.value, 15);
  near(cont.chainFrom.x, 25);
});

t("baseline keeps origin", () => {
  const style = dim.DEFAULT_CAD_DIM_STYLE;
  const last = dim.buildLinearMarkup({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, style, "aligned");
  const base = dim.baselineDimension(last, { x: 20, y: 0 }, { x: 10, y: 8 }, style);
  assert.ok(base);
  near(base.origin.x, 0);
  near(base.markup.value, 20);
});

t("all DIM scenarios registered", () => {
  assert.ok(dim.DIM_SCENARIOS.length >= 10);
  assert.strictEqual(dim.resolveDimCommand("DIMLINEAR"), "dimlinear");
  assert.strictEqual(dim.resolveDimCommand("DAL"), "dimaligned");
  assert.strictEqual(dim.resolveDimCommand("DAN"), "dimang");
  assert.strictEqual(dim.resolveDimCommand("DRA"), "dimradius");
  assert.strictEqual(dim.resolveDimCommand("NOPE"), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
