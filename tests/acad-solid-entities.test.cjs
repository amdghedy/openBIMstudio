/* 3DSOLID/REGION wires, MESH, POLYGONMESH, POLYFACE, HELIX conversion from the engine's JSON. */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "acads-"));
execSync(`npx tsc src/modules/drawings/acad-solid-entities.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const X = require(find(out, "acad-solid-entities.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const notes = []; const cx = { pt: (a) => ({ x: +(a?.[0] ?? 0), y: +(a?.[1] ?? 0), z: +(a?.[2] ?? 0) }), clean: (s) => s, deg: 180 / Math.PI, note: (m) => notes.push(m) };
const c = { layer: "L" };
const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

t("3DSOLID: every stored wire becomes a polyline, and the wireframe-only limit is reported", () => {
  notes.length = 0;
  const r = X.convertSolidWire({ kind: "3DSOLID", wires: [[[0, 0, 0], [5, 0, 0]], [[5, 0, 0], [5, 5, 0], [0, 5, 0]]] }, c, cx);
  assert.strictEqual(r.length, 2); assert.strictEqual(r[1].points.length, 3); assert.ok(notes.some((n) => n.includes("wireframe edges only")));
});
t("REGION without stored wires is reported, not silently dropped", () => {
  notes.length = 0; assert.strictEqual(X.convertSolidWire({ kind: "REGION", wires: [] }, c, cx).length, 0); assert.ok(notes.some((n) => n.includes("REGION") && n.includes("not drawn")));
});
t("MESH: a quad and a triangle sharing an edge give 6 distinct edges, not 7", () => {
  const r = X.convertMesh({ vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0]], faces: [[0, 1, 2, 3], [1, 4, 2]] }, c, cx);
  assert.strictEqual(r.length, 6);
});
t("MESH: out-of-range indices are ignored instead of crashing", () => {
  const r = X.convertMesh({ vertices: [[0, 0, 0], [1, 0, 0]], faces: [[0, 1, 9]] }, c, cx);
  assert.strictEqual(r.length, 1);
});
t("POLYGONMESH: a 3x2 grid gives 3 row and 2 column polylines; closed flags carry over", () => {
  const v = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) v.push([i, j, 0]);
  const r = X.convertPolygonMesh({ m: 3, n: 2, closedM: true, closedN: false, vertices: v }, c, cx);
  assert.strictEqual(r.length, 5); assert.strictEqual(r[0].closed, false); assert.strictEqual(r[3].closed, true);
});
t("POLYFACE: 1-based indices, negative (invisible-edge) indices still connect", () => {
  const r = X.convertPolyface({ vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], faces: [[1, -2, 3, 0]] }, c, cx);
  assert.strictEqual(r.length, 3);
});
t("HELIX: 2 turns about +Z starting at (r,0): radius constant, rises by 2 pitches, ends back on the start meridian", () => {
  const r = X.convertHelix({ base: [10, 10, 0], start: [13, 10, 0], axis: [0, 0, 1], turns: 2, turnHeight: 5, radius: 3, handedness: true }, c, cx);
  const p = r[0].points;
  near(p[0].x, 13); near(p[0].y, 10); near(p[0].z, 0);
  for (const q of p) near(Math.hypot(q.x - 10, q.y - 10), 3, 1e-9);
  const e = p[p.length - 1]; near(e.x, 13, 1e-9); near(e.y, 10, 1e-9); near(e.z, 10, 1e-9);
  assert.ok(p[12].y > 10, "right-handed turns counter-clockwise (up first)");
});
t("HELIX: left-handed turns the other way", () => {
  const r = X.convertHelix({ base: [0, 0, 0], start: [1, 0, 0], axis: [0, 0, 1], turns: 1, turnHeight: 1, handedness: false }, c, cx);
  assert.ok(r[0].points[6].y < 0);
});
t("HELIX with zero radius or turns is reported, not drawn", () => {
  notes.length = 0;
  assert.strictEqual(X.convertHelix({ base: [0, 0, 0], start: [0, 0, 0], axis: [0, 0, 1], turns: 2, turnHeight: 1 }, c, cx).length, 0);
  assert.strictEqual(X.convertHelix({ base: [0, 0, 0], start: [1, 0, 0], axis: [0, 0, 1], turns: 0, turnHeight: 1 }, c, cx).length, 0);
  assert.strictEqual(notes.length, 2);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
