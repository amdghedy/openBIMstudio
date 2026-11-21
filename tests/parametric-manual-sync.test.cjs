/**
 * tests/parametric-manual-sync.test.cjs
 *
 * Follow-up 5 (Revit parity gap 5): manual "Sync instances" (family
 * browser button) must preserve instance overrides.
 *
 * Slice 1 fixed the type-edit path; the manual sync still passed no
 * overrides, so it re-resolved every instance from the type alone and
 * wiped overrides. The button handler now captures each target
 * instance's overrides against the CURRENT type resolution via
 * placement.captureManualSyncOverrides and passes the map to
 * syncFamilyInstances.
 *
 * The capture is scope-aware (see placement.ts): only instance-scope
 * parameters and undeclared (placement-level) geometry keys are
 * captured. A type-scope value that differs from the current type
 * resolution can never be a user override — type-scope edits are routed
 * to the type — so it is a stale inherited value (the type changed
 * out-of-band, e.g. via a catalog import) and must follow the type on
 * sync, not be frozen.
 *
 * Tests:
 *   M1. Regression: override set, type changed out-of-band, manual sync
 *       run — the override survives AND the type value is still updated
 *       (on the same instance, for different keys).
 *   M2. Manual sync with no type selected syncs every type (and untyped
 *       instances), preserving each instance's own overrides; capturing
 *       for one type excludes the other type's instances.
 *   M3. Unit: a stored type-scope deviation is NOT captured (stale
 *       inherited value, not an override); only the instance-scope
 *       override is.
 *   M4. Degenerate cases: no family service / unknown family -> null;
 *       no overrides anywhere -> an (empty) Map, not null.
 *   M1-control. Sensitivity: the same setup synced WITHOUT the captured
 *       map wipes the override — proving M1 guards the bug.
 *
 * Run: `node tests/parametric-manual-sync.test.cjs`
 * CI:  `test:parametric-manual-sync` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * Same compile-from-source pattern as
 * tests/parametric-type-propagation.test.cjs: the slice is compiled with
 * tsc into a temp dir inside the repo so `three` resolves from the
 * repo's node_modules. The full authoring module is a browser module and
 * is not loadable in node; the family-browser button handler is likewise
 * browser-only. The testable surface is the capture helper plus a test
 * double for the authoring seam that runs the REAL applyResolvedParams,
 * exactly as the real syncFamilyInstances does.
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const nassert = require("node:assert");

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
  const tol = typeof tolOrMsg === "number" ? tolOrMsg : 1e-9;
  const label = typeof tolOrMsg === "string" ? tolOrMsg : msg;
  if (!(Math.abs(a - b) <= tol)) {
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol})${label ? ": " + label : ""}`);
  }
};
const deep = (a, b, msg) => nassert.deepStrictEqual(a, b, msg);

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".manual-sync-test-"));
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

/**
 * Install stub family/authoring services on ctx and return the doubles.
 * The authoring double runs the REAL applyResolvedParams over the map it
 * is given, exactly as the real syncFamilyInstances does; `manualSync`
 * reproduces the family-browser button handler (capture, then sync).
 */
function installDoubles(family, elements) {
  const fakeService = {
    get: (id) => (id === family.id ? family : null),
    updateType: (fid, tid, patch) => {
      const type = family.types.find((x) => x.id === tid);
      if (!type) return null;
      Object.assign(type, patch);
      return type;
    },
    resolveParams: (fid, tid, overrides) => {
      const type = tid ? family.types.find((x) => x.id === tid) ?? null : null;
      return E.resolveParametricValues(family, type, { overrides }).values;
    },
  };
  const calls = { sync: [] };
  const fakeAuthoring = {
    getElements: () => elements,
    syncFamilyInstances: (fid, tid, map) => {
      calls.sync.push({ fid, tid, map });
      let changed = 0;
      for (const el of elements) {
        if (el.familyId !== fid) continue;
        if (tid !== null && el.familyTypeId !== tid) continue;
        const resolved = fakeService.resolveParams(fid, el.familyTypeId ?? tid, map?.get(el.id));
        if (!resolved) continue;
        if (P.applyResolvedParams(el, resolved)) changed++;
      }
      return changed;
    },
  };
  CTX.ctx.features.family = fakeService;
  CTX.ctx.features.authoring = fakeAuthoring;
  const manualSync = (fid, tid) => {
    const overrides = P.captureManualSyncOverrides(fid, tid);
    return fakeAuthoring.syncFamilyInstances(fid, tid, overrides);
  };
  const teardown = () => {
    CTX.ctx.features.family = undefined;
    CTX.ctx.features.authoring = undefined;
  };
  return { fakeService, fakeAuthoring, calls, manualSync, teardown };
}

// ── M1. Regression: override survives a manual sync; type value still updates ──
t("M1 regression: thickness override survives manual sync, type height still updates", () => {
  const family = makeFamily();
  // Both instances placed under the old type values (height 3); then the
  // user overrides thickness on e1 only.
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.3, height: 3, width: 2, depth: 1 } },
    { id: "e2", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
  ];
  const { manualSync, calls, teardown } = installDoubles(family, elements);
  try {
    // Out-of-band type change (e.g. a catalog import): height 3 -> 4,
    // with no sync — this is exactly the case the manual button exists
    // to repair.
    family.types[0].values.height = 4;

    const n = manualSync("fam-test", "t1");
    if (calls.sync.length !== 1) throw new Error("expected exactly one sync call");
    const map = calls.sync[0].map;
    if (!(map instanceof Map)) throw new Error("sync was not given an override map");
    deep(map.get("e1"), { thickness: 0.3 }, "only the genuine override is captured for e1");
    if (map.has("e2")) throw new Error("plain instance must not appear in the override map");
    if (n !== 2) throw new Error(`expected 2 instances synced, got ${n}`);
    near(elements[0].params.thickness, 0.3, "e1 keeps its thickness override");
    near(elements[0].params.height, 4, "e1 still receives the new type height");
    near(elements[0].params.width, 2, "e1 untouched type value unchanged");
    near(elements[1].params.thickness, 0.2, "e2 follows the type thickness");
    near(elements[1].params.height, 4, "e2 receives the new type height");
  } finally {
    teardown();
  }
});

// ── M1-control. Sensitivity: the same setup without the map wipes the override ──
t("M1-control: manual sync without the captured map wipes the override", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.3, height: 3, width: 2, depth: 1 } },
    { id: "e2", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
  ];
  const { fakeAuthoring, teardown } = installDoubles(family, elements);
  try {
    family.types[0].values.height = 4;
    // The pre-fix button behaviour: sync with no override map.
    const n = fakeAuthoring.syncFamilyInstances("fam-test", "t1");
    if (n !== 2) throw new Error(`expected 2 instances synced, got ${n}`);
    near(elements[0].params.thickness, 0.2, "control: no map means the type value wins and the override is wiped");
    near(elements[0].params.height, 4, "control: the type change still reaches the instance");
  } finally {
    teardown();
  }
});

// ── M2. No type selected: every type (and untyped instances) sync, overrides kept ──
t("M2 all-types sync preserves each instance's own overrides; per-type capture excludes other types", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.3, height: 3, width: 2, depth: 1 } },
    { id: "e2", familyId: "fam-test", familyTypeId: "t2", params: { thickness: 0.9, height: 5, width: 4, depth: 2 } },
    { id: "e3", familyId: "fam-test", familyTypeId: null, params: { thickness: 0.5, height: 3, width: 2, depth: 1 } },
    { id: "e4", familyId: "other-family", familyTypeId: "t1", params: { thickness: 0.7, height: 3, width: 2, depth: 1 } },
  ];
  const { manualSync, calls, teardown } = installDoubles(family, elements);
  try {
    // Per-type capture must not leak across types.
    const t1Only = P.captureManualSyncOverrides("fam-test", "t1");
    if (!(t1Only instanceof Map)) throw new Error("expected a Map for the t1 capture");
    deep(t1Only.get("e1"), { thickness: 0.3 }, "t1 capture holds e1's override");
    if (t1Only.has("e2")) throw new Error("t1 capture must not include the t2 instance");
    if (t1Only.has("e3")) throw new Error("t1 capture must not include the untyped instance");
    if (t1Only.has("e4")) throw new Error("capture must not include another family's instances");

    // Out-of-band change to t1 only; t2's type is untouched.
    family.types[0].values.height = 4;
    const n = manualSync("fam-test", null);
    if (calls.sync.length !== 1) throw new Error("expected exactly one sync call");
    const map = calls.sync[0].map;
    deep(map.get("e1"), { thickness: 0.3 }, "all-types capture holds e1's override");
    deep(map.get("e2"), { thickness: 0.9 }, "all-types capture holds e2's override");
    deep(map.get("e3"), { thickness: 0.5 }, "all-types capture holds the untyped instance's override");
    if (map.has("e4")) throw new Error("all-types capture must not include another family's instances");
    // All three change: e1 via the type height, e2/e3 because the sync
    // writes `elevation: 0` (the resolved default) onto instances that
    // never stored it — pre-existing sync behaviour via
    // applyResolvedParams, already true in Slice 1.
    if (n !== 3) throw new Error(`expected 3 instances changed, got ${n}`);
    near(elements[0].params.thickness, 0.3, "e1 keeps its override");
    near(elements[0].params.height, 4, "e1 receives the t1 type change");
    near(elements[1].params.thickness, 0.9, "e2 keeps its override");
    near(elements[1].params.height, 5, "e2 keeps its own type's height");
    near(elements[2].params.thickness, 0.5, "untyped e3 keeps its override");
    near(elements[2].params.height, 3, "untyped e3 keeps the family-default height");
    near(elements[3].params.thickness, 0.7, "other family's instance is untouched");
  } finally {
    teardown();
  }
});

// ── M3. Unit: a stored type-scope deviation is not an override ──
t("M3 unit: stale type-scope value is not captured, instance-scope override is", () => {
  const family = makeFamily();
  const elements = [
    // height 9 is a stale inherited value (type says 3); thickness 0.3
    // is a genuine instance override. Only the latter may be captured —
    // capturing height would freeze the stale value on every later sync.
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.3, height: 9, width: 2, depth: 1 } },
  ];
  const { teardown } = installDoubles(family, elements);
  try {
    const map = P.captureManualSyncOverrides("fam-test", "t1");
    if (!(map instanceof Map)) throw new Error("expected a Map");
    deep(map.get("e1"), { thickness: 0.3 }, "only the instance-scope override is captured");
  } finally {
    teardown();
  }
});

// ── M4. Degenerate cases ──
t("M4 degenerate: no service / unknown family -> null; no overrides -> empty Map", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
  ];
  // No service installed at all.
  CTX.ctx.features.family = undefined;
  CTX.ctx.features.authoring = undefined;
  if (P.captureManualSyncOverrides("fam-test", "t1") !== null) {
    throw new Error("expected null with no family service");
  }

  const { teardown } = installDoubles(family, elements);
  try {
    if (P.captureManualSyncOverrides("no-such-family", "t1") !== null) {
      throw new Error("expected null for an unknown family");
    }
    const map = P.captureManualSyncOverrides("fam-test", "t1");
    if (!(map instanceof Map)) throw new Error("expected a Map when the service is ready");
    if (map.size !== 0) throw new Error(`expected an empty Map, got ${map.size} entries`);
  } finally {
    teardown();
  }
});

console.log(`\nparametric-manual-sync: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
