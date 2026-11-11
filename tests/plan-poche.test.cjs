/**
 * Wall poché unit tests — pure math from src/modules/drawings/plan-poche.ts.
 * Compile the module with tsc and require it (house test pattern).
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "poche-"));
execSync(
  `npx tsc src/modules/drawings/plan-poche.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const m = require(path.join(out, "plan-poche.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const nearPt = (p, x, z) => { near(p[0], x); near(p[1], z); };

// ── mergeOpenings ────────────────────────────────────────────────────────
t("mergeOpenings sorts and merges overlaps", () => {
  assert.deepStrictEqual(m.mergeOpenings([{ start: 2, end: 3 }, { start: 1, end: 2.5 }]), [{ start: 1, end: 3 }]);
});
t("mergeOpenings keeps disjoint spans", () => {
  assert.deepStrictEqual(m.mergeOpenings([{ start: 0, end: 1 }, { start: 3, end: 4 }]), [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
});
t("mergeOpenings swallows contained spans", () => {
  assert.deepStrictEqual(m.mergeOpenings([{ start: 0, end: 5 }, { start: 1, end: 2 }]), [{ start: 0, end: 5 }]);
});

// ── solidSpans ───────────────────────────────────────────────────────────
t("solidSpans: no openings → one full span", () => {
  assert.deepStrictEqual(m.solidSpans(4, []), [{ start: 0, end: 4 }]);
});
t("solidSpans: central opening → two spans", () => {
  assert.deepStrictEqual(m.solidSpans(4, [{ start: 1, end: 2 }]), [{ start: 0, end: 1 }, { start: 2, end: 4 }]);
});
t("solidSpans: fully covered wall → no spans", () => {
  assert.deepStrictEqual(m.solidSpans(4, [{ start: 0, end: 4 }]), []);
});
t("solidSpans clamps and drops slivers", () => {
  // Opening hangs past both ends; the 0.01 remnant is below minSpan.
  assert.deepStrictEqual(m.solidSpans(2, [{ start: -1, end: 1.99 }]), []);
});
t("solidSpans: touching openings merge via 1e-9 tolerance only", () => {
  // Touching (2,2) → merged into one hole 1..3.
  assert.deepStrictEqual(m.solidSpans(4, [{ start: 1, end: 2 }, { start: 2, end: 3 }]), [{ start: 0, end: 1 }, { start: 3, end: 4 }]);
});
t("solidSpans accepts unsorted openings", () => {
  assert.deepStrictEqual(m.solidSpans(5, [{ start: 4, end: 4.5 }, { start: 0, end: 1 }]), [{ start: 1, end: 4 }, { start: 4.5, end: 5 }]);
});

// ── spanQuad ─────────────────────────────────────────────────────────────
// Straight wall start(0,0) → end(4,0), thickness 0.2, normal (0,1):
// left = +n·t2, right = −n·t2 (matches plan-generator faceEndsAt).
const straightFaces = {
  startLeft: { x: 0, z: 0.1 }, startRight: { x: 0, z: -0.1 },
  endLeft: { x: 4, z: 0.1 }, endRight: { x: 4, z: -0.1 },
};
t("spanQuad: full span covers the whole cut face", () => {
  const q = m.spanQuad(straightFaces, 4, { start: 0, end: 4 });
  assert.strictEqual(q.length, 4);
  nearPt(q[0], 0, 0.1);   // start-left
  nearPt(q[1], 4, 0.1);   // end-left
  nearPt(q[2], 4, -0.1);  // end-right
  nearPt(q[3], 0, -0.1);  // start-right
});
t("spanQuad: partial span between openings", () => {
  const q = m.spanQuad(straightFaces, 4, { start: 1, end: 2 });
  nearPt(q[0], 1, 0.1); nearPt(q[1], 2, 0.1);
  nearPt(q[2], 2, -0.1); nearPt(q[3], 1, -0.1);
});
t("spanQuad lerps mitred faces (diagonal wall)", () => {
  const faces = {
    startLeft: { x: 0, z: 1 }, startRight: { x: 0, z: -1 },
    endLeft: { x: 10, z: 3 }, endRight: { x: 10, z: 1 },
  };
  const q = m.spanQuad(faces, 10, { start: 5, end: 10 });
  nearPt(q[0], 5, 2);      // half-way lerp left
  nearPt(q[1], 10, 3);
  nearPt(q[2], 10, 1);
  nearPt(q[3], 5, 0);      // half-way lerp right
});
t("spanQuad guards zero length", () => {
  const q = m.spanQuad(straightFaces, 0, { start: 0, end: 0 });
  assert.strictEqual(q.length, 4);
});

// ── rectQuad ─────────────────────────────────────────────────────────────
t("rectQuad: column footprint corners", () => {
  const q = m.rectQuad(3, 5, 0.4, 0.6);
  nearPt(q[0], 2.8, 4.7); nearPt(q[1], 3.2, 4.7);
  nearPt(q[2], 3.2, 5.3); nearPt(q[3], 2.8, 5.3);
});

// ── pocheStyleFor ────────────────────────────────────────────────────────
t("pocheStyleFor: brick/masonry → brick pattern", () => {
  assert.strictEqual(m.pocheStyleFor("wall", "Brick Wall 250").pattern, "brick");
  assert.strictEqual(m.pocheStyleFor("wall", "Masonry block").pattern, "brick");
});
t("pocheStyleFor: concrete → concrete pattern", () => {
  assert.strictEqual(m.pocheStyleFor("wall", "C30/37 concrete").pattern, "concrete");
});
t("pocheStyleFor: steel/wood/glass/insulation/earth map", () => {
  assert.strictEqual(m.pocheStyleFor("wall", "Steel portal").pattern, "steel");
  assert.strictEqual(m.pocheStyleFor("wall", "Timber stud").pattern, "wood");
  assert.strictEqual(m.pocheStyleFor("wall", "Curtain wall glazing").pattern, "glass");
  assert.strictEqual(m.pocheStyleFor("wall", "Insulated panel").pattern, "insulation");
  assert.strictEqual(m.pocheStyleFor("wall", "Gravel fill").pattern, "earth");
});
t("pocheStyleFor: generic wall → solid gray poché", () => {
  const s = m.pocheStyleFor("wall", "Basic Wall");
  assert.strictEqual(s.pattern, null);
  assert.strictEqual(s.color, m.DEFAULT_POCHE_COLOR);
});
t("pocheStyleFor tolerates empty / undefined names", () => {
  const s = m.pocheStyleFor("wall", undefined, null, "");
  assert.strictEqual(s.pattern, null);
});
t("pocheStyleFor: type fallback — column/footing concrete, beam steel", () => {
  assert.strictEqual(m.pocheStyleFor("column", "Column").pattern, "concrete");
  assert.strictEqual(m.pocheStyleFor("footing", "Footing").pattern, "concrete");
  assert.strictEqual(m.pocheStyleFor("beam", "Beam").pattern, "steel");
});
t("pocheStyleFor: material name beats type fallback", () => {
  assert.strictEqual(m.pocheStyleFor("beam", "Concrete Beam").pattern, "concrete");
  assert.strictEqual(m.pocheStyleFor("column", "Steel Column").pattern, "steel");
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
