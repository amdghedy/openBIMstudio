const assert = require("assert");
const dir = process.env.OUT_DIR || "";
const g = require(dir + "/ifc-guid.js");
const r = require(dir + "/room-detect.js");
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; } }
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

t("guid: zero and max vectors", () => {
  assert.strictEqual(g.compressGuid("0".repeat(32)), "0".repeat(22));
  assert.strictEqual(g.compressGuid("f".repeat(32)), "3" + "$".repeat(21));
});
t("guid: round trip + validity for 2000 random ids", () => {
  for (let i = 0; i < 2000; i++) {
    const id = g.newIfcGuid();
    assert.ok(g.isValidIfcGuid(id), id);
    assert.strictEqual(g.compressGuid(g.decompressGuid(id)), id);
  }
});
t("guid: stable ids are deterministic, valid and distinct", () => {
  assert.strictEqual(g.stableIfcGuid("wall-1"), g.stableIfcGuid("wall-1"));
  const s = new Set(); for (let i = 0; i < 5000; i++) { const x = g.stableIfcGuid("el-" + i); assert.ok(g.isValidIfcGuid(x)); s.add(x); }
  assert.strictEqual(s.size, 5000);
});
t("guid: 22 hex chars are rejected", () => { assert.ok(!g.isValidIfcGuid("abcdef0123456789abcdef")); });

const box = (x0, z0, x1, z1, th = 0.2, p = "w") => [
  { id: p + "1", start: [x0, z0], end: [x1, z0], thickness: th },
  { id: p + "2", start: [x1, z0], end: [x1, z1], thickness: th },
  { id: p + "3", start: [x1, z1], end: [x0, z1], thickness: th },
  { id: p + "4", start: [x0, z1], end: [x0, z0], thickness: th },
];

t("room: rectangle uses finish faces (4x3 centre-lines, 0.2 walls -> 3.8 x 2.8)", () => {
  const room = r.detectRoomAt([2, 1.5], box(0, 0, 4, 3));
  assert.ok(room); near(room.area, 3.8 * 2.8); assert.ok(room.exact);
  near(room.perimeter, 2 * (3.8 + 2.8)); assert.strictEqual(room.wallIds.length, 4);
});
t("room: centre-line mode", () => {
  near(r.detectRoomAt([2, 1.5], box(0, 0, 4, 3), { boundary: "center" }).area, 12);
});
t("room: click outside or in open plan -> null", () => {
  assert.strictEqual(r.detectRoomAt([10, 10], box(0, 0, 4, 3)), null);
  const open = box(0, 0, 4, 3).slice(0, 3);
  assert.strictEqual(r.detectRoomAt([2, 1.5], open), null);
});
t("room: partition ending on the wall FACE (T-junction, 8 cm off) splits into two rooms", () => {
  const walls = box(0, 0, 6, 3).concat([{ id: "p", start: [3, 0.08], end: [3, 2.9], thickness: 0.1 }]);
  const all = r.detectAllRooms(walls);
  assert.strictEqual(all.length, 2, "rooms: " + all.length);
  const a = all.map((x) => x.area).sort((m, n) => m - n);
  near(a[0], (3 - 0.1 - 0.05) * 2.8, 0.01); near(a[1], a[0], 0.01);
  assert.ok(r.detectRoomAt([1.5, 1.5], walls).area < 8.5);
});
t("room: overshooting walls (X crossings) still close the room", () => {
  const walls = [
    { id: "a", start: [-0.5, 0], end: [4.5, 0], thickness: 0.2 }, { id: "b", start: [4, -0.5], end: [4, 3.5], thickness: 0.2 },
    { id: "c", start: [4.5, 3], end: [-0.5, 3], thickness: 0.2 }, { id: "d", start: [0, 3.5], end: [0, -0.5], thickness: 0.2 },
  ];
  near(r.detectRoomAt([2, 1.5], walls).area, 3.8 * 2.8);
});
t("room: dangling stub wall inside the room is ignored", () => {
  const walls = box(0, 0, 4, 3).concat([{ id: "stub", start: [2, 0], end: [2, 1], thickness: 0.2 }]);
  near(r.detectRoomAt([3, 1.5], walls).area, 3.8 * 2.8);
});
t("room: walled island becomes a hole (net area)", () => {
  const walls = box(0, 0, 8, 6).concat(box(3, 2, 4, 3, 0.2, "i"));
  const room = r.detectRoomAt([6, 4], walls);
  assert.strictEqual(room.holes.length, 1);
  near(room.area, 7.8 * 5.8 - 1.2 * 1.2, 1e-4);
  assert.ok(Math.abs(r.detectRoomAt([3.5, 2.5], walls).area - 0.8 * 0.8) < 1e-4);
});
t("room: L-shaped room", () => {
  const L = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 5], [0, 5]];
  const walls = L.map((p, i) => ({ id: "l" + i, start: p, end: L[(i + 1) % L.length], thickness: 0.2 }));
  const room = r.detectRoomAt([1, 1], walls);
  assert.ok(room && room.exact);
  // centre-line area 6*2 + 2*3 = 18; each unit of wall removes half thickness on the inside
  near(room.area, 18 - 0.1 * 22 + 0.01 * (5 - 1), 0.02);
  assert.ok(room.labelPoint && require(dir + "/room-detect.js").pointInPolygon(room.labelPoint, room.boundary));
});
t("room: separation line (thickness 0) closes a room", () => {
  const walls = box(0, 0, 6, 3).slice(0, 3).concat([{ id: "sep", start: [0, 3], end: [0, 0], thickness: 0 }]);
  assert.ok(r.detectRoomAt([3, 1.5], walls));
});
console.log(`${passed} passed`);
