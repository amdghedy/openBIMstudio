/**
 * tests/join-advanced.test.cjs
 *
 * Closes the parametric join-status gap with proof:
 *   - "extended" slides the whole square end plane out to the peer's far face;
 *   - "chamfer" cuts exactly ONE face to the convex miter point, other square;
 *   - "allow" keeps the classic full miter (regression guard);
 *   - "disallow"/"butt" stay square (regression guard);
 *   - degenerate inputs fall back to a plain square end (never unbounded).
 *
 * Run: `node tests/join-advanced.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "joinadv-"));
execSync(`npx tsc src/modules/geometry/linear-join.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit", cwd: path.join(__dirname, "..") });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const m = require(find(out, "linear-join.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
const pt = (v, x, z, label) => { near(v[0], x, 1e-6); near(v[1], z, 1e-6); assert(typeof label === "string"); };

// Canonical L corner: self (0,0)->(10,0) joined at its END (atStart=false),
// peer starts at (10,0) heading +Z, both thickness 0.2 (halfT = hB = 0.1).
const SELF_END = [10, 0];
const DIR = [1, 0];
const HALF = 0.1;
const PEER = (status) => ({ id: "peer", start: [10, 0], end: [10, 5], thickness: 0.2, joinStatus: status });
const SELF = (status) => ({ id: "self", start: [0, 0], end: [10, 0], thickness: 0.2, joinStatus: status });

t("allow keeps the classic full miter (regression guard)", () => {
  const r = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("allow"), PEER("allow")]);
  assert.ok(r.joined);
  pt(r.left, 9.9, 0.1, "left=inner corner cut");
  pt(r.right, 10.1, -0.1, "right=outer corner cut");
});

t("disallow and butt stay square and unjoined", () => {
  for (const s of ["disallow", "butt"]) {
    const r = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF(s), PEER("allow")]);
    assert.strictEqual(r.joined, false, s);
    pt(r.left, 10, 0.1, s + " left plain");
    pt(r.right, 10, -0.1, s + " right plain");
  }
});

t("chamfer cuts exactly ONE face to the convex corner, other stays square", () => {
  const r = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("chamfer"), PEER("allow")]);
  assert.ok(r.joined);
  pt(r.left, 10, 0.1, "left face square at the original end");
  pt(r.right, 10.1, -0.1, "right face cut to the convex miter point");
});

t("extended slides the whole square end out to the peer far face", () => {
  const r = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("extended"), PEER("allow")]);
  assert.ok(r.joined);
  pt(r.left, 10.1, 0.1, "left face at x=10.1");
  pt(r.right, 10.1, -0.1, "right face at x=10.1");
});

t("mirrored peer (heading -Z) flips the chamfer side, same extended result", () => {
  const peerDown = { id: "peer", start: [10, 0], end: [10, -5], thickness: 0.2, joinStatus: "allow" };
  const c = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("chamfer"), peerDown]);
  assert.ok(c.joined);
  pt(c.left, 10.1, 0.1, "convex side flips to the left face");
  pt(c.right, 10, -0.1, "right stays square");
  const e = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("extended"), peerDown]);
  assert.ok(e.joined);
  pt(e.left, 10.1, 0.1, "extended flush with far face (mirrored)");
  pt(e.right, 10.1, -0.1, "extended flush with far face (mirrored)");
});

t("join at the START end produces the same physical faces", () => {
  // self (10,0)->(0,0), joint at its start; peer same as canonical.
  const selfRev = { id: "self", start: [10, 0], end: [0, 0], thickness: 0.2, joinStatus: "chamfer" };
  const r = m.mitreEndFaces([10, 0], [-1, 0], HALF, true, "self", [selfRev, PEER("allow")]);
  assert.ok(r.joined);
  pt(r.left, 10.1, -0.1, "start-joint chamfer convex cut");
  pt(r.right, 10, 0.1, "start-joint square face");
});

t("degenerate: no peer endpoint nearby -> null (free end)", () => {
  const far = { id: "peer", start: [50, 50], end: [51, 50], thickness: 0.2, joinStatus: "allow" };
  assert.strictEqual(m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("allow"), far]), null);
  assert.strictEqual(m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("extended"), far]), null);
  assert.strictEqual(m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("chamfer"), far]), null);
});

t("degenerate: beyond maxMiterFactor -> plain square fallback, never unbounded", () => {
  const e = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("extended"), PEER("allow")], 0.5);
  assert.strictEqual(e.joined, false, "extended fallback");
  pt(e.left, 10, 0.1, "fallback plain");
  const c = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF("chamfer"), PEER("allow")], 0.5);
  assert.strictEqual(c.joined, false, "chamfer fallback");
  pt(c.right, 10, -0.1, "fallback square");
});

t("collinear continuation still reports a joined butt (all statuses)", () => {
  const cont = { id: "peer", start: [10, 0], end: [15, 0], thickness: 0.2, joinStatus: "allow" };
  for (const s of ["allow", "chamfer", "extended"]) {
    const r = m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF(s), cont]);
    assert.strictEqual(r.joined, true, s + " continuation");
    pt(r.left, 10, 0.1, s + " plain faces kept");
    pt(r.right, 10, -0.1, s + " plain faces kept");
  }
});

t("peer opt-out (disallow) means no join for self either (null -> caller draws plain)", () => {
  for (const s of ["allow", "chamfer", "extended"]) {
    assert.strictEqual(m.mitreEndFaces(SELF_END, DIR, HALF, false, "self", [SELF(s), PEER("disallow")]), null, s);
  }
});

console.log(`\njoin-advanced: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
