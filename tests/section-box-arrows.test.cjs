// Revit-style section box arrow grips — runtime + source drift-guard test.
//
// src/features/section-box.ts builds 6 face planes PLUS 6 arrow grips
// (shaft + conehead pointing outward along the face normal). This test:
//   1. asserts the real source keeps the expected construction constants
//      (arrow geometry, rotations, recursive raycast with parent walk),
//   2. replicates the construction with the repo's real three.js and proves
//      for every face: the arrow extends OUTWARD past the quad, and a camera
//      ray through the arrow resolves (recursive raycast + parent walk) to
//      the correct axis+sign — i.e. dragging that arrow moves that face.
const fs = require("fs"), path = require("path"), assert = require("assert");

// ── 0. Source drift-guard: the implementation must keep these markers ──
const src = fs.readFileSync(path.join(__dirname, "..", "src", "features", "section-box.ts"), "utf8");
const mustContain = [
  // Unit-arrow geometry (origin at the face surface, pointing +Y)
  "new THREE.CylinderGeometry(0.055, 0.055, 0.9, 10)",
  "shaftGeo.translate(0, 0.45, 0)",
  "new THREE.ConeGeometry(0.21, 0.5, 14)",
  "headGeo.translate(0, 1.15, 0)",
  // Arrow grips are first-class drag targets
  'kind: "section-box-arrow"',
  'ud?.kind !== "section-box-face" && ud?.kind !== "section-box-arrow"',
  // Recursive raycast + walk-up (arrows are Groups)
  "intersectObjects(faceGroup.children, true)",
  'o.userData?.kind === "section-box-arrow"',
  // Per-kind scaling (unit arrow is 1.4 long)
  '"section-box-arrow" ? (s * 0.7) : (s / 0.6)',
];
for (const m of mustContain) {
  assert.ok(src.includes(m), `section-box.ts drift: missing "${m}"`);
}
// Every FACE_DEFS row must define an arrowRotation (type annotations excluded)
assert.strictEqual((src.match(/arrowRotation: \[(?!number)/g) || []).length, 6, "6 arrowRotation entries expected");

// ── 1. Replicate the construction with the real three.js ──
let THREE;
try { THREE = require("three"); } catch { THREE = require(path.join(__dirname, "..", "node_modules", "three", "build", "three.cjs")); }

const FACE_DEFS = [
  { axis: "x", sign: -1, rotation: [0, -Math.PI / 2, 0], arrowRotation: [0, 0,  Math.PI / 2] },
  { axis: "x", sign:  1, rotation: [0,  Math.PI / 2, 0], arrowRotation: [0, 0, -Math.PI / 2] },
  { axis: "y", sign: -1, rotation: [ Math.PI / 2, 0, 0], arrowRotation: [Math.PI, 0, 0] },
  { axis: "y", sign:  1, rotation: [-Math.PI / 2, 0, 0], arrowRotation: [0, 0, 0] },
  { axis: "z", sign: -1, rotation: [Math.PI, 0, 0],      arrowRotation: [-Math.PI / 2, 0, 0] },
  { axis: "z", sign:  1, rotation: [0, 0, 0],            arrowRotation: [ Math.PI / 2, 0, 0] },
];

const faceGroup = new THREE.Group();
const planeGeo = new THREE.PlaneGeometry(0.6, 0.6);
const shaftGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.9, 10);
shaftGeo.translate(0, 0.45, 0);
const headGeo = new THREE.ConeGeometry(0.21, 0.5, 14);
headGeo.translate(0, 1.15, 0);

for (const def of FACE_DEFS) {
  const plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial());
  plane.rotation.set(...def.rotation);
  plane.userData = { kind: "section-box-face", axis: def.axis, sign: def.sign };
  faceGroup.add(plane);

  const arrow = new THREE.Group();
  arrow.rotation.set(...def.arrowRotation);
  arrow.userData = { kind: "section-box-arrow", axis: def.axis, sign: def.sign };
  arrow.add(new THREE.Mesh(shaftGeo, new THREE.MeshBasicMaterial()));
  arrow.add(new THREE.Mesh(headGeo, new THREE.MeshBasicMaterial()));
  faceGroup.add(arrow);
}

// Box under test: 10 × 8 × 6 centred at origin; position every grip on its face.
const box = new THREE.Box3(new THREE.Vector3(-5, -4, -3), new THREE.Vector3(5, 4, 3));
const center = new THREE.Vector3(); box.getCenter(center);
for (const h of faceGroup.children) {
  const { axis, sign } = h.userData;
  const p = center.clone();
  if (axis === "x") p.x = sign < 0 ? box.min.x : box.max.x;
  else if (axis === "y") p.y = sign < 0 ? box.min.y : box.max.y;
  else p.z = sign < 0 ? box.min.z : box.max.z;
  h.position.copy(p);
}
faceGroup.updateMatrixWorld(true);

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const alongN = (v, n) => v.x * n.x + v.y * n.y + v.z * n.z;

// ── 2. Every arrow extends OUTWARD past the 0.6-wide quad ──
for (const def of FACE_DEFS) {
  t(`[${def.axis}${def.sign < 0 ? "−" : "+"}] arrow points outward past the quad`, () => {
    const n = new THREE.Vector3(def.axis === "x" ? def.sign : 0, def.axis === "y" ? def.sign : 0, def.axis === "z" ? def.sign : 0);
    const arrow = faceGroup.children.find((h) => h.userData.kind === "section-box-arrow" && h.userData.axis === def.axis && h.userData.sign === def.sign);
    const face = alongN(arrow.position, n);
    const bb = new THREE.Box3().setFromObject(arrow);
    const corners = [
      new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z), new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
      new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z), new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
      new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z), new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
      new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z), new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
    ];
    const maxRel = Math.max(...corners.map((c) => alongN(c, n) - face));
    assert.ok(maxRel > 0.3, `outer tip only ${maxRel.toFixed(3)} past the face (quad half-width 0.3)`);
  });
}

// ── 3. Ray through each arrow resolves to that face (recursive + parent walk) ──
function castRayOnHandles(ndc, camera) {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(faceGroup.children, true);
  if (!hits.length) return null;
  let o = hits[0].object;
  while (o && o !== faceGroup) {
    if (o.userData?.kind === "section-box-face" || o.userData?.kind === "section-box-arrow") return o;
    o = o.parent;
  }
  return null;
}
for (const def of FACE_DEFS) {
  t(`[${def.axis}${def.sign < 0 ? "−" : "+"}] ray through the arrow drags that face`, () => {
    const n = new THREE.Vector3(def.axis === "x" ? def.sign : 0, def.axis === "y" ? def.sign : 0, def.axis === "z" ? def.sign : 0);
    const c = center.clone();
    if (def.axis === "x") c.x = def.sign < 0 ? box.min.x : box.max.x;
    else if (def.axis === "y") c.y = def.sign < 0 ? box.min.y : box.max.y;
    else c.z = def.sign < 0 ? box.min.z : box.max.z;
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    cam.position.set(c.x + n.x * 8, c.y + n.y * 8, c.z + n.z * 8);
    cam.lookAt(c.x, c.y, c.z);
    cam.updateMatrixWorld(true);
    const hit = castRayOnHandles(new THREE.Vector2(0, 0), cam);
    assert.ok(hit, "no hit through the arrow");
    assert.strictEqual(hit.userData.axis, def.axis);
    assert.strictEqual(hit.userData.sign, def.sign);
  });
}

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
