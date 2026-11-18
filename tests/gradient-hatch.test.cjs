/* Gradient hatches: engine JSON -> DxfHatch.gradient, and the ramp geometry the viewer paints. */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "grad-"));
const flags = `--outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`;
execSync(`npx tsc src/modules/drawings/acad-engine.ts src/modules/cad-viewer/viewer-math.ts ${flags}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const E = require(find(out, "acad-engine.js")), M = require(find(out, "viewer-math.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const hatch = (g) => ({ entities: [{ handle: "1", type: "HATCH", layer: "0", isSolid: true, patternName: "SOLID", patternAngle: 0, patternScale: 1,
  paths: [{ edges: [{ e: "line", s: [0, 0, 0], v: [10, 0, 0] }, { e: "line", s: [10, 0, 0], v: [10, 5, 0] }, { e: "line", s: [10, 5, 0], v: [0, 5, 0] }, { e: "line", s: [0, 5, 0], v: [0, 0, 0] }] }], ...g }],
  blockRecords: [], layers: [], linetypes: [] });
const grad = { name: "LINEAR", angle: 0, shift: 0, single: false, tint: 1, colors: [{ value: 0, color: { t: "rgb", r: 255, g: 0, b: 0 } }, { value: 1, color: { t: "index", v: 5 } }] };
t("gradient hatch keeps its colour stops (true colour and ACI) and stays solid", () => {
  const h = E.mapDocument(hatch({ gradient: grad }), "dwg").entities[0].hatch;
  assert.ok(h.solid); assert.strictEqual(h.gradient.stops.length, 2); assert.strictEqual(h.gradient.stops[0].rgb, 0xff0000); assert.strictEqual(h.gradient.stops[1].rgb, 0x0000ff);
});
t("a plain solid hatch has no gradient", () => assert.strictEqual(E.mapDocument(hatch({}), "dwg").entities[0].hatch.gradient, undefined));
t("ramp at angle 0 runs left to right across the whole box", () => {
  const r = M.gradientRamp({ name: "LINEAR", angle: 0, single: false, tint: 1, stops: [{ pos: 0, rgb: 1 }, { pos: 1, rgb: 2 }] }, { minX: 0, minY: 0, maxX: 10, maxY: 5 });
  near(r.x0, 0); near(r.x1, 10); near(r.y0, 2.5); near(r.y1, 2.5);
});
t("ramp at 90 degrees runs bottom to top", () => {
  const r = M.gradientRamp({ name: "LINEAR", angle: Math.PI / 2, single: false, tint: 1, stops: [{ pos: 0, rgb: 1 }, { pos: 1, rgb: 2 }] }, { minX: 0, minY: 0, maxX: 10, maxY: 5 });
  near(r.y0, 0, 1e-9); near(r.y1, 5, 1e-9); near(r.x0, 5, 1e-9);
});
t("45 degree ramp spans the box diagonal projection", () => {
  const r = M.gradientRamp({ name: "LINEAR", angle: Math.PI / 4, single: false, tint: 1, stops: [{ pos: 0, rgb: 1 }, { pos: 1, rgb: 2 }] }, { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  near(Math.hypot(r.x1 - r.x0, r.y1 - r.y0), 10 * Math.SQRT2, 1e-9);
});
t("CYLINDER mirrors the ramp about the centre", () => {
  const r = M.gradientRamp({ name: "CYLINDER", angle: 0, single: false, tint: 1, stops: [{ pos: 0, rgb: 0xff0000 }, { pos: 1, rgb: 0x0000ff }] }, { minX: 0, minY: 0, maxX: 10, maxY: 5 });
  assert.deepStrictEqual(r.stops.map((s) => s.rgb), [0xff0000, 0x0000ff, 0xff0000]);
});
t("single-colour gradient ramps to white by the tint", () => {
  const r = M.gradientRamp({ name: "LINEAR", angle: 0, single: true, tint: 0, stops: [{ pos: 0, rgb: 0x204060 }] }, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
  assert.strictEqual(r.stops[1].rgb, 0xffffff);
});
console.log(`gradient-hatch: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
