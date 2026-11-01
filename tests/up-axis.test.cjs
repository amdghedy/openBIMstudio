const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "ua-"));
execSync(`npx tsc src/modules/navigation/up-axis.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "up-axis.js"));
let n = 0; const ok = (c, s) => { assert.ok(c, s); n++; };
const near = (a, b, t = 1e-2) => Math.abs(a - b) < t;
// Top view: camera above looking down, wanted screen-up = -Z
let r = m.resolveWorldUp([0, 10, 0], [0, 0, 0], [0, 0, -1]);
ok(r.up[1] === 1 && r.keptWorldUp, "up stays +Y after Top");
let su = m.screenUp(r.pos, [0, 0, 0]);
ok(near(su[2], -1) && near(su[0], 0), "Top: screen-up is -Z: " + su);
// Bottom view: camera below looking up, wanted screen-up = +Z
r = m.resolveWorldUp([0, -10, 0], [0, 0, 0], [0, 0, 1]);
su = m.screenUp(r.pos, [0, 0, 0]);
ok(r.up[1] === 1 && near(su[2], 1), "Bottom: screen-up is +Z: " + su);
// Top view with a custom orientation (up = +X)
r = m.resolveWorldUp([5, 10, 5], [5, 0, 5], [1, 0, 0]);
su = m.screenUp(r.pos, [5, 0, 5]);
ok(near(su[0], 1) && near(su[2], 0), "custom Top up=+X honoured: " + su);
// camera offset is imperceptible
ok(Math.hypot(r.pos[0] - 5, r.pos[2] - 5) / 10 < 2e-3, "offset tiny");
// Side views are untouched
r = m.resolveWorldUp([0, 0, 10], [0, 0, 0], [0, 1, 0]);
ok(r.up[1] === 1 && r.pos[2] === 10 && r.pos[0] === 0, "front view untouched");
// oblique custom up is honoured and flagged
r = m.resolveWorldUp([5, 5, 5], [0, 0, 0], [1, 1, 0]);
ok(!r.keptWorldUp && near(r.up[0], Math.SQRT1_2), "oblique custom up kept");
console.log(`up-axis: ${n} checks OK`);
