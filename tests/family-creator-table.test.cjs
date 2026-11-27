/**
 * tests/family-creator-table.test.cjs
 *
 * Generic catalogue size-table reader (profile driven) and its spec mapper.
 * SYNTHETIC FIXTURE: the cabinet sheet below is invented for this test. It is not a manufacturer
 * catalogue, and nothing here is evidence that a second real catalogue was read.
 * The booster check proves the generic reader gives the same numbers as the booster-specific reader.
 * No Revit step runs here.
 *
 * Run: `node tests/family-creator-table.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const THREE = require("three");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
const near = (a, b, tol = 1e-6) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`); };

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".family-creator-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => { try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ } });
execSync(
  "npx tsc src/modules/families/creator/pipeline.ts src/modules/families/creator/catalogue.ts src/modules/families/creator/catalogue-table.ts src/modules/families/creator/units.ts src/modules/families/creator/preview-svg.ts"
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
const K = require(find("catalogue.js", "creator"));
const G = require(find("catalogue-table.js", "creator"));
const E = require(find("parametric-engine.js"));
const deps = {
  buildInEngine(family, type) {
    const r = E.buildParametricFamily(family, type, {});
    let bbox = null;
    if (r.object) { const b = new THREE.Box3().setFromObject(r.object); bbox = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]; }
    return { object: r.object, params: r.params, errors: r.errors, bbox };
  },
};

// SYNTHETIC: invented cabinet size table, millimetres, three sizes.
const SYNTH = [`SYNTHETIC TEST FIXTURE - not a real catalogue
Sizes S60 S90 S120
W 600 900 1200
D 450 450 500
H 1800 1800 2000
P 100 100 x
`];
const SYNTH_PROFILE = { headerPrefix: "Sizes", columnCount: 3, rowKeys: ["W", "D", "H", "P"], requiredRows: ["W", "D", "H"], metresPerUnit: 0.001, unitBasis: "millimetres: assumed for the synthetic test fixture" };
const SYNTH_MAP = { templateId: "cabinet", model: "SYNTH-CAB", width: "W", depth: "D", height: "H", params: { P: "PlinthHeight" } };

let sheet;
t("reads every synthetic column and picks none", () => {
  sheet = G.readDimensionTable(SYNTH, SYNTH_PROFILE);
  assert.ok(sheet.ok, sheet.reason);
  assert.deepStrictEqual(sheet.columns.map((c) => c.id), ["S60", "S90", "S120"]);
  assert.strictEqual(sheet.columns[2].rows.P, undefined, "x cell has no value");
  assert.strictEqual(sheet.columns[1].rows.W, 900);
  assert.deepStrictEqual(sheet.lines.W, { page: 1, line: 3 });
});

t("fails with a reason when the header or a required row is missing", () => {
  assert.strictEqual(G.readDimensionTable(["nothing"], SYNTH_PROFILE).ok, false);
  const noD = G.readDimensionTable([SYNTH[0].replace(/^D .*$/m, "")], SYNTH_PROFILE);
  assert.strictEqual(noD.ok, false);
  assert.match(noD.reason, /Row D/);
});

t("each synthetic column builds a family whose engine bounds equal the chosen sizes", () => {
  for (const col of sheet.columns) {
    const { spec } = G.specFromTable(sheet, col.id, SYNTH_MAP);
    const r = P.runCreator({ name: spec.name, spec }, deps);
    assert.strictEqual(r.status.exports.ifc2x3.state, "structure-checked", JSON.stringify(r.status.exports));
    const bb = deps.buildInEngine(r.family, r.family.types[0]).bbox;
    near(bb[3] - bb[0], col.rows.W / 1000, 2e-3);
    near(bb[5] - bb[2], col.rows.D / 1000, 2e-3);
    near(bb[4] - bb[1], col.rows.H / 1000, 2e-3);
  }
});

t("a value the sheet marks x is skipped, so the template default stays", () => {
  const { spec, provenance } = G.specFromTable(sheet, "S120", SYNTH_MAP);
  assert.strictEqual(spec.params.PlinthHeight, undefined);
  assert.ok(!provenance.some((p) => p.param === "PlinthHeight"));
  const s90 = G.specFromTable(sheet, "S90", SYNTH_MAP);
  near(s90.spec.params.PlinthHeight, 0.1);
  assert.ok(s90.provenance.some((p) => p.param === "PlinthHeight" && p.source === "sheet row P, S90"));
});

t("a missing size row or unknown column throws", () => {
  assert.throws(() => G.specFromTable(sheet, "S999", SYNTH_MAP), /No such column/);
  assert.throws(() => G.specFromTable(sheet, "S60", { ...SYNTH_MAP, width: "Z" }), /Row Z has no value/);
});

// Regression: the generic reader on the booster sheet must give the same numbers as the booster reader.
const BOOSTER = [`Dimensions 1-3~230 3~208-230 3~460 3~575 1-3~230 3~208-230 3~460 3~575
A 67.2 67.2 67.2 67.2 66.9 66.9 66.9 66.9
A1 2.8 x x x 3 x x x
B 57 57 57 57 57 57 57 57
C 75 75 75 75 75 75 75 75
D 9.4 9.4 9.4 9.4 9.4 9.4 9.4 9.4
E 21.4 21.4 21.4 21.4 19.4 19.4 19.4 19.4
F 8.7 8.7 8.7 10 7.7 7.7 7.7 9
G 24.4 24.4 24.4 24.4 24.4 24.4 24.4 24.4
H 31.1 31.1 31.1 31.1 29.1 29.1 29.1 29.1
I 12 12 12 12 10 10 10 10
J 36.4 36.4 36.4 36.4 33.4 33.4 33.4 33.4
J1 x x x x x x x x`];
t("generic reader matches the booster reader on the booster-style rows", () => {
  const prof = { headerPrefix: "Dimensions", columnCount: 8, rowKeys: ["A", "A1", "B", "C", "D", "E", "F", "G", "H", "I", "J", "J1"], requiredRows: ["A", "C", "J"], metresPerUnit: 0.0254, unitBasis: "inches" };
  const g = G.readDimensionTable(BOOSTER, prof);
  const b = K.readBoosterSheet(BOOSTER);
  assert.ok(g.ok && b.ok);
  assert.strictEqual(g.columns.length, b.variants.length);
  g.columns.forEach((c, i) => assert.deepStrictEqual(c.rows, b.variants[i].dimsIn, `column ${i}`));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
