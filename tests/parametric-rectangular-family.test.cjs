/**
 * tests/parametric-rectangular-family.test.cjs
 *
 * Slice 3 (Revit parity gap 5): one declarative parametric rectangular
 * family, end to end.
 *
 * The family under test is the real seed-catalog entry
 * `public/families/Generic/parametric-rectangular-plinth.json` —
 * "Parametric Rectangular Plinth", a freestanding box with type
 * parameters (width, depth, height) and instance parameters
 * (elevation, rotation in degrees). Its transform lifts the box so its
 * BASE sits at `elevation` and rotates it about Y by `rotation`.
 *
 * Tests (all through the real `buildParametricFamily`, with a fake
 * family service delegating to the real resolver, and real
 * `AuthoredElement` objects placed through `resolvePlacement`):
 *   T1. Build the default type: bounding box is width x height x depth,
 *       base at elevation, no build errors, footprint formula computes.
 *   T2. Rebuild on a type change: the box follows the new type's
 *       dimensions; a second instance carrying an elevation override
 *       keeps it (Slice 1 semantics, via resolveInstanceAfterTypeChange).
 *   T3. Instance parameters: elevation lifts the base; rotation 90
 *       swaps the X/Z extents of the box.
 *   T4. Placement: resolvePlacement produces real AuthoredElements
 *       whose params carry width/depth/height/elevation/rotation
 *       (rotation flows through GEOMETRY_KEYS), and a sync through
 *       applyResolvedParams moves an element's rotation.
 *   T5. Save -> reload round-trip: family + elements survive JSON
 *       serialise -> parse -> re-resolve -> rebuild with identical
 *       resolved parameters and identical bounding boxes.
 *
 * Run: `node tests/parametric-rectangular-family.test.cjs`
 * CI:  `test:parametric-rectangular-family` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The modules under test are compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-type-propagation.test.cjs), so `three` resolves from
 * the repo's node_modules.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const THREE = require("three");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
const near = (a, b, tolOrMsg = 1e-6, msg) => {
  // Third argument may be a tolerance (number) or a label (string).
  const tol = typeof tolOrMsg === "number" ? tolOrMsg : 1e-6;
  const label = typeof tolOrMsg === "string" ? tolOrMsg : msg;
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})${label ? ": " + label : ""}`);
};
const deep = (a, b, msg) => assert.deepStrictEqual(a, b, msg);

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".rect-family-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/parametric-engine.ts src/modules/families/placement.ts"
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
const P = require(find("placement.js"));
const CTX = require(find("context.js"));

// ── The real catalog family ─────────────────────────────────────────────────
const family = JSON.parse(fs.readFileSync(
  path.join(root, "public/families/Generic/parametric-rectangular-plinth.json"), "utf8"));
const typeA = family.types.find((x) => x.name === "1200 x 800 x 600");
const typeB = family.types.find((x) => x.name === "600 x 600 x 450");

const fakeService = {
  get: (id) => (id === family.id ? family : null),
  resolveParams: (fid, tid, overrides) => {
    const type = tid ? family.types.find((x) => x.id === tid) ?? null : null;
    return E.resolveParametricValues(family, type, { overrides }).values;
  },
};
CTX.ctx.features.family = fakeService;

const boxOf = (obj) => {
  const box = new THREE.Box3().setFromObject(obj);
  return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
};
const sizeOf = (box) => [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
const build = (type, overrides) => {
  const r = E.buildParametricFamily(family, type, { overrides });
  if (!r.object) throw new Error(`build produced no object (errors: ${r.errors.join("; ")})`);
  if (r.errors.length) throw new Error(`build errors: ${r.errors.join("; ")}`);
  return r;
};

// ── T1. Default build ───────────────────────────────────────────────────────
t("T1 default type builds a 1.2 x 0.6 x 0.8 box with its base at elevation 0", () => {
  const r = build(typeA);
  const box = boxOf(r.object);
  const size = sizeOf(box);
  near(size[0], 1.2, 1e-6, "width");
  near(size[1], 0.6, 1e-6, "height");
  near(size[2], 0.8, 1e-6, "depth");
  near(box[1], 0, 1e-6, "base at elevation 0");
  near(box[4], 0.6, 1e-6, "top at height");
  near(r.params.footprint, 0.96, 1e-9, "footprint formula = width * depth");
  if (r.object.userData.familyId !== family.id) throw new Error("built object is not tagged with the family id");
  if (r.object.userData.familyTypeId !== typeA.id) throw new Error("built object is not tagged with the type id");
});

// ── T2. Rebuild on a type change ────────────────────────────────────────────
t("T2 rebuild on a type change follows the new type; an override on another instance survives", () => {
  // Instance 1: plain, on type A. Instance 2: elevation override 1.5, on type A.
  const before1 = boxOf(build(typeA).object);
  const ov2 = { elevation: 1.5 };
  const before2 = boxOf(build(typeA, ov2).object);
  near(before2[1], 1.5, 1e-6, "instance 2 base at its elevation override before the change");

  // The type changes: width 1.2 -> 0.6, height 0.6 -> 0.45, depth 0.8 -> 0.6.
  const after1 = E.resolveInstanceAfterTypeChange(family, typeB, {});
  const box1 = boxOf(build(typeB).object);
  near(sizeOf(box1)[0], 0.6, 1e-6, "instance 1 width follows the new type");
  near(sizeOf(box1)[1], 0.45, 1e-6, "instance 1 height follows the new type");
  near(after1.values.width, 0.6, "re-resolved width follows the new type");

  const after2 = E.resolveInstanceAfterTypeChange(family, typeB, ov2);
  const box2 = boxOf(E.buildParametricFamily(family, typeB, { overrides: ov2 }).object);
  near(after2.values.elevation, 1.5, "instance 2 keeps its elevation override after the type change");
  near(box2[1], 1.5, 1e-6, "instance 2 base stays at its elevation override after the type change");
  near(sizeOf(box2)[0], 0.6, 1e-6, "instance 2 still follows the new type width");
  if (JSON.stringify(before1) === JSON.stringify(box1)) throw new Error("rebuild did not change the box");
});

// ── T3. Instance parameters ─────────────────────────────────────────────────
t("T3 elevation lifts the base; rotation 90 swaps the X/Z extents", () => {
  const lifted = boxOf(build(typeA, { elevation: 2 }).object);
  near(lifted[1], 2, 1e-6, "base at elevation 2");
  near(lifted[4], 2.6, 1e-6, "top at elevation + height");

  const rotated = boxOf(build(typeA, { rotation: 90 }).object);
  const size = sizeOf(rotated);
  near(size[0], 0.8, 1e-6, "X extent is the depth after a 90-degree rotation");
  near(size[2], 1.2, 1e-6, "Z extent is the width after a 90-degree rotation");
  near(size[1], 0.6, 1e-6, "height unchanged by plan rotation");

  const both = boxOf(build(typeA, { elevation: 1, rotation: 45 }).object);
  near(both[1], 1, 1e-6, "base at elevation 1 with rotation applied");
  // 45-degree plan rotation of a 1.2 x 0.8 footprint: extent = (1.2 + 0.8) / sqrt(2).
  near(sizeOf(both)[0], (1.2 + 0.8) / Math.SQRT2, 1e-6, "45-degree footprint extent");
});

// ── T4. Placement as real AuthoredElements ──────────────────────────────────
t("T4 resolvePlacement places real AuthoredElements carrying the family params", () => {
  const mk = (id, typeId, overrides) => {
    const placed = P.resolvePlacement(family.id, typeId, overrides);
    if (!placed) throw new Error("resolvePlacement returned null");
    return {
      id, type: "generic", name: "Plinth " + id,
      familyId: family.id, familyTypeId: typeId,
      params: { height: 0.6, thickness: 0.1, elevation: 0, ...placed.params },
    };
  };
  const el1 = mk("el1", typeA.id);
  deep(Object.keys(el1.params).sort(), ["depth", "elevation", "height", "rotation", "thickness", "width"], "placed params carry the family geometry keys");
  near(el1.params.width, 1.2, "placed width from the type");
  near(el1.params.rotation, 0, "placed rotation defaults to 0");

  const el2 = mk("el2", typeA.id, { elevation: 0.5, rotation: 30 });
  near(el2.params.elevation, 0.5, "instance elevation override reaches the element");
  near(el2.params.rotation, 30, "instance rotation override reaches the element");

  // A sync moves rotation through applyResolvedParams.
  const resolved = fakeService.resolveParams(family.id, typeA.id, { rotation: 45 });
  if (!P.applyResolvedParams(el2, resolved)) throw new Error("expected the sync to change the element");
  near(el2.params.rotation, 45, "rotation synced onto the element");
});

// ── T5. Save -> reload round-trip ───────────────────────────────────────────
t("T5 family + elements survive JSON save/reload with identical params and boxes", () => {
  const elements = [
    { id: "el1", type: "generic", name: "Plinth 1", familyId: family.id, familyTypeId: typeA.id,
      params: { width: 1.2, depth: 0.8, height: 0.6, elevation: 0, rotation: 0, thickness: 0.1 } },
    { id: "el2", type: "generic", name: "Plinth 2", familyId: family.id, familyTypeId: typeA.id,
      params: { width: 1.2, depth: 0.8, height: 0.6, elevation: 1.5, rotation: 90, thickness: 0.1 } },
  ];
  const before = elements.map((el) => {
    const type = family.types.find((x) => x.id === el.familyTypeId);
    const ov = E.extractInstanceOverrides(
      fakeService.resolveParams(family.id, el.familyTypeId),
      el.params, P.GEOMETRY_KEYS);
    const r = E.buildParametricFamily(family, type, { overrides: ov });
    return { values: r.params, box: boxOf(r.object) };
  });

  // The save: family definition + elements as plain JSON, as a project
  // document would carry them. The reload: parse and rebuild from scratch.
  const saved = JSON.stringify({ family, elements });
  const restored = JSON.parse(saved);
  if (JSON.stringify(restored.family) !== JSON.stringify(family)) {
    throw new Error("family definition did not survive the round-trip");
  }
  restored.elements.forEach((el, i) => {
    const type = restored.family.types.find((x) => x.id === el.familyTypeId);
    const ov = E.extractInstanceOverrides(
      fakeService.resolveParams(restored.family.id, el.familyTypeId),
      el.params, P.GEOMETRY_KEYS);
    const r = E.buildParametricFamily(restored.family, type, { overrides: ov });
    if (r.errors.length) throw new Error(`rebuild errors after reload: ${r.errors.join("; ")}`);
    deep(r.params, before[i].values, `element ${el.id}: resolved params differ after reload`);
    boxOf(r.object).forEach((v, j) => near(v, before[i].box[j], 1e-9, `element ${el.id}: bounding box differs after reload`));
  });
  near(before[1].box[1], 1.5, 1e-6, "second element keeps its elevation through the round-trip");
});

console.log(`\nparametric-rectangular-family: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
