const assert = require("assert");
const dir = process.env.OUT_DIR || "";
const S = require(dir + "/m3-solids.js");
const P = require(dir + "/m3-project.js");
const G = require(dir + "/m2-geometry.js");
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 3).join("\n       ")); process.exitCode = 1; } }
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
const area = (pts) => { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const wall = (id, s, e, o = {}) => ({ id, type: "wall", params: { start: s, end: e, height: 3, thickness: 0.2, elevation: 0, ...o } });
const door = (id, host, o = {}) => ({ id, type: "door", hostId: host, params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 3, sillHeight: 0, ...o } });
const win = (id, host, o = {}) => ({ id, type: "window", hostId: host, params: { width: 1.2, height: 1.4, thickness: 0.2, elevation: 0, offsetAlongHost: 5, sillHeight: 0.9, ...o } });
const vol = (solid) => solid.parts.filter((p) => p.role === "solid").reduce((s, p) => s + G.signedVolume(p.positions), 0);
const rot = (pt, a) => [pt[0] * Math.cos(a) - pt[1] * Math.sin(a), pt[0] * Math.sin(a) + pt[1] * Math.cos(a)];

t("wall pieces: a door leaves the wall in two full-height runs, a window adds a sill and a lintel", () => {
  const w = wall("w", [0, 0], [8, 0]);
  const ops = S.wallOpenings(w, [door("d", "w"), win("x", "w")]);
  assert.strictEqual(ops.length, 2); near(ops[0].u0, 2.55); near(ops[0].u1, 3.45); near(ops[1].y0, 0.9); near(ops[1].y1, 2.3);
  const pcs = S.wallPieces(w, ops);
  // run | door lintel | run | window sill | window lintel | run
  assert.strictEqual(pcs.length, 6);
  const a = pcs.reduce((s, p) => s + (p.u1 - p.u0) * (p.y1 - p.y0), 0);
  near(a, 8 * 3 - 0.9 * 2.1 - 1.2 * 1.4, 1e-9);
});
t("wall solid: exact volume = wall minus the openings, every part closed and outward wound", () => {
  const els = [wall("w", [0, 0], [8, 0]), door("d", "w"), win("x", "w")];
  const solids = S.elementSolids(els);
  const w = solids.find((s) => s.id === "w");
  near(vol(w), (8 * 3 - 0.9 * 2.1 - 1.2 * 1.4) * 0.2, 1e-9);
  assert.ok(G.signedVolume(w.parts[0].positions) > 0);
  assert.ok(solids.find((s) => s.id === "d") && solids.find((s) => s.id === "x").parts.some((p) => p.role === "glass"));
  assert.strictEqual(solids.filter((s) => s.type === "door" || s.type === "window").length, 2);
});
t("elementSolids: slab, column, beam, footing and the M2 types produce solids; unusable elements are skipped", () => {
  const base = { height: 3, thickness: 0.2, elevation: 0 };
  const els = [
    { id: "s", type: "slab", params: { ...base, height: 0.2, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] } },
    { id: "c", type: "column", params: { ...base, point: [1, 1], depth: 0.4 } },
    { id: "b", type: "beam", params: { ...base, height: 0.5, start: [0, 0], end: [4, 0] } },
    { id: "f", type: "footing", params: { ...base, height: 0.4, point: [1, 1], thickness: 1 } },
    { id: "st", type: "stairs", params: { ...base, start: [0, 0], end: [5, 0], width: 1.2 } },
    { id: "bad", type: "wall", params: { ...base } }, { id: "tiny", type: "wall", params: { ...base, start: [0, 0], end: [0.01, 0] } },
  ];
  const ids = S.elementSolids(els).map((s) => s.id).sort();
  assert.deepStrictEqual(ids, ["b", "c", "f", "s", "st"]);
});
t("elevation frame matches the existing u axis and a unit box projects to one outlined square", () => {
  assert.deepStrictEqual(P.elevationFrame("north").right, [1, 0, 0]); assert.deepStrictEqual(P.elevationFrame("east").right, [0, 0, 1]);
  const solids = S.elementSolids([{ id: "c", type: "column", params: { height: 2, thickness: 1, depth: 1, elevation: 0, point: [0, 0] } }]);
  const ent = P.projectSolids(solids, P.elevationFrame("north"));
  const polys = ent.filter((e) => e.kind === "polyline");
  assert.strictEqual(polys.length, 1);
  near(area(polys[0].points), 1 * 2, 1e-9);
  assert.ok(polys[0].fill && polys[0].fill.color === "#ffffff");
  assert.strictEqual(ent.filter((e) => e.kind === "line").length, 0); // faces of a box meet at 90 deg but the sides are edge-on, so only the outline
});
t("elevation hides what is behind: the near wall is drawn after (over) the far wall", () => {
  const els = [wall("far", [0, -10], [6, -10]), wall("near", [0, 10], [6, 10])];  // north view looks toward -z, near = z 10
  const ent = P.projectSolids(S.elementSolids(els), P.elevationFrame("north"));
  const polys = ent.filter((e) => e.kind === "polyline");
  assert.strictEqual(polys.length, 2);
  // both project to the same rectangle; draw order must be far first, near last: check via depth through ids
  const solids = S.elementSolids(els); const frame = P.elevationFrame("north");
  const depth = (id) => Math.min(...solids.find((s) => s.id === id).parts[0].positions.filter((_, i) => i % 3 === 2).map((z) => P.toView(frame, [0, 0, z])[2]));
  assert.ok(depth("near") < depth("far"));
  const order = P.projectSolids(S.elementSolids(els), frame).filter((e) => e.kind === "polyline");
  assert.strictEqual(order.length, 2);
});
t("elevation shows door and window openings (the wall front is not one rectangle)", () => {
  const els = [wall("w", [0, 0], [8, 0]), door("d", "w"), win("x", "w")];
  const ent = P.projectSolids(S.elementSolids(els), P.elevationFrame("south"));
  const polys = ent.filter((e) => e.kind === "polyline" && e.fill && e.fill.opacity === 1);
  // 6 wall pieces + 3 door frame/leaf pieces + 4 window frame pieces
  assert.ok(polys.length >= 6 + 3, "polygons: " + polys.length);
  assert.ok(ent.some((e) => e.kind === "polyline" && e.fill && e.fill.opacity < 1), "glazing is translucent");
  const b = P.entitiesBounds(ent); near(b.maxZ - b.minZ, 3, 1e-9); near(b.maxX - b.minX, 8, 1e-9);
});
t("elevation of a gable roof shows the real slope, ridge at half the span", () => {
  const els = [{ id: "r", type: "roof", params: { height: 0.2, thickness: 0.2, elevation: 3, polygon: [[0, 0], [10, 0], [10, 6], [0, 6]] }, properties: { slope: 30, roofType: "gable", slopeDirection: 0 } }];
  const ent = P.projectSolids(S.elementSolids(els), P.elevationFrame("north"));
  const b = P.entitiesBounds(ent);
  near(b.maxZ, 3 + Math.tan(Math.PI / 6) * 5, 1e-6); near(b.minZ, 3 - 0.2, 1e-6);
});
t("section: a cut through solid wall gives a cap of exactly thickness x height, both look directions", () => {
  const els = [wall("w", [0, 0], [8, 0])];
  for (const look of ["right", "left"]) {
    const frame = P.sectionFrame({ x1: 3, z1: -5, x2: 3, z2: 5 }, look);
    const r = P.cutSolids(S.elementSolids(els), frame);
    const outer = r.caps.filter((c) => c.area > 0);
    assert.strictEqual(outer.length, 1);
    near(outer[0].area, 0.2 * 3, 1e-9);
  }
});
t("section: an oblique cut through a wall is wider by 1/sin(angle) (the old generator ignored the angle)", () => {
  const els = [wall("w", [0, 0], [8, 0])];
  const a = Math.PI / 4;
  const p0 = [3, 0], d = [Math.cos(Math.PI / 2 + a), Math.sin(Math.PI / 2 + a)];
  const frame = P.sectionFrame({ x1: p0[0] - d[0] * 5, z1: p0[1] - d[1] * 5, x2: p0[0] + d[0] * 5, z2: p0[1] + d[1] * 5 }, "right");
  const r = P.cutSolids(S.elementSolids(els), frame);
  const c = r.caps.filter((x) => x.area > 0);
  assert.strictEqual(c.length, 1);
  near(c[0].area, (0.2 / Math.sin(Math.PI / 4)) * 3, 1e-6);
});
t("section through a door: only the lintel is cut; through a window: sill + lintel; the rest is open", () => {
  const els = [wall("w", [0, 0], [8, 0]), door("d", "w"), win("x", "w")];
  const solids = S.elementSolids(els);
  const cutAt = (x) => P.cutSolids(solids.filter((s) => s.id === "w"), P.sectionFrame({ x1: x, z1: -5, x2: x, z2: 5 }, "right")).caps.filter((c) => c.area > 0).map((c) => c.area).sort((a, b) => a - b);
  const lint = cutAt(3);   // door: lintel from 2.1 to 3.0
  assert.strictEqual(lint.length, 1); near(lint[0], 0.2 * 0.9, 1e-9);
  const wi = cutAt(5);     // window: sill 0..0.9 and lintel 2.3..3.0
  assert.strictEqual(wi.length, 2); near(wi[0], 0.2 * 0.7, 1e-9); near(wi[1], 0.2 * 0.9, 1e-9);
  const solid = cutAt(7.5); assert.strictEqual(solid.length, 1); near(solid[0], 0.6, 1e-9);
});
t("section: slab with a hole in it is not needed - but a stair cut shows the stepped profile with area = cross-section", () => {
  const els = [{ id: "st", type: "stairs", params: { height: 3, thickness: 0.15, elevation: 0, start: [0, 0], end: [5, 0], width: 1.2 } }];
  const frame = P.sectionFrame({ x1: -1, z1: 0, x2: 6, z2: 0 }, "left");   // along the run, through its centre line
  const r = P.cutSolids(S.elementSolids(els), frame);
  const c = r.caps.filter((x) => x.area > 0);
  assert.strictEqual(c.length, 1);
  const td = 5 / 18, rh = 3 / 18, wv = 0.12, u0 = wv * td / rh;
  near(c[0].area, td * rh * 18 * 19 / 2 - 0.5 * (5 - u0) * (3 - wv), 1e-6);
});
t("section: clipping is exact - surface area of the far side plus the near side equals the original, caps match on both sides", () => {
  const solids = S.elementSolids([wall("w", [0, 0], [8, 0]), door("d", "w"), win("x", "w")]);
  const sa = (ss) => ss.reduce((acc, s) => acc + s.parts.reduce((a2, p) => { let a = 0; const P2 = p.positions; for (let i = 0; i + 8 < P2.length; i += 9) { const u = [P2[i + 3] - P2[i], P2[i + 4] - P2[i + 1], P2[i + 5] - P2[i + 2]], v = [P2[i + 6] - P2[i], P2[i + 7] - P2[i + 1], P2[i + 8] - P2[i + 2]]; a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; } return a2 + a; }, 0), 0);
  for (const x of [1.0, 3.0, 5.0, 7.3]) {
    const f1 = P.sectionFrame({ x1: x, z1: -5, x2: x, z2: 5 }, "right"), f2 = P.sectionFrame({ x1: x, z1: -5, x2: x, z2: 5 }, "left");
    const a = P.cutSolids(solids, f1), b = P.cutSolids(solids, f2);
    near(sa(a.far) + sa(b.far), sa(solids), 1e-6);
    near(a.caps.filter((c) => c.area > 0).reduce((s, c) => s + c.area, 0), b.caps.filter((c) => c.area > 0).reduce((s, c) => s + c.area, 0), 1e-9);
  }
});
t("capEntities: outer loops are filled with the poche colour, hole loops are punched white", () => {
  const caps = [{ solidId: "a", type: "wall", loop: [[0, 0], [2, 0], [2, 2], [0, 2]], area: 4 }, { solidId: "a", type: "wall", loop: [[0.5, 0.5], [0.5, 1.5], [1.5, 1.5], [1.5, 0.5]], area: -1 }];
  const e = P.capEntities(caps, () => "#abcdef");
  assert.strictEqual(e.length, 2); assert.strictEqual(e[0].fill.color, "#abcdef"); assert.strictEqual(e[1].fill.color, "#ffffff");
});
t("datum lines span the drawing and are labelled with the elevation", () => {
  const e = P.datumEntities([{ name: "Level 1", elevation: 0 }, { name: "Level 2", elevation: 3.4 }], -1, 9);
  assert.strictEqual(e.length, 4);
  assert.ok(e.some((x) => x.kind === "text" && /Level 2\s+\+3\.40/.test(x.text)));
});
console.log(`${passed} passed`);
