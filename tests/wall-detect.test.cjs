const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "wd-"));
execSync(`npx tsc src/modules/cad-link/wall-detect.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "wall-detect.js"));
let n = 0; const ok = (c, s) => { assert.ok(c, s); n++; };
const S = (x1, z1, x2, z2) => ({ x1, z1, x2, z2 });
const len = (w) => Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
// one wall drawn as two face lines, 0.2 apart
let r = m.detectWalls([S(0, 0, 5, 0), S(0, 0.2, 5, 0.2)]);
ok(r.walls.length === 1 && Math.abs(r.walls[0].thickness - 0.2) < 1e-9 && Math.abs(len(r.walls[0]) - 5) < 1e-9, "single double-line wall");
ok(Math.abs(r.walls[0].z1 - 0.1) < 1e-9 && Math.abs(r.walls[0].z2 - 0.1) < 1e-9, "centre line");
// face lines split into pieces + duplicate -> merged
r = m.detectWalls([S(0, 0, 2, 0), S(2, 0, 5, 0), S(5, 0, 0, 0), S(0, 0.2, 5, 0.2)]);
ok(r.walls.length === 1 && Math.abs(len(r.walls[0]) - 5) < 1e-6, "collinear pieces merged");
// room outer 6x4, inner offset 0.2 -> four walls
const rect = (x0, z0, x1, z1) => [S(x0, z0, x1, z0), S(x1, z0, x1, z1), S(x1, z1, x0, z1), S(x0, z1, x0, z0)];
r = m.detectWalls([...rect(0, 0, 6, 4), ...rect(0.2, 0.2, 5.8, 3.8)]);
ok(r.walls.length === 4 && r.walls.every((w) => Math.abs(w.thickness - 0.2) < 1e-9), "room = 4 walls");
const near = (a, b) => Math.abs(a - b) < 1e-6;
const touch = (p, q) => near(p[0], q[0]) && near(p[1], q[1]);
const ends = r.walls.flatMap((w) => [[w.x1, w.z1], [w.x2, w.z2]]);
ok([[0.1, 0.1], [5.9, 0.1], [5.9, 3.9], [0.1, 3.9]].every((c) => ends.filter((e) => touch(e, c)).length === 2), "centre lines meet at the 4 corners");
// door gap in the inner face: still ONE wall across the opening
const inner = [S(0.2, 0.2, 2, 0.2), S(3, 0.2, 5.8, 0.2), S(5.8, 0.2, 5.8, 3.8), S(5.8, 3.8, 0.2, 3.8), S(0.2, 3.8, 0.2, 0.2)];
r = m.detectWalls([...rect(0, 0, 6, 4), ...inner]);
const bottom = r.walls.filter((w) => Math.abs(w.z1 - 0.1) < 1e-6 && Math.abs(w.z2 - 0.1) < 1e-6);
ok(bottom.length === 1 && Math.abs(len(bottom[0]) - 5.8) < 0.05, "opening bridged and corners joined");
// lines too far apart are not a wall; singles optional
r = m.detectWalls([S(0, 0, 5, 0), S(0, 2, 5, 2)]);
ok(r.walls.length === 0, "2 m apart is not a wall");
r = m.detectWalls([S(0, 0, 5, 0), S(0, 2, 5, 2)], { includeSingleLines: true, defaultThickness: 0.15 });
ok(r.walls.length === 2 && r.walls.every((w) => w.thickness === 0.15 && w.source === "single"), "single lines");
// diagonal wall
const a = Math.PI / 6, nx = -Math.sin(a) * 0.25, nz = Math.cos(a) * 0.25;
r = m.detectWalls([S(0, 0, 4 * Math.cos(a), 4 * Math.sin(a)), S(nx, nz, 4 * Math.cos(a) + nx, 4 * Math.sin(a) + nz)]);
ok(r.walls.length === 1 && Math.abs(r.walls[0].thickness - 0.25) < 1e-9 && Math.abs(len(r.walls[0]) - 4) < 1e-6, "diagonal");
// vertical walls with tiny tilt differences (canonical-direction wrap)
r = m.detectWalls([S(0, 0, 0.0005, 5), S(0.2, 5, 0.2005, 0)]);
ok(r.walls.length === 1, "near-vertical pair");
// short fragments dropped
r = m.detectWalls([S(0, 0, 0.1, 0), S(0, 0.2, 0.1, 0.2)]);
ok(r.walls.length === 0, "tiny dropped");
console.log(`wall-detect: ${n} checks OK`);
