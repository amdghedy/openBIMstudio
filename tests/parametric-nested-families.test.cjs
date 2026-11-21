/**
 * tests/parametric-nested-families.test.cjs
 *
 * Slice 7 (Revit parity gap 7): nested families proven end to end.
 *
 *   - T1: a parent parameter change propagates through `paramMap` to
 *     a nested child (string form, `{ref}` form and `{const}` form),
 *     proven by the child's rebuilt bounding box.
 *   - T2: a `shared` nested instance schedules independently —
 *     `collectSchedulableInstances` lists the parent plus one row per
 *     shared child, each with its own family, type and resolved
 *     parameters; a non-shared child produces no row of its own, and
 *     changing the parent parameter that feeds one shared child
 *     leaves the other shared child's row untouched.
 *   - T3: circular nesting is rejected, not recursed into — A -> B ->
 *     A, a direct self-nest, and a three-family cycle all complete,
 *     report the chain in `warnings`, and build the non-circular
 *     part exactly once.
 *   - T4: a nested reference to a family the lookup cannot find is
 *     reported in `warnings` and skipped; the parent still builds.
 *   - T5: a `paramMap` binding that names a parent parameter which
 *     does not exist is skipped with a warning instead of writing
 *     `undefined` into the child (which would poison it with NaN).
 *
 * Before this slice the engine inlined the paramMap mapping with no
 * guard, nothing marked a shared nested instance in the built tree
 * (there was no way to schedule one independently), and a circular
 * nest recursed until the stack overflowed — the only evidence was
 * "Maximum call stack size exceeded".
 *
 * Run: `node tests/parametric-nested-families.test.cjs`
 * CI:  `test:parametric-nested-families` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The modules under test are compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-voids-sweeps-lofts.test.cjs), so `three` resolves
 * from the repo's node_modules.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const THREE = require("three");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
const near = (a, b, tolOrMsg = 1e-3, msg) => {
  const tol = typeof tolOrMsg === "number" ? tolOrMsg : 1e-3;
  const label = typeof tolOrMsg === "string" ? tolOrMsg : msg;
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})${label ? ": " + label : ""}`);
};

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".nested-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/parametric-engine.ts"
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
const E = require(find("parametric-engine.js"));
const NF = require(find("nested-families.js"));

// ── Fixture families ────────────────────────────────────────────────────────
const C = (n) => ({ const: n });
const R = (name) => ({ ref: name });
const P = (name, def) => ({ name, type: "number", default: def });
const box = (w, d, h) => ({ kind: "box", w, d, h });
const translate = (x, y, z) => ({ translate: [C(x), C(y), C(z)] });

const child = {
  id: "child", name: "Child Panel", category: "generic", ifcEntity: "IfcBuildingElementProxy",
  schemaVersion: 1, builtIn: false,
  parameters: [P("width", 1), P("depth", 1), P("height", 1)],
  geometry: box(R("width"), R("depth"), R("height")),
  types: [
    { id: "small", name: "Small", values: { width: 1, depth: 1, height: 1 } },
    { id: "large", name: "Large", values: { width: 2, depth: 2, height: 2 } },
  ],
};

const parent = {
  id: "parent", name: "Parent Assembly", category: "generic", ifcEntity: "IfcBuildingElementProxy",
  schemaVersion: 1, builtIn: false,
  parameters: [P("bayWidth", 2), P("panelHeight", 3)],
  geometry: {
    kind: "composed",
    parts: [
      box(C(4), C(0.2), C(3)), // base panel
      // A: non-shared, string-form paramMap, at z = 1
      { kind: "nested", familyId: "child",
        paramMap: { width: "bayWidth", height: "panelHeight" },
        transform: translate(0, 0, 1) },
      // B: shared, type "large", const width, at z = 3
      { kind: "nested", familyId: "child", typeId: "large", shared: true,
        paramMap: { width: C(5) },
        transform: translate(0, 0, 3) },
      // C: shared, follows the parent, at z = 5
      { kind: "nested", familyId: "child", shared: true,
        paramMap: { width: "bayWidth" },
        transform: translate(0, 0, 5) },
      // D: non-shared, {ref}-form paramMap, at z = 7
      { kind: "nested", familyId: "child",
        paramMap: { width: R("bayWidth"), height: R("panelHeight") },
        transform: translate(0, 0, 7) },
    ],
  },
  types: [{ id: "t", name: "T", values: {} }],
};

const families = { child, parent };
const familyLookup = (id) => families[id] ?? null;
const typeLookup = (fid, tid) => families[fid]?.types.find((ty) => ty.id === tid) ?? null;
const buildParent = (overrides) => {
  const r = E.buildParametricFamily(parent, parent.types[0], { familyLookup, typeLookup, overrides });
  if (!r.object) throw new Error(`parent build produced no object (errors: ${r.errors.join("; ")})`);
  if (r.errors.length) throw new Error(`parent build errors: ${r.errors.join("; ")}`);
  return r;
};
/** Nested child builds, ordered by their z position (A, B, C, D). */
const nestedChildren = (obj) => {
  obj.updateMatrixWorld(true);
  const found = [];
  obj.traverse((o) => {
    if (o.userData?.familyId === "child") {
      const b = new THREE.Box3().setFromObject(o);
      found.push({ node: o, box: b });
    }
  });
  found.sort((a, b) => (a.box.min.z + a.box.max.z) - (b.box.min.z + b.box.max.z));
  return found;
};
const sizeX = (entry) => entry.box.max.x - entry.box.min.x;
const countFamily = (obj, id) => {
  let n = 0;
  obj.traverse((o) => { if (o.userData?.familyId === id) n++; });
  return n;
};

// ── T1. Parent param change propagates through paramMap ────────────────────
t("T1 parent param change propagates to nested children (string + {ref} forms)", () => {
  const before = buildParent();
  const kidsBefore = nestedChildren(before.object);
  assert.strictEqual(kidsBefore.length, 4, `expected 4 nested children, got ${kidsBefore.length}`);
  near(sizeX(kidsBefore[0]), 2, 1e-3, "child A width follows bayWidth 2");
  near(sizeX(kidsBefore[3]), 2, 1e-3, "child D width follows bayWidth 2 ({ref} form)");

  const after = buildParent({ bayWidth: 3 });
  assert.strictEqual(after.params.bayWidth, 3, "parent params carry the edit");
  const kidsAfter = nestedChildren(after.object);
  near(sizeX(kidsAfter[0]), 3, 1e-3, "child A width follows bayWidth 3");
  near(sizeX(kidsAfter[3]), 3, 1e-3, "child D width follows bayWidth 3 ({ref} form)");
  // The const-mapped child does not follow the parent.
  near(sizeX(kidsAfter[1]), 5, 1e-3, "child B keeps its const width 5");
  // Heights follow panelHeight on the mapped children.
  const hA = kidsAfter[0].box.max.y - kidsAfter[0].box.min.y;
  near(hA, 3, 1e-3, "child A height follows panelHeight 3");
});

// ── T2. Shared nested instances schedule independently ──────────────────────
t("T2 shared nested children schedule as their own rows; non-shared do not", () => {
  const r = buildParent();
  const rows = NF.collectSchedulableInstances(r.object);
  assert.strictEqual(rows.length, 3, `expected 3 schedule rows, got ${JSON.stringify(rows.map((x) => [x.familyId, x.typeId, x.shared]))}`);
  const [rootRow, ...nested] = rows;
  assert.strictEqual(rootRow.familyId, "parent");
  assert.strictEqual(rootRow.shared, false);
  assert.strictEqual(nested.length, 2, "only the two shared children have rows");
  assert.ok(nested.every((x) => x.shared), "nested rows are shared");
  const large = nested.find((x) => x.typeId === "large");
  assert.ok(large, "the large shared child has a row");
  assert.strictEqual(large.params.width, 5, "large row carries its const width");
  assert.strictEqual(large.params.depth, 2, "large row carries its type depth");
  const follower = nested.find((x) => x.typeId === null);
  assert.ok(follower, "the following shared child has a row");
  assert.strictEqual(follower.params.width, 2, "follower row follows bayWidth 2");

  // Independence: changing the parent parameter moves only the row
  // whose paramMap follows it.
  const r2 = buildParent({ bayWidth: 3 });
  const rows2 = NF.collectSchedulableInstances(r2.object);
  const large2 = rows2.find((x) => x.typeId === "large");
  const follower2 = rows2.find((x) => x.typeId === null && x.shared);
  assert.strictEqual(large2.params.width, 5, "large row untouched by the parent edit");
  assert.strictEqual(follower2.params.width, 3, "follower row moves with the parent edit");
});

// ── T3. Circular nesting rejected ───────────────────────────────────────────
t("T3 circular nesting is rejected with the chain reported, build completes", () => {
  const mk = (id, nests) => ({
    id, name: id, category: "generic", ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 1, builtIn: false, parameters: [],
    geometry: {
      kind: "composed",
      parts: [box(C(1), C(1), C(1)),
        ...nests.map((n) => ({ kind: "nested", familyId: n, transform: translate(0, 0, 2) }))],
    },
    types: [{ id: "t", name: "T", values: {} }],
  });
  const cyc = {
    a: mk("a", ["b"]),
    b: mk("b", ["a"]),
    c: mk("c", ["c"]),
    d: mk("d", ["e"]),
    e: mk("e", ["f"]),
    f: mk("f", ["d"]),
  };
  const look = (id) => cyc[id] ?? null;
  const typeLook = (fid, tid) => cyc[fid]?.types.find((ty) => ty.id === tid) ?? null;
  const build = (fam) => E.buildParametricFamily(fam, fam.types[0], { familyLookup: look, typeLookup: typeLook });

  const ab = build(cyc.a);
  assert.ok(ab.object, "A -> B -> A still builds an object");
  assert.ok(ab.warnings.some((w) => w.includes("circular nesting rejected: a -> b -> a")),
    `expected the a->b->a chain in warnings, got: ${ab.warnings.join("; ")}`);
  assert.strictEqual(countFamily(ab.object, "a"), 1, "A appears exactly once (the root)");
  assert.strictEqual(countFamily(ab.object, "b"), 1, "B is built exactly once");

  const self = build(cyc.c);
  assert.ok(self.object, "self-nest still builds an object");
  assert.ok(self.warnings.some((w) => w.includes("circular nesting rejected: c -> c")),
    `expected the c->c chain in warnings, got: ${self.warnings.join("; ")}`);
  assert.strictEqual(countFamily(self.object, "c"), 1, "C appears exactly once (the root)");

  const def = build(cyc.d);
  assert.ok(def.object, "three-family cycle still builds an object");
  assert.ok(def.warnings.some((w) => w.includes("circular nesting rejected: d -> e -> f -> d")),
    `expected the d->e->f->d chain in warnings, got: ${def.warnings.join("; ")}`);
  assert.strictEqual(countFamily(def.object, "d"), 1, "D appears exactly once (the root)");
  assert.strictEqual(countFamily(def.object, "e"), 1, "E is built exactly once");
  assert.strictEqual(countFamily(def.object, "f"), 1, "F is built exactly once");
});

// ── T4. Missing nested family reported, not fatal ───────────────────────────
t("T4 nested reference to an unknown family is reported and skipped", () => {
  const orphan = {
    id: "orphan", name: "Orphan", category: "generic", ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 1, builtIn: false, parameters: [],
    geometry: {
      kind: "composed",
      parts: [box(C(1), C(1), C(1)),
        { kind: "nested", familyId: "does-not-exist", transform: translate(0, 0, 2) }],
    },
    types: [{ id: "t", name: "T", values: {} }],
  };
  const r = E.buildParametricFamily(orphan, orphan.types[0], { familyLookup, typeLookup });
  assert.ok(r.object, "parent still builds");
  assert.ok(r.warnings.some((w) => w.includes("nested family not found: does-not-exist")),
    `expected the missing-family warning, got: ${r.warnings.join("; ")}`);
  assert.strictEqual(countFamily(r.object, "does-not-exist"), 0, "no phantom child");
});

// ── T5. paramMap naming a missing parent parameter ─────────────────────────
t("T5 paramMap to a missing parent parameter is skipped with a warning", () => {
  const typo = {
    id: "typo", name: "Typo", category: "generic", ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 1, builtIn: false, parameters: [P("bayWidth", 2)],
    geometry: {
      kind: "composed",
      parts: [box(C(1), C(1), C(1)),
        { kind: "nested", familyId: "child",
          paramMap: { width: "noSuchParam" },
          transform: translate(0, 0, 2) }],
    },
    types: [{ id: "t", name: "T", values: {} }],
  };
  const r = E.buildParametricFamily(typo, typo.types[0], { familyLookup, typeLookup });
  assert.ok(r.object, "parent still builds");
  assert.ok(r.warnings.some((w) => w.includes("missing parent parameter 'noSuchParam'")),
    `expected the missing-param warning, got: ${r.warnings.join("; ")}`);
  const kids = nestedChildren(r.object);
  assert.strictEqual(kids.length, 1, "the child still builds");
  near(sizeX(kids[0]), 1, 1e-3, "child keeps its default width 1 instead of undefined");
});

console.log(`\nparametric-nested-families: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
