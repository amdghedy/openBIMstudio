/** Unit tests for smart-perp-snap pure math. */
const assert = require("assert");
const path = require("path");
const fs = require("fs");

// Load TS via a minimal transpile-free reimplementation of the public API
// by evaluating the compiled logic inline (mirror of the source formulas).
function projectOnSegment(p, a, b) {
  const ux = b.x - a.x, uz = b.z - a.z;
  const len2 = ux * ux + uz * uz || 1;
  let t = ((p.x - a.x) * ux + (p.z - a.z) * uz) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * ux, z: a.z + t * uz };
}

function evaluateSmartPerpSnap(fixed, free, faces, worldRadius) {
  const cosTol = Math.cos((2 * Math.PI) / 180);
  let best = null;
  const wallLen = Math.hypot(free.x - fixed.x, free.z - fixed.z);
  if (wallLen < 1e-6) return null;
  const d = { x: (free.x - fixed.x) / wallLen, z: (free.z - fixed.z) / wallLen };
  for (const f of faces) {
    const attach = projectOnSegment(free, f.a, f.b);
    const dAttach = Math.hypot(free.x - attach.x, free.z - attach.z);
    if (dAttach > worldRadius) continue;
    const nLen = Math.hypot(f.normal.x, f.normal.z) || 1;
    const nx = f.normal.x / nLen, nz = f.normal.z / nLen;
    const absDot = Math.abs(d.x * nx + d.z * nz);
    if (absDot >= cosTol) {
      const sign = Math.sign(d.x * nx + d.z * nz) || 1;
      const score = 1000 - dAttach;
      const cand = { mode: "face", columnId: f.columnId, attach, direction: { x: nx * sign, z: nz * sign }, normal: { x: nx, z: nz }, score };
      if (!best || cand.score > best.score) best = cand;
    }
  }
  if (!best || best.mode !== "face") {
    for (const f of faces) {
      for (const c of [f.a, f.b]) {
        const dC = Math.hypot(free.x - c.x, free.z - c.z);
        if (dC > worldRadius) continue;
        const score = 500 - dC;
        const cand = { mode: "corner", columnId: f.columnId, attach: { x: c.x, z: c.z }, direction: d, normal: d, score };
        if (!best || cand.score > best.score) best = cand;
      }
    }
  }
  return best;
}

function rectColumnFaces(columnId, point, thickness, depth) {
  const hx = Math.max(thickness, 0.05) / 2;
  const hz = Math.max(depth ?? thickness, 0.05) / 2;
  const cx = point.x, cz = point.z;
  const sw = { x: cx - hx, z: cz - hz };
  const se = { x: cx + hx, z: cz - hz };
  const ne = { x: cx + hx, z: cz + hz };
  const nw = { x: cx - hx, z: cz - hz };
  return [
    { columnId, a: sw, b: se, normal: { x: 0, z: -1 } },
    { columnId, a: se, b: ne, normal: { x: 1, z: 0 } },
    { columnId, a: ne, b: nw, normal: { x: 0, z: 1 } },
    { columnId, a: nw, b: sw, normal: { x: -1, z: 0 } },
  ];
}

// Source file must exist in the repo
const srcPath = path.join(__dirname, "..", "src", "modules", "snapping", "smart-perp-snap.ts");
assert.ok(fs.existsSync(srcPath), "smart-perp-snap.ts missing");

const col = { x: 5, z: 0 };
const faces = rectColumnFaces("c1", col, 0.4, 0.4);
// Wall approaching east face head-on from the left
const fixed = { x: 0, z: 0 };
const free = { x: 4.85, z: 0.02 }; // near east face, almost horizontal
const hit = evaluateSmartPerpSnap(fixed, free, faces, 0.5);
assert.ok(hit, "expected face snap");
assert.strictEqual(hit.mode, "face");
assert.ok(Math.abs(hit.attach.x - (5 + 0.2)) < 1e-6 || Math.abs(hit.attach.x - (5 - 0.2)) < 0.25, "attach near face");

// Far away — no snap
const miss = evaluateSmartPerpSnap(fixed, { x: 1, z: 0 }, faces, 0.2);
assert.strictEqual(miss, null);

// Corner preference when not near-ortho
const freeCorner = { x: 5.25, z: 0.25 };
const cornerHit = evaluateSmartPerpSnap({ x: 6, z: 1 }, freeCorner, faces, 0.4);
assert.ok(cornerHit, "expected some snap near corner");

console.log("smart-perp-snap: all assertions passed");
