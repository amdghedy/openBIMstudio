// AutoCAD 2D parity A8 — viewports, page setups and plot (node test).
//
// Proved fail-without-fix against the base: the pure module
// src/modules/cad-viewer/cad-viewport-a8.ts does not exist on base, so the
// compile below fails there; the writer/reader assertions below fail on base
// too (scale was derived read-only, no lock/clip, no named setups, and the
// writer saved only the first layout).
//
// No mocks: the pure viewport/page-setup/plot math, the writer and the reader
// under test are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-viewport-a8-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, a + "!=" + b);
const P = (x, y) => ({ x, y, z: 0 });
execSync(
  "npx tsc src/modules/cad-viewer/cad-viewport-a8.ts src/modules/cad-viewer/viewer-math.ts " +
    "src/modules/drawings/dxf-types.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts " +
    "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const V = require(find(out, "cad-viewport-a8.js"));
const W = require(find(out, "dxf-writer.js"));
const R = require(find(out, "dxf-reader.js"));

const vp = (over = {}) => ({
  center: P(148, 210), width: 277, height: 400,
  viewCenter: P(50, 25), viewHeight: 20000, ...over,
});

t("createViewport keeps the scale invariant (viewHeight = height / scale)", () => {
  const v = V.createViewport({ minX: 9.5, minY: 10, maxX: 286.5, maxY: 410 }, { minX: 0, minY: 0, maxX: 100, maxY: 50 }, { scale: 0.02 });
  near(v.viewHeight, 20000);
  near(V.viewportScaleOf(v), 0.02);
  near(v.center.x, 148); near(v.center.y, 210);
});

t("setViewportScale re-solves viewHeight and keeps the view centre", () => {
  const v = V.setViewportScale(vp(), 0.01, null);
  near(v.viewHeight, 40000);
  assert.deepStrictEqual(v.viewCenter, P(50, 25));
  assert.strictEqual(v.scale, 0.01);
  // "fit" re-solves from the model bounds — the width dominates at this aspect.
  const f = V.setViewportScale(vp(), "fit", { minX: 0, minY: 0, maxX: 100, maxY: 50 });
  near(f.scale, 400 / Math.max(50, (100 * 400) / 277));
});

t("a locked viewport ignores zoom and pan", () => {
  const locked = vp({ locked: true, scale: 0.02 });
  assert.deepStrictEqual(V.zoomViewportAt(locked, 1, P(148, 210), P(148, 210), 2), locked);
  assert.deepStrictEqual(V.panViewportBy(locked, 1, 10, 10), locked);
  const free = V.zoomViewportAt(vp({ scale: 0.02 }), 1, P(148, 210), P(148, 210), 2);
  near(free.scale, 0.04);
  near(free.viewHeight, 10000);
});

t("clipViewportRect clamps to the viewport sheet rect", () => {
  const v = vp({ clip: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } });
  const c = V.clipViewportRect(v);
  // Sheet rect is centre +/- w/2,h/2: x 9.5..286.5, y 10..410.
  near(c.minX, 9.5); near(c.maxX, 286.5); near(c.minY, 10); near(c.maxY, 410);
  const v2 = V.setViewportClip(vp(), { minX: 100, minY: 100, maxX: 200, maxY: 200 });
  assert.deepStrictEqual(v2.clip, { minX: 100, minY: 100, maxX: 200, maxY: 200 });
  assert.strictEqual(V.setViewportClip(vp(), null).clip, undefined);
});

t("viewportAtSheetPoint finds the topmost viewport under a sheet point", () => {
  const a = vp({ center: P(100, 100), width: 100, height: 100 });
  const b = vp({ center: P(120, 100), width: 100, height: 100 });
  assert.strictEqual(V.viewportAtSheetPoint([a, b], { x: 130, y: 100 }), 1);
  assert.strictEqual(V.viewportAtSheetPoint([a, b], { x: 10, y: 10 }), -1);
});

t("plot scale parsing accepts named scales and fit, rejects the rest", () => {
  assert.strictEqual(V.parsePlotScale("1:50"), 0.02);
  assert.strictEqual(V.parsePlotScale("1:100"), 0.01);
  assert.strictEqual(V.parsePlotScale("Fit"), "fit");
  assert.strictEqual(V.parsePlotScale("1:0"), null);
  assert.strictEqual(V.parsePlotScale("bogus"), null);
  assert.strictEqual(V.plotScaleLabel(0.02), "1:50");
  assert.strictEqual(V.plotScaleLabel("fit"), "Fit");
  assert.strictEqual(V.PLOT_SCALES.find((s) => s.label === "1:50")?.value, 0.02);
});

t("named page setups sanitize, serialize and resolve per layout", () => {
  const s = V.sanitizePageSetup({ name: "A3-1:50", paper: "A3", orient: "landscape", scale: 0.02, area: "layout" });
  assert.ok(s && s.name === "A3-1:50" && s.paper === "A3" && s.scale === 0.02 && s.area === "layout");
  assert.strictEqual(V.sanitizePageSetup({ name: "", paper: "A3" }), null);
  assert.strictEqual(V.validatePageSetupName("  "), "A page setup needs a name.");
  const setups = V.sanitizePageSetups({ "A3-1:50": s });
  assert.strictEqual(Object.keys(setups).length, 1);
  const layout = { name: "Sheet-A", entities: [], viewports: [vp()], pageSetup: "A3-1:50" };
  const resolved = V.resolveLayoutSetup(layout, setups);
  assert.strictEqual(resolved.name, "A3-1:50");
  // No named setup: the layout's own stamped values become the setup.
  const fallback = V.resolveLayoutSetup({ name: "Sheet-B", entities: [], viewports: [], paper: "A4", plotScale: 0.01, plotArea: "extents" }, setups);
  assert.strictEqual(fallback.paper, "A4");
  assert.strictEqual(fallback.scale, 0.01);
  assert.strictEqual(fallback.area, "extents");
  const applied = V.applyPageSetupToLayout(layout, { name: "A4-1:100", paper: "A4", orient: "portrait", scale: 0.01, area: "extents" });
  assert.strictEqual(applied.paper, "A4");
  assert.strictEqual(applied.plotScale, 0.01);
  assert.strictEqual(applied.plotArea, "extents");
  assert.strictEqual(applied.pageSetup, "A4-1:100");
});

t("plotViewForLayout honours the chosen layout's setup; model plots fit the area box", () => {
  const setup = { name: "A3-1:50", paper: "A3", orient: "landscape", scale: 0.02, area: "layout" };
  const view = V.plotViewForLayout(setup, { minX: 0, minY: 0, maxX: 420, maxY: 297 });
  near(view.cx, 210); near(view.cy, 148.5);
  // A3 landscape printable height 297-16 = 281 mm at 1:50 -> 14050 model units.
  near(view.viewHeight, 14050);
  const model = V.plotViewForModel({ name: "fit", paper: "A3", orient: "landscape", scale: "fit", area: "display" }, { minX: 0, minY: 0, maxX: 100, maxY: 50 });
  // Fit: max(50, 100 * 281/404) = 69.55...
  near(model.viewHeight, 100 * 281 / 404, 1e-6);
});

t("writer + reader round-trip: two layouts, named setup, scale, lock and clip", () => {
  const doc = {
    units: "mm",
    layers: [{ name: "0", color: 7 }],
    entities: [{ type: "LINE", layer: "0", start: P(0, 0), end: P(100, 0) }],
    layouts: [
      { name: "Sheet-A", entities: [], viewports: [vp({ scale: 0.02, locked: true, clip: { minX: 20, minY: 20, maxX: 200, maxY: 300 } })], pageSetup: "A3-1:50", paper: "A3", plotScale: 0.02, plotArea: "layout" },
      { name: "Sheet-B", entities: [], viewports: [vp({ scale: 0.25, viewHeight: 1600 })] },
    ],
    pageSetups: { "A3-1:50": { name: "A3-1:50", paper: "A3", orientation: "landscape", plotScale: 0.02, plotArea: "layout" } },
  };
  const text = W.writeDxf(doc);
  assert.strictEqual(W.layoutsNotSaved(doc), 0);
  const back = R.parseDxf(text);
  assert.deepStrictEqual(back.layouts.map((l) => l.name), ["Sheet-A", "Sheet-B"]);
  const a = back.layouts[0];
  assert.strictEqual(a.pageSetup, "A3-1:50");
  assert.strictEqual(a.paper, "A3");
  near(a.plotScale, 0.02);
  assert.strictEqual(a.plotArea, "layout");
  const va = a.viewports[0];
  near(va.scale, 0.02);
  assert.strictEqual(va.locked, true);
  assert.deepStrictEqual(va.clip, { minX: 20, minY: 20, maxX: 200, maxY: 300 });
  near(back.layouts[1].viewports[0].scale, 0.25);
});

t("writer + reader round-trip: an empty layout survives (no entities, no viewports)", () => {
  const doc = {
    units: "mm",
    layers: [{ name: "0", color: 7 }],
    entities: [],
    layouts: [
      { name: "Sheet-A", entities: [], viewports: [] },
      { name: "Sheet-B", entities: [], viewports: [] },
    ],
  };
  const back = R.parseDxf(W.writeDxf(doc));
  assert.deepStrictEqual(back.layouts.map((l) => l.name), ["Sheet-A", "Sheet-B"]);
});

// ── Per-viewport freeze (2D-6) ──
t("setViewportFrozenLayers trims, de-duplicates and clears; locked refuses", () => {
  const v = V.setViewportFrozenLayers(vp(), [" WALLS ", "WALLS", "", "DOORS"]);
  assert.deepStrictEqual(v.frozenLayers, ["WALLS", "DOORS"]);
  assert.deepStrictEqual(V.setViewportFrozenLayers(v, []).frozenLayers, undefined);
  assert.deepStrictEqual(V.setViewportFrozenLayers(v, ["   "]).frozenLayers, undefined);
  const locked = V.setViewportFrozenLayers(vp({ locked: true }), ["WALLS"]);
  assert.strictEqual(locked.frozenLayers, undefined);
  assert.strictEqual(V.isLayerFrozenInViewport(v, "WALLS"), true);
  assert.strictEqual(V.isLayerFrozenInViewport(v, "DOORS"), true);
  assert.strictEqual(V.isLayerFrozenInViewport(v, "0"), false);
  assert.strictEqual(V.isLayerFrozenInViewport(vp(), "WALLS"), false);
});

t("writer + reader round-trip: per-viewport freeze survives QSAVE (group 331)", () => {
  const doc = {
    units: "mm",
    layers: [{ name: "0", color: 7 }, { name: "WALLS", color: 7 }, { name: "DOORS", color: 7 }],
    entities: [
      { type: "LINE", layer: "WALLS", start: P(0, 0), end: P(100, 0) },
      { type: "LINE", layer: "DOORS", start: P(0, 10), end: P(100, 10) },
    ],
    layouts: [
      {
        name: "Sheet-A", entities: [],
        viewports: [
          vp({ frozenLayers: ["WALLS"] }),
          vp({ center: P(400, 210), frozenLayers: ["DOORS", "WALLS"] }),
          vp({ center: P(600, 210) }),
        ],
      },
    ],
  };
  const text = W.writeDxf(doc);
  // The freeze is carried as VIEWPORT group 331 handles, not as layer state.
  assert.ok(text.includes("331\n"), "no group 331 in the written DXF");
  const back = R.parseDxf(text);
  const vps = back.layouts[0].viewports;
  assert.strictEqual(vps.length, 3);
  assert.deepStrictEqual(vps[0].frozenLayers, ["WALLS"]);
  assert.deepStrictEqual(vps[1].frozenLayers, ["DOORS", "WALLS"]);
  assert.strictEqual(vps[2].frozenLayers, undefined);
  // The freeze is per-viewport: neither layer is globally frozen by it.
  assert.strictEqual(back.layers.find((l) => l.name === "WALLS").frozen, false);
  assert.strictEqual(back.layers.find((l) => l.name === "DOORS").frozen, false);
});

t("writer drops frozen names with no layer (no dangling group 331)", () => {
  const doc = {
    units: "mm",
    layers: [{ name: "0", color: 7 }, { name: "WALLS", color: 7 }],
    entities: [],
    layouts: [
      { name: "Sheet-A", entities: [], viewports: [vp({ frozenLayers: ["WALLS", "NOPE"] })] },
    ],
  };
  const back = R.parseDxf(W.writeDxf(doc));
  assert.deepStrictEqual(back.layouts[0].viewports[0].frozenLayers, ["WALLS"]);
});

t("viewer: viewport paints skip their frozen layers only (2D-6 wiring)", () => {
  const viewer = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  assert.ok(viewer.includes("extraHidden?: ReadonlySet<string>"), "paintEntities takes no extra-hidden set");
  assert.ok(viewer.includes("(extraHidden && extraHidden.has(e.layer))"), "paintEntities does not skip extra-hidden layers");
  assert.ok(viewer.includes("const vpFrozen = vp.frozenLayers?.length ? new Set(vp.frozenLayers) : undefined;"), "viewport paint does not build the frozen set");
  assert.ok(viewer.includes("vpFrozen,\n        );"), "viewport paint does not pass the frozen set");
  // The VPORT dialog exposes the freeze per viewport and validates names.
  assert.ok(viewer.includes('data-r="vp-frozen-${i}"'), "VPORT dialog has no frozen-layers input");
  assert.ok(viewer.includes("Vp8.setViewportFrozenLayers(next,"), "VPORT dialog does not apply the freeze");
  assert.ok(viewer.includes("frozen layers ignored — no such layer"), "VPORT dialog does not warn on unknown layers");
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
