const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "de-"));
execSync(`npx tsc src/modules/native-bim/dimension-edit.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "dimension-edit.js"));
const near = (a, b) => Math.abs(a - b) < 1e-9;
let n = 0; const ok = (c, msg) => { assert.ok(c, msg); n++; };

// horizontal wall 0..3 -> 4 : right end (3,0) fixed, left end moves to -1
let r = m.lengthKeepRight([0, 0], [3, 0], 4);
ok(near(r.end[0], 3) && near(r.start[0], -1) && near(r.start[1], 0), "right fixed, left moves");
// same wall drawn right->left (start is the right one): start fixed
r = m.lengthKeepRight([3, 0], [0, 0], 5);
ok(near(r.start[0], 3) && near(r.end[0], -2), "start fixed when start is right");
// shrinking
r = m.lengthKeepRight([0, 0], [3, 0], 1);
ok(near(r.end[0], 3) && near(r.start[0], 2), "shrink keeps right");
// vertical wall (plan): bottom (smaller z) fixed
r = m.lengthKeepRight([0, 0], [0, 3], 5);
ok(near(r.start[1], 0) && near(r.end[1], 5), "bottom fixed");
r = m.lengthKeepRight([0, 3], [0, 0], 5);
ok(near(r.end[1], 0) && near(r.start[1], 5), "bottom fixed (reversed)");
// diagonal keeps direction & length
r = m.lengthKeepRight([0, 0], [3, 4], 10);
ok(near(Math.hypot(r.end[0] - r.start[0], r.end[1] - r.start[1]), 10) && near(r.end[0], 3) && near(r.end[1], 4), "diagonal right fixed");
ok(m.lengthKeepRight([1, 1], [1, 1], 3) === null && m.lengthKeepRight([0, 0], [1, 0], 0) === null, "invalid");

// thickness: horizontal wall, bottom face (z = -t/2) fixed, grows toward +z (north)
r = m.thicknessKeepFace([0, 0], [3, 0], 0.2, 0.4);
ok(near(r.start[1], 0.1) && near(r.end[1], 0.1), "bottom face fixed: centre moves up by 0.1");
ok(near(r.start[1] - 0.4 / 2, -0.1), "bottom face stays at -0.1");
// reversed drawing direction gives the same physical result
r = m.thicknessKeepFace([3, 0], [0, 0], 0.2, 0.4);
ok(near(r.start[1], 0.1) && near(r.end[1], 0.1), "same result when reversed");
// vertical wall: right face (x = +t/2) fixed, grows toward -x
r = m.thicknessKeepFace([0, 0], [0, 3], 0.2, 0.4);
ok(near(r.start[0], -0.1) && near(r.end[0], -0.1), "right face fixed for vertical wall");
// thinning moves the other way
r = m.thicknessKeepFace([0, 0], [3, 0], 0.4, 0.2);
ok(near(r.start[1], -0.1), "thinner: centre moves down");

// opening width: host runs left->right (right edge fixed, centre moves right when narrower)
let o = m.openingWidthKeepRight([0, 0], [6, 0], 2, 1, 2);
ok(near(o.width, 2) && near(o.offsetAlongHost, 1.5), "wider: centre moves left (+-0.5)");
o = m.openingWidthKeepRight([6, 0], [0, 0], 2, 1, 2); // host direction points left
ok(near(o.offsetAlongHost, 2.5), "reversed host: centre moves along host");

// height: base fixed; a level-bound top is released
let p = m.heightKeepBase({ elevation: 0, topLevelId: "L2", topOffset: 0.3 }, 4);
ok(p.height === 4 && p.topLevelId === undefined && p.topOffset === 0 && "topLevelId" in p, "top released");
p = m.heightKeepBase({ elevation: 1 }, 2.5);
ok(p.height === 2.5 && !("topLevelId" in p), "plain height");
ok(m.heightKeepBase({}, -1) === null, "invalid height");

console.log(`dimension-edit: ${n} checks OK`);
