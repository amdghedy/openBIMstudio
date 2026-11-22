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
 * captured by diff — plus any key in the instance's override record
 * (`element.familyOverrides`), any scope. A type-scope value that
 * differs from the current type resolution and carries NO record can
 * never be a user override — type-scope edits are routed to the type —
 * so it is a stale inherited value (the type changed out-of-band, e.g.
 * via a catalog import) and must follow the type on sync, not be
 * frozen. The record is what tells a genuine type-scope override apart
 * from a stale value (FU5 completion).
 *
 * Tests:
 *   M1. Regression: override set, type changed out-of-band, manual sync
 *       run — the override survives AND the type value is still updated
 *       (on the same instance, for different keys).
 *   M2. Manual sync with no type selected syncs every type (and untyped
 *       instances), preserving each instance's own overrides; capturing
 *       for one type excludes the other type's instances.
 *   M3. Unit: a stored type-scope deviation with NO record is NOT
 *       captured (stale inherited value, not an override); only the
 *       instance-scope override is. (The recorded case is M5.)
 *   M4. Degenerate cases: no family service / unknown family -> null;
 *       no overrides anywhere -> an (empty) Map, not null.
 *   M1-control. Sensitivity: the same setup synced WITHOUT the captured
 *       map wipes the override — proving M1 guards the bug.
 *   M5. A RECORDED type-scope override is captured and survives a
 *       manual sync, while an unrecorded stale value for the same key
 *       refreshes from the type.
 *   M6. `editFamilyParameter` records instance-scope writes; writing
 *       the type value back clears the record; the explicit
 *       `overrideInstanceParameter` records a type-scope deviation and
 *       refuses an unknown parameter.
 *   M7. A type swap records the overrides it re-applies, so a later
 *       manual sync preserves them instead of wiping them as stale
 *       deviations from the new type.
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

// ── M3. Unit: a stored type-scope deviation with NO record is not an override ──
t("M3 unit: stale type-scope value is not captured, instance-scope override is", () => {
  const family = makeFamily();
  const elements = [
    // height 9 is a stale inherited value (type says 3) with NO override
    // record; thickness 0.3 is a genuine instance override. Only the
    // latter may be captured — capturing height would freeze the stale
    // value on every later sync. (The recorded case is M5.)
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

// ── M5. A RECORDED type-scope override is captured; an unrecorded stale value refreshes ──
t("M5 recorded type-scope override survives manual sync, unrecorded stale value refreshes", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
    { id: "e2", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
  ];
  const { manualSync, calls, teardown } = installDoubles(family, elements);
  try {
    // e1: a deliberate per-instance override of the TYPE-scope height,
    // via the explicit override API — the case FU5 could not cover, for
    // want of a record. e2 carries the same stored value with NO record
    // (a stale inherited value after the out-of-band change below).
    const res = P.overrideInstanceParameter(elements[0], "height", 9);
    if (res.applied !== "instance") throw new Error(`expected the override to apply to the instance, got ${res.applied}`);
    deep(elements[0].familyOverrides, ["height"], "the override is recorded on the element");
    elements[1].params.height = 9; // stale, unrecorded

    // Out-of-band type change: height 3 -> 4.
    family.types[0].values.height = 4;

    const n = manualSync("fam-test", "t1");
    if (calls.sync.length !== 1) throw new Error("expected exactly one sync call");
    const map = calls.sync[0].map;
    deep(map.get("e1"), { height: 9 }, "the recorded type-scope override is captured");
    if (map.has("e2")) throw new Error("the unrecorded stale value must not be captured");
    if (n !== 2) throw new Error(`expected 2 instances synced, got ${n}`);
    near(elements[0].params.height, 9, "e1 keeps its recorded height override");
    near(elements[1].params.height, 4, "e2 refreshes to the new type height");
  } finally {
    teardown();
  }
});

// ── M6. Write paths record; writing the type value clears the record ──
t("M6 instance edit records the override; writing the type value clears it", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
  ];
  const { teardown } = installDoubles(family, elements);
  try {
    const r1 = P.editFamilyParameter(elements[0], "thickness", 0.3);
    if (r1.applied !== "instance") throw new Error(`expected instance application, got ${r1.applied}`);
    deep(elements[0].familyOverrides, ["thickness"], "the instance edit is recorded");
    // Writing the type value back is not a deviation any more.
    const r2 = P.editFamilyParameter(elements[0], "thickness", 0.2);
    if (r2.applied !== "instance") throw new Error(`expected instance application, got ${r2.applied}`);
    if (elements[0].familyOverrides !== undefined) throw new Error("the record must clear when the value matches the type again");
    // The explicit override API records a type-scope deviation too.
    const r3 = P.overrideInstanceParameter(elements[0], "height", 7);
    if (r3.applied !== "instance") throw new Error(`expected instance application, got ${r3.applied}`);
    deep(elements[0].familyOverrides, ["height"], "the type-scope override is recorded");
    // And it refuses an unknown parameter instead of writing it.
    const r4 = P.overrideInstanceParameter(elements[0], "no-such-param", 1);
    if (r4.applied !== "none") throw new Error("unknown parameter must not apply");
    if (!r4.reason) throw new Error("unknown parameter must explain itself");
  } finally {
    teardown();
  }
});

// ── M7. A type swap records the overrides it re-applies ──
t("M7 swap records re-applied overrides; manual sync after the swap preserves them", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.3, height: 3, width: 2, depth: 1 } },
    { id: "e2", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
  ];
  const { manualSync, teardown } = installDoubles(family, elements);
  try {
    // e1 carries TWO genuine overrides: an instance-scope thickness
    // override, and a RECORDED type-scope height override (via the
    // explicit override API). Both must survive the swap onto t2.
    const ov = P.overrideInstanceParameter(elements[0], "height", 9);
    if (ov.applied !== "instance") throw new Error(`expected the override to apply, got ${ov.applied}`);
    const swapped = P.swapFamilyType(elements[0], "t2");
    if (!swapped.swapped) throw new Error("expected the swap to happen");
    if (elements[0].familyTypeId !== "t2") throw new Error("expected e1 on t2 after the swap");
    deep(elements[0].familyOverrides, ["height", "thickness"], "the swap records the overrides it re-applied");
    // The swap re-resolved e1 from t2 (width 4, depth 2) with both
    // overrides on top.
    near(elements[0].params.height, 9, "e1 keeps its height override across the swap");
    near(elements[0].params.thickness, 0.3, "e1 keeps its thickness override across the swap");
    near(elements[0].params.width, 4, "e1 takes t2's width after the swap");
    // Out-of-band change to t2 (both keys move), then a manual sync:
    // both recorded overrides must survive. Without the record the
    // height deviation would read as a stale value from t2 and be
    // wiped to 6.
    family.types[1].values.height = 6;
    family.types[1].values.thickness = 0.5;
    const n = manualSync("fam-test", "t2");
    // The sync changes NOTHING: both recorded overrides survive and
    // every other key already matches t2 — which is exactly the point.
    // (If either override had been wiped, n would be 1.)
    if (n !== 0) throw new Error(`expected the sync to change nothing, got ${n}`);
    near(elements[0].params.height, 9, "e1 keeps its height override after the post-swap manual sync");
    near(elements[0].params.thickness, 0.3, "e1 keeps its thickness override after the post-swap manual sync");
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
