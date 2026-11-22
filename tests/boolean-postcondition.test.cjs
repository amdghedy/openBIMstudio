/**
 * K4 — one Boolean post-condition for all three Boolean engines.
 *
 * The convex kernel, the general kernel, and three-csg-ts (wall
 * opening / door / reveal cuts) all route their results through the
 * single post-condition in
 * src/modules/solid-kernel/boolean-postcondition.ts (weld + validate
 * via K1's gate; typed verdict ok / quarantined / refused; diagnostics
 * recorded), and a three-csg-ts failure falls back to the general
 * kernel. These tests pin, with REAL three + three-csg-ts + real
 * kernels (no mocks):
 *
 *   - a failing wall cut does NOT leave the wall displayed as cut:
 *     total failure returns the original uncut mesh with the failure
 *     attached, and the FAILED-TO-CUT record lands in K1's registry
 *     (toast-on-transition dedupe: the second record call reports
 *     "already recorded");
 *   - each of the three engines' results passes through the same
 *     post-condition (same verdict shape for the same invalid input —
 *     an open operand is never a silent `ok` on any engine);
 *   - a successful cut still produces the cut mesh (volume-exact,
 *     placement preserved, manifold), via the general-kernel fallback
 *     when three-csg-ts gates refused (measured: every real door cut);
 *   - a position-only reveal cutter — which makes `CSG.fromMesh`
 *     throw, so reveals NEVER cut before this change — now cuts via
 *     the fallback;
 *   - a three-csg-ts result that removed no material is a failed cut,
 *     not a success (never silently keep an uncut solid);
 *   - valid geometry still commits unchanged through the unified
 *     helper, and the K1 calibrations (convex quarantine-on-refusal,
 *     general degenerate-input quarantine, touching-face union clean,
 *     junction-only quarantine class) are preserved by the refactor.
 *
 * Compiles the kernel + adapter from source with tsc (same pattern as
 * tests/validation-gate.test.cjs). The compiled adapter requires
 * `three` / `three-csg-ts` at runtime, so the temp dir gets a
 * `node_modules` symlink to the repo's (test-only resolution shim).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-boolean-postcondition-"));
execFileSync("npx", [
  "tsc", "--rootDir", "src", "--outDir", out,
  "--module", "commonjs", "--moduleResolution", "node",
  "--target", "ES2022", "--skipLibCheck", "--noCheck",
  "src/modules/solid-kernel/validation-gate.ts",
  "src/modules/solid-kernel/general-csg.ts",
  "src/modules/solid-kernel/csg.ts",
  "src/modules/solid-kernel/boolean-postcondition.ts",
  "src/modules/solid-kernel/three-boolean.ts",
], { cwd: root, stdio: "pipe" });
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "dir");

const THREE = require(path.join(root, "node_modules", "three"));
const { CSG } = require(path.join(root, "node_modules", "three-csg-ts"));
const gateMod = require(path.join(out, "modules/solid-kernel/validation-gate.js"));
const kernel = require(path.join(out, "modules/solid-kernel/general-csg.js"));
const convex = require(path.join(out, "modules/solid-kernel/csg.js"));
const post = require(path.join(out, "modules/solid-kernel/boolean-postcondition.js"));
const threeBool = require(path.join(out, "modules/solid-kernel/three-boolean.js"));
const { meshVolume } = require(path.join(out, "modules/adaptive/index.js"));

const { gateSolid, threeGeometryToIndexedMesh, listQuarantinedSolids, clearQuarantinedSolids, ValidationGateError } = gateMod;
const { generalBoolean } = kernel;
const { booleanOp } = convex;
const { applyBooleanPostcondition, postconditionThreeCsgResult, recordBooleanCutFailure, MIN_REMOVED_VOLUME_M3 } = post;
const { subtractThreeMesh } = threeBool;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
// Volume tolerance: the general kernel's plane arrangement introduces
// ~1e-8 float error on split-geometry volumes at this scale (measured:
// 2.0220000223 vs 2.022), so kernel-output volumes compare at 1e-6 —
// still far below any real opening's removed volume.
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── fixtures ─────────────────────────────────────────────────────────────

/** Outward-wound box at (x0,y0,z0) with edge `s`, 12 triangles, volume s^3. */
function box(x0 = 0, y0 = 0, z0 = 0, s = 1) {
  const v = (x, y, z) => ({ x: x * s + x0, y: y * s + y0, z: z * s + z0 });
  return {
    vertices: [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0), v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
    faces: [
      [0, 2, 1], [0, 3, 2], // bottom -z
      [4, 5, 6], [4, 6, 7], // top +z
      [0, 1, 5], [0, 5, 4], // front -y
      [3, 7, 6], [3, 6, 2], // back +y
      [0, 4, 7], [0, 7, 3], // left -x
      [1, 2, 6], [1, 6, 5], // right +x
    ],
  };
}

/**
 * Straight wall exactly as `buildWallWithOpenings` builds it (authoring.ts):
 * 4 m long, 0.2 m thick, 3 m high, start [0,0] end [4,0], elevation 0 —
 * ExtrudeGeometry shape, basis quaternion, position. Uncut volume 2.4 m³.
 */
function buildWallMesh() {
  const T = 0.2, H = 3;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(4, 0);
  shape.lineTo(4, 0.2);
  shape.lineTo(0, 0.2);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false });
  const mat = new THREE.MeshLambertMaterial({ color: 0xd9d4c7 });
  const mesh = new THREE.Mesh(geo, mat);
  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 1, 0),
  );
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.set(0, 0, 0.1);
  mesh.updateMatrixWorld(true);
  return { mesh, mat };
}

/** Door hole exactly as `buildWallWithOpenings` builds it: 0.9 m wide, 2.1 m high, sill 0, offset 2 m. */
function buildDoorHole(wallMesh) {
  const holeGeo = new THREE.BoxGeometry(0.9, 0.2 + 0.2, 2.1);
  const holeMesh = new THREE.Mesh(holeGeo, new THREE.MeshLambertMaterial({ visible: false }));
  holeMesh.position.set(2, 0 + 0 + 2.1 / 2, 0);
  holeMesh.quaternion.copy(wallMesh.quaternion);
  holeMesh.updateMatrixWorld(true);
  return holeMesh;
}

function toIndexed(mesh) {
  mesh.updateMatrixWorld(true);
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const idx = geo.getIndex();
  return threeGeometryToIndexedMesh(pos.array, idx ? idx.array : null, mesh.matrixWorld.elements);
}

/**
 * THREE mesh from an IndexedMesh whose positions are already in WORLD
 * space: identity placement, so the mesh's world geometry IS the given
 * positions (no double transform).
 */
function indexedToMesh(indexed, mat) {
  const positions = new Float32Array(indexed.faces.length * 9);
  let o = 0;
  for (const [a, b, c] of indexed.faces) {
    for (const vi of [a, b, c]) {
      const v = indexed.vertices[vi];
      positions[o++] = v.x; positions[o++] = v.y; positions[o++] = v.z;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.updateMatrixWorld(true);
  return mesh;
}

// ── A. unified post-condition: same invalid input, same verdict shape ───

clearQuarantinedSolids();
// A1. Valid geometry commits unchanged through the unified helper.
{
  const r = applyBooleanPostcondition(box(), "box", { engine: "general-kernel", onRefused: "throw" });
  ok(r.verdict === "ok", "valid box gates ok through the unified helper");
  ok(r.engine === "general-kernel", "outcome carries its engine tag");
  ok(approx(r.volume, 1), "valid box volume exact through the helper");
  ok(JSON.stringify(r.mesh) === JSON.stringify(box()), "valid box mesh identical (welded input unchanged)");
  ok(r.diagnostics.length === 0, "valid box has no diagnostics");
  ok(MIN_REMOVED_VOLUME_M3 === 1e-9, "removed-volume epsilon is 1e-9 m3");
}

// A2. Open operand is never a silent `ok` on ANY engine.
{
  const open = box(); open.faces = open.faces.slice(2); // open shell
  // Convex: quarantine-on-refusal (K1 policy) — returns, but recorded, never ok.
  clearQuarantinedSolids();
  const m = booleanOp("subtract", open, box(0.5, 0.5, -0.5, 1));
  ok(m !== null && m.faces.length > 0, "convex subtract on open operand returns a mesh (quarantine policy)");
  const rec = listQuarantinedSolids().find((q) => q.owner === "boolean:subtract");
  ok(rec !== undefined, "convex open-operand result is recorded in the quarantine registry");
  ok(rec.disposition === "quarantined", "convex open-operand record is quarantined, not silently admitted");
  // General: hard refusal — throws ValidationGateError.
  clearQuarantinedSolids();
  assert.throws(
    () => generalBoolean("subtract", open, box(0.5, 0.5, -0.5, 1)),
    (e) => e instanceof ValidationGateError && e.code === "validation-gate-refused",
    "general subtract on open operand throws ValidationGateError",
  );
  n++;
  // three-csg-ts: total failure — status failed, never a cut mesh.
  clearQuarantinedSolids();
  const { mesh: wall, mat } = buildWallMesh();
  const openIdx = toIndexed(wall);
  openIdx.faces = openIdx.faces.slice(2); // open the wall the same way
  const openWall = indexedToMesh(openIdx, mat);
  const hole = buildDoorHole(wall);
  const out = subtractThreeMesh(openWall, hole, mat, "wall:test door host-1");
  ok(out.cut === false, "three-csg-ts leg on an open wall does not report a cut");
  ok(out.mesh === openWall, "total failure returns the ORIGINAL uncut mesh object");
  ok(out.failure !== undefined && out.failure.diagnostics.length > 0, "total failure carries diagnostics");
  ok(out.failure.reason.includes("general-kernel"), "total-failure reason names the fallback engine");
}

// ── B. failing wall cut: never displayed as cut, failure recorded ────────

{
  clearQuarantinedSolids();
  const { mesh: wall, mat } = buildWallMesh();
  const openIdx = toIndexed(wall);
  openIdx.faces = openIdx.faces.slice(2);
  const openWall = indexedToMesh(openIdx, mat);
  const hole = buildDoorHole(wall);
  const volBefore = meshVolume(toIndexed(openWall));
  const out = subtractThreeMesh(openWall, hole, mat, "wall:wall-1 door host-1");
  ok(out.cut === false, "B: failing wall cut reports cut:false");
  ok(out.mesh === openWall, "B: failing wall cut returns the original mesh (wall stays, uncut)");
  ok(approx(meshVolume(toIndexed(out.mesh)), volBefore, 1e-9), "B: returned mesh volume is the UNCUT volume");
  ok(out.mesh.userData.cutFailed !== true, "B: adapter itself does not mark the mesh (caller marks it)");
  // The FAILED-TO-CUT record (authoring helper's contract, exercised here directly).
  const isNew = recordBooleanCutFailure({
    elementId: "wall-1",
    label: "door host-1",
    diagnostics: out.failure.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    volumeBefore: out.failure.volumeBefore,
  });
  ok(isNew === true, "B: first failure record is new (toast fires)");
  const isNewAgain = recordBooleanCutFailure({
    elementId: "wall-1",
    label: "door host-1",
    diagnostics: out.failure.diagnostics.map((d) => ({ code: d.code, message: d.message })),
    volumeBefore: out.failure.volumeBefore,
  });
  ok(isNewAgain === false, "B: second record for the same opening reports already-recorded (no repeat toast)");
  const records = listQuarantinedSolids().filter((q) => q.id === "wall-1:cut:door host-1");
  ok(records.length === 1, "B: exactly one FAILED-TO-CUT record for the opening (replace, not grow)");
  ok(records[0].owner === "wall-1", "B: record owner is the wall element");
  ok(records[0].source === "wall-cut", "B: record source names the wall-cut path");
  ok(records[0].disposition === "quarantined" && records[0].admitted === true, "B: wall stays admitted but flagged quarantined");
  ok(records[0].occurrences === 2, "B: re-record bumps occurrences instead of growing the registry");
  ok(records[0].diagnostics.length > 0, "B: record carries the failure diagnostics");
  // K1's rebuild gate clears by ELEMENT id — the cut record must survive it.
  const { clearQuarantinedSolid } = gateMod;
  ok(clearQuarantinedSolid("wall-1") === false, "B: clearing by element id does NOT erase the cut record (distinct id)");
  ok(listQuarantinedSolids().some((q) => q.id === "wall-1:cut:door host-1"), "B: cut record survives the rebuild-gate clear");
}

// ── C. successful cut still produces the cut mesh ────────────────────────

{
  clearQuarantinedSolids();
  const { mesh: wall, mat } = buildWallMesh();
  const hole = buildDoorHole(wall);
  const out = subtractThreeMesh(wall, hole, mat, "wall:test door host-1");
  ok(out.cut === true, "C: door cut reports cut:true");
  ok(out.fallbackUsed === true, "C: door cut used the general-kernel fallback (three-csg-ts gates refused — measured)");
  ok(out.engine === "general-kernel", "C: outcome names the engine that produced the mesh");
  ok(out.mesh !== wall, "C: cut returns a NEW mesh, not the input");
  const vol = meshVolume(toIndexed(out.mesh));
  ok(approx(vol, 2.022), `C: cut volume is exactly 2.022 m3 (got ${vol})`);
  ok(out.mesh.position.equals(wall.position), "C: cut mesh keeps the wall position");
  ok(out.mesh.quaternion.angleTo(wall.quaternion) < 1e-6, "C: cut mesh keeps the wall orientation");
  ok(out.mesh.geometry.getAttribute("normal") !== undefined, "C: cut mesh has normals for rendering");
  const gated = gateSolid(toIndexed(out.mesh), "wall:test", { source: "k4-test" });
  ok(gated.verdict === "ok", "C: cut mesh gates ok when converted back");
  // Primary-leg acceptance: a three-csg-ts result that gates ok and
  // removes material is kept as-is (no fallback round-trip). The
  // general-kernel result stands in as such a result — the decision
  // logic, not the engine, is under test here.
  const wallIdx = toIndexed(wall);
  const holeIdx = toIndexed(hole);
  const goodResult = generalBoolean("subtract", wallIdx, holeIdx);
  const leg1 = postconditionThreeCsgResult({
    wallBefore: wallIdx, cutter: holeIdx, result: goodResult, owner: "wall:test door host-1",
  });
  ok(leg1.status === "cut", "C: valid three-csg-ts result counts as a cut");
  ok(leg1.engine === "three-csg-ts" && leg1.fallbackUsed === false, "C: valid primary result is kept, no fallback");
  ok(approx(leg1.volume, 2.022), "C: primary-leg cut volume is exact");
}

// ── D. reveal cutter (position-only): three-csg-ts throws, fallback cuts ─

{
  clearQuarantinedSolids();
  const { mesh: wall, mat } = buildWallMesh();
  const hole = buildDoorHole(wall);
  // Position-only cutter geometry, exactly as authoring.ts builds a reveal cutter.
  const hp = hole.geometry.getAttribute("position").array;
  const hidx = hole.geometry.getIndex().array;
  const seq = [];
  for (let i = 0; i < hidx.length; i++) {
    const vi = hidx[i] * 3;
    seq.push(hp[vi], hp[vi + 1], hp[vi + 2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seq), 3));
  const cutter = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ visible: false }));
  cutter.position.copy(hole.position);
  cutter.quaternion.copy(hole.quaternion);
  cutter.updateMatrixWorld(true);
  assert.throws(
    () => CSG.fromMesh(cutter),
    (e) => e instanceof TypeError && /reading 'array'/.test(e.message),
    "D: three-csg-ts throws on a position-only cutter (missing normal attribute)",
  );
  n++;
  const out = subtractThreeMesh(wall, cutter, mat, "wall:test reveal profile-1 at 0.00 m");
  ok(out.cut === true, "D: reveal cut succeeds via the general-kernel fallback");
  ok(out.fallbackUsed === true, "D: reveal cut used the fallback");
  ok(approx(meshVolume(toIndexed(out.mesh)), 2.022), "D: reveal-cut volume is exact");
}

// ── E. no silent uncut: a result that removed no material is a failure ──

{
  clearQuarantinedSolids();
  const { mesh: wall, mat } = buildWallMesh();
  const hole = buildDoorHole(wall);
  const wallIdx = toIndexed(wall);
  const holeIdx = toIndexed(hole);
  // three-csg-ts "succeeds" but returns the wall unchanged: the uncut
  // result is NOT accepted as a success — the fallback is tried, and
  // because the cutter genuinely overlaps, the fallback rescues the cut.
  const uncut = postconditionThreeCsgResult({
    wallBefore: wallIdx, cutter: holeIdx, result: wallIdx, owner: "wall:test door host-1",
  });
  ok(uncut.status === "cut", "E: an uncut primary result falls back instead of counting as a cut");
  ok(uncut.fallbackUsed === true, "E: uncut primary result triggers the fallback");
  ok(approx(uncut.volume, 2.022), "E: rescued cut volume is exact");
  // The same uncut result with a cutter that misses the wall: both
  // legs remove nothing, so the outcome is failed, never a silent uncut.
  const uncutMiss = postconditionThreeCsgResult({
    wallBefore: wallIdx,
    cutter: toIndexed((() => { const f = buildDoorHole(wall); f.position.set(100, 1.05, 0); f.updateMatrixWorld(true); return f; })()),
    result: wallIdx,
    owner: "wall:test door host-1",
  });
  ok(uncutMiss.status === "failed", "E: an uncut result with a missing cutter is a failed cut");
  ok(uncutMiss.diagnostics.some((d) => /uncut/.test(d.message)), "E: failure diagnostic names the uncut solid");
  // Cutter that misses the wall entirely: fallback also removes nothing.
  const farHole = buildDoorHole(wall);
  farHole.position.set(100, 1.05, 0);
  farHole.updateMatrixWorld(true);
  const missed = postconditionThreeCsgResult({
    wallBefore: wallIdx, cutter: toIndexed(farHole), result: null,
    threeCsgError: "simulated three-csg-ts throw", owner: "wall:test door host-1",
  });
  ok(missed.status === "failed", "E: a missing cutter is a failed cut on both engines");
  ok(missed.lastEngine === "general-kernel", "E: total failure names the last engine attempted");
}

// ── F. K1 calibrations preserved by the refactor ─────────────────────────

{
  // Convex overlapping subtract (K1's interior cutter): exact volume + quarantine record.
  clearQuarantinedSolids();
  const m = booleanOp("subtract", box(), box(0.25, 0.25, 0.25, 0.25));
  ok(approx(meshVolume(m), 0.984375), "F: convex overlapping subtract volume exact (0.984375)");
  ok(listQuarantinedSolids().some((q) => q.owner === "boolean:subtract"), "F: convex subtract still records its quarantine");
  // General touching-face union: clean, exact, no record.
  clearQuarantinedSolids();
  const u = generalBoolean("union", box(0, 0, 0, 1), box(1, 0, 0, 1));
  ok(approx(meshVolume(u), 2) && u.faces.length === 20, "F: general touching-face union is clean (20 faces, volume 2)");
  ok(listQuarantinedSolids().length === 0, "F: clean general union records nothing");
  // General union with a degenerate input face: PE-10 contract — skip + record + return.
  clearQuarantinedSolids();
  const deg = box(); deg.faces = [...deg.faces, [0, 0, 0]];
  const d = generalBoolean("union", deg, box(0.5, 0, 0, 1));
  ok(approx(meshVolume(d), 1.5), "F: degenerate-input union volume exact (1.5)");
  ok(listQuarantinedSolids().some((q) => q.owner === "boolean:union"), "F: degenerate-input union still quarantines, not refuses");
  // Junction-only quarantine class under the unified helper (not whitelisted, not refused).
  clearQuarantinedSolids();
  const a = box(0, 0, 0, 1), b = box(1, 0, 0, 1);
  const soup = {
    vertices: [...a.vertices, ...b.vertices],
    faces: [...a.faces, ...b.faces.map(([x, y, z]) => [x + 8, y + 8, z + 8])],
  };
  const r = applyBooleanPostcondition(soup, "soup", { engine: "general-kernel", onRefused: "throw" });
  ok(r.verdict === "quarantined", "F: touching-contact soup still quarantines under the unified helper");
  ok(approx(r.volume, 2), "F: quarantined soup volume stays exact");
  ok(listQuarantinedSolids().some((q) => q.id === "soup"), "F: quarantined soup is recorded");
  // General union with an open operand still throws (K1 pin, via the new helper).
  clearQuarantinedSolids();
  const open = box(); open.faces = open.faces.slice(2);
  assert.throws(
    () => generalBoolean("union", open, box(0.5, 0, 0, 1)),
    (e) => e instanceof ValidationGateError,
    "F: general union with an open operand still throws ValidationGateError",
  );
  n++;
}

console.log(`boolean-postcondition: ${n} assertions passed`);
