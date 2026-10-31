const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "ms-"));
execSync(`npx tsc src/modules/mep/stretch.ts src/modules/mep/connectivity.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const find = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? find(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = find(out);
const st = require(files.find((f) => f.endsWith("stretch.js")));
const cn = require(files.find((f) => f.endsWith("connectivity.js")));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, t = 1e-6) => Math.abs(a - b) < t;
const run = (id, s, e, type = "pipe", extra = {}) => ({ id, type, params: { start: s, end: e, elevation: 0, height: 0.1, thickness: 0.1, ...extra } });
const fit = (id, pt, kind, aIn, aOut, parentType = "pipe") => ({ id, type: "fitting", params: { point: pt, elevation: 0, height: 0.1, thickness: 0.1, fittingKind: kind, angleIn: aIn, angleOut: aOut, parentType } });
const by = (u) => Object.fromEntries(u.map((x) => [x.id, x.patch]));

// L-shaped pipe: A (0,0)->(3,0), elbow at (3,0), B (3,0)->(3,4)
const els = [run("A", [0, 0], [3, 0]), fit("E", [3, 0], "elbow", 0, Math.PI / 2), run("B", [3, 0], [3, 4])];
// shorten A's end to x=2
let u = by(st.planMepStretch(els, "A", { end: [2, 0] }));
ok(near(u.E.point[0], 2) && near(u.E.point[1], 0), "elbow follows the stretched end");
ok(near(u.B.start[0], 2) && near(u.B.start[1], 0), "other run follows elbow");
ok(!u.B.end && !u.A, "far end of B and A itself untouched");
ok(near(u.E.angleIn, 0), "inbound angle unchanged");
ok(near(u.E.angleOut, Math.atan2(4, 1)), "outbound angle re-aimed at B's fixed far end");
// stretch A the other way (move its start): nothing attached there
ok(st.planMepStretch(els, "A", { start: [-1, 0] }).length === 0, "free end moves alone");
// stretch from B's side
u = by(st.planMepStretch(els, "B", { start: [3, 1] }));
ok(near(u.E.point[1], 1) && near(u.A.end[1], 1), "stretching B drags elbow and A");
// elevation change drags fitting and neighbours vertically
u = by(st.planMepStretch(els, "A", { end: [3, 0], endElevation: 0.5 }));
ok(near(u.E.elevation, 0.5) && near(u.B.elevation, 0.5), "vertical stretch follows");
// no change -> no updates
ok(st.planMepStretch(els, "A", {}).length === 0, "no-op");
// pinned fitting does not move
const pinned = els.map((e) => e.id === "E" ? { ...e, properties: { pinned: true } } : e);
ok(st.planMepStretch(pinned, "A", { end: [2, 0] }).length === 0, "pinned fitting stays");
// tee: main A (0,0)->(2,0), tee (2,0), main C (2,0)->(5,0), branch D (2,0)->(2,3); stretching A's end drags tee, C and D ends
const tee = [run("A", [0, 0], [2, 0]), fit("T", [2, 0], "tee", 0, Math.PI / 2), run("C", [2, 0], [5, 0]), run("D", [2, 0], [2, 3])];
u = by(st.planMepStretch(tee, "A", { end: [1.5, 0] }));
ok(near(u.T.point[0], 1.5) && near(u.C.start[0], 1.5) && near(u.D.start[0], 1.5) && !u.C.end && !u.D.end, "tee drags attached runs only");

// Tab selection: branch stops at the tee, network goes through it
const net = [run("A", [0, 0], [2, 0]), fit("T", [2, 0], "tee", 0, Math.PI / 2), run("C", [2, 0], [5, 0]), run("D", [2, 0], [2, 3]), run("X", [10, 10], [12, 10])];
const br = cn.connectedSelection("A", net, "branch").sort();
ok(JSON.stringify(br) === JSON.stringify(["A", "T"]), "branch = run + junction, not the other branches: " + br);
const nw = cn.connectedSelection("A", net, "network").sort();
ok(JSON.stringify(nw) === JSON.stringify(["A", "C", "D", "T"]), "network = everything connected, not unrelated runs: " + nw);
// elbow is not a junction: branch passes through it
const lb = cn.connectedSelection("A", els, "branch").sort();
ok(JSON.stringify(lb) === JSON.stringify(["A", "B", "E"]), "branch passes through elbows");
// ── Move: select pipe B of an A–elbow–B–elbow–C zig-zag; fittings follow, neighbours stretch, rest stays
const zz = [run("A", [0, 0], [3, 0]), fit("E1", [3, 0], "elbow", 0, Math.PI / 2), run("B", [3, 0], [3, 4]), fit("E2", [3, 4], "elbow", Math.PI / 2, 0), run("C", [3, 4], [8, 4])];
u = by(st.planMepMove(zz, ["B"], 1, 0));
ok(near(u.E1.point[0], 4) && near(u.E2.point[0], 4), "both fittings follow the moved pipe");
ok(near(u.A.end[0], 4) && near(u.A.end[1], 0) && !u.A.start, "pipe A stretches, its far end stays");
ok(near(u.C.start[0], 4) && near(u.C.start[1], 4) && !u.C.end, "pipe C stretches, its far end stays");
ok(!u.B, "moved pipe is the caller's job");
ok(u.E1.angleIn === undefined && u.E1.angleOut === undefined, "angles untouched for a parallel move");
// moving the elbow itself: both runs stretch to it
u = by(st.planMepMove(zz, ["E1"], 0, -1));
ok(near(u.A.end[1], -1) && near(u.B.start[1], -1) && !u.C, "moved fitting: attached runs stretch, rest untouched");
// whole network selected (Tab Tab): nothing left to patch
ok(st.planMepMove(zz, zz.map((e) => e.id), 2, 2).every((x) => !x.patch.start && !x.patch.end && !x.patch.point), "all selected -> rigid, no follower patches");
// pinned neighbour fitting stays put
ok(by(st.planMepMove(zz.map((e) => e.id === "E2" ? { ...e, properties: { pinned: true } } : e), ["B"], 1, 0)).E2 === undefined, "pinned fitting not dragged");

console.log(`mep-stretch: ${n} checks OK`);
