/**
 * tests/family-creator-booster.test.cjs
 *
 * Free family creator: packaged booster set template + data sheet table reader.
 * Table rows below are an excerpt of a manufacturer submittal sheet (values as printed).
 * No Revit step runs here: Revit acceptance is a separate user-run check.
 *
 * Run: `node tests/family-creator-booster.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const THREE = require("three");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
const near = (a, b, tol = 1e-6, msg = "") => {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}) ${msg}`);
};

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".family-creator-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => { try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ } });
execSync(
  "npx tsc src/modules/families/creator/pipeline.ts src/modules/families/creator/catalogue.ts src/modules/families/creator/units.ts src/modules/families/creator/preview-svg.ts"
  + " src/modules/families/parametric-engine.ts src/modules/families/migration.ts src/modules/families/creator/part-map.ts"
  + " --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck",
  { cwd: root, stdio: "inherit", shell: true },
);
const find = (n, dirHint) => {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (f.name === n && (!dirHint || p.includes(dirHint))) return p;
    }
    return null;
  };
  return walk(tmpOut);
};
const P = require(find("pipeline.js", "creator"));
const U = require(find("units.js", "creator"));
const C = require(find("cutsheet.js", "creator"));
const B = require(find("build.js", "creator"));
const I = require(find("ifc2x3.js", "creator"));
const E = require(find("parametric-engine.js"));
const M = require(find("migration.js"));
const PM = require(find("part-map.js", "creator"));
const K = require(find("catalogue.js", "creator"));
const L = require(find("layout.js", "creator"));
const T = require(find("templates.js", "creator"));

const deps = {
  buildInEngine(family, type) {
    const r = E.buildParametricFamily(family, type, {});
    let bbox = null;
    if (r.object) {
      const b = new THREE.Box3().setFromObject(r.object);
      bbox = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
    }
    return { object: r.object, params: r.params, errors: r.errors, bbox };
  },
};


const SHEET = [
`Tag # Model # Flow Head HP/Pump Cycle Phase Voltage
WiBooster 3/323/A 7.5 60Hz
Horsepower/Pump 7.5
Full Flow Connection (in) Half Flow Connection (in)
Dimensions 1-3~230 3~208-230 3~460 3~575 1-3~230 3~208-230 3~460 3~575
System Connection (150#) 6 6 6 6 4 4 4 4
A 67.2 67.2 67.2 67.2 66.9 66.9 66.9 66.9
A1 2.8 x x x 3 x x x
B 57 57 57 57 57 57 57 57
C 75 75 75 75 75 75 75 75
D 9.4 9.4 9.4 9.4 9.4 9.4 9.4 9.4
E 21.4 21.4 21.4 21.4 19.4 19.4 19.4 19.4 (BacNET, LONWorks Optional)
F 8.7 8.7 8.7 10 7.7 7.7 7.7 9 Ethernet Port RJ45 (10/100Mbps)
G 24.4 24.4 24.4 24.4 24.4 24.4 24.4 24.4 Addtional Ports USB 2.0, Micro-SD
H 31.1 31.1 31.1 31.1 29.1 29.1 29.1 29.1
I 12 12 12 12 10 10 10 10
J 36.4 36.4 36.4 36.4 33.4 33.4 33.4 33.4
J1 x x x x x x x x
Panel Dimensions (HxWxD) 30x39x12 30X30X10 30X24X10 30X30X10 30x39x12 30X30X10 30X24X10 30X30X10
Panel Weight (lbs) 162.7 162.7 112.7 150.0 162.7 162.7 112.7 150
System Weight (lbs) 1180 1180 1130 1170 1090 1090 1040 1080`];
const PAGES = process.env.BOOSTER_PAGES ? JSON.parse(fs.readFileSync(process.env.BOOSTER_PAGES, "utf8")) : SHEET;
const IN = 0.0254;
// Independent IFC extents from the written text (IFC axes: X width, Y = -depth, Z up). Handles axis directions.
function ifcExtents(text) {
  const pt = new Map(), dir = new Map(), place = new Map(), circ = new Map(), rect = new Map(), solids = [];
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^#(\d+)=IFCCARTESIANPOINT\(\(([^)]*)\)\);/.exec(line))) pt.set(+m[1], m[2].split(",").map(Number));
    else if ((m = /^#(\d+)=IFCDIRECTION\(\(([^)]*)\)\);/.exec(line))) dir.set(+m[1], m[2].split(",").map(Number));
    else if ((m = /^#(\d+)=IFCAXIS2PLACEMENT3D\(#(\d+),(\$|#\d+),(\$|#\d+)\);/.exec(line))) place.set(+m[1], { p: pt.get(+m[2]), a: m[3] === "$" ? [0, 0, 1] : dir.get(+m[3].slice(1)) });
    else if ((m = /^#(\d+)=IFCCIRCLEPROFILEDEF\(.*,(-?[\d.eE+-]+)\);/.exec(line))) circ.set(+m[1], +m[2]);
    else if ((m = /^#(\d+)=IFCRECTANGLEPROFILEDEF\(.*,(-?[\d.eE+-]+),(-?[\d.eE+-]+)\);/.exec(line))) rect.set(+m[1], [+m[2], +m[3]]);
    else if ((m = /^#(\d+)=IFCEXTRUDEDAREASOLID\(#(\d+),#(\d+),#\d+,([\d.eE+-]+)\);/.exec(line))) solids.push({ prof: +m[2], pl: +m[3], len: +m[4] });
  }
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const s of solids) {
    const { p, a } = place.get(s.pl);
    const end = [p[0] + a[0] * s.len, p[1] + a[1] * s.len, p[2] + a[2] * s.len];
    let ext;
    if (circ.has(s.prof)) { const r = circ.get(s.prof); ext = a.map((c) => (Math.abs(c) > 0.5 ? 0 : r)); }
    else { const [w, d] = rect.get(s.prof); ext = [w / 2, d / 2, 0]; }
    for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i] - ext[i], end[i] - ext[i]); mx[i] = Math.max(mx[i], p[i] + ext[i], end[i] + ext[i]); }
  }
  return { mn, mx, count: solids.length };
}

let sheet;
t("reads the table into 8 variants and picks none", () => {
  sheet = K.readBoosterSheet(PAGES);
  assert.ok(sheet.ok, sheet.reason);
  assert.strictEqual(sheet.variants.length, 8);
  assert.strictEqual(sheet.model, "WiBooster 3/323/A");
  assert.strictEqual(sheet.pumps, 3);
  assert.strictEqual(sheet.hpPerPump, 7.5);
  const h460 = sheet.variants.find((v) => v.id === "half-3~460"), f460 = sheet.variants.find((v) => v.id === "full-3~460");
  assert.strictEqual(h460.dimsIn.A, 66.9); assert.strictEqual(f460.dimsIn.A, 67.2);
  assert.strictEqual(h460.dimsIn.J, 33.4); assert.strictEqual(f460.dimsIn.J, 36.4);
  assert.strictEqual(h460.connectionIn, 4); assert.strictEqual(f460.connectionIn, 6);
  assert.deepStrictEqual(h460.panelIn, { h: 30, w: 24, d: 10 });
  assert.strictEqual(h460.systemWeightLb, 1040);
  assert.strictEqual(f460.dimsIn.A1, undefined, "x marks stay absent");
});
t("a multi-model sheet gives one reading per model page, none merged", () => {
  const all = K.readBoosterSheets(PAGES);
  assert.ok(all.length >= 1);
  const models = all.map((x) => x.model);
  assert.strictEqual(new Set(models).size, models.length);
  console.log("    models read:", models.join(", "), all.map((x) => x.hpPerPump).join("/"));
});
t("a table that is not there is reported, not guessed", () => {
  const r = K.readBoosterSheet(["Display Cabinet\nOverall size: 1200 x 700 x 2000 mm"]);
  assert.strictEqual(r.ok, false); assert.ok(r.reason);
});
t("a variant and a depth row must be chosen", () => {
  assert.throws(() => K.boosterSpecFromSheet(sheet, { variantId: "nope", depthRow: "J" }));
  assert.throws(() => K.boosterSpecFromSheet(sheet, { variantId: "half-3~460", depthRow: "Q" }));
});

for (const [id, depthRow] of [["half-3~460", "J"], ["full-3~460", "J"], ["half-3~460", "H"], ["full-1-3~230", "J"]]) {
  t(`generates ${id} depth ${depthRow}: all stages done, engine and IFC boxes equal the sheet`, () => {
    const { spec, provenance } = K.boosterSpecFromSheet(sheet, { variantId: id, depthRow });
    const v = sheet.variants.find((x) => x.id === id);
    const r = P.runCreator({ name: spec.name, spec }, deps);
    assert.strictEqual(r.status.completed, r.status.total, JSON.stringify(r.status.stages.map((s) => [s.id, s.state, s.detail])));
    const wantW = v.dimsIn.A * IN, wantH = v.dimsIn.C * IN, wantD = v.dimsIn[depthRow] * IN;
    const eng = deps.buildInEngine(r.family, r.family.types[0]);
    assert.strictEqual(eng.errors.length, 0, eng.errors.join(";"));
    const [x0, y0, z0, x1, y1, z1] = eng.bbox;
    near(x1 - x0, wantW, 1e-4, "engine width"); near(y1 - y0, wantH, 1e-4, "engine height"); near(z1 - z0, wantD, 1e-4, "engine depth");
    near(y0, 0, 1e-6, "sits on the floor");
    const ifc = ifcExtents(r.ifcText);
    near(ifc.mx[0] - ifc.mn[0], wantW, 1e-4, "ifc width"); near(ifc.mx[2] - ifc.mn[2], wantH, 1e-4, "ifc height"); near(ifc.mx[1] - ifc.mn[1], wantD, 1e-4, "ifc depth");
    assert.ok(/IFCDIRECTION\(\(1\.,0\.,0\.\)\)/.test(r.ifcText) && /IFCDIRECTION\(\(0\.,-1\.,0\.\)\)/.test(r.ifcText), "horizontal cylinders written with axes");
    assert.ok(provenance.every((p) => p.source));
    console.log(`    ${id}/${depthRow}: bbox ${(wantW / IN).toFixed(1)} x ${(wantD / IN).toFixed(1)} x ${(wantH / IN).toFixed(1)} in; parts ${ifc.count}`);
  });
}
t("parameters really drive geometry: pumps count changes the part count, not the box; width changes the flange", () => {
  const base = K.boosterSpecFromSheet(sheet, { variantId: "half-3~460", depthRow: "J" }).spec;
  const partsOf = (s) => { const f = P.runCreator({ name: s.name, spec: s }, deps).family; return L.resolveParts(B.templateFor(s), deps.buildInEngine(f, f.types[0]).params); };
  const count = (s) => partsOf(s).length;
  const n3 = count(base), n2 = count({ ...base, params: { ...base.params, Pumps: 2 } }), n4 = count({ ...base, params: { ...base.params, Pumps: 4 } });
  assert.ok(n2 < n3 && n3 < n4, `${n2} ${n3} ${n4}`);
  assert.strictEqual(n3 - n2, n4 - n3);
  const r2 = P.runCreator({ name: "p2", spec: { ...base, params: { ...base.params, Pumps: 2 } } }, deps);
  const e2 = deps.buildInEngine(r2.family, r2.family.types[0]);
  near(e2.bbox[4] - e2.bbox[1], base.heightM, 1e-4);
  const wide = { ...base, widthM: base.widthM + 0.1 };
  const rw = P.runCreator({ name: "w", spec: wide }, deps);
  const ew = deps.buildInEngine(rw.family, rw.family.types[0]);
  near(ew.bbox[3] - ew.bbox[0], wide.widthM, 1e-4);
  // editing a type value in the engine moves parts: raise Height
  const fam = P.runCreator({ name: "h", spec: base }, deps).family;
  const ty = JSON.parse(JSON.stringify(fam.types[0])); ty.values.Height = base.heightM + 0.2;
  const eh = deps.buildInEngine(fam, ty);
  near(eh.bbox[4] - eh.bbox[1], base.heightM + 0.2, 1e-4, "engine height after editing Height");
});
t("motor cooling ribs exist, sit on each motor, and stand proud of the motor body", () => {
  const spec = K.boosterSpecFromSheet(sheet, { variantId: "half-3~460", depthRow: "J" }).spec;
  const f = P.runCreator({ name: "r", spec }, deps).family; const parts = L.resolveParts(B.templateFor(spec), deps.buildInEngine(f, f.types[0]).params);
  const motors = parts.filter((p) => /^Motor \d+$/.test(p.name)), ribs = parts.filter((p) => /^Motor cooling rib/.test(p.name));
  assert.strictEqual(ribs.length, 3 * 6, "ribs: " + ribs.length);
  for (const m of motors) {
    const mine = ribs.filter((r) => Math.abs(r.cx - m.cx) < 1e-6);
    assert.strictEqual(mine.length, 6);
    for (const r of mine) { assert.ok(r.r > m.r, "rib radius above motor"); assert.ok(r.cz - r.h / 2 >= m.cz - m.h / 2 - 1e-6 && r.cz + r.h / 2 <= m.cz + m.h / 2 + 1e-6, "rib inside motor length"); }
    assert.strictEqual(new Set(mine.map((r) => r.cz.toFixed(4))).size, 6, "distinct positions");
  }
});
t("parts carry their basis: sheet-or-catalogue values versus proportions chosen here", () => {
  const spec = K.boosterSpecFromSheet(sheet, { variantId: "half-3~460", depthRow: "J" }).spec;
  const f = P.runCreator({ name: "b", spec }, deps).family; const parts = L.resolveParts(B.templateFor(spec), deps.buildInEngine(f, f.types[0]).params);
  const inf = parts.filter((p) => p.basis === "inferred").length, cat = parts.filter((p) => p.basis === "catalogue").length;
  assert.ok(inf > 0 && cat > 0); console.log(`    ${cat} catalogue parts, ${inf} inferred parts`);
});
t("placement follows sheet rows D, E, I and G and stays inside the overall box (both depth rows)", () => {
  const IN = 0.0254;
  for (const depthRow of ["J", "H"]) {
    const { spec, provenance } = K.boosterSpecFromSheet(sheet, { variantId: "half-3~460", depthRow });
    for (const k of ["SuctionAxisH", "DischargeRise", "PumpSetLength", "ManifoldSpacing"]) assert.ok(provenance.some((p) => p.param === k), `${k} has a provenance entry`);
    const f = P.runCreator({ name: spec.name, spec }, deps).family;
    const parts = L.resolveParts(B.templateFor(spec), deps.buildInEngine(f, f.types[0]).params);
    const by = (id) => parts.find((p) => p.id === id);
    const sm = by("manifold-suction"), dm = by("manifold-discharge");
    near(dm.cy - sm.cy, 19.4 * IN, 1e-6, "E: discharge axis above suction axis");
    near(sm.cy, 9.4 * IN, 1e-6, "D: suction axis height");
    near(dm.cz - sm.cz, 10 * IN, 1e-6, "I: manifold spacing in depth");
    const half = spec.depthM / 2;
    for (const p of parts.filter((q) => /^(motor|head)/.test(q.id))) {
      const len = p.h; // cylinders along z: h is the length
      assert.ok(p.cz + len / 2 <= half + 1e-9 && p.cz - len / 2 >= -half - 1e-9, `${p.id} inside depth (${depthRow})`);
      assert.ok(p.cz - len / 2 >= sm.cz + sm.r - 1e-9, `${p.id} starts past the suction manifold wall (${depthRow})`);
    }
    const mo = by("motor-1"), hd = by("head-1");
    near(hd.cz + hd.h / 2, mo.cz - mo.h / 2, 1e-9, "head and motor touch");
  }
});
if (process.env.BOOSTER_PAGES) {
  t("every model page (A 7.5 HP, B 5, C 3, D 2) generates: bbox equals the sheet, pumps stay inside the depth, rows D/E/I are honoured", () => {
    const IN = 0.0254;
    const pages = JSON.parse(fs.readFileSync(process.env.BOOSTER_PAGES, "utf8"));
    const sheets = K.readBoosterSheets(pages);
    assert.strictEqual(sheets.length, 4);
    for (const sh of sheets) for (const v of sh.variants) for (const depthRow of ["J", "H"]) {
      if (v.dimsIn[depthRow] === undefined || v.dimsIn.D === undefined) continue;
      const { spec } = K.boosterSpecFromSheet(sh, { variantId: v.id, depthRow });
      const f = P.runCreator({ name: spec.name, spec }, deps).family;
      const parts = L.resolveParts(B.templateFor(spec), deps.buildInEngine(f, f.types[0]).params);
      const sm = parts.find((p) => p.id === "manifold-suction"), dm = parts.find((p) => p.id === "manifold-discharge");
      const tag = `${sh.model} ${v.id} ${depthRow}`;
      near(dm.cy - sm.cy, v.dimsIn.E * IN, 1e-6, tag + " E");
      near(dm.cz - sm.cz, v.dimsIn.I * IN, 1e-6, tag + " I");
      for (const p of parts.filter((q) => /^(motor|head)/.test(q.id))) {
        assert.ok(p.cz + p.h / 2 <= spec.depthM / 2 + 1e-9 && p.cz - p.h / 2 >= sm.cz + sm.r - 1e-9, `${tag} ${p.id} placement`);
      }
    }
  });
}
if (process.env.BOOSTER_DUMP) {
  const { spec } = K.boosterSpecFromSheet(sheet, { variantId: "half-3~460", depthRow: "J" });
  const f = P.runCreator({ name: spec.name, spec }, deps).family; const parts = L.resolveParts(B.templateFor(spec), deps.buildInEngine(f, f.types[0]).params);
  fs.writeFileSync(process.env.BOOSTER_DUMP, JSON.stringify({ spec, parts }));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
