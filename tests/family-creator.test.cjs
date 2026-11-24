/**
 * tests/family-creator.test.cjs
 *
 * Free family creator, slice 1 (PARTIAL). Product size in, editable family
 * out, IFC2X3 written and structure-checked. No Revit step runs here: Revit
 * acceptance is a separate, user-run check (see docs/family-creator.md).
 *
 * Run: `node tests/family-creator.test.cjs`
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
  "npx tsc src/modules/families/creator/pipeline.ts src/modules/families/creator/units.ts src/modules/families/creator/preview-svg.ts"
  + " src/modules/families/parametric-engine.ts"
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

// Neutral synthetic fixture, not a real manufacturer sheet.
const PAGES = ["Display Cabinet DC-100\nOverall size: 1200 x 700 x 2000 mm\nPower: 230 V"];

// IFC extents computed independently from the written text (IFC axes: X width, Y depth, Z up).
function ifcExtents(text) {
  const pts = new Map(), rects = new Map(), circles = new Map(), solids = [];
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^#(\d+)=IFCCARTESIANPOINT\(\(([^)]*)\)\);/.exec(line))) pts.set(+m[1], m[2].split(",").map(Number));
    else if ((m = /^#(\d+)=IFCAXIS2PLACEMENT3D\(#(\d+),\$,\$\);/.exec(line))) pts.set(+m[1], pts.get(+m[2]));
    else if ((m = /^#(\d+)=IFCRECTANGLEPROFILEDEF\([^,]*,[^,]*,#\d+,([^,]+),([^)]+)\);/.exec(line))) rects.set(+m[1], [+m[2], +m[3]]);
    else if ((m = /^#(\d+)=IFCCIRCLEPROFILEDEF\([^,]*,[^,]*,#\d+,([^)]+)\);/.exec(line))) circles.set(+m[1], +m[2]);
    else if ((m = /^#(\d+)=IFCEXTRUDEDAREASOLID\(#(\d+),#(\d+),#\d+,([^)]+)\);/.exec(line))) solids.push({ prof: +m[2], pos: +m[3], depth: +m[4] });
  }
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const s of solids) {
    const base = pts.get(s.pos);
    const [dx, dy] = rects.has(s.prof) ? rects.get(s.prof) : [circles.get(s.prof) * 2, circles.get(s.prof) * 2];
    const lo = [base[0] - dx / 2, base[1] - dy / 2, base[2]];
    const hi = [base[0] + dx / 2, base[1] + dy / 2, base[2] + s.depth];
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], lo[i]); max[i] = Math.max(max[i], hi[i]); }
  }
  return { n: solids.length, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], min };
}

t("T1 length parsing: mm, m, ft-in, fractions; rejects junk", () => {
  near(U.parseLength("3525 mm"), 3.525);
  near(U.parseLength("3.525 m"), 3.525);
  near(U.parseLength("4' 6\""), 4 * 0.3048 + 6 * 0.0254);
  near(U.parseLength("3'-6 1/2\""), 3 * 0.3048 + 6.5 * 0.0254);
  near(U.parseLength("10 in"), 0.254);
  near(U.parseLength("1200"), 1.2, 1e-9, "bare number uses mm");
  assert.strictEqual(U.parseLength("about big"), null);
  assert.strictEqual(U.parseLength(""), null);
});

t("T2 cut sheet: triplet and labelled sizes keep page, line and source text; conflicts return null", () => {
  const a = C.pickOverallSize(PAGES);
  near(a.widthM, 1.2); near(a.depthM, 0.7); near(a.heightM, 2.0);
  assert.strictEqual(a.how, "triplet");
  assert.strictEqual(a.sources[0].page, 1);
  assert.strictEqual(a.sources[0].line, 2);
  assert.ok(a.sources[0].sourceText.includes("1200 x 700 x 2000 mm"));
  const l = C.pickOverallSize(["Width: 900 mm\nDepth: 600 mm\nHeight: 1.8 m"]);
  near(l.widthM, 0.9); near(l.depthM, 0.6); near(l.heightM, 1.8);
  assert.strictEqual(l.how, "labelled");
  assert.strictEqual(C.pickOverallSize(["1200 x 700 x 2000 mm", "1300 x 700 x 2000 mm"]), null, "conflicting sizes must not be guessed");
  assert.strictEqual(C.pickOverallSize(["no numbers here"]), null);
});

let ok;
t("T3 pipeline from cut sheet text: every stage done, real engine bbox, IFC2X3 checked, Revit stays unverified", () => {
  ok = P.runCreator({ name: "Display Cabinet DC-100", manufacturer: "Example", model: "DC-100", pages: PAGES }, deps);
  const s = ok.status;
  assert.deepStrictEqual(s.stages.map((x) => x.state), ["done", "done", "done", "done"]);
  assert.strictEqual(s.completed, 4); assert.strictEqual(s.progress, 1);
  assert.strictEqual(s.platformReady, true);
  assert.strictEqual(s.exports.ifc2x3.state, "structure-checked");
  assert.strictEqual(s.revit.state, "unverified");
  assert.ok(!/ready for revit/i.test(JSON.stringify(s)), "status must never claim Ready for Revit");
  assert.strictEqual(ok.family.ifcEntity, "IfcFurnishingElement");
  assert.ok(ok.spec.sources.length === 3);
});

t("T4 status is real: updates track done stages only; failure leaves later stages pending", () => {
  const seen = [];
  P.runCreator({ name: "Display Cabinet DC-100", pages: PAGES }, deps, (s) => seen.push(s));
  assert.ok(seen.length >= 8, "an update for each start and finish");
  let last = -1;
  for (const s of seen) {
    assert.strictEqual(s.completed, s.stages.filter((x) => x.state === "done").length);
    near(s.progress, s.completed / s.total, 1e-12);
    assert.ok(s.completed >= last, "progress never goes backwards"); last = s.completed;
  }
  const bad = P.runCreator({ name: "X", pages: ["nothing useful"] }, deps);
  assert.deepStrictEqual(bad.status.stages.map((x) => x.state), ["failed", "pending", "pending", "pending"]);
  assert.strictEqual(bad.status.progress, 0);
  assert.strictEqual(bad.status.platformReady, false);
  assert.strictEqual(bad.status.exports.ifc2x3.state, "not-built");
  const brokenEngine = P.runCreator({ name: "X", pages: PAGES }, { buildInEngine: () => ({ object: null, params: {}, errors: [], bbox: null }) });
  assert.deepStrictEqual(brokenEngine.status.stages.map((x) => x.state), ["done", "done", "failed", "pending"]);
  assert.strictEqual(brokenEngine.status.platformReady, false);
  const wrongSize = P.runCreator({ name: "X", pages: PAGES }, { buildInEngine: (f, ty) => { const r = deps.buildInEngine(f, ty); r.bbox[3] += 0.01; return r; } });
  assert.strictEqual(wrongSize.status.stages[2].state, "failed");
});

t("T5 the family is editable: change Width, engine and IFC both follow", () => {
  const fam = ok.family;
  const edited = JSON.parse(JSON.stringify(fam));
  edited.types[0].values.Width = 1.5;
  edited.types[0].values.PlinthHeight = 0.2;
  const r = E.buildParametricFamily(edited, edited.types[0], {});
  assert.strictEqual(r.errors.length, 0, r.errors.join(";"));
  const b = new THREE.Box3().setFromObject(r.object);
  near(b.max.x - b.min.x, 1.5); near(b.max.y - b.min.y, 2.0); near(b.max.z - b.min.z, 0.7);
  near(r.params.BodyHeight, 1.8, 1e-9, "derived parameter follows PlinthHeight");
});

t("T6 IFC extents, computed from the written text, equal the spec size; parts and units are right", () => {
  const x = ifcExtents(ok.ifcText);
  assert.strictEqual(x.n, 4, "plinth, body, door, handle");
  near(x.size[0], 1.2, 1e-6, "IFC X = width"); near(x.size[1], 0.7, 1e-6, "IFC Y = depth"); near(x.size[2], 2.0, 1e-6, "IFC Z = height");
  near(x.min[2], 0, 1e-9, "base at z = 0");
  assert.ok(ok.ifcText.includes("FILE_SCHEMA(('IFC2X3'))"));
  assert.ok(ok.ifcText.includes(".METRE."));
  assert.ok(ok.ifcText.includes("IFCLENGTHMEASURE(1.2)"), "Width written as a length property");
  assert.ok(ok.ifcText.includes("'Manufacturer'") && ok.ifcText.includes("'Model'"));
});

t("T7 box template, spec validation, guid and string escaping", () => {
  const spec = { name: "Plinth", widthM: 0.6, depthM: 0.5, heightM: 0.4 };
  const r = P.runCreator({ name: "Plinth", spec }, deps);
  assert.strictEqual(r.status.platformReady, true);
  assert.strictEqual(r.family.ifcEntity, "IfcBuildingElementProxy");
  assert.strictEqual(ifcExtents(r.ifcText).n, 1);
  assert.ok(B.validateSpec({ name: "", widthM: -1, depthM: NaN, heightM: 99 }).length >= 4);
  assert.strictEqual(I.ifcGuid("a").length, 22);
  assert.strictEqual(I.ifcGuid("a"), I.ifcGuid("a"));
  assert.notStrictEqual(I.ifcGuid("a"), I.ifcGuid("b"));
  assert.strictEqual(I.stepString("O'Neil \u00e9"), "'O''Neil \\X2\\00E9\\X0\\'");
});

t("T8 template parameter overrides, units without float noise, and the three-view drawing", () => {
  assert.strictEqual(U.parseLength("700 mm"), 0.7, "no 0.7000000000000001 noise");
  const spec = { name: "Display Cabinet DC-100", widthM: 1.2, depthM: 0.7, heightM: 2.0, params: { PlinthHeight: 0.2 } };
  const r = P.runCreator({ name: spec.name, spec }, deps);
  assert.strictEqual(r.status.platformReady, true);
  near(r.family.types[0].values.PlinthHeight, 0.2);
  const bad = P.runCreator({ name: spec.name, spec: { ...spec, params: { PlinthHeight: 5 } } }, deps);
  assert.strictEqual(bad.status.stages[0].state, "failed", "out-of-range template parameter is refused");
  const bad2 = P.runCreator({ name: spec.name, spec: { ...spec, params: { BodyHeight: 1 } } }, deps);
  assert.strictEqual(bad2.status.stages[0].state, "failed", "a derived parameter cannot be overridden");
  const V = require(find("preview-svg.js", "creator"));
  const L = require(find("layout.js", "creator"));
  const T = require(find("templates.js", "creator"));
  const E2 = E.buildParametricFamily(r.family, r.family.types[0], {});
  const svg = V.renderThreeViews(L.resolveParts(T.CABINET_TEMPLATE, E2.params), { w: 1.2, d: 0.7, h: 2.0 });
  assert.strictEqual((svg.match(/<rect /g) || []).length, 12, "4 parts x 3 views");
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.ok(!/NaN|Infinity/.test(svg));
});

t("T9 user-facing order is width x depth x height everywhere; failure text speaks to the user; keys exist", () => {
  const r = P.runCreator({ name: "Display Cabinet DC-100", pages: PAGES }, deps);
  const [intake, , engine] = r.status.stages;
  // Engine order is X, Y(up), Z = width, height, depth. The label must still read W x D x H.
  assert.strictEqual(intake.detail, "1200 x 700 x 2000 mm (W x D x H)");
  assert.strictEqual(engine.detail, "1200 x 700 x 2000 mm (W x D x H)");
  assert.deepStrictEqual(engine.detailVars, { w: 1200, d: 700, h: 2000 });
  const bad = P.runCreator({ name: "X", pages: ["nothing useful"] }, deps);
  const msg = bad.status.stages[0].detail;
  assert.ok(!/ask the user/i.test(msg), "must not talk about the user in the third person");
  assert.ok(/enter the size yourself/i.test(msg));
  // Every key the pipeline can emit exists in the English catalogue.
  const en = JSON.parse(fs.readFileSync(path.join(root, "src/locales/en.json"), "utf8")).familyCreator;
  const get = (k) => k.split(".").slice(1).reduce((o, p) => (o ? o[p] : undefined), en);
  for (const st of [...r.status.stages, ...bad.status.stages]) {
    assert.ok(typeof get(st.labelKey) === "string", st.labelKey);
    if (st.detailKey) assert.ok(typeof get(st.detailKey) === "string", st.detailKey);
  }
  // No internal milestone wording in product copy.
  assert.ok(!/slice/i.test(JSON.stringify(en)));
});

t("T10 table and shelf templates: chosen by name or by the user, engine and IFC extents equal the spec, part counts right", () => {
  const TB = require(find("templates.js", "creator"));
  assert.strictEqual(TB.chooseTemplate("Workshop bench WB-2").id, "table");
  assert.strictEqual(TB.chooseTemplate("Steel shelving unit").id, "shelf");
  assert.strictEqual(TB.chooseTemplate("Bookcase").id, "shelf", "bookcase is shelving, not a cabinet");
  assert.strictEqual(TB.chooseTemplate("Display Cabinet").id, "cabinet");
  assert.strictEqual(TB.chooseTemplate("Mystery item").id, "box");
  const cases = [
    { id: "table", name: "Dining table", parts: 5, size: "1800 x 900 x 750 mm", w: 1.8, d: 0.9, h: 0.75 },
    { id: "shelf", name: "Wall shelving", parts: 6, size: "900 x 300 x 1800 mm", w: 0.9, d: 0.3, h: 1.8 },
  ];
  for (const c of cases) {
    for (const byUser of [false, true]) {
      const r = P.runCreator({ name: byUser ? "Thing" : c.name, pages: ["Overall size: " + c.size], templateId: byUser ? c.id : undefined }, deps);
      assert.deepStrictEqual(r.status.stages.map((x) => x.state), ["done", "done", "done", "done"], c.id + (byUser ? " user" : " name"));
      const x = ifcExtents(r.ifcText);
      assert.strictEqual(x.n, c.parts);
      near(x.size[0], c.w, 1e-6); near(x.size[1], c.d, 1e-6); near(x.size[2], c.h, 1e-6);
      near(x.min[2], 0, 1e-9);
    }
  }
  // Too short for its parts is refused with a reason.
  const bad = P.runCreator({ name: "Low table", pages: ["Overall size: 800 x 600 x 60 mm"], templateId: "table" }, deps);
  assert.strictEqual(bad.status.stages[0].state, "failed");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
