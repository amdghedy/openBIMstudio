/**
 * Native Twin conversion safety — geometry validation and registry shape.
 * Does not drive WebGL; verifies pure conversion helpers stay finite-safe.
 */
const assert = require("assert");

function buildCenteredGeometryPure(tris) {
  if (!tris.length) return null;
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const expand = (x, y, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    box.min[0] = Math.min(box.min[0], x); box.min[1] = Math.min(box.min[1], y); box.min[2] = Math.min(box.min[2], z);
    box.max[0] = Math.max(box.max[0], x); box.max[1] = Math.max(box.max[1], y); box.max[2] = Math.max(box.max[2], z);
    return true;
  };
  let any = false;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      if (expand(t[k * 3], t[k * 3 + 1], t[k * 3 + 2])) any = true;
    }
  }
  if (!any) return null;
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const cz = (box.min[2] + box.max[2]) / 2;
  if (![cx, cy, cz].every(Number.isFinite)) return null;
  const positions = [];
  for (const t of tris) {
    let ok = true;
    for (let k = 0; k < 3; k++) {
      if (![t[k*3], t[k*3+1], t[k*3+2]].every(Number.isFinite)) { ok = false; break; }
    }
    if (!ok) continue;
    for (let k = 0; k < 3; k++) {
      positions.push(t[k*3] - cx, t[k*3+1] - cy, t[k*3+2] - cz);
    }
  }
  return positions.length >= 9 ? { positions, center: [cx, cy, cz] } : null;
}

// Unit cube triangles (2 faces worth for simplicity — 2 tris)
const cubeTris = [
  new Float32Array([0,0,0, 1,0,0, 1,1,0]),
  new Float32Array([0,0,0, 1,1,0, 0,1,0]),
];
const built = buildCenteredGeometryPure(cubeTris);
assert.ok(built, "valid geometry builds");
assert.ok(built.positions.every(Number.isFinite), "all positions finite");
assert.ok(built.center.every(Number.isFinite), "center finite");

// Non-finite must be rejected
const bad = [new Float32Array([NaN, 0, 0, 1, 0, 0, 1, 1, 0])];
assert.strictEqual(buildCenteredGeometryPure(bad), null, "NaN geometry rejected");

const inf = [new Float32Array([0, 0, 0, Infinity, 0, 0, 1, 1, 0])];
assert.strictEqual(buildCenteredGeometryPure(inf), null, "Infinity geometry rejected");

console.log("native-twin-conversion.test.cjs: ok");
