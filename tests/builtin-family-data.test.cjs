/**
 * tests/builtin-family-data.test.cjs
 *
 * Slice 2 (Revit parity gap 5): builtin family data corrections.
 *
 * Data bugs fixed by this slice:
 *   - Pipe ("Round Pipe"): `circumference` and `crossSectionArea` formulas
 *     referenced `diameter`, but the family defines no such parameter — its
 *     size parameter is `thickness` (labelled "Diameter"). Both formulas
 *     always failed evaluation. Fixed to reference `thickness`.
 *   - Slab ("Basic Floor"): its types set `thickness`, but the family
 *     defines no `thickness` parameter — its thickness parameter is
 *     `height` (labelled "Thickness"). Those type values were dead.
 *     Fixed to set `height`.
 *
 * Validation (runs on every builtin family, so the same class of bug
 * cannot recur silently):
 *   - every formula references only declared parameters or engine
 *     built-in functions;
 *   - every type value names a declared parameter;
 *   - every geometry reference/expression names a declared parameter;
 *   - evaluating every family's formulas produces no errors, and the
 *     pipe formulas now compute the expected values (circumference
 *     = pi * thickness; cross-section area = pi * (thickness/2)^2);
 *   - the slab types resolve `height` to 0.15 / 0.2 / 0.25.
 *
 * Also covers the seed-catalog type check: tests/seed-families.test.cjs
 * used to read `t.parameters ?? {}` while the schema uses `t.values`,
 * which made that assertion vacuous — it now reads `t.values`.
 *
 * Run: `node tests/builtin-family-data.test.cjs`
 * CI:  `test:builtin-family-data` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The modules under test are compiled from source with tsc into a temp
 * dir inside the repo (same pattern as tests/family-sketch.test.cjs), so
 * `three` is not needed (builtin-families.ts and formula-engine.ts have
 * no runtime imports beyond type-only ones).
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const out = fs.mkdtempSync(path.join(__dirname, "..", ".builtin-data-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}'); // the repo is "type": "module"
process.on("exit", () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* */ } });
try {
  execSync(`npx tsc src/modules/families/builtin-families.ts src/modules/families/formula-engine.ts src/modules/families/types.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop`, { stdio: "pipe" });
} catch (e) { /* type errors from missing packages locally still emit */ }
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const B = require(find("builtin-families.js"));
const FE = require(find("formula-engine.js"));

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, e = 1e-9) => ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

const families = B.createBuiltInFamilies();
ok(Array.isArray(families) && families.length === 11, `11 builtin families, got ${families.length}`);
for (const name of ["Basic Wall", "Basic Floor", "Basic Column", "Basic Beam", "Basic Door", "Basic Window", "Rectangular Duct", "Round Pipe", "Cable Tray", "Conduit", "Generic Equipment"]) {
  ok(families.some((f) => f.name === name), `builtin family present: ${name}`);
}

// Built-in function names from the engine itself, plus the unit helpers
// the tokenizer treats as functions (mm/cm/ft/in/deg); anything else an
// identifier refers to must be a declared parameter.
const BUILTINS = new Set([...Object.keys(FE.BUILTIN_FUNCTIONS), "mm", "cm", "ft", "in", "deg", "true", "false"]);
const identifiers = (expr) => (expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

// Walk a geometry spec the same way seed-families does: {ref} names and
// {expr} identifiers.
const geometryNames = (spec, outNames = new Set()) => {
  const walk = (v) => {
    if (v && typeof v === "object") {
      if (typeof v.ref === "string") outNames.add(v.ref);
      if (typeof v.expr === "string") identifiers(v.expr).forEach((x) => outNames.add(x));
      Object.values(v).forEach(walk);
    }
  };
  walk(spec); return outNames;
};

for (const f of families) {
  const params = new Set(f.parameters.map((p) => p.name));
  ok(params.size === f.parameters.length, `${f.name}: duplicate parameter names`);
  for (const p of f.parameters) {
    if (!p.formula) continue;
    const expr = String(p.formula).replace(/^=\s*/, "");
    for (const name of identifiers(expr)) {
      ok(params.has(name) || BUILTINS.has(name), `${f.name}: formula for "${p.name}" references unknown parameter "${name}" (${p.formula})`);
    }
  }
  for (const t of f.types ?? []) {
    for (const k of Object.keys(t.values ?? {})) {
      ok(params.has(k), `${f.name}: type "${t.name}" sets unknown parameter "${k}"`);
    }
  }
  for (const u of geometryNames(f.geometry)) {
    ok(params.has(u) || BUILTINS.has(u) || /^\d/.test(u), `${f.name}: geometry refers to unknown parameter "${u}"`);
  }
  // Every family's formulas evaluate without errors from defaults.
  const res = FE.evaluateParameters(f.parameters, {});
  ok(res.errors.length === 0, `${f.name}: formula errors: ${JSON.stringify(res.errors)}`);
}

// ---- the two fixed bugs, proved by evaluation, not just by name ----
// Pipe: DN 100 has thickness 0.1; circumference = pi * 0.1, area = pi * 0.05^2.
const pipe = families.find((f) => f.id.startsWith("builtin-pipe-"));
ok(pipe, "pipe family exists");
const pipeType = pipe.types.find((t) => t.name === "DN 100");
const pipeRes = FE.evaluateParameters(pipe.parameters, { ...pipeType.values });
ok(pipeRes.errors.length === 0, `pipe DN 100 formula errors: ${JSON.stringify(pipeRes.errors)}`);
near(pipeRes.values.circumference, Math.PI * 0.1);
near(pipeRes.values.crossSectionArea, Math.PI * 0.05 * 0.05);
// Slab: types now set height (the declared thickness parameter).
const slab = families.find((f) => f.id.startsWith("builtin-slab-"));
ok(slab, "slab family exists");
for (const [name, h] of [["Concrete 150 mm", 0.15], ["Concrete 200 mm", 0.2], ["Concrete 250 mm", 0.25]]) {
  const t = slab.types.find((x) => x.name === name);
  ok(t && t.values.height === h, `slab type "${name}" sets height ${h}, got ${JSON.stringify(t && t.values)}`);
  const r = FE.evaluateParameters(slab.parameters, { ...t.values });
  ok(r.errors.length === 0 && r.values.height === h, `slab "${name}" resolves height ${h}`);
}

console.log(`builtin-family-data: ${n} assertions passed`);
