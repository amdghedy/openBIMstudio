const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "tx-"));
execSync(`npx tsc src/modules/native-twin/twin-export-geometry.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "twin-export-geometry.js"));
const near = (a, b, e = 1e-4) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
// Box: length 4 along X (x 0..4), height 3 (y 0..3), thickness 0.2 (z 0..0.2); non-indexed corners are enough.
const P = [];
for (const x of [0, 4]) for (const y of [0, 3]) for (const z of [0, 0.2]) P.push(x, y, z);
const base = () => ({
  params: { start: [0, 0.1], end: [4, 0.1], height: 3, thickness: 0.2 },
  properties: { nativeBaseHeight: 3, nativeBaseThickness: 0.2, nativeBaseLength: 4 },
  nativeGeometry: { positions: P },
  transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
});
const world = (r) => { const q = r.transform, ps = r.positions, o = []; for (let i = 0; i < ps.length; i += 3) {
  const [qx, qy, qz, qw] = q.quaternion, x = ps[i] * q.scale[0], y = ps[i + 1] * q.scale[1], z = ps[i + 2] * q.scale[2];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  o.push([x + qw * tx + (qy * tz - qz * ty) + q.position[0], y + qw * ty + (qz * tx - qx * tz) + q.position[1], z + qw * tz + (qx * ty - qy * tx) + q.position[2]]); } return o; };
const ext = (w, k) => [Math.min(...w.map((v) => v[k])), Math.max(...w.map((v) => v[k]))];
// unedited -> identical
let w = world(m.resolveTwinExportGeometry(base())); near(ext(w, 1)[1], 3); near(ext(w, 0)[1], 4);
// height 6 keeps base at 0, top at 6
let e = base(); e.params.height = 6; w = world(m.resolveTwinExportGeometry(e)); near(ext(w, 1)[0], 0); near(ext(w, 1)[1], 6);
// length 8 -> x extent 8
e = base(); e.params.end = [8, 0.1]; w = world(m.resolveTwinExportGeometry(e)); near(ext(w, 0)[1] - ext(w, 0)[0], 8);
// thickness 0.4
e = base(); e.params.thickness = 0.4; w = world(m.resolveTwinExportGeometry(e)); near(ext(w, 2)[1] - ext(w, 2)[0], 0.4);
// rotation 90: plan extents swap, centre preserved, height untouched
e = base(); e.params.rotation = 90; w = world(m.resolveTwinExportGeometry(e));
near(ext(w, 0)[1] - ext(w, 0)[0], 0.2); near(ext(w, 2)[1] - ext(w, 2)[0], 4);
near((ext(w, 0)[0] + ext(w, 0)[1]) / 2, 2); near((ext(w, 2)[0] + ext(w, 2)[1]) / 2, 0.1); near(ext(w, 1)[1], 3);
// no transform / no base dims: no crash, geometry passes through
w = world(m.resolveTwinExportGeometry({ params: { height: 3 }, nativeGeometry: { positions: P } })); near(ext(w, 0)[1], 4);
console.log("twin-export-geometry OK");
