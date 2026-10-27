const assert = require("assert");

function planAxesFromBaseline(start, end) {
  const dx = end[0] - start[0], dz = end[1] - start[1];
  const len = Math.hypot(dx, dz);
  const along = [dx / len, dz / len];
  const thick = [-along[1], along[0]];
  const origin = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  return { along, thick, origin };
}

function deformPlanDimensions(positions, axes, worldPivot, lengthRatio, thicknessRatio) {
  const out = new Float32Array(positions.length);
  const lr = lengthRatio, tr = thicknessRatio;
  const [ax, az] = axes.along, [tx, tz] = axes.thick, [ox, oz] = axes.origin;
  const [px, , pz] = worldPivot;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const lx = positions[i], ly = positions[i + 1], lz = positions[i + 2];
    const wx = lx + px, wz = lz + pz;
    const dx = wx - ox, dz = wz - oz;
    const along = dx * ax + dz * az;
    const thick = dx * tx + dz * tz;
    const wx2 = ox + along * lr * ax + thick * tr * tx;
    const wz2 = oz + along * lr * az + thick * tr * tz;
    out[i] = wx2 - px; out[i + 1] = ly; out[i + 2] = wz2 - pz;
  }
  return out;
}

const positions = new Float32Array([
  -5, 0, -0.1,
   5, 0, -0.1,
   5, 0,  0.1,
  -5, 0,  0.1,
]);
const axes = planAxesFromBaseline([-5, 0], [5, 0]);
const out = deformPlanDimensions(positions, axes, [0, 0, 0], 1, 2);
assert.ok(Math.abs(out[2] + 0.2) < 1e-5);
assert.ok(Math.abs(out[8] - 0.2) < 1e-5);
assert.ok(Math.abs(out[0] + 5) < 1e-5);
assert.ok(Math.abs(out[3] - 5) < 1e-5);

// Length scale 2x
const outL = deformPlanDimensions(positions, axes, [0, 0, 0], 2, 1);
assert.ok(Math.abs(outL[0] + 10) < 1e-5);
assert.ok(Math.abs(outL[3] - 10) < 1e-5);

console.log("mesh-plan-deform.test.cjs: ok");
