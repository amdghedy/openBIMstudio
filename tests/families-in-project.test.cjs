/**
 * tests/families-in-project.test.cjs
 *
 * Slice 4 (Revit parity gap 5): families travel with the project.
 *
 * User families used to live only in localStorage, so a project opened
 * on another machine lost its custom families while its instances kept
 * dangling `familyId`s. The fix: the project document carries
 * `userFamilies` (written on save, restored on open — see
 * src/modules/projects/projects.ts), validated tolerantly by
 * src/modules/families/project-families.ts, and instances whose family
 * is missing are reported on load, never silently dropped.
 *
 * Tests:
 *   T1. Serialise keeps only user families and deep-clones them.
 *   T2. Round-trip: user families -> JSON -> restore -> identical
 *       definitions; built-ins in the payload are skipped, not restored.
 *   T3. Invalid entries are skipped with reasons and the rest still
 *       restore; garbage payloads never throw.
 *   T4. Missing-family scan: dangling familyIds are reported per
 *       element; known families and family-less elements are not.
 *   T5. Wiring (source inspection, same pattern as seed-families):
 *       the project doc declares `userFamilies`; save writes it;
 *       open restores it AFTER the project-change notify() — the
 *       family store's hook clears the store on notify, so a restore
 *       placed any earlier would be wiped — and before the
 *       "Project repaired on load" report; the missing-family scan is
 *       wired on open too.
 *
 * Run: `node tests/families-in-project.test.cjs`
 * CI:  `test:families-in-project` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The module under test is compiled from source with tsc into a temp
 * dir inside the repo (same pattern as tests/family-sketch.test.cjs).
 * It has no runtime imports, so nothing else is needed.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const deep = (a, b, msg) => assert.deepStrictEqual(a, b, msg);

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".families-in-project-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/project-families.ts"
  + " --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck",
  { cwd: root, stdio: "inherit", shell: true },
);
const find = (nm) => {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (f.name === nm) return p;
    }
    return null;
  };
  return walk(tmpOut);
};
const PF = require(find("project-families.js"));

// ── Fixtures ────────────────────────────────────────────────────────────────
const userFamily = {
  id: "user-plinth", name: "Custom Plinth", category: "generic",
  ifcEntity: "IfcBuildingElementProxy", schemaVersion: 1, builtIn: false,
  parameters: [
    { name: "width", type: "length", scope: "type", default: 1.2, editable: true },
    { name: "height", type: "length", scope: "type", default: 0.6, editable: true },
  ],
  geometry: { kind: "box", w: { ref: "width" }, d: { const: 1 }, h: { ref: "height" } },
  types: [{ id: "user-plinth-t1", name: "Default", values: { width: 1.2, height: 0.6 } }],
};
const builtinFamily = { ...userFamily, id: "builtin-wall", name: "Basic Wall", builtIn: true };

// ── T1. Serialise ──────────────────────────────────────────────────────────
{
  const out = PF.serializeUserFamilies([userFamily, builtinFamily]);
  deep(out, [userFamily], "only user families are serialised");
  out[0].parameters[0].default = 999;
  ok(userFamily.parameters[0].default === 1.2, "serialised copy is a deep clone");
}

// ── T2. Round-trip ──────────────────────────────────────────────────────────
{
  const saved = JSON.stringify(PF.serializeUserFamilies([userFamily, builtinFamily]));
  const parsed = JSON.parse(saved);
  // A fake store: the apply step the real store performs.
  const store = new Map();
  const { valid, skipped } = PF.partitionFamilyDefinitions(parsed);
  for (const def of valid) store.set(def.id, def);
  ok(store.size === 1 && store.has("user-plinth"), "user family restored into the store");
  deep(store.get("user-plinth"), userFamily, "restored definition is identical");
  ok(skipped.length === 0, "nothing skipped for a clean payload");
}

// ── T2b. Built-ins in the payload are skipped ─────────────────────────────
{
  const { valid, skipped } = PF.partitionFamilyDefinitions([builtinFamily, userFamily]);
  ok(valid.length === 1 && valid[0].id === "user-plinth", "built-in not restored from the document");
  ok(skipped.length === 1 && skipped[0].id === "builtin-wall" && /built-in/.test(skipped[0].reason), "built-in skip is reported");
}

// ── T3. Invalid entries ─────────────────────────────────────────────────────
{
  const bad = [
    null,
    "not an object",
    { name: "No id", ifcEntity: "IfcWall", parameters: [], geometry: { kind: "box" } },
    { id: "no-name", ifcEntity: "IfcWall", parameters: [], geometry: { kind: "box" } },
    { id: "no-geom", name: "No geometry", ifcEntity: "IfcWall", parameters: [] },
    { id: "bad-geom", name: "Bad geometry", ifcEntity: "IfcWall", parameters: [], geometry: {} },
    { id: "bad-types", name: "Bad types", ifcEntity: "IfcWall", parameters: [], geometry: { kind: "box" }, types: "nope" },
    { id: "dup-param", name: "Dup param", ifcEntity: "IfcWall", parameters: [{ name: "width" }, { name: "width" }], geometry: { kind: "box" } },
  ];
  const { valid, skipped } = PF.partitionFamilyDefinitions([...bad, userFamily]);
  ok(valid.length === 1 && valid[0].id === "user-plinth", "the one valid entry still restores");
  ok(skipped.length === bad.length, `all ${bad.length} invalid entries skipped, got ${skipped.length}`);
  for (const s of skipped) ok(typeof s.reason === "string" && s.reason.length > 0, "every skip carries a reason");

  // Garbage payloads never throw.
  for (const garbage of [null, undefined, "nope", 42, {}, { userFamilies: "x" }]) {
    const r = PF.partitionFamilyDefinitions(garbage);
    ok(r.valid.length === 0 && r.skipped.length === 1, `garbage payload handled without throwing: ${JSON.stringify(garbage)}`);
  }
  ok(PF.validateFamilyDefinition(userFamily) === null, "valid definition validates clean");
}

// ── T4. Missing-family scan ─────────────────────────────────────────────────
{
  const elements = [
    { id: "e1", familyId: "user-plinth" },
    { id: "e2", familyId: "gone-family" },
    { id: "e3", familyId: "gone-family" },
    { id: "e4" },
    { id: "e5", familyId: "builtin-wall" },
  ];
  const missing = PF.findMissingFamilies(elements, (id) => id === "user-plinth" || id === "builtin-wall");
  deep(missing, [
    { elementId: "e2", familyId: "gone-family" },
    { elementId: "e3", familyId: "gone-family" },
  ], "only the dangling refs are reported, per element");
  ok(PF.findMissingFamilies([], () => false).length === 0, "no elements, no report");
  ok(PF.findMissingFamilies(elements, () => true).length === 0, "all families present, no report");
}

// ── T5. Wiring ──────────────────────────────────────────────────────────────
{
  const projectsSrc = fs.readFileSync(path.join(root, "src/modules/projects/projects.ts"), "utf8");
  const typesSrc = fs.readFileSync(path.join(root, "src/modules/projects/types.ts"), "utf8");
  const storeSrc = fs.readFileSync(path.join(root, "src/modules/families/store.ts"), "utf8");
  ok(/userFamilies\?: FamilyDefinition\[\]/.test(typesSrc), "project doc declares userFamilies");
  ok(/serializeUserFamilies\(\)/.test(projectsSrc), "save writes userFamilies");
  ok(/restoreUserFamilies\(/.test(projectsSrc), "open restores userFamilies");
  ok(/findMissingFamilies\(/.test(projectsSrc), "open scans for missing families");
  // Ordering: the restore must run after the project-change notify() in
  // openProject (the store hook clears the store there) and before the
  // "Project repaired on load" report that surfaces the issues.
  const tail = projectsSrc.slice(projectsSrc.indexOf("recordLastProjectId"));
  const restoreAt = tail.indexOf("restoreUserFamilies");
  const reportAt = tail.indexOf("Project repaired on load");
  ok(restoreAt !== -1 && reportAt !== -1 && restoreAt < reportAt, "restore runs after notify and before the load report");
  ok(/restoreUserFamilies\(raw: unknown\)/.test(storeSrc), "store exposes restoreUserFamilies");
  ok(/serializeUserFamilies\(\): FamilyDefinition\[\]/.test(storeSrc), "store exposes serializeUserFamilies");
}

console.log(`families-in-project: ${n} assertions passed`);
