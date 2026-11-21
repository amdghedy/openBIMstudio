/**
 * tests/property-palette-type-selector.test.cjs
 *
 * G10 — Properties palette Type Selector (Revit 2D environment audit).
 *
 * Proves, against the pure model in src/features/type-selector.ts:
 *   1. a plain wall lists the wall-type presets, current type inferred;
 *   2. choosing a type re-types the element (wall preset + family type);
 *   3. instance overrides survive a re-type (height / sill height stay,
 *      type-driven keys follow the new type) — and a sibling already on
 *      the target type is NOT clobbered (no syncFamilyInstances sweep);
 *   4. mixed-type multi-selection shows the <varies> state and re-types
 *      only the elements whose family offers the picked type;
 *   5. same-family multi-selection shows the shared current type;
 *   6. unknown type ids and types with no type source change nothing.
 *
 * The family service used here is a test-local adapter, because the real
 * createFamilyService() cannot be required in plain node: its import graph
 * (families/store -> projects/projects -> features/camera-tools) touches
 * `document` at module scope. The adapter is built from the REAL builtin
 * families (createBuiltInFamilies) and the REAL formula engine
 * (evaluateParameters); its resolveParams merge (family defaults -> type
 * values -> instance overrides -> formula pass) mirrors
 * registry.ts resolveParameters (lines 16-55) step for step.
 *
 * Run: `node tests/property-palette-type-selector.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");

// ── Compile the pure slice ──────────────────────────────────────────────
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-g10-type-selector-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type": "commonjs"}');
// `three` (pulled in by the compiled graph's type-only imports is erased,
// but formula-engine/registry-adjacent files may require it) must resolve.
try {
  fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "dir");
} catch { /* already linked */ }

function findCompiled(dir, file) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findCompiled(full, file);
      if (found) return found;
    } else if (entry.isFile() && entry.name === file) return full;
  }
  return null;
}

try {
  execSync(
    "npx tsc" +
      " src/features/type-selector.ts" +
      " src/modules/architecture-depth/wall-types.ts" +
      " src/modules/families/builtin-families.ts" +
      " src/modules/families/formula-engine.ts" +
      ` --rootDir src --outDir "${out}"` +
      " --module commonjs --target es2020 --strict --skipLibCheck",
    { cwd: root, stdio: "pipe", shell: true },
  );
} catch (e) {
  console.error("tsc compile of the G10 slice failed:");
  console.error((e.stdout || e.stderr || e.message || "").toString().slice(0, 4000));
  process.exit(1);
}

const typeSelector = require(findCompiled(out, "type-selector.js"));
const { resolveTypeSelector, retypeElements, inferWallPresetId } = typeSelector;
const { createBuiltInFamilies } = require(findCompiled(out, "builtin-families.js"));
const { evaluateParameters } = require(findCompiled(out, "formula-engine.js"));

// ── Test-local family service (real data + real formula engine) ─────────
const builtins = createBuiltInFamilies();
const byId = new Map(builtins.map((f) => [f.id, f]));
const familyService = {
  get: (id) => byId.get(id) ?? null,
  getByElementType: (et) => builtins.find((f) => f.sourceElementType === et) ?? null,
  resolveParams: (fid, tid, overrides) => {
    const fam = byId.get(fid);
    if (!fam) return null;
    const type = tid ? fam.types.find((t) => t.id === tid) ?? null : null;
    const values = {};
    for (const p of fam.parameters) values[p.name] = p.default;
    if (type) for (const [k, v] of Object.entries(type.values)) values[k] = v;
    if (overrides) for (const [k, v] of Object.entries(overrides)) values[k] = v;
    return evaluateParameters(fam.parameters, values).values;
  },
};
const wallFamily = builtins.find((f) => f.category === "wall");
const columnFamily = builtins.find((f) => f.category === "column");
const doorFamily = builtins.find((f) => f.category === "door");
const deps = { familyService, wallPresets: undefined }; // wall presets default to the real catalog

// ── Element factories ───────────────────────────────────────────────────
function el(id, type, params, extra = {}) {
  return {
    id,
    type,
    name: type,
    params: { height: 3, thickness: 0.2, elevation: 0, ...params },
    properties: {},
    ...extra,
  };
}
const wall = (id, opts = {}) => el(id, "wall", { start: [0, 0], end: [4, 0], ...opts.params }, opts.extra);
const column = (id, opts = {}) => el(id, "column", { ...opts.params }, opts.extra);

// ── Tests ───────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail++;
    console.error("  FAIL " + name + ": " + e.message);
  }
}

const COMPOUND_EXTERIOR_LAYERS =
  "Exterior Finish 0.025|#c4b59a; Structure Core 0.20|#a8a29e; Interior Finish 0.03|#e7e5e4";

/** A wall exactly as the Wall tool places it: 0.255 m compound exterior. */
function placedWall(id, opts = {}) {
  const w = wall(id, { params: { thickness: 0.255, ...opts.params }, ...opts });
  w.properties.layers = COMPOUND_EXTERIOR_LAYERS;
  return w;
}

t("plain wall lists wall presets, current type inferred from its layers", () => {
  const m = resolveTypeSelector([placedWall("w1")], deps);
  assert.equal(m.kind, "wall");
  assert.equal(m.sourceName, "Wall Type");
  assert.equal(m.varies, false);
  assert.equal(m.currentId, "compound-exterior");
  const names = m.options.map((o) => o.name);
  assert.ok(names.includes("Basic Wall: Generic 200mm"));
  assert.ok(names.includes("Basic Wall: Concrete 300mm"));
  assert.ok(!names.some((n) => n.startsWith("Curtain Wall")), "no curtain types for a plain wall");
  assert.equal(m.options.length, 4);
});

t("plain wall lists wall presets even when the family service is absent", () => {
  const m = resolveTypeSelector([placedWall("w1")], { familyService: null });
  assert.equal(m.kind, "wall");
  assert.equal(m.currentId, "compound-exterior");
  assert.equal(m.options.length, 4);
});

t("curtain wall lists only the curtain presets", () => {
  const m = resolveTypeSelector([el("c1", "curtain-wall", {})], deps);
  assert.equal(m.kind, "wall");
  assert.equal(m.options.length, 2);
  assert.ok(m.options.every((o) => o.name.startsWith("Curtain Wall")));
});

t("family-backed wall lists its family types", () => {
  const w = wall("w1", { extra: { familyId: wallFamily.id, familyTypeId: wallFamily.types[1].id } });
  const m = resolveTypeSelector([w], deps);
  assert.equal(m.kind, "family");
  assert.equal(m.sourceName, "Basic Wall");
  assert.equal(m.currentId, wallFamily.types[1].id);
  assert.deepEqual(m.options.map((o) => o.name), ["Generic 100 mm", "Generic 200 mm", "Generic 300 mm"]);
});

t("family-backed wall with no type assigned infers its type from thickness", () => {
  const w = wall("w1", {
    params: { thickness: 0.2 },
    extra: { familyId: wallFamily.id },
  });
  const m = resolveTypeSelector([w], deps);
  assert.equal(m.kind, "family");
  assert.equal(m.currentId, wallFamily.types[1].id);
  assert.equal(m.varies, false);
  const unmatched = wall("w2", {
    params: { thickness: 0.255 },
    extra: { familyId: wallFamily.id },
  });
  assert.equal(resolveTypeSelector([unmatched], deps).currentId, null);
});

t("re-typing a plain wall applies the preset and preserves a height override", () => {
  const w = placedWall("w1", { params: { height: 4.5 } });
  const res = retypeElements([w], "compound-concrete", deps);
  assert.deepEqual(res.retyped, ["w1"]);
  assert.deepEqual(res.skipped, []);
  assert.equal(w.params.thickness, 0.3);
  assert.equal(w.params.height, 4.5, "instance height override survives the re-type");
  assert.equal(w.properties.wallTypeId, "compound-concrete");
  assert.equal(w.properties.layers, "Concrete Core 0.30|#9ca3af");
  assert.equal(w.name, "Basic Wall: Concrete 300mm");
});

t("re-typing a family wall follows the new type and preserves overrides; siblings untouched", () => {
  const w = wall("w1", {
    params: { height: 4.5, thickness: 0.2 },
    extra: { familyId: wallFamily.id, familyTypeId: wallFamily.types[1].id },
  });
  // Sibling already on the target type, with its own height override.
  const sib = wall("w2", {
    params: { height: 5.0, thickness: 0.3 },
    extra: { familyId: wallFamily.id, familyTypeId: wallFamily.types[2].id },
  });
  const res = retypeElements([w], wallFamily.types[2].id, deps);
  assert.deepEqual(res.retyped, ["w1"]);
  assert.equal(w.familyTypeId, wallFamily.types[2].id);
  assert.equal(w.params.thickness, 0.3, "type-driven thickness follows the new type");
  assert.equal(w.params.height, 4.5, "instance height override survives the re-type");
  assert.equal(sib.params.height, 5.0, "sibling on the target type is not re-synced");
  assert.equal(sib.params.thickness, 0.3);
});

t("re-typing a door follows type-driven width and preserves sill-height override", () => {
  const d = el("d1", "door", { width: 0.9, height: 2.1, sillHeight: 0.5 }, {
    familyId: doorFamily.id, familyTypeId: doorFamily.types[0].id,
  });
  const res = retypeElements([d], doorFamily.types[2].id, deps);
  assert.deepEqual(res.retyped, ["d1"]);
  assert.equal(d.params.width, 1.8, "type-driven width follows the Double type");
  assert.equal(d.params.height, 2.1);
  assert.equal(d.params.sillHeight, 0.5, "instance sill-height override survives");
});

t("mixed wall + column selection shows varies and re-types only matching elements", () => {
  const w = wall("w1", { extra: { familyId: wallFamily.id, familyTypeId: wallFamily.types[1].id } });
  const c = column("c1", {
    params: { thickness: 0.3, depth: 0.3 },
    extra: { familyId: columnFamily.id, familyTypeId: columnFamily.types[0].id },
  });
  const m = resolveTypeSelector([w, c], deps);
  assert.equal(m.varies, true);
  assert.equal(m.currentId, null);
  const names = m.options.map((o) => o.name);
  assert.ok(names.includes("Generic 300 mm"), "wall types offered");
  assert.ok(names.includes("400 x 400"), "column types offered");

  const res = retypeElements([w, c], wallFamily.types[2].id, deps);
  assert.deepEqual(res.retyped, ["w1"]);
  assert.deepEqual(res.skipped, ["c1"]);
  assert.equal(w.familyTypeId, wallFamily.types[2].id);
  assert.equal(w.params.thickness, 0.3);
  assert.equal(c.familyTypeId, columnFamily.types[0].id, "column untouched by a wall re-type");
  assert.equal(c.params.thickness, 0.3, "column thickness untouched");

  const res2 = retypeElements([w, c], columnFamily.types[1].id, deps);
  assert.deepEqual(res2.retyped, ["c1"]);
  assert.deepEqual(res2.skipped, ["w1"]);
  assert.equal(c.params.thickness, 0.4);
});

t("same-family multi-selection shows the shared current type and re-types all", () => {
  const a = wall("w1", { extra: { familyId: wallFamily.id, familyTypeId: wallFamily.types[1].id } });
  const b = wall("w2", { extra: { familyId: wallFamily.id, familyTypeId: wallFamily.types[1].id } });
  const m = resolveTypeSelector([a, b], deps);
  assert.equal(m.varies, false);
  assert.equal(m.currentId, wallFamily.types[1].id);
  const res = retypeElements([a, b], wallFamily.types[0].id, deps);
  assert.deepEqual(res.retyped, ["w1", "w2"]);
  assert.equal(a.params.thickness, 0.1);
  assert.equal(b.params.thickness, 0.1);
});

t("unknown type id changes nothing", () => {
  const w = wall("w1", { params: { thickness: 0.2 } });
  const res = retypeElements([w], "no-such-type", deps);
  assert.deepEqual(res.retyped, []);
  assert.deepEqual(res.skipped, ["w1"]);
  assert.equal(w.params.thickness, 0.2);
  assert.equal(w.properties.wallTypeId, undefined);
});

t("element type with no type source offers no selector", () => {
  const m = resolveTypeSelector([el("r1", "roof", {})], deps);
  assert.equal(m.kind, "none");
  assert.deepEqual(m.options, []);
  const res = retypeElements([el("r1", "roof", {})], "basic-generic-200", deps);
  assert.deepEqual(res.retyped, []);
});

t("inferWallPresetId: stored id wins, then layers, then thickness default", () => {
  const stored = wall("w1");
  stored.properties.wallTypeId = "compound-interior";
  assert.equal(inferWallPresetId(stored, undefined), "compound-interior");
  const layered = wall("w2");
  layered.properties.layers = "Exterior Finish 0.025|#c4b59a; Structure Core 0.20|#a8a29e; Interior Finish 0.03|#e7e5e4";
  assert.equal(inferWallPresetId(layered, undefined), "compound-exterior");
  assert.equal(inferWallPresetId(wall("w3"), undefined), "basic-generic-200");
  const curtain = el("c1", "curtain-wall", {});
  curtain.properties.panelType = "solid";
  assert.equal(inferWallPresetId(curtain, undefined), "curtain-solid");
});

// ── Cleanup + verdict ───────────────────────────────────────────────────
try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* */ }
console.log(`property-palette-type-selector: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
