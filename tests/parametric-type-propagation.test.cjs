/**
 * tests/parametric-type-propagation.test.cjs
 *
 * Slice 1 (Revit parity gap 5): type propagation must preserve instance
 * overrides.
 *
 *   - A1: a type change updates every instance of that type (and no other).
 *   - A2: an instance change updates only that instance.
 *   - A3: an instance override set *before* a type edit survives that edit
 *         (the regression this slice exists for).
 *   - A4: a type-scope edit on an element with no type writes nothing and
 *         reports `applied: "none"`.
 *   - A5: definition + bindings survive JSON round-trip with identical
 *         resolved parameters and identical rebuilt bounding boxes.
 *
 * Tests:
 *   T1. fast-check property (fixed seeds): random family, random type
 *       change, random overrides — A1 + A2 hold for every generated case.
 *   T2. Regression: the exact override-wipe scenario (instance overrides
 *       `thickness`, then the type changes `height`) — A3, plus the
 *       control proving the test is sensitive (without overrides the
 *       value is wiped).
 *   T3. fast-check property (fixed seeds): random instance bindings — a
 *       type change never alters an instance's override values — A3.
 *   T4. Round-trip: definition + two bindings -> JSON -> restore ->
 *       re-resolve identical, including a formula parameter, and rebuilt
 *       bounding boxes identical — A5.
 *   T5. Unit: type-scope edit with no type -> `applied: "none"`, no
 *       write — A4; plus the placement-level wiring test proving the live
 *       path captures overrides before the type changes and passes them
 *       to the sync.
 *
 * Run: `node tests/parametric-type-propagation.test.cjs`
 * CI:  `test:parametric-type-propagation` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The slice under test is compiled from source with tsc into a temp dir
 * inside the repo (same pattern as tests/family-sketch.test.cjs), so
 * `three` resolves from the repo's node_modules.
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const nassert = require("node:assert");
const fc = require("fast-check");
const THREE = require("three");

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}

const near = (a, b, tolOrMsg = 1e-9, msg) => {
  // Third argument may be a tolerance (number) or a label (string).
  const tol = typeof tolOrMsg === "number" ? tolOrMsg : 1e-9;
  const label = typeof tolOrMsg === "string" ? tolOrMsg : msg;
  if (!(Math.abs(a - b) <= tol)) {
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol})${label ? ": " + label : ""}`);
  }
};
const deep = (a, b, msg) => nassert.deepStrictEqual(a, b, msg);

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".type-prop-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  } catch { /* */ }
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
      if (f.isDirectory()) {
        const r = walk(p);
        if (r) return r;
      } else if (f.name === n) return p;
    }
    return null;
  };
  return walk(tmpOut);
};
const E = require(find("parametric-engine.js"));
const P = require(find("placement.js"));
const CTX = require(find("context.js"));

// ── Fixtures ────────────────────────────────────────────────────────────────
const GEO_KEYS = P.GEOMETRY_KEYS;

function makeFamily() {
  return {
    id: "fam-test",
    name: "Test family",
    category: "generic",
    ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 1,
    builtIn: false,
    parameters: [
      { name: "width", type: "length", scope: "type", default: 2, editable: true },
      { name: "height", type: "length", scope: "type", default: 3, editable: true },
      { name: "depth", type: "length", scope: "type", default: 1, editable: true },
      { name: "thickness", type: "length", scope: "instance", default: 0.2, editable: true },
      { name: "elevation", type: "length", scope: "instance", default: 0, editable: true },
      { name: "area", type: "area", scope: "type", default: 0, editable: false, formula: "= width * depth" },
    ],
    geometry: { kind: "box", w: { ref: "width" }, d: { ref: "depth" }, h: { ref: "height" } },
    types: [
      { id: "t1", name: "Type 1", values: { width: 2, height: 3, depth: 1, thickness: 0.2 } },
      { id: "t2", name: "Type 2", values: { width: 4, height: 5, depth: 2, thickness: 0.4 } },
    ],
  };
}

const round2 = (v) => Math.round(v * 100) / 100;

// Fixed seeds, printed on every run so a failure is reproducible.
const SEEDS = [1, 7, 42, 1337, 20261121];
console.log(`  fast-check seeds: ${SEEDS.join(", ")} (25 runs each)`);

const PARAM_NAMES = ["width", "height", "depth", "thickness", "sillHeight", "frameThickness", "elevation", "offsetAlongHost"];

// ── T1. Property: type change reaches all instances of the type, overrides survive ──
t("T1 property: type change propagates, instance overrides survive (A1+A2+A3)", () => {
  const familyArb = fc.record({
    params: fc.uniqueArray(
      fc.record({
        name: fc.constantFrom(...PARAM_NAMES),
        scope: fc.constantFrom("type", "instance"),
        def: fc.double({ min: 0.1, max: 5, noNaN: true }).map(round2),
      }),
      { minLength: 2, maxLength: 5, selector: (p) => p.name },
    ),
  });
  const caseArb = familyArb.chain((rec) => {
    const names = rec.params.map((p) => p.name);
    return fc.record({
      params: fc.constant(rec.params),
      typeValues: fc.dictionary(
        fc.constantFrom(...names),
        fc.double({ min: 0.1, max: 5, noNaN: true }).map(round2),
      ),
      overrides: fc.dictionary(
        fc.constantFrom(...names),
        fc.double({ min: 0.1, max: 5, noNaN: true }).map(round2),
      ),
      newValue: fc.double({ min: 0.1, max: 5, noNaN: true }).map(round2),
    });
  });

  for (const seed of SEEDS) {
    fc.assert(
      fc.property(caseArb, (c) => {
        // Force at least one type-scope parameter so the "type change"
        // below is well defined; the rest stays random.
        const params = c.params.map((p, i) => (i === 0 ? { ...p, scope: "type" } : p));
        const changedName = params[0].name;
        const family = {
          id: "fam-prop",
          name: "Prop family",
          category: "generic",
          ifcEntity: "IfcBuildingElementProxy",
          schemaVersion: 1,
          builtIn: false,
          parameters: params.map((p) => ({
            name: p.name, type: "length", scope: p.scope, default: p.def, editable: true,
          })),
          geometry: { kind: "box", w: { const: 1 }, d: { const: 1 }, h: { const: 1 } },
          types: [{ id: "t1", name: "T1", values: { ...c.typeValues } }],
        };
        const oldType = family.types[0];
        const newType = {
          ...oldType,
          values: { ...oldType.values, [changedName]: c.newValue },
        };

        // The instance re-resolution after the type change.
        const after = E.resolveInstanceAfterTypeChange(family, newType, c.overrides).values;
        const typeOnly = E.resolveParametricValues(family, newType).values;
        // A3: every override survives exactly.
        for (const [k, v] of Object.entries(c.overrides)) {
          if (after[k] !== v) {
            throw new Error(`override ${k} lost: expected ${v}, got ${after[k]}`);
          }
        }
        // A1/A2: every non-overridden key follows the new type exactly.
        for (const p of params) {
          if (p.name in c.overrides) continue;
          if (after[p.name] !== typeOnly[p.name]) {
            throw new Error(`key ${p.name} diverged from type resolution: ${after[p.name]} vs ${typeOnly[p.name]}`);
          }
        }
        // The changed key itself reaches the instance unless overridden.
        const expected = changedName in c.overrides ? c.overrides[changedName] : c.newValue;
        if (after[changedName] !== expected) {
          throw new Error(`changed param ${changedName}: expected ${expected}, got ${after[changedName]}`);
        }

        // propagateTypeChange: only instances of the changed type are in
        // the output, and the other type is untouched (A1).
        const otherType = { id: "t2", name: "T2", values: { ...c.typeValues, [changedName]: 9.99 } };
        family.types.push(otherType);
        const out = E.propagateTypeChange(family, newType, [
          { elementId: "e1", familyId: "fam-prop", typeId: "t1", overrides: c.overrides },
          { elementId: "e2", familyId: "fam-prop", typeId: "t1", overrides: {} },
          { elementId: "e3", familyId: "fam-prop", typeId: "t2", overrides: c.overrides },
          { elementId: "e4", familyId: "other-family", typeId: "t1", overrides: c.overrides },
        ]);
        if (out.size !== 2) throw new Error(`expected 2 instances in output, got ${out.size}`);
        if (!out.has("e1") || !out.has("e2")) throw new Error("instances of the changed type missing from output");
        if (out.get("e2")[changedName] !== c.newValue) {
          throw new Error(`plain instance did not receive the type change: ${out.get("e2")[changedName]} vs ${c.newValue}`);
        }
        return true;
      }),
      { seed, numRuns: 25 },
    );
  }
});

// ── T2. Regression: the exact override-wipe scenario ──
t("T2 regression: thickness override survives a height type edit (A3)", () => {
  const family = makeFamily();
  const oldType = family.types[0];
  const newType = { ...oldType, values: { ...oldType.values, height: 4 } };

  // Element placed under the old type, then the user overrides thickness.
  const oldResolved = E.resolveParametricValues(family, oldType).values;
  const stored = {};
  for (const key of GEO_KEYS) {
    const v = oldResolved[key];
    if (typeof v === "number" && Number.isFinite(v)) stored[key] = v;
  }
  stored.thickness = 0.3; // the instance override
  near(stored.height, 3);

  // The live path captures overrides against the OLD type resolution.
  const overrides = E.extractInstanceOverrides(oldResolved, stored, GEO_KEYS);
  deep(overrides, { thickness: 0.3 }, "only the genuine override is extracted");

  // Re-resolve against the NEW type with those overrides.
  const after = E.resolveInstanceAfterTypeChange(family, newType, overrides).values;
  near(after.thickness, 0.3, "override survives");
  near(after.height, 4, "type change reaches the instance");
  near(after.width, 2, "untouched type value unchanged");
  near(after.area, 2, "formula recomputed from type values (width 2 x depth 1)");

  // Same story through propagateTypeChange with a second, un-overridden instance.
  const out = E.propagateTypeChange(family, newType, [
    { elementId: "e1", familyId: "fam-test", typeId: "t1", overrides },
    { elementId: "e2", familyId: "fam-test", typeId: "t1", overrides: {} },
  ]);
  near(out.get("e1").thickness, 0.3, "overridden instance keeps its thickness");
  near(out.get("e1").height, 4, "overridden instance still gets the type change");
  near(out.get("e2").thickness, 0.2, "plain instance follows the type thickness");
  near(out.get("e2").height, 4, "plain instance gets the type change");

  // Control: without overrides the old code path wipes the value — this
  // is what the test guards against, so the test must be sensitive to it.
  const wiped = E.resolveParametricValues(family, newType).values;
  near(wiped.thickness, 0.2, "control: no overrides means the type value wins");
});

// ── T3. Property: random bindings — overrides are never altered ──
t("T3 property: a type change never alters any instance override (A3)", () => {
  const familyArb = fc.record({
    params: fc.uniqueArray(
      fc.record({
        name: fc.constantFrom(...PARAM_NAMES),
        scope: fc.constantFrom("type", "instance"),
        def: fc.double({ min: 0.1, max: 5, noNaN: true }).map(round2),
      }),
      { minLength: 2, maxLength: 5, selector: (p) => p.name },
    ),
  });
  const caseArb = familyArb.chain((rec) => {
    const names = rec.params.map((p) => p.name);
    return fc.record({
      params: fc.constant(rec.params),
      typeValues: fc.dictionary(
        fc.constantFrom(...names),
        fc.double({ min: 0.1, max: 5, noNaN: true }).map(round2),
      ),
      bindings: fc.array(
        fc.dictionary(
          fc.constantFrom(...names),
          fc.double({ min: 0.1, max: 5, noNaN: true }).map(round2),
        ),
        { minLength: 1, maxLength: 4 },
      ),
      newValue: fc.double({ min: 0.1, max: 5, noNaN: true }).map(round2),
    });
  });

  for (const seed of SEEDS) {
    fc.assert(
      fc.property(caseArb, (c) => {
        const params = c.params.map((p, i) => (i === 0 ? { ...p, scope: "type" } : p));
        const changedName = params[0].name;
        const family = {
          id: "fam-prop3",
          name: "Prop family 3",
          category: "generic",
          ifcEntity: "IfcBuildingElementProxy",
          schemaVersion: 1,
          builtIn: false,
          parameters: params.map((p) => ({
            name: p.name, type: "length", scope: p.scope, default: p.def, editable: true,
          })),
          geometry: { kind: "box", w: { const: 1 }, d: { const: 1 }, h: { const: 1 } },
          types: [{ id: "t1", name: "T1", values: { ...c.typeValues } }],
        };
        const newType = {
          ...family.types[0],
          values: { ...family.types[0].values, [changedName]: c.newValue },
        };
        const typeOnly = E.resolveParametricValues(family, newType).values;
        const bindings = c.bindings.map((ov, i) => ({
          elementId: `b${i}`, familyId: "fam-prop3", typeId: "t1", overrides: ov,
        }));
        const out = E.propagateTypeChange(family, newType, bindings);
        if (out.size !== bindings.length) {
          throw new Error(`expected ${bindings.length} outputs, got ${out.size}`);
        }
        for (const b of bindings) {
          const values = out.get(b.elementId);
          for (const [k, v] of Object.entries(b.overrides)) {
            if (values[k] !== v) {
              throw new Error(`binding ${b.elementId}: override ${k} changed ${v} -> ${values[k]}`);
            }
          }
          for (const p of params) {
            if (p.name in b.overrides) continue;
            if (values[p.name] !== typeOnly[p.name]) {
              throw new Error(`binding ${b.elementId}: key ${p.name} diverged from type resolution`);
            }
          }
        }
        return true;
      }),
      { seed, numRuns: 25 },
    );
  }
});

// ── T4. Round-trip: definition + bindings -> JSON -> re-resolve ──
t("T4 round-trip: JSON serialise restores identical params and boxes (A5)", () => {
  const family = makeFamily();
  const type = family.types[0];
  const bindings = [
    { elementId: "e1", familyId: "fam-test", typeId: "t1", overrides: { thickness: 0.3 } },
    { elementId: "e2", familyId: "fam-test", typeId: "t1", overrides: { thickness: 0.5, elevation: 1.2 } },
  ];

  const boxOf = (obj) => {
    const box = new THREE.Box3().setFromObject(obj);
    return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
  };

  const before = bindings.map((b) => {
    const r = E.buildParametricFamily(family, type, { overrides: b.overrides });
    if (r.errors.length) throw new Error(`build errors before round-trip: ${r.errors.join("; ")}`);
    if (!r.object) throw new Error("build produced no object before round-trip");
    return { values: r.params, box: boxOf(r.object) };
  });

  const serialised = JSON.stringify({ family, bindings });
  const restored = JSON.parse(serialised);
  const restoredFamily = restored.family;

  restored.bindings.forEach((b, i) => {
    const r = E.buildParametricFamily(restoredFamily, restoredFamily.types[0], { overrides: b.overrides });
    if (r.errors.length) throw new Error(`build errors after round-trip: ${r.errors.join("; ")}`);
    if (!r.object) throw new Error("build produced no object after round-trip");
    deep(r.params, before[i].values, `binding ${b.elementId}: resolved params differ after round-trip`);
    const box = boxOf(r.object);
    box.forEach((v, j) => near(v, before[i].box[j], 1e-9, `binding ${b.elementId}: bounding box differs after round-trip`));
  });

  // The two instances keep *different* overrides after the round-trip.
  near(before[0].values.thickness, 0.3);
  near(before[1].values.thickness, 0.5);
  near(before[1].values.elevation, 1.2);
});

// ── T5. editFamilyParameter: no-type edit reports "none"; wiring captures overrides ──
t("T5a type-scope edit with no type writes nothing, reports none (A4)", () => {
  const family = makeFamily();
  const fakeService = {
    get: (id) => (id === family.id ? family : null),
    updateType: () => { throw new Error("updateType must not be called for a typeless edit"); },
    resolveParams: () => { throw new Error("resolveParams must not be called for a typeless edit"); },
  };
  CTX.ctx.features.family = fakeService;
  CTX.ctx.features.authoring = null;
  try {
    const element = {
      id: "e0", familyId: "fam-test", familyTypeId: null,
      params: { thickness: 0.2, height: 3 },
    };
    const before = JSON.stringify(element.params);
    const res = P.editFamilyParameter(element, "height", 4);
    if (res.applied !== "none") throw new Error(`expected applied "none", got "${res.applied}"`);
    if (!res.reason) throw new Error("expected a reason to be surfaced");
    if (res.instancesSynced !== 0) throw new Error(`expected 0 instances synced, got ${res.instancesSynced}`);
    if (JSON.stringify(element.params) !== before) {
      throw new Error(`element params were written despite no type: ${JSON.stringify(element.params)}`);
    }
  } finally {
    CTX.ctx.features.family = undefined;
    CTX.ctx.features.authoring = undefined;
  }
});

t("T5b live-path wiring: type edit captures overrides before the change (A3)", () => {
  const family = makeFamily();
  const calls = { updateType: [], sync: [] };
  const elements = [
    {
      id: "e1", familyId: "fam-test", familyTypeId: "t1",
      params: { thickness: 0.3, height: 3, width: 2, depth: 1 },
    },
    {
      id: "e2", familyId: "fam-test", familyTypeId: "t1",
      params: { thickness: 0.2, height: 3, width: 2, depth: 1 },
    },
  ];
  const fakeService = {
    get: (id) => (id === family.id ? family : null),
    updateType: (fid, tid, patch) => {
      calls.updateType.push({ fid, tid, patch });
      const t = family.types.find((x) => x.id === tid);
      if (!t) return null;
      Object.assign(t, patch);
      return t;
    },
    resolveParams: (fid, tid, overrides) => {
      const type = tid ? family.types.find((x) => x.id === tid) ?? null : null;
      return E.resolveParametricValues(family, type, { overrides }).values;
    },
  };
  // Test double for the authoring seam only: it runs the REAL
  // applyResolvedParams over the captured override map, exactly as the
  // real syncFamilyInstances does. The full authoring module is a browser
  // module and is not loadable in node; the pure helpers + this seam are
  // the testable surface of Slice 1.
  const fakeAuthoring = {
    getElements: () => elements,
    syncFamilyInstances: (fid, tid, map) => {
      calls.sync.push({ fid, tid, map });
      let changed = 0;
      for (const el of elements) {
        if (el.familyId !== fid || el.familyTypeId !== tid) continue;
        const resolved = fakeService.resolveParams(fid, tid, map?.get(el.id));
        if (!resolved) continue;
        if (P.applyResolvedParams(el, resolved)) changed++;
      }
      return changed;
    },
  };
  CTX.ctx.features.family = fakeService;
  CTX.ctx.features.authoring = fakeAuthoring;
  try {
    const res = P.editFamilyParameter(elements[0], "height", 4);
    if (res.applied !== "type") throw new Error(`expected applied "type", got "${res.applied}"`);
    if (calls.updateType.length !== 1) throw new Error("expected exactly one updateType call");
    deep(calls.updateType[0].patch.values.height, 4, "type value updated");
    if (calls.sync.length !== 1) throw new Error("expected exactly one sync call");
    const map = calls.sync[0].map;
    if (!(map instanceof Map)) throw new Error("sync was not given an override map");
    deep(map.get("e1"), { thickness: 0.3 }, "overrides captured for the overridden instance");
    if (map.has("e2")) throw new Error("plain instance must not appear in the override map");
    if (res.instancesSynced !== 2) throw new Error(`expected 2 instances synced, got ${res.instancesSynced}`);
    near(elements[0].params.thickness, 0.3, "e1 keeps its thickness override");
    near(elements[0].params.height, 4, "e1 receives the type change");
    near(elements[1].params.thickness, 0.2, "e2 follows the type thickness");
    near(elements[1].params.height, 4, "e2 receives the type change");
  } finally {
    CTX.ctx.features.family = undefined;
    CTX.ctx.features.authoring = undefined;
  }
});

console.log(`\nparametric-type-propagation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
