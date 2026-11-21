/**
 * tests/parametric-type-swap.test.cjs
 *
 * Slice 1 follow-up (Revit parity gap 5): the property-palette type
 * swap used to set `element.familyTypeId` and call
 * `syncFamilyInstances(familyId, newTypeId)` with no override map, so a
 * swap wiped the swapped element's instance overrides — the same wipe
 * Slice 1 fixed for type edits, on a different operation.
 * `placement.swapFamilyType` captures every affected instance's
 * overrides against the type it is leaving, before the swap, and passes
 * the map to the sync.
 *
 * Tests (all through the real `swapFamilyType`, with a fake family
 * service and a test double for the authoring seam that runs the REAL
 * `applyResolvedParams`, exactly as the real syncFamilyInstances does;
 * the full authoring module is a browser module and is not loadable
 * in node):
 *   T1. Regression: an instance override survives a type swap, and an
 *       instance already on the new type is untouched.
 *   T2. A swap with no overrides adopts the new type fully.
 *   T3. Undo round-trip: swap A->B then B->A — the override survives
 *       both directions.
 *   T4. Swapping to the current type is a no-op (no sync call).
 *   T5. A typeless element swapping to a type keeps only the values
 *       that differ from the family defaults; default-equal values
 *       adopt the new type.
 *
 * Run: `node tests/parametric-type-swap.test.cjs`
 * CI:  `test:parametric-type-swap` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The modules under test are compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-type-propagation.test.cjs), so `three` resolves from
 * the repo's node_modules.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const nassert = assert;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
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
const tmpOut = fs.mkdtempSync(path.join(root, ".type-swap-test-"));
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

// Test double for the authoring seam only: runs the REAL
// applyResolvedParams over the captured override map, exactly as the
// real syncFamilyInstances does.
function makeWorld(family, elements) {
  const calls = { sync: [] };
  const fakeService = {
    get: (id) => (id === family.id ? family : null),
    resolveParams: (fid, tid, overrides) => {
      const type = tid ? family.types.find((x) => x.id === tid) ?? null : null;
      return E.resolveParametricValues(family, type, { overrides }).values;
    },
  };
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
  return { calls, teardown: () => { CTX.ctx.features.family = undefined; CTX.ctx.features.authoring = undefined; } };
}

// ── T1. Regression: override survives a type swap ──────────────────────────
t("T1 override survives a type swap; instances already on the new type untouched", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.3, height: 3, width: 2, depth: 1 } },
    { id: "e2", familyId: "fam-test", familyTypeId: "t2", params: { thickness: 0.4, height: 5, width: 4, depth: 2 } },
    { id: "e3", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
  ];
  const { calls, teardown } = makeWorld(family, elements);
  try {
    const res = P.swapFamilyType(elements[0], "t2");
    if (!res.swapped) throw new Error("expected swapped true");
    if (calls.sync.length !== 1) throw new Error(`expected exactly one sync call, got ${calls.sync.length}`);
    const map = calls.sync[0].map;
    if (!(map instanceof Map)) throw new Error("sync was not given an override map");
    deep(map.get("e1"), { thickness: 0.3 }, "swapped element's override captured against the previous type");
    if (map.has("e2")) throw new Error("plain instance on the new type must not appear in the override map");
    if (elements[0].familyTypeId !== "t2") throw new Error("element type id was not updated");
    near(elements[0].params.thickness, 0.3, "e1 keeps its thickness override after the swap");
    near(elements[0].params.height, 5, "e1 receives the new type height");
    near(elements[0].params.width, 4, "e1 receives the new type width");
    near(elements[0].params.depth, 2, "e1 receives the new type depth");
    near(elements[1].params.thickness, 0.4, "e2 on the new type is untouched");
    near(elements[1].params.height, 5, "e2 on the new type is untouched (height)");
    near(elements[2].params.thickness, 0.2, "e3 still on the old type is untouched");
    near(elements[2].params.height, 3, "e3 still on the old type is untouched (height)");
  } finally { teardown(); }
});

// ── T2. Swap with no overrides adopts the new type fully ───────────────────
t("T2 swap with no overrides adopts the new type fully", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.2, height: 3, width: 2, depth: 1 } },
  ];
  const { calls, teardown } = makeWorld(family, elements);
  try {
    const res = P.swapFamilyType(elements[0], "t2");
    if (!res.swapped) throw new Error("expected swapped true");
    if (calls.sync[0].map.size !== 0) throw new Error("no overrides should be captured");
    near(elements[0].params.thickness, 0.4, "thickness follows the new type");
    near(elements[0].params.height, 5, "height follows the new type");
    near(elements[0].params.width, 4, "width follows the new type");
  } finally { teardown(); }
});

// ── T3. Undo round-trip ─────────────────────────────────────────────────────
t("T3 override survives swap A->B and back B->A", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.3, height: 3, width: 2, depth: 1 } },
  ];
  const { teardown } = makeWorld(family, elements);
  try {
    P.swapFamilyType(elements[0], "t2");
    near(elements[0].params.thickness, 0.3, "override survives the forward swap");
    near(elements[0].params.height, 5, "new type height after forward swap");
    P.swapFamilyType(elements[0], "t1");
    near(elements[0].params.thickness, 0.3, "override survives the revert");
    near(elements[0].params.height, 3, "old type height restored by the revert");
    near(elements[0].params.width, 2, "old type width restored by the revert");
  } finally { teardown(); }
});

// ── T4. Same-type swap is a no-op ───────────────────────────────────────────
t("T4 swapping to the current type is a no-op", () => {
  const family = makeFamily();
  const elements = [
    { id: "e1", familyId: "fam-test", familyTypeId: "t1", params: { thickness: 0.3, height: 3, width: 2, depth: 1 } },
  ];
  const { calls, teardown } = makeWorld(family, elements);
  try {
    const before = JSON.stringify(elements[0].params);
    const res = P.swapFamilyType(elements[0], "t1");
    if (res.swapped) throw new Error("expected swapped false");
    if (res.instancesSynced !== 0) throw new Error("expected 0 instances synced");
    if (calls.sync.length !== 0) throw new Error("no sync call should happen");
    if (JSON.stringify(elements[0].params) !== before) throw new Error("params were written by a no-op swap");
  } finally { teardown(); }
});

// ── T5. Typeless element ────────────────────────────────────────────────────
t("T5 typeless element keeps only values that differ from the family defaults", () => {
  const family = makeFamily();
  const elements = [
    // thickness 0.35 differs from the 0.2 default (user-set, keep);
    // height 3 and width 2 equal the defaults (adopt the new type).
    { id: "e1", familyId: "fam-test", familyTypeId: null, params: { thickness: 0.35, height: 3, width: 2, depth: 1 } },
  ];
  const { calls, teardown } = makeWorld(family, elements);
  try {
    const res = P.swapFamilyType(elements[0], "t2");
    if (!res.swapped) throw new Error("expected swapped true");
    deep(calls.sync[0].map.get("e1"), { thickness: 0.35 }, "only the above-default value is captured as an override");
    if (elements[0].familyTypeId !== "t2") throw new Error("element type id was not updated");
    near(elements[0].params.thickness, 0.35, "above-default thickness survives the swap");
    near(elements[0].params.height, 5, "default-equal height adopts the new type");
    near(elements[0].params.width, 4, "default-equal width adopts the new type");
  } finally { teardown(); }
});

console.log(`\nparametric-type-swap: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
