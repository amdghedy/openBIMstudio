/**
 * tests/catalog-shared-parameters.test.cjs
 *
 * Slice 8 (Revit parity gap 8): catalog <-> family sync and
 * shared-parameter `.txt` import.
 *
 *   - C1: catalog import CREATES family types that do not exist yet.
 *   - C2: catalog import UPDATES an existing type by name
 *     (case-insensitive), merging values — parameters the catalog
 *     does not mention keep their old values.
 *   - C3: a catalog column naming a parameter the family does not
 *     declare is skipped for every row and reported once.
 *   - C4: a catalog value whose JSON type does not fit the family
 *     parameter's declared type is skipped for that row and reported.
 *   - C5: family -> catalog -> CSV -> parse round-trips the types.
 *   - C6: syncing a catalog to a family that does not exist throws.
 *   - S1: a Revit-format shared-parameter `.txt` file imports
 *     (groups, GUIDs, types, VISIBLE flag, descriptions).
 *   - S2: `.txt` export round-trips the imported definitions.
 *   - S3: the manager works with a null storage handle (in-memory
 *     cache) — create followed by findByName. On main this failed:
 *     the storage-only manager silently dropped the write.
 *   - S4: `.txt` import with a null storage handle works.
 *   - S5: malformed `.txt` input throws with a line number.
 *   - S6: JSON import merge rules are preserved (existing GUID
 *     updated, duplicate name with a different GUID skipped).
 *   - S7: a fresh manager instance still reloads from shared storage.
 *
 * The sync is written against a minimal `FamilyTypeStore` interface
 * (`get` / `createType` / `updateType`); the test uses a small
 * in-memory implementation of that contract because the real
 * `FamilyStore` is a browser module (imports `projects`, uses
 * `localStorage`). The real store's compatibility is proven at
 * compile time by the assignability check in `catalog-sync.ts`
 * (verified by `npm run typecheck`).
 *
 * Run: `node tests/catalog-shared-parameters.test.cjs`
 * CI:  `test:catalog-shared-parameters` (package.json +
 *       scripts/ci-unit-tests.mjs). The pre-existing
 *       `tests/shared-parameters.test.mjs` is wired as
 *       `test:shared-parameters` in the same change.
 *
 * The modules under test are compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-nested-families.test.cjs), so no `three` import is
 * needed here.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".catalog-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/catalog-sync.ts src/modules/families/type-catalog.ts src/modules/families/shared-parameters.ts"
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
const SYNC = require(find("catalog-sync.js"));
const CAT = require(find("type-catalog.js"));
const SP = require(find("shared-parameters.js"));

// ── In-memory FamilyTypeStore ───────────────────────────────────────────────
function makeStore() {
  const byId = new Map();
  let seq = 0;
  return {
    byId,
    get: (id) => byId.get(id) ?? null,
    addFamily: (fam) => { byId.set(fam.id, JSON.parse(JSON.stringify(fam))); return byId.get(fam.id); },
    createType: (familyId, name, values = {}) => {
      const fam = byId.get(familyId);
      if (!fam) return null;
      const ty = { id: `t${++seq}`, name, values };
      fam.types.push(ty);
      return ty;
    },
    updateType: (familyId, typeId, patch) => {
      const fam = byId.get(familyId);
      if (!fam) return null;
      const idx = fam.types.findIndex((x) => x.id === typeId);
      if (idx < 0) return null;
      fam.types[idx] = { ...fam.types[idx], ...patch, id: typeId };
      return fam.types[idx];
    },
  };
}
const P = (name, type, def) => ({ name, type, scope: "type", default: def, editable: true });
const doorFamily = () => ({
  id: "door", name: "Door", category: "generic", ifcEntity: "IfcDoor",
  schemaVersion: 1, builtIn: false,
  parameters: [
    P("Width", "length", 0.9), P("Height", "length", 2.1), P("Count", "integer", 1),
    P("Operable", "boolean", true), P("Label", "text", ""), P("FireRating", "text", "2h"),
  ],
  geometry: { kind: "box", w: { const: 1 }, d: { const: 1 }, h: { const: 1 } },
  types: [
    { id: "t-single", name: "Single", values: { Width: 0.9, Height: 2.1, Count: 1, Operable: true, Label: "Main", FireRating: "2h" } },
  ],
});
const CATALOG_CSV = [
  "##TYPE",
  "Door,Width##length,Height##length,Count##integer,Operable##yesno,Label##string",
  "Single,1.0,2.2,4,No,Updated entry",
  "Double,1.8,2.1,2,Yes,Double door",
].join("\n");

// ── C1-C6. Catalog <-> family sync ──────────────────────────────────────────
t("C1 catalog import creates missing types with their values", () => {
  const store = makeStore();
  const fam = store.addFamily({ ...doorFamily(), types: [] });
  const catalog = CAT.TypeCatalogManager.parseCSV(CATALOG_CSV);
  const report = SYNC.syncCatalogToFamily(catalog, fam.id, store);
  assert.deepStrictEqual(report.created, ["Single", "Double"]);
  assert.deepStrictEqual(report.updated, []);
  assert.deepStrictEqual(report.unknownParameters, []);
  assert.deepStrictEqual(report.skippedValues, []);
  assert.strictEqual(store.get("door").types.length, 2);
  const dbl = store.get("door").types.find((x) => x.name === "Double");
  assert.deepStrictEqual(dbl.values, { Width: 1.8, Height: 2.1, Count: 2, Operable: true, Label: "Double door" });
});

t("C2 catalog import updates by name (case-insensitive) and merges values", () => {
  const store = makeStore();
  const fam = store.addFamily(doorFamily());
  const csv = [
    "##TYPE",
    "Door,Width##length,Label##string",
    "single,1.0,Renamed",
    "Triple,2.7,Wide",
  ].join("\n");
  const report = SYNC.syncCatalogToFamily(CAT.TypeCatalogManager.parseCSV(csv), fam.id, store);
  assert.deepStrictEqual(report.created, ["Triple"]);
  assert.deepStrictEqual(report.updated, ["Single"]);
  const single = store.get("door").types.find((x) => x.id === "t-single");
  assert.strictEqual(single.values.Width, 1.0, "catalog value overwrites");
  assert.strictEqual(single.values.Label, "Renamed", "catalog value overwrites");
  assert.strictEqual(single.values.Height, 2.1, "parameter the catalog omits keeps its value");
  assert.strictEqual(single.values.FireRating, "2h", "parameter the catalog omits keeps its value");
  assert.strictEqual(single.values.Count, 1, "parameter the catalog omits keeps its value");
});

t("C3 catalog columns naming undeclared parameters are skipped and reported", () => {
  const store = makeStore();
  const fam = store.addFamily({ ...doorFamily(), types: [] });
  const csv = [
    "##TYPE",
    "Door,Width##length,NoSuchParam##number",
    "Single,1.0,42",
  ].join("\n");
  const report = SYNC.syncCatalogToFamily(CAT.TypeCatalogManager.parseCSV(csv), fam.id, store);
  assert.deepStrictEqual(report.unknownParameters, ["NoSuchParam"]);
  assert.deepStrictEqual(report.created, ["Single"]);
  assert.deepStrictEqual(store.get("door").types[0].values, { Width: 1.0 });
});

t("C4 a catalog value that does not fit the family parameter type is skipped", () => {
  const store = makeStore();
  const fam = store.addFamily({ ...doorFamily(), types: [] });
  const csv = [
    "##TYPE",
    "Door,Width##length,Count##string",
    "Single,1.0,four",
  ].join("\n");
  const report = SYNC.syncCatalogToFamily(CAT.TypeCatalogManager.parseCSV(csv), fam.id, store);
  assert.strictEqual(report.skippedValues.length, 1, "one value skipped");
  assert.strictEqual(report.skippedValues[0].parameter, "Count");
  assert.strictEqual(report.skippedValues[0].typeName, "Single");
  assert.deepStrictEqual(store.get("door").types[0].values, { Width: 1.0 });
});

t("C5 family -> catalog -> CSV -> parse round-trips the types", () => {
  const fam = doorFamily();
  const exported = SYNC.catalogFromFamily(fam);
  assert.strictEqual(exported.familyName, "Door");
  assert.deepStrictEqual(exported.parameters.map((p) => [p.name, p.type]), [
    ["Width", "length"], ["Height", "length"], ["Count", "integer"],
    ["Operable", "yesno"], ["Label", "string"], ["FireRating", "string"],
  ]);
  const csv = CAT.TypeCatalogManager.toCSV(exported);
  const reparsed = CAT.TypeCatalogManager.parseCSV(csv);
  assert.deepStrictEqual(reparsed.types, [
    { typeName: "Single", values: { Width: 0.9, Height: 2.1, Count: 1, Operable: true, Label: "Main", FireRating: "2h" } },
  ]);
  // And the round-tripped catalog syncs back onto a bare family.
  const store = makeStore();
  const bare = store.addFamily({ ...doorFamily(), types: [] });
  const report = SYNC.syncCatalogToFamily(reparsed, bare.id, store);
  assert.deepStrictEqual(report.created, ["Single"]);
  assert.deepStrictEqual(store.get("door").types[0].values, fam.types[0].values);
});

t("C6 syncing to a family that does not exist throws", () => {
  const store = makeStore();
  const catalog = CAT.TypeCatalogManager.parseCSV(CATALOG_CSV);
  assert.throws(() => SYNC.syncCatalogToFamily(catalog, "nope", store), /does not exist/);
});

// ── S1-S7. Shared parameters ───────────────────────────────────────────────
const TXT = [
  "# This is a Revit shared parameter file. Do not edit manually.",
  "*META\tVERSION\tMINVERSION",
  "META\t2\t1",
  "*GROUP\tID\tNAME",
  "GROUP\t1\tDimensions",
  "GROUP\t2\tIdentity Data",
  "*PARAM\tGUID\tNAME\tDATACATEGORY\tDATATYPE\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE\tHIDEWHENNOVALUE",
  "PARAM\t11111111-1111-4111-8111-111111111111\tWidth\tLENGTH\tLENGTH\t1\t1\tPanel width\t1\t0",
  "PARAM\t22222222-2222-4222-8222-222222222222\tFire Rating\tTEXT\tTEXT\t2\t0\tRating text\t1\t0",
  "PARAM\t33333333-3333-4333-8333-333333333333\tOperable\tYESNO\tYESNO\t1\t1\t\t1\t0",
  "PARAM\t44444444-4444-4444-8444-444444444444\tCount\tINTEGER\tINTEGER\t1\t1\t\t1\t0",
].join("\r\n");

t("S1 Revit .txt file imports groups, GUIDs, types and flags", () => {
  const m = new SP.SharedParameterManager(null);
  const defs = m.importText(TXT);
  assert.strictEqual(defs.length, 4);
  const width = m.findByName("width");
  assert.ok(width, "findByName is case-insensitive");
  assert.strictEqual(width.guid, "11111111-1111-4111-8111-111111111111", "GUID preserved");
  assert.strictEqual(width.type, "length");
  assert.strictEqual(width.group, "Dimensions");
  assert.strictEqual(width.description, "Panel width");
  assert.strictEqual(width.visible, true);
  const rating = m.findByName("Fire Rating");
  assert.strictEqual(rating.type, "string");
  assert.strictEqual(rating.group, "Identity Data");
  assert.strictEqual(rating.visible, false, "VISIBLE=0 is honoured");
  assert.strictEqual(m.findByName("Operable").type, "boolean");
  assert.strictEqual(m.findByName("Count").type, "integer");
  assert.strictEqual(m.listByGroup("dimensions").length, 3);
});

t("S2 .txt export round-trips the imported definitions", () => {
  const m = new SP.SharedParameterManager(null);
  const first = m.importText(TXT);
  const out = m.exportText();
  const reparsed = SP.parseSharedParameterText(out);
  assert.deepStrictEqual(reparsed, first);
});

t("S3 the manager works with a null storage handle (in-memory cache)", () => {
  const m = new SP.SharedParameterManager(null);
  const created = m.create({ name: "Area", group: "Dimensions", type: "area", defaultValue: 10, isInstance: false });
  assert.strictEqual(m.findByName("area")?.guid, created.guid, "create followed by findByName");
  assert.strictEqual(m.list().length, 1);
  assert.strictEqual(m.listByGroup("dimensions").length, 1);
  assert.strictEqual(m.delete(created.guid), true);
  assert.strictEqual(m.get(created.guid), null);
});

t("S4 .txt import with a null storage handle works", () => {
  const m = new SP.SharedParameterManager(null);
  m.importText(TXT);
  assert.strictEqual(m.list().length, 4);
  assert.strictEqual(m.findByName("WIDTH")?.group, "Dimensions");
});

t("S5 malformed .txt input throws with a line number", () => {
  assert.throws(() => SP.parseSharedParameterText(TXT.replace("11111111-1111-4111-8111-111111111111", "not-a-guid")), /Line 8.*GUID/);
  assert.throws(() => SP.parseSharedParameterText(TXT.replace("LENGTH\tLENGTH", "WIDGET\tWIDGET")), /Line 8.*DATACATEGORY/);
  assert.throws(() => SP.parseSharedParameterText(TXT.replace("PARAM\t11111111-1111-4111-8111-111111111111\tWidth\tLENGTH\tLENGTH\t1\t", "PARAM\t11111111-1111-4111-8111-111111111111\tWidth\tLENGTH\tLENGTH\t9\t")), /Line 8.*GROUP id/);
  assert.throws(() => SP.parseSharedParameterText("hello\n"), /unexpected content/);
  assert.throws(() => SP.parseSharedParameterText(""), /empty/);
});

t("S6 JSON import merge rules are preserved", () => {
  const m = new SP.SharedParameterManager(null);
  const guid = "55555555-5555-4555-8555-555555555555";
  m.create({ guid, name: "Width", group: "Dimensions", type: "length", defaultValue: 1, isInstance: true });
  const merged = m.import(JSON.stringify([
    { guid, name: "Width", group: "Dimensions", type: "length", defaultValue: 2, isInstance: true },
    { guid: "66666666-6666-4666-8666-666666666666", name: "WIDTH", group: "Dimensions", type: "length", defaultValue: 3, isInstance: true },
    { guid: "77777777-7777-4777-8777-777777777777", name: "Height", group: "Dimensions", type: "length", defaultValue: 4, isInstance: true },
  ]));
  assert.strictEqual(merged.length, 2, "duplicate name with a different GUID is skipped");
  assert.strictEqual(m.findByName("Width").defaultValue, 2, "existing GUID is updated");
  assert.strictEqual(m.findByName("Height").defaultValue, 4, "new GUID is added");
});

t("S7 a fresh manager instance reloads from shared storage", () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const first = new SP.SharedParameterManager(storage);
  const saved = first.create({ name: "FireRating", group: "Identity", type: "string", defaultValue: "2h", isInstance: true });
  const reloaded = new SP.SharedParameterManager(storage);
  assert.deepStrictEqual(reloaded.get(saved.guid), saved);
  assert.strictEqual(reloaded.list().length, 1);
});

console.log(`\ncatalog-shared-parameters: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
