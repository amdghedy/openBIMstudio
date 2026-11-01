const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "lf-"));
execSync(`npx tsc src/modules/native-bim/linear-follow.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "linear-follow.js"));
let n = 0; const ok = (c, s) => { assert.ok(c, s); n++; };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const w = (id, s, e, x = {}) => ({ id, type: "wall", ...x, params: { start: s, end: e, elevation: 0 } });
// U-shaped walls: A (0,0)-(4,0), B (4,0)-(4,3), C (4,3)-(0,3). Move B by +1 in x.
const els = [w("A", [0, 0], [4, 0]), w("B", [4, 0], [4, 3]), w("C", [4, 3], [0, 3])];
let u = Object.fromEntries(m.planLinearFollow(els, ["B"], 1, 0).map((x) => [x.id, x.patch]));
ok(near(u.A.end[0], 5) && near(u.A.end[1], 0) && !u.A.start, "A's joined end follows B, far end stays");
ok(near(u.C.start[0], 5) && near(u.C.start[1], 3) && !u.C.end, "C's joined end follows B");
ok(!u.B, "moved wall is the caller's job");
// any direction
u = Object.fromEntries(m.planLinearFollow(els, ["B"], -0.5, 2).map((x) => [x.id, x.patch]));
ok(near(u.A.end[0], 3.5) && near(u.A.end[1], 2) && near(u.C.start[1], 5), "diagonal move");
// moving everything: nothing left to patch
ok(m.planLinearFollow(els, ["A", "B", "C"], 1, 1).length === 0, "all moved");
// pinned neighbour stays; different type not joined
ok(m.planLinearFollow(els.map((e) => e.id === "A" ? { ...e, properties: { pinned: true } } : e), ["B"], 1, 0).every((x) => x.id !== "A"), "pinned stays");
ok(m.planLinearFollow([w("A", [0, 0], [4, 0]), { id: "Bm", type: "beam", params: { start: [4, 0], end: [4, 3], elevation: 0 } }], ["Bm"], 1, 0).length === 0, "wall and beam are not joined");
// beams follow vertically per end
const bm = (id, s, e, y, y2) => ({ id, type: "beam", params: { start: s, end: e, elevation: y, endElevation: y2 } });
u = Object.fromEntries(m.planLinearFollow([bm("b1", [0, 0], [4, 0], 3, 3), bm("b2", [4, 0], [8, 0], 3, 3)], ["b2"], 0, 0, 1).map((x) => [x.id, x.patch]));
ok(near(u.b1.endElevation, 4) && near(u.b1.end[0], 4) && u.b1.elevation === undefined, "beam end follows vertically");
// beams at different heights are not joined
ok(m.planLinearFollow([bm("b1", [0, 0], [4, 0], 3, 3), bm("b2", [4, 0], [8, 0], 5, 5)], ["b2"], 1, 0).length === 0, "different elevation: not joined");
console.log(`linear-follow: ${n} checks OK`);
