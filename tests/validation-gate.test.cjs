/**
 * K1 — validation as a gate.
 *
 * The gate (src/modules/solid-kernel/validation-gate.ts) welds then
 * validates every Boolean result + authoring commit / import, and
 * refuses or quarantines on errors. These tests pin the verdicts:
 *
 *   - valid geometry commits / imports unchanged (ok verdict, welded
 *     mesh identical to the input when already welded);
 *   - an invalid GENERAL-kernel Boolean result is refused
 *     (ValidationGateError, never returned as a solid), while the
 *     CONVEX kernel quarantines-on-refusal: its splitter is
 *     seam-inconsistent on every overlapping operation (measured
 *     12–26 non-manifold edges, volume exact), and hard refusal there
 *     would stop all void cutting — so the defect is recorded with
 *     diagnostics instead of silently producing non-manifold solids;
 *   - the documented touching-contact class (PE-09: two solids touching
 *     at a face with zero overlap) is QUARANTINED, not refused — volume
 *     stays exact and the record is visible in the registry;
 *   - an invalid import is refused admission (skipped + recorded +
 *     warned) or quarantined-admitted, never silently admitted;
 *   - the THREE/buffer-geometry converter round-trips indexed and
 *     non-indexed geometry and rejects malformed input.
 *
 * Compiles the kernel + solid-core from source with tsc (same pattern
 * as tests/solid-kernel-weld.test.cjs), so the tests run the real gate
 * including the in-kernel post-conditions in booleanOp/generalBoolean.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-validation-gate-"));
execFileSync("npx", [
  "tsc", "--rootDir", "src", "--outDir", out,
  "--module", "commonjs", "--moduleResolution", "node",
  "--target", "ES2022", "--skipLibCheck", "--noCheck",
  "src/modules/solid-kernel/validation-gate.ts",
  "src/modules/solid-kernel/general-csg.ts",
  "src/modules/solid-kernel/csg.ts",
  "src/modules/solids/solid-core.ts",
], { cwd: root, stdio: "pipe" });
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');

const gateMod = require(path.join(out, "modules/solid-kernel/validation-gate.js"));
const kernel = require(path.join(out, "modules/solid-kernel/general-csg.js"));
const convex = require(path.join(out, "modules/solid-kernel/csg.js"));
const solids = require(path.join(out, "modules/solids/solid-core.js"));
const { meshVolume } = require(path.join(out, "modules/adaptive/index.js"));

const {
  gateSolid, assertCommitEligible, gateImportedSolid,
  threeGeometryToIndexedMesh, summarizeGateDiagnostics,
  listQuarantinedSolids, isQuarantined, clearQuarantinedSolids,
  recordQuarantinedSolid, ValidationGateError,
} = gateMod;
const { generalBoolean } = kernel;
const { booleanOp } = convex;
const { occtToParts } = solids;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

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

/** Same box as flat non-indexed positions (THREE ExtrudeGeometry / twin shape). */
function boxPositions(x0 = 0, y0 = 0, z0 = 0) {
  const b = box(x0, y0, z0);
  const pos = [];
  for (const [a, c, d] of b.faces) {
    for (const i of [a, c, d]) pos.push(b.vertices[i].x, b.vertices[i].y, b.vertices[i].z);
  }
  return pos;
}

/** OcctResult-shaped mesh for occtToParts. */
function occtMesh(positions, indices, name = "Shape 1") {
  return {
    success: true,
    meshes: [{
      name,
      attributes: { position: { array: positions } },
      index: { array: indices },
    }],
  };
}

function occtBoxIndices() {
  const idx = [];
  for (let t = 0; t < 12; t++) idx.push(t * 3, t * 3 + 1, t * 3 + 2);
  return idx;
}

// ── (a) the gate itself ──────────────────────────────────────────────────

clearQuarantinedSolids();
{
  const r = gateSolid(box(), "unit-box", { source: "test" });
  ok(r.verdict === "ok", "valid box gates ok");
  ok(Math.abs(r.volume - 1) < 1e-9, "valid box volume is 1");
  ok(r.mesh.vertices.length === 8 && r.mesh.faces.length === 12, "valid welded box is unchanged");
  ok(listQuarantinedSolids().length === 0, "ok verdict records nothing");
}
{
  // Open shell: top face removed -> boundary edges used exactly once.
  const open = box();
  open.faces = open.faces.slice(0, 10);
  const r = gateSolid(open, "open-box", { source: "test" });
  ok(r.verdict === "refused", "open shell is refused");
  ok(r.hardRefusal === false, "open shell is not the unbuildable subset");
  ok(r.errors.some((d) => d.code === "non-manifold-edge"), "open shell reports non-manifold edges");
  ok(listQuarantinedSolids().length === 0, "refused verdict is not auto-recorded by gateSolid");
}
{
  const r = gateSolid({ vertices: [], faces: [] }, "empty", { source: "test" });
  ok(r.verdict === "refused" && r.hardRefusal === true, "empty mesh is a hard refusal");
}
{
  const nan = box();
  nan.vertices[0] = { x: NaN, y: 0, z: 0 };
  const r = gateSolid(nan, "nan-box", { source: "test" });
  ok(r.verdict === "refused" && r.hardRefusal === true, "non-finite coordinates are a hard refusal");
}
{
  // Touching-contact class: two boxes sharing exactly one face, as one
  // soup. After welding the shared face's edges are used 4x; volume is
  // exact (2). This must QUARANTINE, not refuse (PE-09 calibration).
  clearQuarantinedSolids();
  const a = box(0, 0, 0);
  const b = box(1, 0, 0);
  const soup = {
    vertices: [...a.vertices, ...b.vertices],
    faces: [...a.faces, ...b.faces.map(([x, y, z]) => [x + 8, y + 8, z + 8])],
  };
  const r = gateSolid(soup, "touching-pair", { source: "test", id: "touching-pair" });
  ok(r.verdict === "quarantined", "touching-face pair is quarantined, not refused");
  ok(Math.abs(r.volume - 2) < 1e-9, "touching pair volume stays exact (2)");
  ok(isQuarantined("touching-pair"), "quarantined solid is visible in the registry");
  ok(listQuarantinedSolids().length === 1, "exactly one quarantine record");
  ok(listQuarantinedSolids()[0].disposition === "quarantined" && listQuarantinedSolids()[0].admitted === true, "quarantine record admits with diagnostics");
  clearQuarantinedSolids();
  ok(listQuarantinedSolids().length === 0, "registry clears");
  recordQuarantinedSolid({ id: "x", owner: "x", source: "test", disposition: "quarantined", admitted: true, diagnostics: [], volume: 1 });
  recordQuarantinedSolid({ id: "x", owner: "x", source: "test", disposition: "quarantined", admitted: true, diagnostics: [], volume: 2 });
  ok(listQuarantinedSolids().length === 1 && listQuarantinedSolids()[0].volume === 2, "same id+owner replaces instead of growing");
  clearQuarantinedSolids();
}
{
  // assertCommitEligible: throws typed refusal, returns mesh otherwise.
  assert.throws(
    () => assertCommitEligible({ vertices: [], faces: [] }, "empty"),
    (e) => e instanceof ValidationGateError && e.code === "validation-gate-refused" && e.owner === "empty",
    "assertCommitEligible throws ValidationGateError on refused",
  );
  const kept = assertCommitEligible(box(), "unit-box");
  ok(kept.faces.length === 12, "assertCommitEligible returns the welded mesh on ok");
  clearQuarantinedSolids();
  const touching = assertCommitEligible(
    { vertices: [...box().vertices, ...box(1, 0, 0).vertices],
      faces: [...box().faces, ...box(1, 0, 0).faces.map(([x, y, z]) => [x + 8, y + 8, z + 8])] },
    "touching-pair",
    { source: "test", id: "touching-pair" },
  );
  ok(touching.faces.length > 0 && isQuarantined("touching-pair"), "assertCommitEligible returns + records the quarantined class");
  clearQuarantinedSolids();
  ok(/non-manifold-edge/.test(summarizeGateDiagnostics(gateSolid(box(), "b").diagnostics)) === false, "summarize is empty for ok");
}

// ── (b) Boolean results are gated in-kernel ─────────────────────────────

clearQuarantinedSolids();
{
  // Overlapping boxes: union volume 1 + 1 - 0.5 (overlap) = 1.5.
  const u = generalBoolean("union", box(0, 0, 0), box(0.5, 0, 0));
  ok(Math.abs(meshVolume(u) - 1.5) < 1e-9, "general union keeps exact volume 1.5");
  ok(gateSolid(u, "union-result").verdict === "ok", "general union result re-gates ok");
}
{
  // Touching-face union through the public kernel path: must NOT throw
  // (PE-09), volume exact — and, measured here, the general kernel's
  // coplanar pass already gives single-copy skin ownership, so the
  // result gates `ok` with no quarantine record. PE-09 skipped the
  // watertight assertion for touching pairs without proving they fail;
  // the gate proves this leg clean (the quarantine class still fires
  // for producers that keep both skins — see the soup test above).
  clearQuarantinedSolids();
  const u = generalBoolean("union", box(0, 0, 0), box(1, 0, 0));
  ok(Math.abs(meshVolume(u) - 2) < 1e-9, "touching-face union volume stays exact (2)");
  ok(gateSolid(u, "touching-union").verdict === "ok", "touching-face union re-gates ok (single-copy skins)");
  ok(listQuarantinedSolids().length === 0, "touching-face union records nothing");
  clearQuarantinedSolids();
}
{
  // Convex kernel (booleanOp): quarantine-on-refusal, NOT a throw.
  // Measured on the chain base: the convex splitter is seam-inconsistent
  // whenever it splits (12–26 non-manifold edges, volume exact), so hard
  // refusal would stop all void cutting (cutVoids calls subtract per
  // void). A closed-box interior cut returns the volume-exact mesh AND
  // a quarantine record; an open-box cut does the same (the gate cannot
  // distinguish the splitter's T-junctions from a genuinely open shell
  // on this kernel — recorded, never silent).
  clearQuarantinedSolids();
  const cut = booleanOp("subtract", box(0, 0, 0), box(0.25, 0.25, 0.25, 0.25));
  ok(Math.abs(meshVolume(cut) - (1 - 0.25 * 0.25 * 0.25)) < 1e-9, "convex subtract keeps exact volume");
  ok(listQuarantinedSolids().some((q) => q.source === "convex-kernel" && q.disposition === "quarantined"), "convex subtract is recorded as quarantined by the kernel");
  const open = box();
  open.faces = open.faces.slice(0, 10);
  const openCut = booleanOp("subtract", open, box(0.25, 0.25, 0.25, 0.25));
  ok(openCut.faces.length > 0, "convex subtract of an open box still returns a mesh (quarantined, not thrown)");
  clearQuarantinedSolids();
}
{
  // PE-10 contract preserved: a degenerate INPUT triangle is skipped +
  // recorded and the volume-exact result is returned — the gate
  // quarantines (records) instead of refusing, because the degenerate
  // face corrupts the coplanar pass on coplanar operands. Without the
  // degenerate face the same union gates clean (pinned above via the
  // PE-09 property suite); with it, the result is returned, recorded,
  // and volume-exact.
  clearQuarantinedSolids();
  const a = box(0, 0, 0);
  a.faces.push([0, 0, 0]); // degenerate: all three corners the same vertex
  const { mesh, diagnostics } = kernel.generalBooleanDetailed("union", a, box(0.5, 0, 0));
  ok(Math.abs(meshVolume(mesh) - 1.5) < 1e-9, "degenerate-input union keeps exact volume 1.5");
  ok(diagnostics.some((d) => d.code === "degenerate-triangle-skipped"), "degenerate input is recorded");
  ok(listQuarantinedSolids().some((q) => q.source === "general-kernel"), "degenerate-input union is recorded as quarantined by the kernel");
  clearQuarantinedSolids();
}
{
  // General kernel (generalBoolean): hard refusal. An open operand
  // produces an open result, and the gate refuses it — the mesh is
  // NEVER returned as a solid.
  const open = box();
  open.faces = open.faces.slice(0, 10);
  assert.throws(
    () => generalBoolean("union", open, box(3, 0, 0)),
    (e) => e instanceof ValidationGateError && e.code === "validation-gate-refused",
    "generalBoolean refuses an invalid (open-operand) union result instead of returning it",
  );
  assert.throws(
    () => generalBoolean("subtract", open, box(0.25, 0.25, 0.25, 0.25)),
    (e) => e instanceof ValidationGateError && e.code === "validation-gate-refused",
    "generalBoolean refuses an invalid (open-operand) subtract result instead of returning it",
  );
  // ...while the same cut on a closed box succeeds with exact volume.
  const cut = generalBoolean("subtract", box(0, 0, 0), box(0.25, 0.25, 0.25, 0.25));
  ok(Math.abs(meshVolume(cut) - (1 - 0.25 * 0.25 * 0.25)) < 1e-9, "general subtract keeps exact volume");
}
{
  // Disjoint union stays two closed shells in one mesh: ok, not quarantined.
  clearQuarantinedSolids();
  const u = generalBoolean("union", box(0, 0, 0), box(3, 0, 0));
  ok(Math.abs(meshVolume(u) - 2) < 1e-9, "disjoint union volume is 2");
  ok(gateSolid(u, "disjoint").verdict === "ok", "disjoint union re-gates ok");
  ok(listQuarantinedSolids().length === 0, "disjoint union records nothing");
}

// ── (c) import leg: occtToParts admits / refuses / quarantines ──────────

{
  clearQuarantinedSolids();
  const good = occtToParts(occtMesh(boxPositions(), occtBoxIndices()), 1);
  ok(good.parts.length === 1, "valid imported box is admitted");
  ok(!good.warnings.some((w) => /validation/.test(w)), "valid import carries no validation warning");
  ok(listQuarantinedSolids().length === 0, "valid import records nothing");
}
{
  clearQuarantinedSolids();
  // Open box: top face's triangles removed from the flat positions
  // (first 10 of 12 triangles: 90 position numbers, 30 indices).
  const openPos = boxPositions().slice(0, 90); // first 10 triangles only
  const openIdx = occtBoxIndices().slice(0, 30);
  const bad = occtToParts(occtMesh(openPos, openIdx, "Open box"), 1);
  ok(bad.parts.length === 0, "invalid imported solid is refused admission");
  ok(bad.warnings.some((w) => /Open box/.test(w) && /validation/.test(w)), "refused import is named in warnings");
  ok(listQuarantinedSolids().some((q) => q.disposition === "refused" && q.admitted === false), "refused import leaves a registry record as evidence");
  clearQuarantinedSolids();
}
{
  clearQuarantinedSolids();
  // Two touching boxes as ONE imported mesh: quarantined-admitted.
  const soupPos = [...boxPositions(0, 0, 0), ...boxPositions(1, 0, 0)];
  const soupIdx = [...occtBoxIndices(), ...occtBoxIndices().map((i) => i + 36)];
  const res = occtToParts(occtMesh(soupPos, soupIdx, "Touching pair"), 1);
  ok(res.parts.length === 1, "quarantined import is admitted");
  ok(res.warnings.some((w) => /Touching pair/.test(w) && /validity warning/.test(w)), "quarantined import is warned about");
  ok(listQuarantinedSolids().some((q) => q.disposition === "quarantined" && q.admitted === true), "quarantined import is recorded");
  clearQuarantinedSolids();
}
{
  // gateImportedSolid records refused outcomes (admitted: false).
  clearQuarantinedSolids();
  const r = gateImportedSolid({ vertices: [], faces: [] }, "empty-import", "import:test");
  ok(r.verdict === "refused", "gateImportedSolid refuses empty");
  ok(listQuarantinedSolids().some((q) => q.id === "empty-import" && q.disposition === "refused" && q.admitted === false), "gateImportedSolid records the refusal");
  clearQuarantinedSolids();
}

// ── (d) buffer-geometry converter ────────────────────────────────────────

{
  const m = threeGeometryToIndexedMesh(boxPositions(), null);
  ok(m.faces.length === 12 && m.vertices.length === 36, "non-indexed positions convert to 12 faces");
  ok(gateSolid(m, "converted-box").verdict === "ok", "converted box gates ok");
  const indexed = threeGeometryToIndexedMesh(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
    [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5],
  );
  ok(indexed.vertices.length === 8 && indexed.faces.length === 12, "indexed geometry converts");
  ok(gateSolid(indexed, "indexed-box").verdict === "ok", "indexed box gates ok");
  // Column-major translation matrix: x + 5.
  const translated = threeGeometryToIndexedMesh(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
    [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1],
  );
  ok(translated.vertices[1].x === 6 && translated.vertices[0].x === 5, "matrix translation applies (column-major)");
  ok(gateSolid(translated, "translated-box").verdict === "ok", "translated box gates ok");
  assert.throws(
    () => threeGeometryToIndexedMesh([0, 0, NaN, 1, 0, 0, 0, 1, 0], null),
    /non-finite/,
    "non-finite coordinates throw instead of converting",
  );
  assert.throws(
    () => threeGeometryToIndexedMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 9]),
    /missing vertex/,
    "out-of-range index throws instead of converting",
  );
  assert.throws(
    () => threeGeometryToIndexedMesh([0, 0, 0, 1, 0], null),
    /multiple of 3/,
    "malformed positions throw instead of converting",
  );
}

console.log(`validation-gate: ${n} assertions passed`);
