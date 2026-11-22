/**
 * K2 — validator holes.
 *
 * Two holes in src/modules/solid-kernel/validate.ts, fixed here:
 *
 *   (1) The volume check ran only `if (out.length === 0)`, so a mesh
 *       that already had other diagnostics never got its volume
 *       checked — an inverted / zero / non-finite volume hid behind
 *       an earlier diagnostic.
 *   (2) Self-intersection was skipped for open profiles:
 *       validateProfileDiagnostics only called validateProfile() when
 *       no diagnostic existed yet, and validateProfile() throws
 *       open-profile before it ever reaches its self-intersection
 *       check — so a crossing open profile passed validation.
 *
 * The fixes handle WHY each gate was there, not just the condition:
 *
 *   (1) meshVolume throws on a face that references a missing vertex
 *       (undefined vertex), so the volume check is skipped only when
 *       the shell is structurally unusable — that case is already
 *       reported as invalid-shell. Degenerate faces and zero-length
 *       edges contribute zero to the divergence sum, so the volume
 *       stays computable alongside them.
 *   (2) The closed-ring self-intersection test treats first/last as
 *       joined by a real segment, so it cannot be applied to an open
 *       profile: the imaginary closing segment can properly cross a
 *       middle segment (false positive — pinned below). Open profiles
 *       get their own test, selfIntersectsOpen() in forms.ts, over
 *       the n-1 real segments only, with no wrap-around.
 *
 * Compiles the kernel from source with tsc (same pattern as
 * tests/validation-gate.test.cjs), so the tests run the real
 * validate.ts / forms.ts / validation-gate.ts.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-validator-holes-"));
execFileSync("npx", [
  "tsc", "--rootDir", "src", "--outDir", out,
  "--module", "commonjs", "--moduleResolution", "node",
  "--target", "ES2022", "--skipLibCheck", "--noCheck",
  "src/modules/solid-kernel/validate.ts",
  "src/modules/solid-kernel/forms.ts",
  "src/modules/solid-kernel/validation-gate.ts",
  "src/modules/solid-kernel/general-csg.ts",
  "src/modules/solid-kernel/csg.ts",
  "src/modules/solids/solid-core.ts",
], { cwd: root, stdio: "pipe" });
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');

const validate = require(path.join(out, "modules/solid-kernel/validate.js"));
const forms = require(path.join(out, "modules/solid-kernel/forms.js"));
const gateMod = require(path.join(out, "modules/solid-kernel/validation-gate.js"));
const { validateMeshDiagnostics, validateProfileDiagnostics, commitEligible } = validate;
const { selfIntersects, selfIntersectsOpen } = forms;
const { gateSolid, clearQuarantinedSolids } = gateMod;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const hasCode = (diags, code) => diags.some((d) => d.code === code);

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

/** Every face wound the other way: same shape, volume -s^3. */
function flippedBox() {
  const m = box();
  return { vertices: m.vertices, faces: m.faces.map(([a, b, c]) => [a, c, b]) };
}

/** Append a degenerate face (repeats a vertex) to a mesh. */
function withDegenerateFace(m) {
  const vertices = [...m.vertices, { ...m.vertices[1] }];
  const faces = [...m.faces, [vertices.length - 1, vertices.length - 1, 1]];
  return { vertices, faces };
}

// ── (1) volume check runs alongside other diagnostics ───────────────────

{
  // Control: a valid box reports nothing; a flipped box reports only
  // the inverted volume (warning, does not block commit).
  ok(validateMeshDiagnostics(box(), "box").length === 0, "valid box: no diagnostics");
  const d = validateMeshDiagnostics(flippedBox(), "flipped");
  ok(hasCode(d, "inverted-volume"), "flipped box alone: inverted volume reported");
  ok(commitEligible(d), "inverted volume is a warning and does not block commit");
}

{
  // Hole 1a: flipped winding AND a degenerate face — before the fix
  // only the degenerate face was reported.
  const d = validateMeshDiagnostics(withDegenerateFace(flippedBox()), "flipped-degenerate");
  ok(hasCode(d, "degenerate-face"), "flipped + degenerate: degenerate face reported");
  ok(hasCode(d, "inverted-volume"), "flipped + degenerate: inverted volume ALSO reported");
  ok(!commitEligible(d), "degenerate face (error) blocks commit");
}

{
  // Hole 1b: zero volume (flat mesh) alongside another diagnostic.
  const flat = box();
  for (const v of flat.vertices) v.z = 0;
  const d = validateMeshDiagnostics(withDegenerateFace(flat), "flat-degenerate");
  ok(hasCode(d, "degenerate-face"), "flat + degenerate: degenerate face reported");
  ok(hasCode(d, "inverted-volume"), "flat + degenerate: zero volume ALSO reported as inverted-volume");
}

{
  // Hole 1c: non-finite volume alongside another diagnostic.
  const nan = box();
  nan.vertices[0] = { x: NaN, y: 0, z: 0 };
  const d = validateMeshDiagnostics(withDegenerateFace(nan), "nan-degenerate");
  ok(hasCode(d, "degenerate-face"), "NaN vertex + degenerate: degenerate face reported");
  ok(hasCode(d, "invalid-boolean"), "NaN vertex + degenerate: non-finite volume ALSO reported");
  ok(!commitEligible(d), "non-finite volume (error) blocks commit");
}

{
  // Guard rationale: a face referencing a missing vertex must not
  // throw (meshVolume would throw on the undefined vertex) and must
  // not gain a spurious volume diagnostic — the volume is undefined
  // there, and the missing vertex is already reported as invalid-shell.
  const missing = box();
  missing.faces.push([0, 1, 99]);
  let d;
  assert.doesNotThrow(() => { d = validateMeshDiagnostics(missing, "missing"); });
  ok(hasCode(d, "invalid-shell"), "missing vertex: invalid-shell reported");
  ok(!hasCode(d, "invalid-boolean") && !hasCode(d, "inverted-volume"),
    "missing vertex: no volume diagnostic is synthesised for an uncomputable volume");
}

// ── (2) self-intersection checked for open profiles ─────────────────────

{
  // Hole 2a: an open profile that crosses itself. Before the fix only
  // the open-profile diagnostic was reported.
  const openBowtie = [{ u: 0, v: 0 }, { u: 2, v: 2 }, { u: 2, v: 0 }, { u: 0, v: 2 }];
  ok(selfIntersectsOpen(openBowtie), "selfIntersectsOpen: open bowtie crosses itself");
  const d = validateProfileDiagnostics(openBowtie, "open-bowtie");
  ok(hasCode(d, "open-profile"), "open bowtie: open-profile reported");
  ok(hasCode(d, "self-intersection"), "open bowtie: self-intersection ALSO reported");
  ok(!commitEligible(d), "self-intersecting open profile blocks commit");
}

{
  // Hole 2b: a valid open profile whose endpoints near-touch must NOT
  // be falsely flagged. Endpoints differ by ~1.4e-6 m — open (tolerance
  // is 1e-9 m) but far from any crossing: the last segment runs from
  // (0,1) to (1e-6,1e-6) and never reaches the y=0 first segment.
  const almostClosed = [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }, { u: 1e-6, v: 1e-6 }];
  ok(!selfIntersectsOpen(almostClosed), "selfIntersectsOpen: almost-closed square does not cross itself");
  const d = validateProfileDiagnostics(almostClosed, "almost-closed");
  ok(hasCode(d, "open-profile"), "almost-closed square: open-profile reported");
  ok(!hasCode(d, "self-intersection"), "almost-closed square: NO false self-intersection");
}

{
  // Endpoint handling: the closed-ring test MUST NOT be applied to an
  // open profile. This open polyline is simple — its only "crossing"
  // is the imaginary closing segment (2,2)->(0,0) properly crossing
  // the middle segment (2,1)->(0,2) at (4/3, 4/3) — so the closed-ring
  // test false-positives while the open test correctly says clean.
  const zigzag = [{ u: 0, v: 0 }, { u: 2, v: 1 }, { u: 0, v: 2 }, { u: 2, v: 2 }];
  ok(selfIntersects(zigzag), "closed-ring test false-positives on this open polyline (imaginary closing segment)");
  ok(!selfIntersectsOpen(zigzag), "open test correctly says the same polyline is clean");
  const d = validateProfileDiagnostics(zigzag, "zigzag");
  ok(hasCode(d, "open-profile"), "zigzag: open-profile reported");
  ok(!hasCode(d, "self-intersection"), "zigzag: NO false self-intersection from the closing segment");
}

{
  // Control: a closed bowtie is still caught, with no open-profile
  // diagnostic (existing behaviour, unchanged by the fix).
  const bowtie = [{ u: 0, v: 0 }, { u: 1, v: 1 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 0, v: 0 }];
  const d = validateProfileDiagnostics(bowtie, "bowtie");
  ok(hasCode(d, "self-intersection"), "closed bowtie: self-intersection reported");
  ok(!hasCode(d, "open-profile"), "closed bowtie: no open-profile diagnostic");
}

// ── the fixes flow into the K1 gate ──────────────────────────────────────

clearQuarantinedSolids();
{
  // Flipped box missing one face: boundary edges (refused) AND an
  // inverted volume — the gate must surface the volume diagnostic,
  // not just the manifold errors.
  const m = flippedBox();
  const broken = { vertices: m.vertices, faces: m.faces.slice(0, m.faces.length - 1) };
  const r = gateSolid(broken, "flipped-broken", { source: "test" });
  ok(hasCode(r.diagnostics, "non-manifold-edge"), "gate: boundary edges reported");
  ok(hasCode(r.diagnostics, "inverted-volume"), "gate: inverted volume flows into the gate alongside manifold errors");
  ok(r.verdict === "refused", "gate: flipped open shell is refused");
}

{
  // The gate must not double-report a non-finite volume: validate.ts
  // owns the diagnostic now, the gate only records the hard refusal.
  const nan = box();
  nan.vertices[0] = { x: NaN, y: 0, z: 0 };
  const r = gateSolid(withDegenerateFace(nan), "nan-gate", { source: "test" });
  ok(r.diagnostics.filter((d) => d.code === "invalid-boolean").length === 1,
    "gate: non-finite volume is reported exactly once (no validate.ts + gate duplicate)");
  ok(r.hardRefusal, "gate: non-finite volume is still a hard refusal");
  ok(r.verdict === "refused", "gate: non-finite volume is refused");
}

console.log(`validator-holes: ${n} assertions passed`);
