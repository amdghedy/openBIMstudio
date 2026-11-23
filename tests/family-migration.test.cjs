/**
 * tests/family-migration.test.cjs
 *
 * Revit parity Rank 6, item 4 — family versioning / migration.
 *
 * `schemaVersion` was 1 everywhere with no migrator: a family saved by
 * an older build (or hand-written JSON) loaded verbatim, so a parameter
 * without a `scope`, a type value naming a parameter the family no
 * longer declares, or a family with no types at all all reached the
 * engine and the panel unchecked. `migrateFamilyDefinition`
 * (src/modules/families/migration.ts) is the v1 → v2 migrator.
 *
 * The module under test is compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-voids-sweeps-lofts.test.cjs). It has no runtime
 * imports (types only), so the compile is trivial.
 *
 * Run: `node tests/family-migration.test.cjs`
 * CI:  `test:family-migration` (package.json +
 *       scripts/ci-unit-tests.mjs).
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".family-migration-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/migration.ts"
  + " --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck",
  { cwd: root, stdio: "inherit", shell: true },
);
const find = (n) => {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (f.name === n) return p;
    }
    return null;
  };
  return walk(tmpOut);
};
const { migrateFamilyDefinition, CURRENT_FAMILY_SCHEMA_VERSION } = require(find("migration.js"));

const base = (over = {}) => ({
  id: "fam-1",
  name: "Test Family",
  category: "generic",
  ifcEntity: "IfcBuildingElementProxy",
  schemaVersion: 1,
  builtIn: false,
  parameters: [
    { name: "width", type: "length", scope: "type", default: 2, editable: true },
    { name: "height", type: "length", scope: "instance", default: 1, editable: true },
  ],
  geometry: { kind: "box", w: { ref: "width" }, d: { const: 1 }, h: { ref: "height" } },
  types: [{ id: "t1", name: "Default", values: { width: 2 } }],
  ...over,
});

t("V0 the current schema version is 2", () => {
  eq(CURRENT_FAMILY_SCHEMA_VERSION, 2);
});

t("V1 a clean v1 family migrates to v2 with no warnings and no other change", () => {
  const r = migrateFamilyDefinition(base());
  eq(r.migratedFrom, 1);
  eq(r.family.schemaVersion, 2);
  eq(r.warnings, []);
  eq(r.family.parameters, base().parameters);
  eq(r.family.types, base().types);
});

t("V2 a missing schemaVersion is assumed v1 (pre-versioning save)", () => {
  const input = base();
  delete input.schemaVersion;
  const r = migrateFamilyDefinition(input);
  eq(r.migratedFrom, 1);
  eq(r.family.schemaVersion, 2);
  if (!r.warnings.some((w) => /schemaVersion/i.test(w))) throw new Error("expected a schemaVersion warning");
});

t("V3 a parameter without a scope defaults to instance (the safe default)", () => {
  const input = base();
  delete input.parameters[0].scope;
  const r = migrateFamilyDefinition(input);
  eq(r.family.parameters[0].scope, "instance");
  eq(r.migratedFrom, 1);
  if (!r.warnings.some((w) => /scope/i.test(w))) throw new Error("expected a scope warning");
});

t("V4 a parameter without a type is inferred from its default", () => {
  const input = base();
  delete input.parameters[0].type;
  input.parameters[1].type = undefined;
  input.parameters[1].default = "brick";
  const r = migrateFamilyDefinition(input);
  eq(r.family.parameters[0].type, "number");
  eq(r.family.parameters[1].type, "text");
});

t("V5 stale type values (undeclared parameters) are pruned with a warning", () => {
  const input = base();
  input.types = [{ id: "t1", name: "Default", values: { width: 2, removedParam: 5, alsoGone: "x" } }];
  const r = migrateFamilyDefinition(input);
  eq(r.family.types[0].values, { width: 2 });
  if (!r.warnings.some((w) => /removedParam/.test(w) && /alsoGone/.test(w))) {
    throw new Error(`expected a stale-values warning, got: ${r.warnings.join("; ")}`);
  }
});

t("V6 a family with no types gains a Default type", () => {
  const input = base({ types: [] });
  const r = migrateFamilyDefinition(input);
  eq(r.family.types.length, 1);
  eq(r.family.types[0].name, "Default");
  eq(r.family.types[0].values, {});
  if (!r.warnings.some((w) => /no types/i.test(w))) throw new Error("expected a no-types warning");
});

t("V7 an already-current v2 family is returned unchanged (migration is idempotent)", () => {
  const input = base({ schemaVersion: 2 });
  const r1 = migrateFamilyDefinition(input);
  eq(r1.migratedFrom, null);
  eq(r1.warnings, []);
  eq(r1.family, input);
  const r2 = migrateFamilyDefinition(r1.family);
  eq(r2.migratedFrom, null);
  eq(r2.warnings, []);
  eq(r2.family, r1.family);
});

t("V8 an unknown geometry kind warns and is kept as-is (never invented)", () => {
  const input = base();
  input.geometry = { kind: "teleport", w: { const: 1 } };
  const r = migrateFamilyDefinition(input);
  eq(r.family.geometry.kind, "teleport");
  eq(r.family.schemaVersion, 2);
  if (!r.warnings.some((w) => /unknown geometry kind/i.test(w))) throw new Error("expected an unknown-kind warning");
});

t("V9 a newer schema version is kept as-is with a warning, never downgraded", () => {
  const input = base({ schemaVersion: 3 });
  const r = migrateFamilyDefinition(input);
  eq(r.migratedFrom, null);
  eq(r.family.schemaVersion, 3);
  if (!r.warnings.some((w) => /newer/i.test(w))) throw new Error("expected a newer-version warning");
});

t("V10 unrecoverable input throws: no id, no name, no parameters array, duplicate parameters, duplicate type ids", () => {
  assert.throws(() => migrateFamilyDefinition(base({ id: "" })), /no id/);
  assert.throws(() => migrateFamilyDefinition(base({ name: "  " })), /no name/);
  assert.throws(() => migrateFamilyDefinition(base({ parameters: "nope" })), /parameters array/);
  assert.throws(() => migrateFamilyDefinition(base({ geometry: { kind: 7 } })), /geometry/);
  const dupParam = base();
  dupParam.parameters.push({ name: "width", type: "length", scope: "type", default: 1, editable: true });
  assert.throws(() => migrateFamilyDefinition(dupParam), /twice/);
  const dupType = base();
  dupType.types.push({ id: "t1", name: "Copy", values: {} });
  assert.throws(() => migrateFamilyDefinition(dupType), /two types/);
  assert.throws(() => migrateFamilyDefinition(null), /not an object/);
  assert.throws(() => migrateFamilyDefinition("family"), /not an object/);
});

t("V13 a type without an id gets one assigned (never drops the family)", () => {
  const input = base();
  delete input.types[0].id;
  const r = migrateFamilyDefinition(input);
  eq(typeof r.family.types[0].id, "string");
  if (!r.family.types[0].id) throw new Error("expected an assigned type id");
  if (!r.warnings.some((w) => /no id/i.test(w))) throw new Error("expected a missing-id warning");
});

t("V14 duplicate type ids still throw (an identity collision is ambiguous)", () => {
  const dupType = base();
  dupType.types.push({ id: "t1", name: "Copy", values: {} });
  assert.throws(() => migrateFamilyDefinition(dupType), /two types/);
});

t("V11 the input is never mutated (the result is a deep clone)", () => {
  const input = base();
  input.parameters[0].scope = undefined;
  const snapshot = JSON.stringify(input);
  migrateFamilyDefinition(input);
  eq(JSON.stringify(input), snapshot);
});

t("V12 a parameter with no type and no usable default throws", () => {
  const input = base();
  delete input.parameters[0].type;
  input.parameters[0].default = undefined;
  assert.throws(() => migrateFamilyDefinition(input), /no type/);
});


t("V15 missing type IDs remain stable when uniquely named types are reordered", () => {
  const input = base({ schemaVersion: 2, types: [
    { name: "400x400 C30", values: { width: 0.4 } },
    { name: "500x500 C35", values: { width: 0.5 } },
    { name: "600x400 C40", values: { width: 0.6 } },
  ] });
  const first = migrateFamilyDefinition(input).family.types;
  const reordered = migrateFamilyDefinition({ ...input, types: [...input.types].reverse() }).family.types;
  const ids = new Map(first.map((x) => [x.name, x.id]));
  for (const x of reordered) eq(x.id, ids.get(x.name), `ID changed for ${x.name}`);
});

t("V16 existing type IDs are preserved while missing IDs are generated", () => {
  const input = base({ schemaVersion: 2, types: [
    { id: "legacy-stable-id", name: "Existing", values: {} },
    { name: "New type", values: {} },
  ] });
  const r = migrateFamilyDefinition(input);
  eq(r.family.types[0].id, "legacy-stable-id");
  if (!r.family.types[1].id) throw new Error("missing ID was not generated");
});

t("V17 same-name types with different values receive distinct stable IDs", () => {
  const input = base({ schemaVersion: 2, types: [
    { name: "400 x 400", values: { width: 0.4 } },
    { name: "400   x   400", values: { width: 0.5 } },
  ] });
  const first = migrateFamilyDefinition(input).family.types;
  const reordered = migrateFamilyDefinition({ ...input, types: [...input.types].reverse() }).family.types;
  const ids = new Map(first.map((x) => [x.values.width, x.id]));
  for (const x of reordered) eq(x.id, ids.get(x.values.width));
  if (first[0].id === first[1].id) throw new Error("same-name types collided");
});

t("V18 generated IDs are stable and migration remains idempotent", () => {
  const input = base({ schemaVersion: 2, types: [{ name: "UB 457x191x67", values: {} }] });
  const once = migrateFamilyDefinition(input).family;
  const twice = migrateFamilyDefinition(once);
  eq(twice.family.types[0].id, once.types[0].id);
  eq(twice.migratedFrom, null);
});
\nconsole.log(`\nfamily-migration: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
