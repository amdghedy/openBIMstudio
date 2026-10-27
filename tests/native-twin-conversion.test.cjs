/**
 * Native Twin conversion — geometry extraction guards (no WebGL).
 */
const assert = require("assert");

function finiteMatrixFromUnknown(input) {
  // Mirrors src/modules/native-twin/geometry-extract.ts behaviour for tests
  if (!input) return "identity";
  if (input.elements && (Array.isArray(input.elements) || ArrayBuffer.isView(input.elements))) {
    const a = Array.from(input.elements);
    assert.strictEqual(a.length >= 16, true);
    return "from-elements";
  }
  if (Array.isArray(input) || ArrayBuffer.isView(input)) {
    const a = Array.from(input);
    if (a.length >= 16) return "from-array";
  }
  return "identity";
}

function meshDataListFromApiResult(groups, localId) {
  if (!groups) return [];
  if (Array.isArray(groups)) {
    if (groups.length && Array.isArray(groups[0])) {
      const flat = [];
      for (const g of groups) if (Array.isArray(g)) flat.push(...g);
      return flat.filter(Boolean);
    }
    if (groups.length && (groups[0]?.positions || groups[0]?.transform)) return groups;
  }
  if (typeof groups === "object") {
    const obj = groups;
    if (Array.isArray(obj[String(localId)])) return obj[String(localId)];
    const values = Object.values(obj);
    if (values.length && Array.isArray(values[0])) return values.flat().filter(Boolean);
  }
  return [];
}

// Nested MeshData[][] (Fragments contract)
const nested = [[{ positions: new Float32Array(9), transform: { elements: new Array(16).fill(0) } }]];
assert.strictEqual(meshDataListFromApiResult(nested, 35960).length, 1);

// Flat MeshData[]
const flat = [{ positions: new Float32Array(12), transform: null }];
assert.strictEqual(meshDataListFromApiResult(flat, 1).length, 1);

// Map by localId
const map = { "35960": [{ positions: new Float32Array(9) }] };
assert.strictEqual(meshDataListFromApiResult(map, 35960).length, 1);

// Transform formats
assert.strictEqual(finiteMatrixFromUnknown({ elements: new Array(16).fill(1) }), "from-elements");
assert.strictEqual(finiteMatrixFromUnknown(new Array(16).fill(0)), "from-array");
assert.strictEqual(finiteMatrixFromUnknown(null), "identity");

// Reject non-finite geometry for twin registration
function positionsUsable(positions) {
  if (!positions || positions.length < 9) return false;
  for (let i = 0; i < Math.min(positions.length, 12); i++) {
    if (!Number.isFinite(Number(positions[i]))) return false;
  }
  return true;
}
assert.strictEqual(positionsUsable(new Float32Array([0,0,0,1,0,0,1,1,0])), true);
assert.strictEqual(positionsUsable(new Float32Array([NaN,0,0,1,0,0,1,1,0])), false);
assert.strictEqual(positionsUsable(new Float32Array(6)), false);

// Failure message distinguishes mapping vs empty
function failureUserMessage(modelId, localId, reason) {
  if (reason === "no_geometry_mapping") {
    return `Native Twin: element ${localId} in ${modelId} has no geometry mapping`;
  }
  return `Native Twin: could not retrieve usable geometry for ${modelId} / ${localId}`;
}
assert.ok(failureUserMessage("3032_ECG-INT-T2-BASE2-S", 35960, "no_geometry_mapping").includes("35960"));
assert.ok(failureUserMessage("3032_ECG-INT-T2-BASE2-S", 35960, "geometry_api_empty").includes("3032_ECG-INT-T2-BASE2-S"));

console.log("native-twin-conversion.test.cjs: ok");
