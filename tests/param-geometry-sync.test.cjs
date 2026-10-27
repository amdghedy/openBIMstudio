
const assert = require("assert");

function yScale(baseH, h, sy0 = 1) {
  return baseH > 1e-8 ? (h / baseH) * sy0 : sy0;
}

// Bug: if baseH falls back to already-updated height, scale is always 1
assert.strictEqual(yScale(3, 4.5), 1.5, "with fixed base");
assert.strictEqual(yScale(4.5, 4.5), 1, "broken fallback pattern");

// Parametric preference: linear baseline should regenerate solid
function preferParametricSolid(el) {
  const editMode = String(el.properties?.editMode ?? "");
  const hasLinearBaseline = !!(el.params.start && el.params.end);
  return hasLinearBaseline && (editMode === "parametric-linear" || el.type === "wall" || el.type === "beam");
}
assert.strictEqual(preferParametricSolid({
  type: "wall",
  params: { start: [0,0], end: [5,0], height: 3, thickness: 0.2 },
  properties: { editMode: "parametric-linear" },
  nativeGeometry: { positions: [0,0,0,1,0,0,1,1,0] },
}), true);

assert.strictEqual(preferParametricSolid({
  type: "wall",
  params: { height: 3, thickness: 0.2 },
  properties: { editMode: "boundary-mesh" },
  nativeGeometry: { positions: [0,0,0,1,0,0,1,1,0] },
}), false);

console.log("param-geometry-sync.test.cjs: ok");
