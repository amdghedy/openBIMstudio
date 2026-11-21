/* Native SPLINE/ELLIPSE preservation: DXF read -> edit -> DXF write must keep true curve definitions,
 * carry them through affine edits, and never emit stale data after a non-affine edit. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "natc-"));
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts src/modules/cad-viewer/modify-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop${flag}`, { stdio: "pipe", cwd: path.join(__dirname, "..") });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { parseDxf } = require(find(out, "dxf-reader.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));
const M = require(find(out, "modify-math.js"));
const N = require(find(out, "native-curves.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const D = (...a) => a.flat().map(String).join("\n") + "\n";
const SPLINE = D(0, "SPLINE", 8, "S", 70, 8, 71, 3, 72, 8, 73, 4, 74, 0, 40, 0, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 40, 1,
  10, 0, 20, 0, 30, 0, 10, 2, 20, 5, 30, 0, 10, 6, 20, 5, 30, 0, 10, 8, 20, 0, 30, 0);
const ELL = D(0, "ELLIPSE", 8, "E", 10, 5, 20, 5, 30, 0, 11, 4, 21, 0, 31, 0, 210, 0, 220, 0, 230, 1, 40, 0.5, 41, 0, 42, 3.14159265358979);
const doc = (...ents) => D(0, "SECTION", 2, "ENTITIES", ents.map((x) => x.trimEnd()), 0, "ENDSEC", 0, "EOF");
const read = (txt) => { const d = parseDxf(txt); assert.ok(!(d instanceof Error), String(d)); return d; };
const dxfOf = (entities, base) => writeDxf({ ...base, entities });
const countType = (txt, ty) => (txt.match(new RegExp(`\\n0\\n${ty}\\n`, "g")) || []).length;

const base = read(doc(SPLINE, ELL));
const [sp, el] = base.entities;
t("reader keeps the true SPLINE definition", () => {
  assert.equal(sp.native.kind, "SPLINE"); assert.equal(sp.native.degree, 3);
  assert.equal(sp.native.controlPoints.length, 4); assert.equal(sp.native.knots.length, 8);
  assert.ok(N.nativeIfValid(sp));
});
t("reader keeps the true ELLIPSE definition", () => {
  assert.equal(el.native.kind, "ELLIPSE"); assert.equal(el.native.ratio, 0.5); assert.equal(el.native.majorAxis.x, 4);
});
t("unedited drawing writes real SPLINE and ELLIPSE entities", () => {
  const txt = dxfOf(base.entities, base);
  assert.equal(countType(txt, "SPLINE"), 1); assert.equal(countType(txt, "ELLIPSE"), 1);
  const back = read(txt);
  assert.deepEqual(back.entities[0].native.controlPoints.map((p) => [p.x, p.y]), [[0, 0], [2, 5], [6, 5], [8, 0]]);
  assert.deepEqual(back.entities[0].native.knots, [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.equal(back.entities[1].native.ratio, 0.5);
});
t("move/rotate/scale/mirror carry the native definition exactly", () => {
  for (const f of [(e) => M.translateEnt(e, 10, -3), (e) => M.rotateEnt(e, 1, 1, 37), (e) => M.scaleEnt(e, 0, 0, 2.5), (e) => M.mirrorEnt(e, { x: 0, y: 0 }, { x: 1, y: 1 })]) {
    for (const src of [sp, el]) {
      const moved = f(src);
      assert.ok(N.nativeIfValid(moved), "native lost after " + f.toString());
      // The carried definition, re-tessellated, must match the transformed polyline endpoints.
      const a = moved.points[0], b = moved.points[moved.points.length - 1];
      if (src.native.kind === "SPLINE") {
        const cp = moved.native.controlPoints;
        assert.ok(Math.hypot(cp[0].x - a.x, cp[0].y - a.y) < 1e-6); assert.ok(Math.hypot(cp[3].x - b.x, cp[3].y - b.y) < 1e-6);
      } else {
        const n = moved.native, ang = (t) => t; const mj = n.majorAxis, bx = -mj.y * n.ratio, by = mj.x * n.ratio;
        const refl = f === undefined;
        const pt = (tt) => ({ x: n.center.x + Math.cos(tt) * mj.x + Math.sin(tt) * bx, y: n.center.y + Math.cos(tt) * mj.y + Math.sin(tt) * by });
        const p0 = pt(n.startParam), p1 = pt(n.endParam);
        const ok = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-6;
        assert.ok((ok(p0, a) && ok(p1, b)) || (ok(p0, b) && ok(p1, a)), "ellipse endpoints diverge");
      }
    }
  }
});
t("edited drawing writes the edited geometry, never stale native data", () => {
  const edited = JSON.parse(JSON.stringify(sp)); edited.points[2] = { x: 40, y: 40, z: 0 }; // non-affine point edit
  assert.equal(N.nativeIfValid(edited), null);
  const txt = dxfOf([edited], base);
  assert.equal(countType(txt, "SPLINE"), 0); assert.equal(countType(txt, "LWPOLYLINE"), 1);
  assert.ok(txt.includes("\n40\n"));
});
t("moved spline is written natively at its new position", () => {
  const txt = dxfOf([M.translateEnt(sp, 100, 0)], base); const back = read(txt);
  assert.equal(countType(txt, "SPLINE"), 1); assert.equal(back.entities[0].native.controlPoints[0].x, 100);
});
t("malformed spline (knot count mismatch) falls back to polyline without native", () => {
  const bad = read(doc(D(0, "SPLINE", 8, "S", 71, 3, 73, 4, 40, 0, 40, 1, 10, 0, 20, 0, 10, 1, 20, 1, 10, 2, 20, 0, 10, 3, 20, 1)));
  for (const e of bad.entities) assert.ok(!e.native || N.nativeIfValid(e));
});
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
