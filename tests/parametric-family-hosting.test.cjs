/**
 * tests/parametric-family-hosting.test.cjs
 *
 * Slice 9 — generic family hosting: face / wall hosting for ARBITRARY
 * families, host-change propagation, audit, and the placement.ts wiring.
 *
 * All values are verified against closed forms to 1e-6 or better; nothing
 * here asserts "no throw" as a substitute for a value. The hosting
 * module is pure (no DOM, no ctx) and is compiled from source with tsc
 * into a temp dir, the same harness pattern as v68-solid-hosting.
 *
 * Run: `node tests/parametric-family-hosting.test.cjs`
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
function nearPoint(p, q, tol = 1e-6) { near(p[0], q[0], tol); near(p[1], q[1], tol); }
function throws(fn, substr) {
  try { fn(); } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(`expected throw containing '${substr}'`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-family-hosting-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/families/family-hosting.ts src/modules/families/placement.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const fh = require(path.join(tmpOut, "modules/families/family-hosting.js"));
const placement = require(path.join(tmpOut, "modules/families/placement.js"));

// ── Fixtures ────────────────────────────────────────────────────────────
// Plan (x, y) + z elevation, matching AuthoredElement and hosting/index.ts.
const wall = {
  id: "wall-1",
  kind: "wall",
  curve: { kind: "line", start: [0, 0], end: [8, 0] },
  baseZ: 0,
  height: 3,
  version: 1,
  thickness: 0.2,
};
const arcWall = {
  id: "wall-arc",
  kind: "wall",
  curve: { kind: "arc", center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI / 2 },
  baseZ: 0,
  height: 3,
  version: 1,
};
const wallFace = {
  id: "face-1",
  kind: "face",
  origin: [0, 0, 0],
  normal: [0, 1, 0],
  uAxis: [1, 0, 0],
  uMin: 0, uMax: 4, vMin: 0, vMax: 3,
  version: 1,
};
const floorFace = {
  id: "face-floor",
  kind: "face",
  // vAxis = uAxis x normal = (0, -1, 0): v runs from the far edge
  // (y = 4) toward the origin edge, so the origin sits at y = 4.
  origin: [0, 4, 0],
  normal: [0, 0, 1],
  uAxis: [1, 0, 0],
  uMin: 0, uMax: 6, vMin: 0, vMax: 4,
  version: 1,
};

function element(id, familyId = "fam-plinth") {
  return {
    id,
    kind: "family",
    familyId,
    familyTypeId: null,
    params: {},
    metadata: {},
  };
}

// ═══ Wall hosting ═══════════════════════════════════════════════════════

t("H1 wall attach: s, elevation and offset from a world point; placement faces the host normal", () => {
  const a = fh.attachFamilyToWall(wall, [2, 0.3, 1.2]);
  assert(a.hostKind === "wall", "hostKind wall");
  near(a.s, 2); near(a.elevation, 1.2); near(a.offset, 0.3); assert(a.hostVersion === 1, "version recorded");
  const p = fh.hostedFamilyPlacement(wall, a);
  nearPoint(p.point, [2, 0.3]);
  near(p.elevation, 1.2);
  near(p.rotation, 90); // wall runs +x; its normal is +y
  nearPoint(p.normal.slice(0, 2), [0, 1]);
  assert(p.normal[2] === 0, "wall normal is horizontal");
});

t("H2 wall attach on an arc host: s is arc length, placement sits on the curve, normal points to the centre", () => {
  const q = 5 / Math.SQRT2;
  const a = fh.attachFamilyToWall(arcWall, [q, q, 1]);
  near(a.s, 5 * Math.PI / 4, 1e-9); // 45° of a radius-5 arc
  near(a.offset, 0);
  near(a.elevation, 1);
  const p = fh.hostedFamilyPlacement(arcWall, a);
  nearPoint(p.point, [q, q]);
  near(p.elevation, 1);
  // CCW arc: the normal left of the tangent points toward the centre.
  near(p.rotation, -135);
});

t("H3 wall attach on a wall running in +y: rotation 180, offset measured from the location line", () => {
  const w = { ...wall, id: "wall-y", curve: { kind: "line", start: [0, 0], end: [0, 6] } };
  const a = fh.attachFamilyToWall(w, [-0.2, 3, 1]);
  // The normal is (-1, 0); the point sits 0.2 along it, not -0.2.
  near(a.s, 3); near(a.offset, 0.2);
  const p = fh.hostedFamilyPlacement(w, a);
  nearPoint(p.point, [-0.2, 3]);
  near(p.rotation, 180);
});

t("H4 wall attach rejects points that do not fit the host", () => {
  throws(() => fh.attachFamilyToWall(wall, [9, 0, 1]), "outside the host");
  throws(() => fh.attachFamilyToWall(wall, [2, 0, 3.5]), "outside the host height");
  throws(() => fh.attachFamilyToWall(wall, [2, 0, -0.1]), "outside the host height");
  throws(() => fh.attachFamilyToWall(arcWall, [5, -5, 1]), "outside the host");
});

t("H5 placement rejects a mismatched host id / kind", () => {
  const a = fh.attachFamilyToWall(wall, [2, 0, 1]);
  throws(() => fh.hostedFamilyPlacement({ ...wall, id: "wall-2" }, a), 'not "wall-2"');
  // Same id but a face host: the kind check (not the id check) must fire.
  throws(() => fh.hostedFamilyPlacement({ ...wallFace, id: "wall-1" }, a), "does not match host kind");
  // A wall attachment relabelled as a face attachment must not silently
  // produce NaN: the face branch rejects its non-finite u / v.
  throws(() => fh.hostedFamilyPlacement({ ...wallFace, id: "wall-1" }, { ...a, hostKind: "face" }), "non-finite u, v or offset");
});

// ═══ Face hosting ═══════════════════════════════════════════════════════

t("H6 vertical face attach: (u, v) + offset; placement faces the normal", () => {
  const a = fh.attachFamilyToFace(wallFace, [2, 0.15, 1.5]);
  assert(a.hostKind === "face", "hostKind face");
  near(a.u, 2); near(a.v, 1.5); near(a.offset, 0.15);
  const p = fh.hostedFamilyPlacement(wallFace, a);
  nearPoint(p.point, [2, 0.15]);
  near(p.elevation, 1.5);
  near(p.rotation, 90); // normal +y
  nearPoint(p.normal.slice(0, 2), [0, 1]);
});

t("H7 horizontal face attach: (u, v) on the floor; placement is oriented along the u-axis", () => {
  const a = fh.attachFamilyToFace(floorFace, [3, 2, 0.2]);
  near(a.u, 3); near(a.v, 2); near(a.offset, 0.2);
  const p = fh.hostedFamilyPlacement(floorFace, a);
  nearPoint(p.point, [3, 2]);
  near(p.elevation, 0.2);
  near(p.rotation, 0); // u-axis +x
  assert(p.normal[2] === 1, "floor normal is +z");
});

t("H8 face attach rejects points outside the face and malformed faces", () => {
  throws(() => fh.attachFamilyToFace(wallFace, [5, 0, 1]), "outside the face");
  throws(() => fh.attachFamilyToFace(wallFace, [2, 0, 4]), "outside the face");
  throws(() => fh.attachFamilyToFace({ ...wallFace, normal: [0, 2, 0] }, [2, 0, 1]), "unit vector");
  throws(() => fh.attachFamilyToFace({ ...wallFace, uAxis: [0, 1, 0] }, [2, 0, 1]), "perpendicular");
});

// ═══ Host-change propagation ════════════════════════════════════════════

t("H9 wall translated: the hosted instance follows its host parameters", () => {
  const a = fh.attachFamilyToWall(wall, [2, 0.3, 1.2]);
  const moved = { ...wall, curve: { kind: "line", start: [0, 2], end: [8, 2] }, version: 2 };
  const r = fh.evaluateHostedFamiliesAfterHostChange(wall, moved, [a]);
  assert(r.kind === "curve-edit", `kind curve-edit, got ${r.kind}`);
  assert(r.invalid.length === 0, "nothing invalid");
  assert(r.moved.length === 1, "one moved");
  nearPoint(r.moved[0].placement.point, [2, 2.3]);
  near(r.moved[0].placement.elevation, 1.2);
  near(r.moved[0].placement.rotation, 90);
  assert(r.version === 2, "new version reported");
});

t("H10 wall shortened: an attachment past the new end is invalid, not silently dropped", () => {
  const a = fh.attachFamilyToWall(wall, [6, 0, 1]);
  const el = element("el-1");
  placement.attachElementToHost(el, wall, [6, 0, 1]);
  nearPoint(el.params.point, [6, 0]);
  const short = { ...wall, curve: { kind: "line", start: [0, 0], end: [4, 0] }, version: 2 };
  const r = fh.evaluateHostedFamiliesAfterHostChange(wall, short, [a]);
  assert(r.kind === "curve-edit", "kind curve-edit");
  assert(r.moved.length === 0, "nothing moved");
  assert(r.invalid.length === 1, "one invalid");
  assert(/outside/.test(r.invalid[0].reason), `reason names the fit: ${r.invalid[0].reason}`);
  const res = placement.rehostElementAfterHostChange(el, wall, short);
  assert(res.outcome === "invalid", `outcome invalid, got ${res.outcome}`);
  nearPoint(el.params.point, [6, 0]); // the element keeps its last placement
  assert(el.hostAttachment.s === 6, "attachment kept for the audit to report");
});

t("H11 wall height reduced: a high attachment is invalid, a low one moves with kind height-change", () => {
  const high = fh.attachFamilyToWall(wall, [2, 0, 2.8]);
  const low = fh.attachFamilyToWall(wall, [4, 0, 1.2]);
  const shorter = { ...wall, height: 2.5, version: 2 };
  const r = fh.evaluateHostedFamiliesAfterHostChange(wall, shorter, [high, low]);
  assert(r.kind === "height-change", `kind height-change, got ${r.kind}`);
  assert(r.invalid.length === 1 && r.invalid[0].attachment === high, "only the high attachment is invalid");
  assert(r.moved.length === 1 && r.moved[0].attachment === low, "the low one moved");
  near(r.moved[0].placement.elevation, 1.2);
});

t("H12 face moved: the hosted instance follows the face", () => {
  const a = fh.attachFamilyToFace(wallFace, [2, 0.15, 1.5]);
  const moved = { ...wallFace, origin: [1, 0, 0], version: 2 };
  const r = fh.evaluateHostedFamiliesAfterHostChange(wallFace, moved, [a]);
  assert(r.kind === "face-change", `kind face-change, got ${r.kind}`);
  assert(r.invalid.length === 0, "nothing invalid");
  nearPoint(r.moved[0].placement.point, [3, 0.15]);
  near(r.moved[0].placement.elevation, 1.5);
});

t("H13 unchanged host: no movement, no invalid", () => {
  const a = fh.attachFamilyToWall(wall, [2, 0, 1]);
  const r = fh.evaluateHostedFamiliesAfterHostChange(wall, { ...wall }, [a]);
  assert(r.kind === "unchanged", `kind unchanged, got ${r.kind}`);
  assert(r.moved.length === 1 && r.invalid.length === 0, "attachment re-derived, not invalidated");
});

t("H14 host deleted: all attachments invalid; rehost detaches the element but keeps it", () => {
  const a = fh.attachFamilyToWall(wall, [2, 0, 1]);
  const r = fh.evaluateHostedFamiliesAfterHostChange(wall, null, [a]);
  assert(r.kind === "host-deleted", "kind host-deleted");
  assert(r.invalid.length === 1 && /deleted/.test(r.invalid[0].reason), "reason names the deletion");
  assert(r.version === 0, "version 0 for a deleted host");
  const el = element("el-1");
  placement.attachElementToHost(el, wall, [2, 0, 1]);
  const res = placement.rehostElementAfterHostChange(el, wall, null);
  assert(res.outcome === "detached", `outcome detached, got ${res.outcome}`);
  assert(!el.hostId && !el.hostAttachment, "host link dropped");
  nearPoint(el.params.point, [2, 0]); // the element itself survives, freestanding
});

// ═══ Placement wiring + audit ═══════════════════════════════════════════

t("H15 attachElementToHost writes the host link and the derived placement onto the element", () => {
  const el = element("el-1");
  const p = placement.attachElementToHost(el, wall, [2, 0.3, 1.2]);
  assert(el.hostId === "wall-1", "hostId set");
  assert(el.hostAttachment.hostKind === "wall", "attachment stored");
  near(el.hostAttachment.s, 2); near(el.hostAttachment.elevation, 1.2); near(el.hostAttachment.offset, 0.3);
  nearPoint(el.params.point, [2, 0.3]);
  near(el.params.elevation, 1.2);
  near(el.params.rotation, 90);
  nearPoint(p.point, [2, 0.3]);
  // The attachment is serialisable with the element (Slice 4's round-trip).
  const round = JSON.parse(JSON.stringify(el));
  assert(round.hostAttachment.s === 2 && round.hostAttachment.hostVersion === 1, "attachment survives JSON round-trip");
});

t("H16 rehost after a host move refreshes the version and the element follows", () => {
  const el = element("el-1");
  placement.attachElementToHost(el, wall, [2, 0.3, 1.2]);
  const moved = { ...wall, curve: { kind: "line", start: [0, 2], end: [8, 2] }, version: 2 };
  const res = placement.rehostElementAfterHostChange(el, wall, moved);
  assert(res.outcome === "moved", `outcome moved, got ${res.outcome}`);
  nearPoint(el.params.point, [2, 2.3]);
  assert(el.hostAttachment.hostVersion === 2, "hostVersion refreshed so the audit does not flag it stale");
  const audit = fh.auditHostedFamilies([el], new Map([["wall-1", moved]]));
  assert(audit.total === 1 && audit.orphaned.length === 0 && audit.invalid.length === 0 && audit.stale.length === 0, "clean audit after a propagated move");
});

t("H17 audit: orphaned, invalid and stale are reported separately, never silently dropped", () => {
  const hosts = new Map([["wall-1", { ...wall, version: 2, curve: { kind: "line", start: [0, 0], end: [4, 0] } }]]);
  const v2host = hosts.get("wall-1");
  const good = element("el-good");
  placement.attachElementToHost(good, v2host, [2, 0, 1]); // attached against the CURRENT host: clean
  const orphan = element("el-orphan");
  orphan.hostId = "wall-missing";
  const stale = element("el-stale");
  placement.attachElementToHost(stale, wall, [3, 0, 1]); // v1 attachment; still fits the v2 host, but stale
  const bad = element("el-bad");
  placement.attachElementToHost(bad, wall, [6, 0, 1]); // v1 attachment; past the v2 host's end
  const audit = fh.auditHostedFamilies([good, orphan, stale, bad], hosts);
  assert(audit.total === 4, "four hosted elements");
  assert(audit.orphaned.length === 1 && audit.orphaned[0].elementId === "el-orphan", "orphan reported");
  assert(audit.invalid.length === 1 && audit.invalid[0].elementId === "el-bad", "out-of-range attachment reported invalid");
  assert(audit.stale.length === 1 && audit.stale[0].elementId === "el-stale", "stale version reported as a warning");
  assert(audit.stale[0].severity === "warning", "stale is a warning, not an error");
  assert(audit.orphaned[0].severity === "error" && audit.invalid[0].severity === "error", "orphan/invalid are errors");
  assert(audit.orphaned[0].code === "orphaned" && audit.invalid[0].code === "invalid", "codes are distinct");
});

t("H18 detach removes the host link and is a no-op on a freestanding element", () => {
  const el = element("el-1");
  assert(fh.familyHostingService.detach(el) === false, "nothing to detach");
  placement.attachElementToHost(el, wallFace, [2, 0.15, 1.5]);
  assert(fh.familyHostingService.detach(el) === true, "detached");
  assert(!el.hostId && !el.hostAttachment, "link gone");
  assert(fh.familyHostingService.detach(el) === false, "second detach is a no-op");
});

console.log(`\nparametric-family-hosting: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
