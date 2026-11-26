/**
 * tests/family-creator-outline.test.cjs
 *
 * Prototype: picture of a flat shape -> polygon with holes -> scaled by one stated dimension
 * -> extruded IFC2X3. Synthetic picture (anti-aliased, noisy, off-white background), so no
 * image decoder is needed. IfcOpenShell checks the written file outside this test.
 *
 * Run: `node tests/family-creator-outline.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log(`  ok - ${name}`); } catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); } }
const near = (a, b, tol, msg = "") => { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}) ${msg}`); };

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".family-creator-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => { try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ } });
execSync("npx tsc src/modules/families/creator/outline.ts src/modules/families/creator/outline-family.ts src/modules/families/creator/ifc2x3.ts src/modules/families/parametric-engine.ts --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck", { cwd: root, stdio: "inherit", shell: true });
const find = (n) => { const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = walk(p); if (r) return r; } else if (f.name === n) return p; } return null; }; return walk(tmpOut); };
const THREE = require("three");
const O = require(find("outline.js")), I = require(find("ifc2x3.js")), OF = require(find("outline-family.js")), E = require(find("parametric-engine.js"));

// L bracket 300 x 200 mm with a round hole and a slot, drawn at 2 px/mm with a 20 px margin.
const PX = 2, M = 20, WPX = 300 * PX + 2 * M, HPX = 200 * PX + 2 * M;
const inL = (x, y) => (x >= 0 && x <= 300 && y >= 0 && y <= 60) || (x >= 0 && x <= 80 && y >= 0 && y <= 200);
const inHole = (x, y) => Math.hypot(x - 40, y - 130) <= 15 || (x >= 150 && x <= 250 && y >= 20 && y <= 40);
const solid = (x, y) => inL(x, y) && !inHole(x, y);
function picture(noise = 6, bg = 245, ink = 60) {
  const data = new Uint8ClampedArray(WPX * HPX * 4);
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let py = 0; py < HPX; py++) for (let px = 0; px < WPX; px++) {
    let c = 0; // 4x4 supersample for anti-aliased edges; image y is down, drawing y is up
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const x = (px + (sx + 0.5) / 4 - M) / PX, y = (HPX - (py + (sy + 0.5) / 4) - M) / PX;
      if (solid(x, y)) c++;
    }
    const v = bg + (ink - bg) * (c / 16) + (rnd() - 0.5) * noise;
    const i = 4 * (py * WPX + px); data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  return { data, width: WPX, height: HPX };
}
const areaOf = (l) => Math.abs(l.reduce((a, p, i) => { const q = l[(i + 1) % l.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
const img = picture();
const o = O.extractOutline(img);
const sc = O.scaleOutline(o, { widthM: 0.3 });

t("the outline is read from pixels: one outer loop and two holes", () => {
  assert.strictEqual(o.holes.length, 2);
  near(o.shapeWidthPx, 600, 3); near(o.shapeHeightPx, 400, 3);
});
t("one stated width scales the shape; the height is derived, not assumed", () => {
  near(sc.widthM, 0.3, 1e-9); near(sc.heightM, 0.2, 0.002);
  assert.deepStrictEqual(sc.warnings, []);
});
t("area matches the drawn shape within 1% (holes subtracted)", () => {
  const a = (areaOf(sc.outer) - sc.holes.reduce((s, h) => s + areaOf(h), 0)) * 1e6;
  const want = 300 * 60 + 80 * 140 - Math.PI * 225 - 2000;
  near(a / want, 1, 0.01, `area ${a.toFixed(0)} vs ${want.toFixed(0)} mm2`);
});
t("the outline is simplified to few straight segments, not one per pixel", () => {
  assert.ok(sc.outer.length <= 14, "outer has " + sc.outer.length + " points");
});
t("a second stated dimension that disagrees with the picture warns instead of stretching", () => {
  const w = O.scaleOutline(o, { widthM: 0.3, heightM: 0.25 });
  assert.strictEqual(w.warnings.length, 1);
  near(w.widthM, 0.3, 1e-9); near(w.heightM, 0.2, 0.002);
  assert.deepStrictEqual(O.scaleOutline(o, { widthM: 0.3, heightM: 0.2 }).warnings, []);
});
t("no real dimension is an error, never a guess", () => {
  assert.throws(() => O.scaleOutline(o, {}), /real dimension/);
});
t("a blank picture is refused", () => {
  const d = new Uint8ClampedArray(40 * 40 * 4).fill(240);
  assert.throws(() => O.extractOutline({ data: d, width: 40, height: 40 }), /No shape found/);
});
t("a light-on-dark picture works the same (background is read from the border)", () => {
  const dark = picture(6, 20, 220);
  const r = O.scaleOutline(O.extractOutline(dark), { widthM: 0.3 });
  assert.strictEqual(r.holes.length, 2); near(r.heightM, 0.2, 0.002);
});
t("IFC2X3 with an arbitrary profile with voids, extruded by the stated thickness", () => {
  const out = I.writeIfc2x3({ name: "L bracket", entity: "IfcBuildingElementProxy", parts: [], lengthParams: { Thickness: 0.01 }, timestamp: "2026-01-01T00:00:00",
    outline: { outer: sc.outer, holes: sc.holes, thicknessM: 0.01 } });
  assert.ok(/IFCARBITRARYPROFILEDEFWITHVOIDS/.test(out.text)); assert.ok(/IFCEXTRUDEDAREASOLID/.test(out.text));
  fs.writeFileSync(process.env.OUTLINE_IFC || path.join(tmpOut, "l-bracket.ifc"), out.text);
  if (process.env.OUTLINE_PNG_DIR) {
    // Dump the synthetic picture as a PPM so it can be converted and viewed.
    const b = Buffer.alloc(WPX * HPX * 3); for (let i = 0; i < WPX * HPX; i++) { b[3 * i] = img.data[4 * i]; b[3 * i + 1] = img.data[4 * i + 1]; b[3 * i + 2] = img.data[4 * i + 2]; }
    fs.writeFileSync(path.join(process.env.OUTLINE_PNG_DIR, "l-bracket.ppm"), Buffer.concat([Buffer.from(`P6 ${WPX} ${HPX} 255\n`), b]));
    fs.writeFileSync(path.join(process.env.OUTLINE_PNG_DIR, "l-bracket-outline.json"), JSON.stringify({ outer: sc.outer, holes: sc.holes }));
  }
});

const meshVolume = (obj) => { let v = 0; obj.updateMatrixWorld(true); obj.traverse((m) => { if (!m.isMesh) return; const g = m.geometry, pos = g.attributes.position, idx = g.index; const P = (i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); const n = idx ? idx.count : pos.count; for (let k = 0; k < n; k += 3) { const a = P(idx ? idx.getX(k) : k), b = P(idx ? idx.getX(k + 1) : k + 1), c = P(idx ? idx.getX(k + 2) : k + 2); v += a.dot(b.clone().cross(c)) / 6; } }); return Math.abs(v); };
t("the outline family builds in the family engine at the stated size, with the holes cut", () => {
  const spec = OF.specFromOutline("L bracket", sc, 0.01, { fileName: "bracket.png", statedWidthM: 0.3 });
  const fam = OF.buildOutlineFamily(spec);
  const b = E.buildParametricFamily(fam, fam.types[0], {});
  assert.ok(b.object, "engine built an object"); assert.deepStrictEqual(b.errors ?? [], []);
  const box = new THREE.Box3().setFromObject(b.object);
  near(box.max.x - box.min.x, 0.3, 1e-4); near(box.max.y - box.min.y, 0.2, 2e-3); near(box.max.z - box.min.z, 0.01, 1e-6);
  near(box.min.y, 0, 1e-6, "sits on the base level");
  const want = (300 * 60 + 80 * 140 - Math.PI * 225 - 2000) * 10; // mm3
  near(meshVolume(b.object) * 1e9 / want, 1, 0.012, "engine volume");
});
t("editing Width and Thickness rescales the same outline; Height stays", () => {
  const spec = OF.specFromOutline("L bracket", sc, 0.01, { fileName: "bracket.png" });
  const fam = OF.buildOutlineFamily(spec);
  const ty = { ...fam.types[0], values: { Width: 0.45, Height: sc.heightM, Thickness: 0.02 } };
  const b = E.buildParametricFamily(fam, ty, {});
  const box = new THREE.Box3().setFromObject(b.object);
  near(box.max.x - box.min.x, 0.45, 1e-4); near(box.max.y - box.min.y, sc.heightM, 1e-4); near(box.max.z - box.min.z, 0.02, 1e-6);
  near(meshVolume(b.object) * 1e9 / ((300 * 60 + 80 * 140 - Math.PI * 225 - 2000) * 1.5 * 20), 1, 0.012, "volume scales by 1.5 x 2");
});
t("the creator spec survives a JSON round trip and refuses a missing thickness", () => {
  const spec = OF.specFromOutline("L bracket", sc, 0.01, { fileName: "bracket.png" });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(spec)), spec);
  assert.throws(() => OF.specFromOutline("x", sc, 0, { fileName: "a" }), /thickness/i);
  const ifc = OF.writeOutlineIfc(spec, { widthM: 0.45, heightM: sc.heightM, thicknessM: 0.02 });
  assert.ok(/IFCARBITRARYPROFILEDEFWITHVOIDS/.test(ifc.text));
  if (process.env.OUTLINE_IFC2) fs.writeFileSync(process.env.OUTLINE_IFC2, ifc.text);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
