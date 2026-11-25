/**
 * Unit tests for the CAD dimension engine.
 * (Was cad-snap-dimension: the duplicate snap engine was removed in
 * AutoCAD parity A14, so the snap section went with it. The live
 * snapper is viewer-math.ts findSnap.)
 * Run: node --experimental-strip-types tests/cad-dimension.test.mjs
 */
import assert from "assert";
import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

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
