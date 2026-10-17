const assert = require("assert");
const g = require((process.env.OUT_DIR || "") + "/m2-geometry.js");
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 3).join("\n       ")); process.exitCode = 1; } }
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b} (tol ${tol})`);
const vol = (r) => r.parts.filter((p) => p.role === "solid").reduce((s, p) => s + g.signedVolume(p.positions), 0);
const bbox = (r) => { const b = { min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9] }; for (const p of r.parts) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], p.positions[i + k]); b.max[k] = Math.max(b.max[k], p.positions[i + k]); } return b; };
const rot = (pt, a, c = [0, 0]) => { const dx = pt[0] - c[0], dz = pt[1] - c[1]; return [c[0] + dx * Math.cos(a) - dz * Math.sin(a), c[1] + dx * Math.sin(a) + dz * Math.cos(a)]; };

// exact cross-section area of a waist-slab flight (stepped top above the sloped underside, clipped at the floor)
const flightArea = (n, L, rh, waist) => { const td = L / n, u0 = waist * td / rh; return td * rh * n * (n + 1) / 2 - 0.5 * (L - u0) * (n * rh - waist); };
t("earClip: concave L polygon (either orientation) tiles exactly its area", () => {
  const L = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 5], [0, 5]];
  for (const poly of [L, L.slice().reverse()]) {
    const tris = g.earClip(poly); let a = 0;
    for (const [i, j, k] of tris) { const A = poly[i], B = poly[j], C = poly[k]; a += ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2; }
    near(a, 18, 1e-9); assert.strictEqual(tris.length, 4);
  }
});
t("stairs: 3.0 m rise over 5 m -> 18 risers of 166.7 mm, 278 mm treads, closed outward shell", () => {
  const r = g.buildStair({ start: [0, 0], end: [5, 0], width: 1.2, totalRise: 3, elevation: 1 });
  assert.strictEqual(r.info.risers, 18); near(r.info.riserHeight, 3 / 18); near(r.info.treadDepth, 5 / 18, 1e-9);
  assert.strictEqual(r.info.compliant, true);
  assert.ok(g.isWatertight(r.parts[0].positions), "not watertight");
  near(vol(r), 1.2 * flightArea(18, 5, 3 / 18, 0.12), 1e-9);
  const b = bbox(r); near(b.min[1], 1, 1e-9); near(b.max[1], 4, 1e-9); near(b.min[0], 0, 1e-9); near(b.max[0], 5, 1e-9);
  near(b.min[2], -0.6, 1e-9); near(b.max[2], 0.6, 1e-9);
});
t("stairs: result does not depend on the run direction (handedness of the extrusion)", () => {
  const base = vol(g.buildStair({ start: [0, 0], end: [5, 0], width: 1.2, totalRise: 3, elevation: 0 }));
  for (const a of [0.4, 1.9, 3.3, -2.2]) {
    const r = g.buildStair({ start: [2, 3], end: rot([7, 3], a, [2, 3]), width: 1.2, totalRise: 3, elevation: 0 });
    near(vol(r), base, 1e-6); assert.ok(g.isWatertight(r.parts[0].positions));
  }
});
t("stairs: too steep / too short runs are reported, non-compliant treads flagged", () => {
  assert.throws(() => g.buildStair({ start: [0, 0], end: [0.1, 0], width: 1, totalRise: 3, elevation: 0 }));
  const r = g.buildStair({ start: [0, 0], end: [2.5, 0], width: 1, totalRise: 3, elevation: 0 });
  assert.strictEqual(r.info.compliant, false);
});
for (const shape of ["L", "U"]) for (const turn of ["left", "right"]) {
  t(`stairs: ${shape}-shape turning ${turn}: two flights, landing at half rise, top at exactly the total rise`, () => {
    const r = g.buildStair({ start: [0, 0], end: [3, 0], width: 1.1, totalRise: 3.2, elevation: 0, shape, turn });
    assert.strictEqual(r.info.flights, 2); assert.strictEqual(r.info.risers, 19);
    near(r.info.landingHeight, Math.floor(19 / 2) * (3.2 / 19), 1e-9);
    const b = bbox(r); near(b.max[1], 3.2, 1e-9); assert.ok(b.min[1] >= -1e-9);
    const rh = 3.2 / 19, n1 = 9, n2 = 10, w = 1.1, lt = 0.15;
    const landing = shape === "L" ? w * w * lt : w * (2 * w + 0.1) * lt;
    near(vol(r), w * flightArea(n1, 3, rh, 0.12) + w * flightArea(n2, 3, rh, 0.12) + landing, 1e-9);
    // the second flight must lie to the correct side of the first
    const side = turn === "left" ? -1 : 1; // left of +x run is -z (plan: north)
    const zExt = side < 0 ? b.min[2] : b.max[2];
    if (shape === "L") assert.ok(Math.abs(zExt) > 2.0, "second flight not on the " + turn + " side: " + zExt);
    else near(Math.abs(zExt), 1.1 + 0.1 + 0.55, 1e-9); // U: flight 2 centred w+gap from flight 1, half a width beyond
    assert.strictEqual(Math.sign(zExt), side, "wrong side for " + turn);
    const other = side < 0 ? b.max[2] : b.min[2]; near(Math.abs(other), 0.55, 1e-9); // the first flight stays on its own axis
  });
}
t("stairs L/U: volume is the same for any rotation", () => {
  for (const shape of ["L", "U"]) {
    const v0 = vol(g.buildStair({ start: [0, 0], end: [3, 0], width: 1.1, totalRise: 3.2, elevation: 0, shape }));
    const r = g.buildStair({ start: [4, 4], end: rot([7, 4], 0.9, [4, 4]), width: 1.1, totalRise: 3.2, elevation: 0, shape });
    near(vol(r), v0, 1e-6);
  }
});
t("ramp: exact volume, slope and compliance flag, any direction", () => {
  const r = g.buildRamp({ start: [0, 0], end: [6, 0], width: 1.5, rise: 0.6, thickness: 0.2, elevation: 0 });
  near(vol(r), 6 * 0.2 * 1.5, 1e-9); assert.ok(g.isWatertight(r.parts[0].positions));
  near(r.info.slopePercent, 10, 1e-9); assert.strictEqual(r.info.compliant, false);
  assert.strictEqual(g.buildRamp({ start: [0, 0], end: [6, 0], width: 1.5, rise: 0.5, thickness: 0.2, elevation: 0 }).info.compliant, true); // exactly 1:12
  const r2 = g.buildRamp({ start: [1, 1], end: rot([7, 1], 2.4, [1, 1]), width: 1.5, rise: 0.6, thickness: 0.2, elevation: 0 });
  near(vol(r2), vol(r), 1e-9);
});
t("railing: top rail + posts have exactly the box volumes (winding + orientation + slope)", () => {
  const o = { path: [[0, 0], [1, 0]], elevation: 0, height: 1, railSize: 0.05, postSize: 0.05, postSpacing: 10, balusters: false, bottomRail: false };
  const r = g.buildRailing(o);
  assert.strictEqual(r.info.posts, 2);
  near(vol(r), 1 * (0.05 * 1.2) * 0.05 + 2 * 0.05 * 0.05 * 1, 1e-9);
  const slope = g.buildRailing({ ...o, rise: 0.5 });
  const L = Math.hypot(1, 0.5);
  near(vol(slope), L * (0.05 * 1.2) * 0.05 + 2 * 0.05 * 0.05 * 1, 1e-9);
  assert.strictEqual(g.buildRailing({ ...o, path: [[0, 0], [5, 0], [5, 3]], postSpacing: 1.2, balusters: true }).info.posts, 5 + 3 + 1);
});
t("railing: balusters at the requested spacing", () => {
  const r = g.buildRailing({ path: [[0, 0], [2.4, 0]], elevation: 0, postSpacing: 2.4, balusterSpacing: 0.12 });
  assert.ok(r.info.balusters >= 18 && r.info.balusters <= 20, "balusters " + r.info.balusters);
});
t("curtain wall: grid, glass and frame; mullions keep their cross-section when the wall is rotated", () => {
  const r = g.buildCurtainWall({ start: [0, 0], end: [6, 0], elevation: 0, height: 3.6 });
  assert.strictEqual(r.info.columns, 4); assert.strictEqual(r.info.rows, 3); assert.strictEqual(r.info.panels, 12);
  const glass = r.parts.find((p) => p.role === "glass"); assert.ok(g.signedVolume(glass.positions) > 0.2 && g.signedVolume(glass.positions) < 0.6);
  const frame = r.parts.find((p) => p.role === "solid"); assert.ok(g.signedVolume(frame.positions) > 0);
  const r2 = g.buildCurtainWall({ start: [1, 1], end: rot([7, 1], 1.1, [1, 1]), elevation: 0, height: 3.6 });
  near(g.signedVolume(r2.parts[0].positions), g.signedVolume(frame.positions), 1e-6);
  near(g.signedVolume(r2.parts[1].positions), g.signedVolume(glass.positions), 1e-6);
  const b = bbox(r); near(b.max[1], 3.6, 1e-9); assert.ok(b.max[2] <= 0.05 + 1e-9 && b.min[2] >= -0.05 - 1e-9, "mullion depth across the wall");
});
t("roof (shed): single closed shell, volume = plan area x thickness, ridge height from slope", () => {
  const poly = [[0, 0], [10, 0], [10, 6], [0, 6]];
  const r = g.buildRoof({ polygon: poly, elevation: 3, thickness: 0.2, slopeDeg: 20, roofType: "shed", dirDeg: 0 });
  assert.ok(g.isWatertight(r.parts[0].positions));
  near(vol(r), 60 * 0.2, 1e-9); near(r.info.rise, Math.tan(20 * Math.PI / 180) * 10, 1e-9);
  near(r.info.surfaceArea, 60 / Math.cos(20 * Math.PI / 180), 1e-9);
});
t("roof (gable): two planes meet at the ridge at half the span; volume = plan area x thickness", () => {
  const poly = [[0, 0], [10, 0], [10, 6], [0, 6]];
  const r = g.buildRoof({ polygon: poly, elevation: 3, thickness: 0.2, slopeDeg: 30, roofType: "gable", dirDeg: 0 });
  near(vol(r), 12, 1e-9); near(r.info.ridgeHeight, 3 + Math.tan(Math.PI / 6) * 5, 1e-9);
  const b = bbox(r); near(b.max[1], 3 + Math.tan(Math.PI / 6) * 5, 1e-9); near(b.min[1], 3 - 0.2, 1e-9);
  const r2 = g.buildRoof({ polygon: poly, elevation: 3, thickness: 0.2, slopeDeg: 30, roofType: "gable", dirDeg: 90 });
  near(r2.info.ridgeHeight, 3 + Math.tan(Math.PI / 6) * 3, 1e-9); near(vol(r2), 12, 1e-9);
});
t("roof on a concave L footprint keeps its volume", () => {
  const L = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 5], [0, 5]];
  near(vol(g.buildRoof({ polygon: L, elevation: 3, thickness: 0.25, slopeDeg: 25, roofType: "shed" })), 18 * 0.25, 1e-9);
  near(vol(g.buildRoof({ polygon: L, elevation: 3, thickness: 0.25, slopeDeg: 25, roofType: "gable" })), 18 * 0.25, 1e-6);
});
t("ceiling: closed outward prism for convex, concave and clockwise polygons", () => {
  const L = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 5], [0, 5]];
  for (const poly of [L, L.slice().reverse()]) {
    const r = g.buildCeiling({ polygon: poly, elevation: 2.7, thickness: 0.02 });
    assert.ok(g.isWatertight(r.parts[0].positions)); near(vol(r), 18 * 0.02, 1e-9); near(r.info.area, 18, 1e-9);
  }
});
t("buildElementGeo: dispatches on authored elements, returns null for incomplete / unknown", () => {
  const base = { height: 3, thickness: 0.2, elevation: 0 };
  assert.ok(g.buildElementGeo({ type: "stairs", params: { ...base, start: [0, 0], end: [4, 0], width: 1.2 }, properties: { stairShape: "L" } }).info.flights === 2);
  assert.strictEqual(g.buildElementGeo({ type: "stairs", params: { ...base } }), null);
  assert.strictEqual(g.buildElementGeo({ type: "wall", params: { ...base, start: [0, 0], end: [1, 0] } }), null);
  assert.ok(g.buildElementGeo({ type: "railing", params: { ...base, thickness: 0.05, height: 1, polygon: [[0, 0], [3, 0], [3, 2]] } }).info.length > 4.9);
  assert.ok(g.isM2Type("curtain-wall") && !g.isM2Type("wall"));
});
t("quantities: stairs, ramp, curtain wall, roof, ceiling report real volumes / areas", () => {
  const base = { height: 3, thickness: 0.2, elevation: 0 };
  const s = g.m2Quantities({ type: "stairs", params: { ...base, start: [0, 0], end: [5, 0], width: 1.2 } });
  near(s.volume, vol(g.buildStair({ start: [0, 0], end: [5, 0], width: 1.2, totalRise: 3, elevation: 0 })), 1e-9); assert.ok(/18 risers/.test(s.detail));
  near(g.m2Quantities({ type: "curtain-wall", params: { ...base, height: 3.6, start: [0, 0], end: [6, 0] } }).area, 21.6, 1e-9);
  near(g.m2Quantities({ type: "ceiling", params: { ...base, thickness: 0.02, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] } }).area, 12, 1e-9);
  near(g.m2Quantities({ type: "roof", params: { ...base, polygon: [[0, 0], [10, 0], [10, 6], [0, 6]] }, properties: { slope: 30 } }).area, 60 / Math.cos(Math.PI / 6), 1e-9);
  assert.strictEqual(g.m2Quantities({ type: "wall", params: base }), null);
});
console.log(`${passed} passed`);
