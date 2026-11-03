const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
execSync(`npx tsc src/features/section-box-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit" });
const m = require(path.join(out, "section-box-math.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const near3 = (v, w, label) => {
  for (const k of ["x", "y", "z"]) assert.ok(Math.abs(v[k] - w[k]) < 1e-9, `${label}: ${k} ${v[k]} != ${w[k]}`);
};
// Rotate v = (0,0,1) by a single-axis Euler (the FACE_DEFS convention),
// right-handed. Throws if a def ever grows a second non-zero angle so the
// helper cannot silently go wrong.
function rotatedZ(rotation) {
  const [rx, ry, rz] = rotation;
  const nonZero = rotation.filter((a) => Math.abs(a) > 1e-12);
  assert.ok(nonZero.length <= 1, "multi-axis rotation — extend this helper first");
  if (Math.abs(rx) > 1e-12) return { x: 0, y: -Math.sin(rx), z: Math.cos(rx) }; // about X
  if (Math.abs(ry) > 1e-12) return { x: Math.sin(ry), y: 0, z: Math.cos(ry) }; // about Y
  if (Math.abs(rz) > 1e-12) return { x: 0, y: 0, z: 1 }; // about Z: +Z is invariant
  return { x: 0, y: 0, z: 1 };
}
t("module loads", () => { assert.ok(m); });
t("six distinct faces are defined", () => {
  assert.strictEqual(m.FACE_DEFS.length, 6);
  assert.strictEqual(new Set(m.FACE_DEFS.map((d) => d.axis + d.sign)).size, 6);
});
t("each face rotation maps local +Z onto the outward normal (arrow points outward)", () => {
  for (const def of m.FACE_DEFS) near3(rotatedZ(def.rotation), m.faceNormal(def.axis, def.sign), def.label);
});
t("faceNormal points outward along the face axis", () => {
  assert.deepStrictEqual(m.faceNormal("x", 1), { x: 1, y: 0, z: 0 });
  assert.deepStrictEqual(m.faceNormal("x", -1), { x: -1, y: 0, z: 0 });
  assert.deepStrictEqual(m.faceNormal("y", 1), { x: 0, y: 1, z: 0 });
  assert.deepStrictEqual(m.faceNormal("y", -1), { x: 0, y: -1, z: 0 });
  assert.deepStrictEqual(m.faceNormal("z", 1), { x: 0, y: 0, z: 1 });
  assert.deepStrictEqual(m.faceNormal("z", -1), { x: 0, y: 0, z: -1 });
});
t("faceCenter lands on the face and stays centred on the other axes", () => {
  const b = { min: { x: -1, y: -2, z: -3 }, max: { x: 5, y: 6, z: 7 } };
  let c = m.faceCenter(b, "x", 1);
  near(c.x, 5); near(c.y, 2); near(c.z, 2);
  c = m.faceCenter(b, "x", -1);
  near(c.x, -1); near(c.y, 2); near(c.z, 2);
  c = m.faceCenter(b, "y", 1);
  near(c.x, 2); near(c.y, 6); near(c.z, 2);
  c = m.faceCenter(b, "y", -1);
  near(c.x, 2); near(c.y, -2); near(c.z, 2);
  c = m.faceCenter(b, "z", 1);
  near(c.x, 2); near(c.y, 2); near(c.z, 7);
  c = m.faceCenter(b, "z", -1);
  near(c.x, 2); near(c.y, 2); near(c.z, -3);
});
t("arrow geometry straddles the face (inner tip inside, outer head proud of the quad)", () => {
  const s = m.ARROW_SPEC;
  near(m.arrowTotalLength(), s.shaftLen + 2 * s.coneLen);
  const tipIn = s.lift - s.shaftLen / 2 - s.coneLen;
  const tipOut = s.lift + s.shaftLen / 2 + s.coneLen;
  assert.ok(tipIn < 0, `inner tip ${tipIn} should sit slightly inside the face`);
  assert.ok(tipOut > 0.3, `outer head ${tipOut} should poke past the 0.6-wide quad edge`);
});
t("arrow drag contract: outward grows the box, inward shrinks it, min-size respected", () => {
  const b = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } };
  near(m.moveBoxFace(b, "x", 1, 12).max.x, 12);   // drag +X arrow outward
  near(m.moveBoxFace(b, "x", 1, 8, 0.1).max.x, 8); // drag +X arrow inward
  near(m.moveBoxFace(b, "y", -1, -2).min.y, -2);  // drag bottom arrow down
  near(m.moveBoxFace(b, "y", -1, 3, 0.1).min.y, 3);
  near(m.moveBoxFace(b, "y", -1, 11, 0.1).min.y, 9.9); // cannot invert through +Y
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
