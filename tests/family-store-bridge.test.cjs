/**
 * tests/family-store-bridge.test.cjs
 *
 * Family Creator audit item 1 — bridge the two family stores.
 *
 * The TS service (familyStore) and the legacy editor
 * (public/js/obs-family-editor.js) never met: an editor save stayed in
 * localStorage `obs.families.v1` and a service family never appeared in
 * the editor's library. `src/modules/families/family-bridge.ts` syncs
 * them both ways (plus shared parameters); this suite pins the
 * conversion and merge rules with a fake store / manager / storage.
 *
 * The module under test is compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/family-migration.test.cjs). Its only runtime import is the
 * family migrator, so the compile is a two-file closure.
 *
 * Run: `node tests/family-store-bridge.test.cjs`
 * CI:  `test:family-store-bridge` (package.json +
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
const ok = (c, m) => assert.ok(c, m);

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".family-bridge-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/family-bridge.ts"
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
const bridge = require(find("family-bridge.js"));
const { migrateFamilyDefinition } = require(find("migration.js"));

// ── Fakes ───────────────────────────────────────────────────────────────────
let uidN = 0;
const uid = () => `test-id-${++uidN}`;

class FakeStore {
  constructor() { this.byId = new Map(); this.changes = 0; }
  list() { return [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  get(id) { return this.byId.get(id) ?? null; }
  create(def) {
    const migrated = migrateFamilyDefinition({ ...def, id: uid(), schemaVersion: 2, builtIn: false });
    this.byId.set(migrated.family.id, migrated.family);
    this.changes++;
    return migrated.family;
  }
  update(id, patch) {
    const cur = this.byId.get(id);
    if (!cur) return null;
    const next = migrateFamilyDefinition({ ...cur, ...patch, id: cur.id }).family;
    this.byId.set(id, next);
    this.changes++;
    return next;
  }
  remove(id) {
    const cur = this.byId.get(id);
    if (!cur || cur.builtIn) return false;
    this.changes++;
    return this.byId.delete(id);
  }
  /** Insert a record verbatim (built-ins, seed families). */
  seed(def) {
    const migrated = migrateFamilyDefinition(def);
    this.byId.set(migrated.family.id, migrated.family);
    return migrated.family;
  }
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

class FakeManager {
  constructor() { this.params = []; }
  findByName(name) {
    return this.params.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  create(input) {
    if (this.findByName(input.name)) throw new Error(`A shared parameter named "${input.name}" already exists.`);
    const guid = input.guid || uid();
    if (this.params.some((p) => p.guid === guid)) throw new Error(`GUID "${guid}" already exists.`);
    const p = { guid, ...input };
    this.params.push(p);
    return p;
  }
  list() { return this.params.map((p) => ({ ...p })); }
  delete(guid) {
    const before = this.params.length;
    this.params = this.params.filter((p) => p.guid !== guid);
    return this.params.length < before;
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const editorDoor = () => ({
  name: "Single Door",
  category: "Doors",
  description: "Rectangular single-leaf door",
  manufacturer: "",
  model: "",
  version: "1.0",
  placement: { kind: "HostBased", host: "Wall", workPlane: "XY" },
  parameters: [
    { name: "Width", kind: "Length", isType: true, default: 0.9, formula: "", group: "Dimensions" },
    { name: "Height", kind: "Length", isType: true, default: 2.1, formula: "", group: "Dimensions" },
    { name: "Thickness", kind: "Length", isType: true, default: 0.04, formula: "", group: "Dimensions" },
    { name: "FrameWidth", kind: "Length", isType: true, default: 0.05, formula: "", group: "Frame" },
  ],
  types: [
    { name: "900 × 2100", values: { Width: 0.9, Height: 2.1 } },
    { name: "800 × 2000", values: { Width: 0.8, Height: 2.0 } },
  ],
  constraints: [],
  sharedParamRefs: [],
  geometry: {
    kind: "Extrusion",
    profile: { kind: "Rectangle", width: "Width", height: "Height" },
    depth: "Thickness",
    angle: "360",
    path: "",
    origin: { x: 0, y: 0, z: 0 },
    solid: true,
    voids: [],
  },
});

const tsComposedDoor = () => ({
  id: "door-svc-1",
  name: "Parametric Door",
  category: "door",
  ifcEntity: "IfcDoor",
  schemaVersion: 2,
  sourceElementType: "door",
  builtIn: false,
  group: "Architecture",
  parameters: [
    { name: "Width", type: "length", scope: "type", default: 0.9, editable: true, group: "Dimensions" },
    { name: "Height", type: "length", scope: "type", default: 2.1, editable: true, group: "Dimensions" },
    { name: "IsSingle", type: "boolean", scope: "type", default: true, editable: false, formula: "= eq(LeafCount, 1)", group: "Configuration" },
  ],
  geometry: {
    kind: "composed",
    parts: [
      { kind: "box", w: { ref: "Width" }, d: { const: 0.1 }, h: { ref: "Height" } },
    ],
  },
  types: [{ id: "t-door-1", name: "900 × 2100", values: { Width: 0.9 } }],
});

// ── Conversion: editor -> TS ─────────────────────────────────────────────────
t("C1 editor door converts: category, ifc, params, types, extrusion", () => {
  const def = bridge.editorFamilyToDefinition(editorDoor());
  eq(def.name, "Single Door");
  eq(def.category, "door");
  eq(def.ifcEntity, "IfcDoor");
  eq(def.origin, "editor");
  eq(def.parameters.map((p) => [p.name, p.type, p.scope]), [
    ["Width", "length", "type"],
    ["Height", "length", "type"],
    ["Thickness", "length", "type"],
    ["FrameWidth", "length", "type"],
  ]);
  eq(def.parameters[0].default, 0.9);
  eq(def.types.map((ty) => ty.name), ["900 × 2100", "800 × 2000"]);
  eq(def.types[0].values, { Width: 0.9, Height: 2.1 });
  eq(def.geometry.kind, "extrusion");
  eq(def.geometry.profile, { kind: "rect", w: { ref: "Width" }, h: { ref: "Height" } });
  eq(def.geometry.depth, { ref: "Thickness" });
  ok(def.editorSource && def.editorSource.name === "Single Door", "verbatim editor record preserved");
  eq(def.editorSource.placement, { kind: "HostBased", host: "Wall", workPlane: "XY" });
});

t("C2 numeric-string depth becomes a constant; empty depth becomes 0", () => {
  const f = editorDoor();
  f.geometry.depth = "0.08";
  eq(bridge.editorFamilyToDefinition(f).geometry.depth, { const: 0.08 });
  f.geometry.depth = "";
  eq(bridge.editorFamilyToDefinition(f).geometry.depth, { const: 0 });
});

t("C3 YesNo / Text / Integer kinds and instance scope map", () => {
  const f = editorDoor();
  f.parameters = [
    { name: "Open", kind: "YesNo", isType: false, default: 1, formula: "", group: "G" },
    { name: "Label", kind: "Text", isType: false, default: "A", formula: "", group: "G" },
    { name: "Count", kind: "Integer", isType: true, default: 2, formula: "", group: "G" },
  ];
  const def = bridge.editorFamilyToDefinition(f);
  eq(def.parameters.map((p) => [p.type, p.scope, p.default]), [
    ["boolean", "instance", true],
    ["text", "instance", "A"],
    ["integer", "type", 2],
  ]);
});

t("C4 unknown category/kind fall back to generic/number", () => {
  const f = editorDoor();
  f.category = "Site";
  f.parameters = [{ name: "X", kind: "Length", isType: true, default: 1, formula: "", group: "G" }];
  const def = bridge.editorFamilyToDefinition(f);
  eq(def.category, "generic");
  eq(def.ifcEntity, "IfcBuildingElementProxy");
});

t("C5 Revolve keeps its kind and round-trips its recipe exactly", () => {
  const f = editorDoor();
  f.geometry = {
    kind: "Revolve",
    profile: { kind: "Rectangle", width: "Width", height: "Height" },
    depth: "Depth", angle: "270", path: "", origin: { x: 0, y: 0, z: 0 }, solid: true, voids: [],
  };
  const def = bridge.editorFamilyToDefinition(f);
  eq(def.geometry.kind, "revolve");
  const back = bridge.definitionToEditorFamily({ ...def, id: "x", schemaVersion: 2, builtIn: false });
  eq(back.geometry.kind, "Revolve");
  eq(back.geometry.angle, "270");
  eq(back.serviceId, "x");
});

t("C6 type values naming undeclared parameters are pruned", () => {
  const f = editorDoor();
  f.types = [{ name: "Odd", values: { Width: 1, NoSuch: 5 } }];
  const def = bridge.editorFamilyToDefinition(f);
  eq(def.types[0].values, { Width: 1 });
});

t("C7 duplicate parameter names and a missing name throw", () => {
  const dup = editorDoor();
  dup.parameters.push({ name: "Width", kind: "Length", isType: true, default: 1, formula: "", group: "G" });
  assert.throws(() => bridge.editorFamilyToDefinition(dup), /twice/);
  assert.throws(() => bridge.editorFamilyToDefinition({ ...editorDoor(), name: "  " }), /no name/);
});

t("C8 equal/ratio constraints map; range is skipped but preserved", () => {
  const f = editorDoor();
  f.constraints = [
    { kind: "equal", target: ["Width", "Height"], params: {} },
    { kind: "ratio", target: ["Width", "Height"], params: { ratio: 1.5 } },
    { kind: "range", target: ["Width"], params: { min: 0.1, max: 10 } },
  ];
  const { constraints, skipped } = bridge.editorConstraintsToTs(f.constraints);
  eq(constraints, [
    { kind: "equality", a: "Width", b: "Height" },
    { kind: "ratio", a: "Width", b: "Height", k: 1.5 },
  ]);
  eq(skipped, 1);
  const def = bridge.editorFamilyToDefinition(f);
  eq(def.editorSource.constraints.length, 3);
});

// ── Conversion: TS -> editor ─────────────────────────────────────────────────
t("C9 TS composed door converts: category, YesNo 1/0, formula kept, geometry preserved", () => {
  const ed = bridge.definitionToEditorFamily(tsComposedDoor());
  eq(ed.name, "Parametric Door");
  eq(ed.category, "Doors");
  eq(ed.parameters.find((p) => p.name === "IsSingle").kind, "YesNo");
  eq(ed.parameters.find((p) => p.name === "IsSingle").default, 1);
  eq(ed.parameters.find((p) => p.name === "IsSingle").formula, "= eq(LeafCount, 1)");
  eq(ed.geometry.kind, "Composed");
  eq(ed.serviceGeometry.kind, "composed");
  eq(ed.serviceGeometry.parts.length, 1);
  eq(ed.serviceId, "door-svc-1");
  eq(ed.serviceIfcEntity, "IfcDoor");
});

t("C10 TS extrusion converts faithfully, including a numeric depth", () => {
  const def = {
    id: "ext-1", name: "Box", category: "generic", ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 2, builtIn: false,
    parameters: [
      { name: "Width", type: "length", scope: "type", default: 2, editable: true },
      { name: "Height", type: "length", scope: "type", default: 1, editable: true },
    ],
    geometry: { kind: "extrusion", profile: { kind: "rect", w: { ref: "Width" }, h: { ref: "Height" } }, depth: { const: 0.5 } },
    types: [{ id: "t1", name: "Default", values: {} }],
  };
  const ed = bridge.definitionToEditorFamily(def);
  eq(ed.geometry.kind, "Extrusion");
  eq(ed.geometry.profile, { kind: "Rectangle", width: "Width", height: "Height" });
  eq(ed.geometry.depth, 0.5);
  eq(ed.serviceGeometry, undefined);
});

t("C11 TS family edited in the editor keeps its composed geometry on save-back", () => {
  const ed = bridge.definitionToEditorFamily(tsComposedDoor());
  // The user edits a parameter in the editor and saves.
  ed.parameters.find((p) => p.name === "Width").default = 1.0;
  const def = bridge.editorFamilyToDefinition(ed);
  eq(def.geometry.kind, "composed");
  eq(def.geometry.parts.length, 1);
  eq(def.parameters.find((p) => p.name === "Width").default, 1.0);
});

// ── Push / import / export ──────────────────────────────────────────────────
t("P1 push creates, repeat push updates the same family with stable type ids", () => {
  const store = new FakeStore();
  const ed = editorDoor();
  const r1 = bridge.pushEditorFamily(store, ed);
  ok(r1.created, "first push creates");
  ok(typeof ed.serviceId === "string" && ed.serviceId.length > 0, "serviceId stamped");
  eq(store.list().length, 1);
  const firstTypeId = store.get(r1.id).types[0].id;
  // Edit a type value and push again.
  ed.types[0].values.Width = 1.0;
  const r2 = bridge.pushEditorFamily(store, ed);
  ok(!r2.created, "second push updates");
  eq(r2.id, r1.id);
  eq(store.list().length, 1);
  eq(store.get(r1.id).types[0].id, firstTypeId, "type id stable across saves");
  eq(store.get(r1.id).types[0].values.Width, 1.0);
});

t("P2 push by name match: a fresh editor object with the same name updates, never duplicates", () => {
  const store = new FakeStore();
  bridge.pushEditorFamily(store, editorDoor());
  const again = editorDoor();
  again.parameters[0].default = 1.2;
  const r = bridge.pushEditorFamily(store, again);
  ok(!r.created, "matched by name");
  eq(store.list().length, 1);
  eq(store.list()[0].parameters[0].default, 1.2);
});

t("P3 import is idempotent and skips corrupt entries with a report", () => {
  const store = new FakeStore();
  const storage = new FakeStorage();
  storage.setItem("obs.families.v1", JSON.stringify({
    "Single Door": editorDoor(),
    "Table": { name: "Table", category: "Furniture", parameters: [], types: [], geometry: { kind: "Extrusion", profile: { kind: "Rectangle", width: "Length", height: "Width" }, depth: "Height" } },
    "Broken": { parameters: "not-an-array" },
    "Nameless": { category: "Doors" },
  }));
  const r1 = bridge.importEditorLibrary(store, storage);
  eq([r1.imported, r1.updated, r1.skipped], [2, 0, 2]);
  ok(r1.errors.length === 2, "errors reported");
  eq(store.list().length, 2);
  const r2 = bridge.importEditorLibrary(store, storage);
  eq([r2.imported, r2.updated, r2.skipped], [0, 2, 2]);
  eq(store.list().length, 2);
  // Imported entries carry their serviceId in the library now.
  const lib = JSON.parse(storage.getItem("obs.families.v1"));
  ok(typeof lib["Single Door"].serviceId === "string", "serviceId stamped into the library");
});

t("P4 export mirrors service families, skips seed + built-in, keeps editor-native entries", () => {
  const store = new FakeStore();
  const storage = new FakeStorage();
  const door = store.seed({
    id: "svc-door", name: "Parametric Door", category: "door", ifcEntity: "IfcDoor",
    schemaVersion: 2, builtIn: false,
    parameters: [{ name: "Width", type: "length", scope: "type", default: 0.9, editable: true }],
    geometry: { kind: "composed", parts: [{ kind: "box", w: { ref: "Width" }, d: { const: 0.1 }, h: { const: 2 } }] },
    types: [{ id: "t1", name: "Default", values: {} }],
  });
  store.seed({
    id: "seed-1", name: "Single Flush Door", category: "door", ifcEntity: "IfcDoor",
    schemaVersion: 2, builtIn: false, origin: "seed-catalog",
    parameters: [{ name: "Width", type: "length", scope: "type", default: 0.9, editable: true }],
    geometry: { kind: "box", w: { ref: "Width" }, d: { const: 0.1 }, h: { const: 2 } },
    types: [{ id: "t1", name: "Default", values: {} }],
  });
  store.seed({
    id: "bi-1", name: "Basic Wall", category: "wall", ifcEntity: "IfcWall",
    schemaVersion: 2, builtIn: true,
    parameters: [], geometry: { kind: "box", w: { const: 1 }, d: { const: 1 }, h: { const: 1 } },
    types: [{ id: "t1", name: "Default", values: {} }],
  });
  storage.setItem("obs.families.v1", JSON.stringify({
    "My Editor Family": editorDoor(),
    "Stale": { name: "Stale", serviceId: "gone-from-store", category: "Generic", parameters: [], types: [] },
  }));
  const r = bridge.exportServiceFamilies(store, storage);
  eq(r.exported, 1);
  eq(r.removed, 1);
  const lib = JSON.parse(storage.getItem("obs.families.v1"));
  ok(lib["Parametric Door"], "service door exported");
  eq(lib["Parametric Door"].serviceId, door.id);
  ok(!lib["Single Flush Door"], "seed family not exported");
  ok(!lib["Basic Wall"], "built-in not exported");
  ok(lib["My Editor Family"], "editor-native entry untouched");
  ok(!lib["Stale"], "stale serviceId entry removed");
});

t("P5 export after a store delete removes the library entry", () => {
  const store = new FakeStore();
  const storage = new FakeStorage();
  const created = bridge.pushEditorFamily(store, editorDoor());
  bridge.exportServiceFamilies(store, storage);
  ok(JSON.parse(storage.getItem("obs.families.v1"))["Single Door"], "exported before delete");
  store.remove(created.id);
  bridge.exportServiceFamilies(store, storage);
  ok(!JSON.parse(storage.getItem("obs.families.v1"))["Single Door"], "removed after store delete");
});

t("P6 removeBridgedFamily deletes both sides; built-ins refuse", () => {
  const store = new FakeStore();
  const storage = new FakeStorage();
  const created = bridge.pushEditorFamily(store, editorDoor());
  bridge.exportServiceFamilies(store, storage);
  ok(bridge.removeBridgedFamily(store, storage, created.id), "removed");
  eq(store.list().length, 0);
  ok(!JSON.parse(storage.getItem("obs.families.v1"))["Single Door"], "library entry gone");
  const bi = store.seed({
    id: "bi-2", name: "Basic Wall", category: "wall", ifcEntity: "IfcWall",
    schemaVersion: 2, builtIn: true, parameters: [],
    geometry: { kind: "box", w: { const: 1 }, d: { const: 1 }, h: { const: 1 } },
    types: [{ id: "t1", name: "Default", values: {} }],
  });
  eq(bridge.removeBridgedFamily(store, storage, bi.id), false);
});

t("P7 mappable editor constraints reach the service via setConstraints", () => {
  const store = new FakeStore();
  const seen = [];
  const f = editorDoor();
  f.constraints = [
    { kind: "equal", target: ["Width", "Height"], params: {} },
    { kind: "range", target: ["Width"], params: { min: 0.1, max: 10 } },
  ];
  bridge.pushEditorFamily(store, f, { setConstraints: (id, cs) => seen.push([id, cs]) });
  eq(seen.length, 1);
  eq(seen[0][1], [{ kind: "equality", a: "Width", b: "Height" }]);
});

t("P8 isExportableFamily: service yes, seed no, built-in no", () => {
  const mk = (over) => ({ builtIn: false, ...over });
  ok(bridge.isExportableFamily(mk({})), "plain user family");
  ok(!bridge.isExportableFamily(mk({ origin: "seed-catalog" })), "seed catalog");
  ok(!bridge.isExportableFamily(mk({ builtIn: true })), "built-in");
});

t("P9 a stale serviceId is skipped on import, never resurrecting a delete", () => {
  const store = new FakeStore();
  const storage = new FakeStorage();
  const created = bridge.pushEditorFamily(store, editorDoor());
  bridge.exportServiceFamilies(store, storage);
  store.remove(created.id);
  // The app's onChange export would remove the library entry at this
  // point; the test drives the export explicitly (the fake store has
  // no change bus).
  bridge.exportServiceFamilies(store, storage);
  const lib0 = JSON.parse(storage.getItem("obs.families.v1"));
  ok(!lib0["Single Door"], "export removed the entry after the delete");
  // Simulate a missed cleanup (e.g. an older build) by putting the
  // stale entry back and importing.
  const lib = JSON.parse(storage.getItem("obs.families.v1"));
  lib["Single Door"] = { ...editorDoor(), serviceId: created.id };
  storage.setItem("obs.families.v1", JSON.stringify(lib));
  const r = bridge.importEditorLibrary(store, storage);
  eq(r.skipped, 1);
  eq(store.list().length, 0);
  const r2 = bridge.exportServiceFamilies(store, storage);
  eq(r2.removed, 1);
  ok(!JSON.parse(storage.getItem("obs.families.v1"))["Single Door"], "stale entry cleaned up");
});

t("P10 another project's entry is left alone by import and export", () => {
  const store = new FakeStore();
  const storage = new FakeStorage();
  const other = { ...editorDoor(), name: "Other Project Door", serviceId: "other-id", serviceProject: "proj-B" };
  storage.setItem("obs.families.v1", JSON.stringify({ "Other Project Door": other }));
  const r = bridge.importEditorLibrary(store, storage, { projectId: "proj-A" });
  eq(r.skipped, 1);
  eq(store.list().length, 0);
  const r2 = bridge.exportServiceFamilies(store, storage, { projectId: "proj-A" });
  eq(r2.removed, 0);
  ok(JSON.parse(storage.getItem("obs.families.v1"))["Other Project Door"], "other-project entry untouched");
  // And a push in this project stamps this project's id.
  const ed = editorDoor();
  bridge.pushEditorFamily(store, ed, { projectId: "proj-A" });
  eq(ed.serviceProject, "proj-A");
});

// ── Shared parameters ───────────────────────────────────────────────────────
t("S1 editor shared param lands in the manager; manager param lands in the editor list", () => {
  const manager = new FakeManager();
  const storage = new FakeStorage();
  storage.setItem("obs.families.shared.v1", JSON.stringify([
    { name: "FireRating", kind: "Text" },
  ]));
  manager.create({ name: "Width", group: "Dimensions", type: "length", defaultValue: 0.9, isInstance: false });
  const r = bridge.syncSharedParameters(manager, storage);
  eq([r.imported, r.exported, r.removed], [1, 1, 0]);
  ok(manager.findByName("FireRating"), "editor param imported");
  eq(manager.findByName("FireRating").type, "string");
  const list = JSON.parse(storage.getItem("obs.families.shared.v1"));
  ok(list.some((e) => e.name === "Width" && e.kind === "Length" && typeof e.guid === "string"), "manager param exported with guid");
  ok(list.some((e) => e.name === "FireRating"), "editor param kept");
  const r2 = bridge.syncSharedParameters(manager, storage);
  eq([r2.imported, r2.exported, r2.removed], [0, 0, 0]);
});

t("S2 manager delete cleans up the bridged editor entry, editor-native entries survive", () => {
  const manager = new FakeManager();
  const storage = new FakeStorage();
  const p = manager.create({ name: "Width", group: "Dimensions", type: "length", defaultValue: 0.9, isInstance: false });
  bridge.syncSharedParameters(manager, storage);
  storage.setItem("obs.families.shared.v1", JSON.stringify([
    ...JSON.parse(storage.getItem("obs.families.shared.v1")),
    { name: "EditorOnly", kind: "Number" },
  ]));
  manager.delete(p.guid);
  const r = bridge.syncSharedParameters(manager, storage);
  eq(r.removed, 1);
  const list = JSON.parse(storage.getItem("obs.families.shared.v1"));
  ok(!list.some((e) => e.name === "Width"), "bridged entry removed");
  ok(list.some((e) => e.name === "EditorOnly"), "editor-native entry kept");
});

// ── Whole sync ──────────────────────────────────────────────────────────────
t("W1 syncAll imports, exports and syncs shared params in one pass", () => {
  const store = new FakeStore();
  const manager = new FakeManager();
  const storage = new FakeStorage();
  storage.setItem("obs.families.v1", JSON.stringify({ "Single Door": editorDoor() }));
  storage.setItem("obs.families.shared.v1", JSON.stringify([{ name: "FireRating", kind: "Text" }]));
  const r = bridge.syncAll(store, manager, storage);
  eq(r.families.imported, 1);
  eq(r.families.exported, 1);
  eq(r.shared.imported, 1);
  eq(r.errors.length, 0);
  const lib = JSON.parse(storage.getItem("obs.families.v1"));
  eq(lib["Single Door"].serviceId, store.list()[0].id);
});

console.log(`\nfamily-store-bridge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
