const assert = require("assert");
const dir = process.env.OUT_DIR || "";
const X = require(dir + "/m3-plan.js");
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 3).join("\n       ")); process.exitCode = 1; } }
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
const area = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s / 2); };
const wall = (id, s, e, o = {}) => ({ id, type: "wall", params: { start: s, end: e, height: 3, thickness: 0.2, elevation: 0, ...o } });
const door = (id, host, o = {}) => ({ id, type: "door", hostId: host, params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 3, sillHeight: 0, ...o } });
const win = (id, host, o = {}) => ({ id, type: "window", hostId: host, params: { width: 1.2, height: 1.4, thickness: 0.2, elevation: 0, offsetAlongHost: 5, sillHeight: 0.9, ...o } });
const base = { cutElevation: 1.2, bandLow: -0.5, bandHigh: 2.4, scale: 100, kind: "plan", rooms: [] };
const run = (elements, extra = {}) => X.planExtras({ ...base, elements, ...extra });
const polys = (es) => es.filter((e) => e.kind === "polyline");
const lines = (es) => es.filter((e) => e.kind === "line");
const texts = (es) => es.filter((e) => e.kind === "text").map((e) => e.text);

t("poche: walls are broken at the openings the cut plane passes through", () => {
  const r = run([wall("w", [0, 0], [8, 0]), door("d", "w"), win("x", "w")]);
  const total = polys(r.under).reduce((s, p) => s + area(p.points), 0);
  near(total, (8 - 0.9 - 1.2) * 0.2, 1e-9);                      // door (0..2.1) and window (0.9..2.3) both span 1.2 m
  assert.strictEqual(polys(r.under).length, 3);
  const high = run([wall("w", [0, 0], [8, 0]), win("x", "w", { sillHeight: 1.5 })]);   // window sill above the cut: wall stays solid
  near(polys(high.under).reduce((s, p) => s + area(p.points), 0), 8 * 0.2, 1e-9);
  assert.strictEqual(r.stats.pocheWalls, 1);
});
t("poche: only elements the cut plane passes through; columns too; option switches it off", () => {
  const els = [wall("hi", [0, 0], [4, 0], { elevation: 3 }), wall("lo", [0, 5], [4, 5], { height: 1.0 }), { id: "c", type: "column", params: { point: [1, 1], height: 3, thickness: 0.3, depth: 0.4, elevation: 0 } }];
  const r = run(els);
  assert.strictEqual(polys(r.under).length, 1); near(area(polys(r.under)[0].points), 0.12, 1e-9);
  assert.strictEqual(run(els, { options: { poche: false } }).under.length, 0);
});
t("stairs: riser lines up to the cut are solid, those above are dashed, arrow + UP, base geometry suppressed", () => {
  const st = { id: "st", type: "stairs", params: { height: 3, thickness: 0.15, elevation: 0, start: [0, 0], end: [5, 0], width: 1.2 } };
  const r = run([st]);
  assert.ok(r.suppressIds.has("st"));
  const rh = 3 / 18;
  const cutLines = lines(r.cut).length, overLines = lines(r.overhead).length;
  const below = Array.from({ length: 17 }, (_, i) => (i + 1) * rh).filter((h) => h <= 1.2).length;   // risers 1..17
  assert.strictEqual(cutLines, below); assert.strictEqual(overLines, 17 - below);
  assert.strictEqual(polys(r.cut).length, 1);                                                            // flight outline
  assert.ok(texts(r.symbols).includes("UP")); assert.strictEqual(lines(r.symbols).length, 3);          // arrow = shaft + 2 head strokes
  assert.strictEqual(r.stats.stairs, 1);
});
t("stairs L and U: two flights + landing outlines, arrows on both", () => {
  for (const shape of ["L", "U"]) {
    const st = { id: "s" + shape, type: "stairs", params: { height: 3.2, thickness: 0.15, elevation: 0, start: [0, 0], end: [3, 0], width: 1.1 }, properties: { stairShape: shape } };
    const r = run([st]);
    assert.strictEqual(polys(r.cut).length + polys(r.overhead).length, 3, shape);
    assert.strictEqual(lines(r.symbols).length, 6, shape);
  }
});
t("stairs entirely above the cut are drawn dashed; stairs outside the view range are skipped", () => {
  const above = run([{ id: "s", type: "stairs", params: { height: 3, thickness: 0.15, elevation: 1.5, start: [0, 0], end: [5, 0], width: 1.2 } }]);
  assert.strictEqual(polys(above.cut).length, 0); assert.strictEqual(polys(above.overhead).length, 1);
  const far = run([{ id: "s", type: "stairs", params: { height: 3, thickness: 0.15, elevation: 9, start: [0, 0], end: [5, 0], width: 1.2 } }]);
  assert.strictEqual(far.stats.stairs, 0); assert.strictEqual(far.suppressIds.size, 0);
});
t("railing: a double line per segment (never a closed loop), ramp: outline, arrow and slope", () => {
  const rl = { id: "r", type: "railing", params: { height: 1, thickness: 0.05, elevation: 0, polygon: [[0, 0], [4, 0], [4, 3]] } };
  const r = run([rl]);
  assert.strictEqual(lines(r.cut).length, 4); assert.strictEqual(polys(r.cut).length, 0); assert.ok(r.suppressIds.has("r"));
  const rp = run([{ id: "p", type: "ramp", params: { height: 0.5, thickness: 0.2, elevation: 0, start: [0, 0], end: [6, 0], width: 1.5 } }]);
  assert.strictEqual(polys(rp.cut).length, 1); assert.ok(texts(rp.symbols).includes("1:12.0"));
  const high = run([{ ...rl, id: "rh", params: { ...rl.params, elevation: 3 } }], { bandHigh: 4 });
  assert.strictEqual(lines(high.overhead).length, 4); assert.strictEqual(lines(high.cut).length, 0);        // above the cut plane: dashed
  const spanning = run([{ ...rl, id: "rs", params: { ...rl.params, height: 1.5 } }]);
  assert.strictEqual(lines(spanning.cut).length, 4);
});
t("curtain wall: two face lines, one tick per mullion, glazing line", () => {
  const cw = { id: "c", type: "curtain-wall", params: { height: 3.6, thickness: 0.1, elevation: 0, start: [0, 0], end: [6, 0] }, properties: { uSpacing: 1.5 } };
  const r = run([cw]);
  assert.strictEqual(lines(r.cut).length, 2 + 5 + 1);
});
t("roof: dashed outline, ridge for gable only, slope label; ceilings only on reflected ceiling plans", () => {
  const roof = (type) => ({ id: "rf", type: "roof", params: { height: 0.2, thickness: 0.2, elevation: 3.0, polygon: [[0, 0], [10, 0], [10, 6], [0, 6]] }, properties: { roofType: type, slope: 25, slopeDirection: 90 } });
  const g = run([roof("gable")], { bandHigh: 4 }), s = run([roof("shed")], { bandHigh: 4 });
  assert.strictEqual(polys(g.overhead).length, 1); assert.strictEqual(lines(g.overhead).length, 1); assert.strictEqual(lines(s.overhead).length, 0);
  assert.ok(texts(g.symbols).includes("25\u00B0"));
  // the ridge of a gable with slope direction 90 deg (rising along z) runs along x at mid-depth z = 3
  const ridge = lines(g.overhead)[0]; near(ridge.z1, 3, 1e-9); near(ridge.z2, 3, 1e-9);
  const clg = { id: "cl", type: "ceiling", params: { height: 0.02, thickness: 0.02, elevation: 2.7, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] } };
  assert.strictEqual(run([clg], { bandHigh: 4 }).cut.length, 0);
  const rcp = run([clg], { bandHigh: 4, kind: "rcp" });
  assert.strictEqual(polys(rcp.cut).length, 1); assert.ok(texts(rcp.symbols).includes("CLG 2.70"));
  assert.strictEqual(polys(run([roof("gable")], { bandHigh: 4, kind: "rcp" }).overhead).length, 0);
});
t("marks: doors D1.., windows W1.., properties.mark wins; tags sit beside the opening on the wall normal", () => {
  const els = [wall("w", [0, 0], [8, 0]), door("d1", "w"), win("x1", "w"), door("d2", "w", { offsetAlongHost: 6.5, properties: undefined })];
  els[3].properties = { mark: "EX-1" };
  const m = X.autoMarks(els);
  assert.strictEqual(m.get("d1"), "D1"); assert.strictEqual(m.get("x1"), "W1"); assert.strictEqual(m.get("d2"), "EX-1");
  const r = run(els);
  assert.strictEqual(r.stats.doorTags, 3);
  const circles = r.symbols.filter((e) => e.kind === "circle");
  assert.strictEqual(circles.length, 3);
  near(circles[0].cx, 3, 1e-9); near(circles[0].cz, 0.1 + 0.0045 * 100, 1e-9);      // 4.5 mm on paper at 1:100 = 0.45 m beyond the wall face
  assert.deepStrictEqual(texts(r.symbols).sort(), ["D1", "EX-1", "W1"]);
  assert.strictEqual(run(els, { options: { doorTags: false } }).stats.doorTags, 0);
});
t("rooms: number, name and area stacked at the label point; boundaries optional; tags can be switched off", () => {
  const room = { id: "r1", name: "Office", number: "101", area: 21.456, levelId: null, boundary: [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 4 }, { x: 0, z: 4 }], labelPoint: [3, 2] };
  const r = run([], { rooms: [room] });
  assert.deepStrictEqual(texts(r.symbols), ["101", "Office", "21.5 m\u00B2"]);
  const tx = r.symbols.filter((e) => e.kind === "text");
  assert.ok(tx[0].z > tx[1].z && tx[1].z > tx[2].z); near(tx[1].z, 2, 1e-9); near(tx[0].z - tx[1].z, 0.0034 * 100, 1e-9);
  assert.strictEqual(r.stats.roomsTagged, 1); assert.strictEqual(polys(r.symbols).length, 0);
  assert.strictEqual(polys(run([], { rooms: [room], options: { roomBoundaries: true } }).symbols).length, 1);
  assert.strictEqual(run([], { rooms: [room], options: { roomTags: false } }).symbols.length, 0);
  const noLp = run([], { rooms: [{ ...room, labelPoint: undefined }] }).symbols.filter((e) => e.kind === "text")[1];
  near(noLp.x, 3, 1e-9); near(noLp.z, 2, 1e-9);
});
console.log(`${passed} passed`);
