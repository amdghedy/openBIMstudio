// RVT-style section box arrow grips — runtime + source drift-guard test.
//
// src/features/section-box.ts builds 6 translucent drag quads PLUS one
// double-headed arrow per face (geometry along local +Z, pre-lifted so the
// inner head crosses into the crop and the outer head stands proud of the
// 0.6-wide quad). The arrow is a real drag target: recursive raycast + a
// parent walk back to the owning face handle, exactly like the quad.
//
// This test:
//   1. guards the real source against drift (construction markers),
//   2. compiles the real section-box-math.ts (ARROW_SPEC / FACE_DEFS /
//      faceCenter / faceNormal) and replicates the construction with the
//      repo's real three.js,
//   3. proves, for every face: the outer head pokes proud of the quad, the
//      inner head crosses slightly inside, and a camera ray through the
//      arrow resolves (recursive raycast + parent walk) to the correct
//      axis+sign — i.e. dragging that arrow stretches / shrinks that face.
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
const { execSync } = require("child_process");

// ── 0. Source drift-guard: the implementation must keep these markers ──
const src = fs.readFileSync(path.join(__dirname, "..", "src", "features", "section-box.ts"), "utf8");
const mustContain = [
  // Arrow geometry built along local +Z from the shared ARROW_SPEC
  "new THREE.CylinderGeometry(ARROW_SPEC.shaftR, ARROW_SPEC.shaftR, ARROW_SPEC.shaftLen, 12)",
  "shaftGeo.rotateX(Math.PI / 2)",
  "new THREE.ConeGeometry(ARROW_SPEC.coneR, ARROW_SPEC.coneLen, 16)",
  // Pre-lifted double heads (outward + inward)
  "ARROW_SPEC.lift + ARROW_SPEC.shaftLen / 2 + ARROW_SPEC.coneLen / 2",
  "ARROW_SPEC.lift - ARROW_SPEC.shaftLen / 2 - ARROW_SPEC.coneLen / 2",
  // Arrows are drag targets sharing the face-handle userData
  'part: "arrow"',
  'part: "arrow-mesh"',
  // Recursive raycast with a parent walk back to the face handle
  "intersectObjects(faceGroup.children, true)",
];
for (const m of mustContain) {
  assert.ok(src.includes(m), `section-box.ts drift: missing "${m}"`);
}

// ── 1. Compile the real math module (single source of truth for constants) ──
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-arrows-"));
execSync(`npx tsc src/features/section-box-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "ignore", cwd: path.join(__dirname, "..") });
const { ARROW_SPEC, FACE_DEFS, faceCenter, faceNormal } = require(path.join(out, "section-box-math.js"));

// ── 2. Replicate the construction with the real three.js ──
let THREE;
try { THREE = require("three"); } catch { THREE = require(path.join(__dirname, "..", "node_modules", "three", "build", "three.cjs")); }

const faceGroup = new THREE.Group();
const planeGeo = new THREE.PlaneGeometry(0.6, 0.6);
const shaftGeo = new THREE.CylinderGeometry(ARROW_SPEC.shaftR, ARROW_SPEC.shaftR, ARROW_SPEC.shaftLen, 12);
shaftGeo.rotateX(Math.PI / 2); // cylinder Y axis → Z
const coneOutGeo = new THREE.ConeGeometry(ARROW_SPEC.coneR, ARROW_SPEC.coneLen, 16);
coneOutGeo.rotateX(Math.PI / 2); // +Z head
const coneInGeo = new THREE.ConeGeometry(ARROW_SPEC.coneR, ARROW_SPEC.coneLen, 16);
coneInGeo.rotateX(-Math.PI / 2); // −Z head
const headOutZ = ARROW_SPEC.lift + ARROW_SPEC.shaftLen / 2 + ARROW_SPEC.coneLen / 2;
const headInZ = ARROW_SPEC.lift - ARROW_SPEC.shaftLen / 2 - ARROW_SPEC.coneLen / 2;

for (const def of FACE_DEFS) {
  const ud = { kind: "section-box-face", axis: def.axis, sign: def.sign, label: def.label };
  const plane = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial());
  plane.rotation.set(...def.rotation);
  plane.userData = { ...ud, part: "plane" };
  faceGroup.add(plane);

  const arrow = new THREE.Group();
  arrow.rotation.set(...def.rotation); // local +Z = outward normal
  arrow.userData = { ...ud, part: "arrow" };
  const shaft = new THREE.Mesh(shaftGeo, new THREE.MeshBasicMaterial());
  shaft.position.z = ARROW_SPEC.lift;
  const headOut = new THREE.Mesh(coneOutGeo, new THREE.MeshBasicMaterial());
  headOut.position.z = headOutZ;
  const headIn = new THREE.Mesh(coneInGeo, new THREE.MeshBasicMaterial());
  headIn.position.z = headInZ;
  for (const part of [shaft, headOut, headIn]) {
    part.renderOrder = 1001;
    part.userData = { ...ud, part: "arrow-mesh" };
    arrow.add(part);
  }
  faceGroup.add(arrow);
}

// Box under test: 10 × 8 × 6 centred at origin; centre every handle on its face.
const box = new THREE.Box3(new THREE.Vector3(-5, -4, -3), new THREE.Vector3(5, 4, 3));
for (const h of faceGroup.children) {
  if (h.userData?.kind !== "section-box-face") continue;
  const c = faceCenter(box, h.userData.axis, h.userData.sign);
  h.position.set(c.x, c.y, c.z);
}
faceGroup.updateMatrixWorld(true);

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const alongN = (v, n) => v.x * n.x + v.y * n.y + v.z * n.z;

// ── 3. Per face: outer head proud of the quad, inner head inside, ray resolves ──
function castRayOnHandles(ndc, camera) {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(faceGroup.children, true);
  if (!hits.length) return null;
  let o = hits[0].object;
  while (o && o !== faceGroup) {
    if (o.userData?.kind === "section-box-face") return o;
    o = o.parent;
  }
  return null;
}

for (const def of FACE_DEFS) {
  const tag = `${def.axis}${def.sign < 0 ? "−" : "+"}`;
  const n = faceNormal(def.axis, def.sign);
  const c = faceCenter(box, def.axis, def.sign);
  const nrm = new THREE.Vector3(n.x, n.y, n.z);
  const ctr = new THREE.Vector3(c.x, c.y, c.z);

  t(`[${tag}] outer head pokes proud of the 0.6-wide quad`, () => {
    const arrow = faceGroup.children.find((h) => h.userData?.part === "arrow" && h.userData.axis === def.axis && h.userData.sign === def.sign);
    const bb = new THREE.Box3().setFromObject(arrow);
    const corners = [
      new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z), new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
      new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z), new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
      new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z), new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
      new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z), new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
    ];
    const face = alongN(ctr, nrm);
    const maxRel = Math.max(...corners.map((v) => alongN(v, nrm) - face));
    assert.ok(maxRel > 0.3, `outer extent only ${maxRel.toFixed(3)} past the face (quad half-width 0.3)`);
  });

  t(`[${tag}] inner head crosses slightly inside the crop`, () => {
    const arrow = faceGroup.children.find((h) => h.userData?.part === "arrow" && h.userData.axis === def.axis && h.userData.sign === def.sign);
    const bb = new THREE.Box3().setFromObject(arrow);
    const corners = [
      new THREE.Vector3(bb.min.x, bb.min.y, bb.min.z), new THREE.Vector3(bb.max.x, bb.max.y, bb.max.z),
      new THREE.Vector3(bb.min.x, bb.min.y, bb.max.z), new THREE.Vector3(bb.min.x, bb.max.y, bb.min.z),
      new THREE.Vector3(bb.max.x, bb.min.y, bb.min.z), new THREE.Vector3(bb.max.x, bb.max.y, bb.min.z),
      new THREE.Vector3(bb.min.x, bb.max.y, bb.max.z), new THREE.Vector3(bb.max.x, bb.min.y, bb.max.z),
    ];
    const face = alongN(ctr, nrm);
    const minRel = Math.min(...corners.map((v) => alongN(v, nrm) - face));
    assert.ok(minRel < 0, `arrow does not cross the face (minRel=${minRel.toFixed(3)})`);
    assert.ok(minRel > -0.5, `arrow reaches too deep inside (minRel=${minRel.toFixed(3)})`);
  });

  t(`[${tag}] ray through the arrow drags that face`, () => {
    const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    cam.position.set(ctr.x + nrm.x * 8, ctr.y + nrm.y * 8, ctr.z + nrm.z * 8);
    cam.lookAt(ctr.x, ctr.y, ctr.z);
    cam.updateMatrixWorld(true);
    const hit = castRayOnHandles(new THREE.Vector2(0, 0), cam); // screen centre = face centre
    assert.ok(hit, "no hit through the arrow");
    assert.strictEqual(hit.userData.axis, def.axis);
    assert.strictEqual(hit.userData.sign, def.sign);
  });
}

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
