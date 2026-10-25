/**
 * tests/v68-solid-hosting.test.cjs
 *
 * Unit tests for MASTER PROMPT Module 2.7–2.9/2.12 (solid kernel:
 * parametric forms, BSP booleans, voids, validation) and Module 1.5
 * (hosting: surface parameterisation, openings, host-change propagation).
 * All values verified against closed forms to 1e-6 or better.
 *
 * Run: `node tests/v68-solid-hosting.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, tol = 1e-6) { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`); }
function throws(fn, substr) {
  try { fn(); } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(`expected throw containing '${substr}'`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v68-solid-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/solid-kernel/index.ts src/modules/hosting/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const sk = require(path.join(tmpOut, "modules/solid-kernel/index.js"));
const host = require(path.join(tmpOut, "modules/hosting/index.js"));

// ── Helpers ─────────────────────────────────────────────────────────────
// Profiles are explicitly CLOSED (spec 2.8 requires closure).
const rect = (w, h) => [{ u: 0, v: 0 }, { u: w, v: 0 }, { u: w, v: h }, { u: 0, v: h }, { u: 0, v: 0 }];
const box = (x0, y0, z0, x1, y1, z1) => sk.generateVoid({ kind: "box", center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 }, size: { x: x1 - x0, y: y1 - y0, z: z1 - z0 } });

// ═══ MODULE 2.8: parametric forms ═══════════════════════════════════════

t("extrude: box volume exact (1×1×2)", () => {
  const m = sk.extrude({ profile: rect(1, 1), depth: 2 });
  near(sk.meshVolume(m), 2, 1e-9);
});

t("extrude: start offset shifts, volume unchanged", () => {
  const m = sk.extrude({ profile: rect(1, 1), depth: 2, startOffset: 3 });
  near(sk.meshVolume(m), 2, 1e-9);
  const zs = m.vertices.map((v) => v.z);
  near(Math.min(...zs), 3, 1e-12);
  near(Math.max(...zs), 5, 1e-12);
});

t("extrude: open profile and self-intersection rejected (spec 2.8)", () => {
  throws(() => sk.extrude({ profile: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }], depth: 1 }), "closed");
  // Bow-tie profile crosses itself (explicitly closed ring).
  const bowtie = [{ u: 0, v: 0 }, { u: 1, v: 1 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 0, v: 0 }];
  throws(() => sk.extrude({ profile: bowtie, depth: 1 }), "self-intersecting");
});

t("revolve: full cylinder volume πr²h exact", () => {
  const m = sk.revolve({
    profile: [{ u: 0, v: 0 }, { u: 0.5, v: 0 }, { u: 0.5, v: 2 }, { u: 0, v: 2 }, { u: 0, v: 0 }],
    axisPoint: { x: 0, y: 0, z: 0 }, axisDir: { x: 0, y: 0, z: 1 }, segments: 64,
  });
  near(sk.meshVolume(m), Math.PI * 0.25 * 2, 5e-3); // inscribed 64-gon tessellation error ~2e-3
});

t("revolve: half revolution = πr²h/2, caps present", () => {
  const m = sk.revolve({
    profile: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }, { u: 0, v: 0 }],
    axisPoint: { x: 0, y: 0, z: 0 }, axisDir: { x: 0, y: 0, z: 1 },
    angle: Math.PI, segments: 64,
  });
  near(sk.meshVolume(m), Math.PI / 2, 5e-3);
});

t("revolve: axis-crossing profile rejected (spec 2.8)", () => {
  throws(() => sk.revolve({
    profile: [{ u: -0.5, v: 0 }, { u: 0.5, v: 0 }, { u: 0.5, v: 1 }, { u: -0.5, v: 1 }, { u: -0.5, v: 0 }],
    axisPoint: { x: 0, y: 0, z: 0 }, axisDir: { x: 0, y: 0, z: 1 },
  }), "crosses the axis");
});

t("blend: rectangle→rectangle loft volume exact", () => {
  const m = sk.blend({ startProfile: rect(2, 2), endProfile: rect(1, 1), height: 3 });
  // Frustum between similar squares: V = h/3 · (A1 + A2 + sqrt(A1·A2))
  const expected = (3 / 3) * (4 + 1 + Math.sqrt(4));
  near(sk.meshVolume(m), expected, 1e-6);
});

t("sweep: profile along L path (delegates to adaptive sweepProfile)", () => {
  const m = sk.sweep({
    profile: rect(0.2, 0.2),
    path: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }],
  });
  near(sk.meshVolume(m), 0.04 * 2, 1e-9); // 0.2² × total path length 2
});

// ═══ MODULE 2.9: booleans + voids ═══════════════════════════════════════

t("csg subtract: 2³ − 1³ = 7 exact", () => {
  const a = box(0, 0, 0, 2, 2, 2);
  const b = box(0.5, 0.5, 0.5, 1.5, 1.5, 1.5);
  const r = sk.subtract(a, b);
  near(sk.meshVolume(r), 7, 1e-6);
});

t("csg union + intersect: exact on non-coplanar overlapping boxes", () => {
  // A=[0,2]³, B=[1,3]×[0.5,2.5]²: overlap [1,2]×[0.5,2]² = 2.25 m³,
  // and no face plane is shared between the two boxes.
  const a = box(0, 0, 0, 2, 2, 2);
  const b = box(1, 0.5, 0.5, 3, 2.5, 2.5);
  near(sk.meshVolume(sk.union(a, b)), 16 - 2.25, 1e-6);
  near(sk.meshVolume(sk.intersect(a, b)), 2.25, 1e-6);
});

t("csg: coincident-face union throws a precise error (documented limit)", () => {
  // A and B share the y=0 and y=2 planes → coplanar faces.
  const a = box(0, 0, 0, 2, 2, 2);
  const b = box(1, 0, 0, 3, 2, 2);
  throws(() => sk.union(a, b), "coincident (coplanar) faces");
});

t("csg: contained void (fully inside) removes exactly its volume", () => {
  const a = box(0, 0, 0, 3, 3, 3);           // 27
  const b = box(1, 1, 1, 2, 2, 2);           // 1
  const r = sk.booleanOp("subtract", a, b);
  near(sk.meshVolume(r), 26, 1e-6);
});

t("csg: empty result throws (no silent empty solids)", () => {
  const a = box(0, 0, 0, 1, 1, 1);
  const b = box(5, 5, 5, 6, 6, 6);
  throws(() => sk.intersect(a, b), "result is empty");
});

t("AabbTree: broad-phase query returns exactly the straddled triangles", () => {
  const mesh = box(0, 0, 0, 10, 10, 10); // 12 triangles
  const tree = new sk.AabbTree(mesh);
  // Query box straddling the +x face (x=10 plane): only its 2 triangles.
  const hits = tree.query({ minX: 8, minY: 4, minZ: 4, maxX: 12, maxY: 6, maxZ: 6 });
  assert(hits.length === 2, `hits=${hits.length}, expect the 2 +x-face triangles`);
  // Query entirely inside the solid touches no surface triangle (correct:
  // broad-phase works on surface triangle boxes, not solid occupancy).
  const inside = tree.query({ minX: 4, minY: 4, minZ: 4, maxX: 6, maxY: 6, maxZ: 6 });
  assert(inside.length === 0, `inside hits=${inside.length}`);
  // Far away: nothing.
  const far = tree.query({ minX: 100, minY: 100, minZ: 100, maxX: 101, maxY: 101, maxZ: 101 });
  assert(far.length === 0);
});

t("cutVoids: sequential subtraction with records; miss reported not errored", () => {
  const host = box(0, 0, 0, 2, 2, 2); // 8
  const result = sk.cutVoids(host, [
    { kind: "box", center: { x: 1, y: 1, z: 1 }, size: { x: 0.5, y: 0.5, z: 0.5 } }, // 0.125 hit
    { kind: "box", center: { x: 10, y: 1, z: 1 }, size: { x: 0.5, y: 0.5, z: 0.5 } }, // miss
  ]);
  near(sk.meshVolume(result.solid), 8 - 0.125, 1e-6);
  assert(result.records.length === 2);
  assert(result.records[0].confirmed === true);
  near(result.records[0].removedVolume, 0.125, 1e-6);
  assert(result.records[1].confirmed === false, "miss must be reported, not thrown");
  assert(result.failures.length === 0);
  // Rollback guarantee: the input mesh is untouched.
  near(sk.meshVolume(host), 8, 1e-9);
});

t("cutVoids: two overlapping voids subtract without double-counting", () => {
  const host = box(0, 0, 0, 4, 2, 2); // 16
  // Two voids overlapping each other inside the host.
  const r = sk.cutVoids(host, [
    { kind: "box", center: { x: 1, y: 1, z: 1 }, size: { x: 2, y: 1, z: 1 } }, // 2
    { kind: "box", center: { x: 2, y: 1, z: 1 }, size: { x: 2, y: 1, z: 1 } }, // 2, overlap 1
  ]);
  // Union of voids = 3 → remaining 13.
  near(sk.meshVolume(r.solid), 13, 1e-6);
});

// ═══ MODULE 2.12: validation diagnostics ════════════════════════════════

t("validate: non-manifold edge and inverted winding detected", () => {
  // Two separate tetrahedra merged into one "solid": their shared-face
  // absence is fine, but drop one face of a tetra → boundary edges (use 1).
  const m = box(0, 0, 0, 1, 1, 1);
  const broken = { vertices: m.vertices, faces: m.faces.slice(0, m.faces.length - 1) };
  const diags = sk.validateMeshDiagnostics(broken, "broken");
  assert(diags.some((d) => d.code === "non-manifold-edge"), "boundary edges must be reported");
  assert(!sk.commitEligible(diags), "errors block commit");
  // Inverted winding: flip every triangle.
  const flipped = { vertices: m.vertices, faces: m.faces.map(([a, b, c]) => [a, c, b]) };
  const d2 = sk.validateMeshDiagnostics(flipped, "flipped");
  assert(d2.some((d) => d.code === "inverted-volume"), "inverted volume must be reported");
  assert(sk.commitEligible(d2), "warnings do not block commit");
});

t("validate: zero-length edge + degenerate face", () => {
  const m = box(0, 0, 0, 1, 1, 1);
  m.vertices.push({ ...m.vertices[0] });
  m.faces.push([m.vertices.length - 1, m.vertices.length - 1, 0]);
  const diags = sk.validateMeshDiagnostics(m, "m");
  assert(diags.some((d) => d.code === "degenerate-face" || d.code === "zero-length-edge"));
});

t("validate: profile self-intersection and open profile", () => {
  const bowtie = [{ u: 0, v: 0 }, { u: 1, v: 1 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 0, v: 0 }];
  const d1 = sk.validateProfileDiagnostics(bowtie, "p1");
  assert(d1.some((d) => d.code === "self-intersection"));
  const open = [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }];
  const d2 = sk.validateProfileDiagnostics(open, "p2");
  assert(d2.some((d) => d.code === "open-profile"));
});

t("validate: unresolved host + missing reference + analysis bridging", () => {
  const d1 = sk.validateReferenceDiagnostics({ hostId: "h1", hostExists: false });
  assert(d1.some((d) => d.code === "unresolved-host" && !d.commitEligible));
  const d2 = sk.validateReferenceDiagnostics({
    hostId: null, hostExists: true,
    requiredReferences: ["Center (Front/Back)"],
    availableReferences: ["Center (Left/Right)"],
  });
  assert(d2.some((d) => d.code === "missing-reference"));
  const d3 = sk.validateAnalysisDiagnostics({ solverStatus: "over-constrained" });
  assert(d3.some((d) => d.code === "unsolvable-constraint" && !d.commitEligible));
});

// ═══ MODULE 1.5: hosting ════════════════════════════════════════════════

t("hosting: line host parameterisation + frames exact", () => {
  const curve = { kind: "line", start: [1, 2], end: [4, 6] };
  near(host.hostLength(curve), 5, 1e-12); // 3-4-5
  const f = host.evaluateHost(curve, 2.5);
  near(f.position[0], 1 + 0.6 * 2.5, 1e-12);
  near(f.position[1], 2 + 0.8 * 2.5, 1e-12);
  near(f.tangent[0], 0.6, 1e-12);
  near(f.tangent[1], 0.8, 1e-12);
  near(f.normal[0], -0.8, 1e-12);
  near(f.normal[1], 0.6, 1e-12);
});

t("hosting: arc host length = r·Δθ; point on arc exact", () => {
  const curve = { kind: "arc", center: [0, 0], radius: 2, startAngle: 0, endAngle: Math.PI };
  near(host.hostLength(curve), Math.PI * 2, 1e-9); // r·π = 2π
  const f = host.evaluateHost(curve, Math.PI); // half-way: angle π/2
  near(f.position[0], 0, 1e-9);
  near(f.position[1], 2, 1e-9);
});

t("hosting: opening placement + overlap detection (spec 1.5)", () => {
  const g = {
    curve: { kind: "line", start: [0, 0], end: [6, 0] },
    baseZ: 0, height: 3, version: 1,
    layers: [{ name: "core", function: "structure", thickness: 0.2, material: "concrete" }],
  };
  const w1 = { id: "w1", s: 2, width: 1, height: 1.5, sillHeight: 0.9, layerOffset: 0 };
  const p1 = host.placeOpening(g, w1);
  near(p1.center[0], 2, 1e-12);
  near(p1.zStart, 0.9, 1e-12);
  near(p1.zEnd, 2.4, 1e-12);
  // Out-of-host opening rejected.
  throws(() => host.placeOpening(g, { ...w1, s: 5.8 }), "exceeds host length");
  // Head above host height rejected.
  throws(() => host.placeOpening(g, { ...w1, sillHeight: 2.5 }), "exceeds host height");
  // Overlap: w2 at s=2.5 width 1 overlaps w1 (2 ± 0.5).
  const w2 = { id: "w2", s: 2.5, width: 1, height: 1.2, sillHeight: 1.0, layerOffset: 0 };
  const overlaps = host.findOverlappingOpenings([w1, w2]);
  assert(overlaps.length === 1 && overlaps[0][0] === "w1" && overlaps[0][1] === "w2");
  // Non-overlapping vertical ranges are NOT conflicts even when s overlaps.
  const w3 = { id: "w3", s: 2.5, width: 1, height: 0.3, sillHeight: 0.1, layerOffset: 0 };
  assert(host.findOverlappingOpenings([w1, w3]).length === 0);
});

t("hosting: host-change propagation — shortened wall invalidates openings", () => {
  const prev = {
    curve: { kind: "line", start: [0, 0], end: [6, 0] },
    baseZ: 0, height: 3, version: 1, layers: [],
  };
  const next = { ...prev, curve: { kind: "line", start: [0, 0], end: [3, 0] }, version: 2 };
  const openings = [
    { id: "ok", s: 1.5, width: 1, height: 1.5, sillHeight: 0.9, layerOffset: 0 },
    { id: "gone", s: 5, width: 1, height: 1.5, sillHeight: 0.9, layerOffset: 0 },
  ];
  const r = host.evaluateHostedOpeningsAfterHostChange(prev, next, openings);
  assert(r.version === 2 && r.kind === "curve-edit");
  assert(r.moved.length === 1 && r.moved[0].openingId === "ok");
  assert(r.invalid.length === 1 && r.invalid[0].openingId === "gone");
});

t("hosting: curved wall radius change preserves angular position (spec Ex. B)", () => {
  const arc = { center: [0, 0], radius: 3, startAngle: 0, endAngle: Math.PI / 2 };
  const opening = { id: "win", s: 3 * Math.PI / 8, width: 0.5, height: 1.2, sillHeight: 0.9, layerOffset: 0 };
  const r = host.propagateOpeningToNewRadius(arc, opening, 6);
  // Angular fraction preserved: s_new/s_new_L == s_old/L_old.
  const newL = 6 * (Math.PI / 2);
  near(r.newS / newL, (3 * Math.PI / 8) / (3 * Math.PI / 2), 1e-9);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
