// Family sketch editor core: outline validation, extrusion spec, adding to a family, and (when real three.js is installed,
// i.e. in CI) the 3-D geometry the spec actually builds: footprint, height, elevation, orientation.
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), os = require("os"), assert = require("assert");
// Compile inside the project so the compiled files resolve `three` from the repo's node_modules (a temp dir would not).
const out = fs.mkdtempSync(path.join(__dirname, "..", ".sketch-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}'); // the repo is "type": "module"
process.on("exit", () => { try { fs.rmSync(out, { recursive: true, force: true }); } catch { /* */ } });
const build = (files) => { try { execSync(`npx tsc ${files} --outDir ${out} --module commonjs --target es2020 --skipLibCheck --moduleResolution node --esModuleInterop`, { stdio: "pipe" }); } catch (e) { /* type errors from missing packages locally still emit */ } };
build("src/modules/families/sketch-core.ts src/modules/families/parametric-geometry.ts");
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const S = require(find("sketch-core.js"));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, e = 1e-6) => ok(Math.abs(a - b) <= e, `${a} !~ ${b}`);

// ---- outline checks
ok(S.validateSketch([[0, 0], [4, 0], [4, 3], [0, 3]]).ok, "rectangle ok");
near(S.validateSketch([[0, 0], [4, 0], [4, 3], [0, 3]]).area, 12);
let v = S.validateSketch([[0, 3], [4, 3], [4, 0], [0, 0]]);
ok(v.ok && S.signedArea(v.points) > 0, "clockwise input is normalised to counter-clockwise");
ok(S.validateSketch([[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]]).points.length === 4, "repeated closing point removed");
ok(S.validateSketch([[0, 0], [0, 0], [1, 0], [1, 1]]).points.length === 3, "consecutive duplicates removed");
ok(/at least 3/.test(S.validateSketch([[0, 0], [1, 1]]).errors[0]), "too few points");
ok(/no area/.test(S.validateSketch([[0, 0], [1, 1], [2, 2]]).errors[0]), "collinear = no area");
ok(/crosses itself/.test(S.validateSketch([[0, 0], [4, 4], [4, 0], [0, 4]]).errors.join()), "bow-tie rejected");
ok(S.validateSketch([[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]]).ok === false || true, "(shape with touching vertex handled without throwing)");
ok(S.validateSketch([[0, 0], [4, 0], [4, 4], [2, 2], [0, 4]]).ok, "concave L/arrow shape is valid");
ok(!S.validateSketch([[0, 0], [NaN, 1], [2, 2], [Infinity, 3]]).ok, "non-finite points dropped, then too few");
ok(!S.validateSketch(Array.from({ length: 600 }, (_, i) => [Math.cos(i), Math.sin(i)])).ok, "more than 500 points refused");
ok(S.snap(1.26, 0.25) === 1.25 && S.snap(1.26, 0) === 1.26 && S.snapPt([0.12, 0.38], 0.1)[1] === 0.4, "grid snap");
ok(S.rectPoints(3, 2, 1, 5).join() === "1,2,3,2,3,5,1,5", "rect from any two corners");
const c = S.circlePoints(0, 0, 1, 24); ok(c.length === 24 && S.validateSketch(c).ok, "circle polygon valid"); near(S.validateSketch(c).area, 24 / 2 * Math.sin(2 * Math.PI / 24), 1e-9);

// ---- family building
const base = { id: "f1", name: "Base", category: "generic", ifcEntity: "IfcBuildingElementProxy", schemaVersion: 1, builtIn: true,
  parameters: [{ name: "width", type: "length", scope: "type", default: 1, editable: true }], types: [{ id: "t", name: "T", values: {} }],
  geometry: { kind: "box", w: { ref: "width" }, d: { const: 1 }, h: { const: 1 } } };
const snapshot = JSON.stringify(base);
let r = S.addSketchToFamily(base, [[0, 0], [2, 0], [2, 1], [0, 1]], { depth: 0.3, elevation: 1 });
ok(r.ok && JSON.stringify(base) === snapshot, "original family not mutated");
ok(r.family.geometry.kind === "composed" && r.family.geometry.parts.length === 2 && r.family.geometry.parts[0].kind === "box" && r.family.geometry.parts[1].kind === "extrusion", "added as a second part");
ok(r.family.parameters.map((p) => p.name).join() === "width,sketchDepth,sketchElevation" && r.family.builtIn === false, "parameters added, no longer built-in");
const r2 = S.addSketchToFamily(r.family, [[0, 0], [1, 0], [1, 1]], { depth: 1 });
ok(r2.ok && r2.depthParam === "sketchDepth2" && r2.elevationParam === "sketchElevation2" && r2.family.geometry.parts.length === 3, "second sketch gets unique parameter names and a third part");
ok(!S.addSketchToFamily(base, [[0, 0], [1, 1]], { depth: 1 }).ok, "bad outline refused");
for (const d of [0, -1, NaN, 5000]) ok(!S.addSketchToFamily(base, [[0, 0], [1, 0], [1, 1]], { depth: d }).ok, "bad depth refused: " + d);
const nf = S.newFamilyFromSketch({ id: "u.f", name: "  Plinth ", points: [[0, 0], [2, 0], [2, 2], [0, 2]], depth: 0.2, category: "equipment" });
ok(nf.ok && nf.family.name === "Plinth" && nf.family.geometry.kind === "extrusion" && nf.family.types.length === 1 && nf.family.types[0].id === "u.f.default", "new family: one extrusion, default type");
ok(!S.newFamilyFromSketch({ id: "x", name: " ", points: [[0, 0], [1, 0], [1, 1]], depth: 1 }).ok, "name required");

// ---- holes
const outerSq = [[0, 0], [4, 0], [4, 4], [0, 4]];
const hh = S.addSketchToFamily(base, outerSq, { depth: 1, holes: [[[1, 1], [2, 1], [2, 2], [1, 2]]] });
ok(hh.ok && hh.family.geometry.parts[1].holes.length === 1, "hole stored on the extrusion");
near(hh.area, 15);
ok(!S.addSketchToFamily(base, outerSq, { depth: 1, holes: [[[3, 3], [5, 3], [5, 5], [3, 5]]] }).ok, "hole sticking out refused");
ok(!S.addSketchToFamily(base, outerSq, { depth: 1, holes: [[[5, 5], [6, 5], [6, 6], [5, 6]]] }).ok, "hole outside refused");
ok(!S.addSketchToFamily(base, outerSq, { depth: 1, holes: [[[1, 1], [2, 1], [2, 2], [1, 2]], [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]]] }).ok, "overlapping holes refused");
ok(S.addSketchToFamily(base, outerSq, { depth: 1, holes: [[[1, 1], [1.5, 1], [1.5, 1.5], [1, 1.5]], [[2.5, 2.5], [3, 2.5], [3, 3], [2.5, 3]]] }).ok, "two separate holes ok");
ok(S.pointInPolygon([1, 1], outerSq) && !S.pointInPolygon([5, 1], outerSq), "point in polygon");
// concave outline: a hole inside the notch is outside the shape
ok(!S.addSketchToFamily(base, [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]], { depth: 1, holes: [[[1.8, 2.5], [2.2, 2.5], [2.2, 3], [1.8, 3]]] }).ok, "hole in a concave notch refused");

// ---- parametric rect / circle
const pr = S.addShapeToFamily(base, { kind: "rect", cx: 1, cy: 2, width: 3, length: 5 }, { depth: 0.4 });
ok(pr.ok && pr.sizeParams.join() === "sketchWidth,sketchLength" && pr.family.geometry.parts[1].profile.kind === "rect", "rect uses width/length parameters");
near(pr.area, 15);
const pc = S.addShapeToFamily(base, { kind: "circle", cx: 0, cy: 0, radius: 0.5 }, { depth: 0.4 });
ok(pc.ok && pc.sizeParams[0] === "sketchRadius" && pc.family.geometry.parts[1].profile.kind === "circle", "circle uses a radius parameter");
ok(!S.addShapeToFamily(base, { kind: "rect", cx: 0, cy: 0, width: 0, length: 1 }, { depth: 1 }).ok && !S.addShapeToFamily(base, { kind: "circle", cx: 0, cy: 0, radius: -1 }, { depth: 1 }).ok, "non-positive sizes refused");
const pr2 = S.addShapeToFamily(pr.family, { kind: "rect", cx: 0, cy: 0, width: 1, length: 1 }, { depth: 1 });
ok(pr2.sizeParams.join() === "sketchWidth2,sketchLength2", "unique size parameter names");
const nr = S.newFamilyFromSketch({ id: "u.r", name: "Pad", shape: { kind: "rect", cx: 0, cy: 0, width: 2, length: 1 }, depth: 0.1 });
ok(nr.ok && nr.family.geometry.kind === "extrusion", "new family from a parametric rect");

// ---- real geometry (needs the real three.js; skipped locally where only a stub is installed)
let THREE = null; try { THREE = require("three"); if (typeof THREE.ExtrudeGeometry !== "function" || typeof THREE.Box3 !== "function") THREE = null; } catch { THREE = null; }
if (THREE) {
  const G = require(find("parametric-geometry.js"));
  const params = (def) => Object.fromEntries(def.parameters.map((p) => [p.name, p.default]));
  const o = G.buildParametricGeometry(nf.family.geometry, params(nf.family));
  o.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(o), size = b.getSize(new THREE.Vector3());
  near(size.x, 2, 1e-5); near(size.z, 2, 1e-5); near(size.y, 0.2, 1e-5); near(b.min.y, 0, 1e-5); // base at elevation 0, rising by depth
  // plan orientation: a point drawn at sketch y=+1 (up the screen) lands at +Z; elevation lifts the base
  const l = S.newFamilyFromSketch({ id: "u.l", name: "L", points: [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]], depth: 0.5, elevation: 2 });
  const lo = G.buildParametricGeometry(l.family.geometry, params(l.family)); lo.updateMatrixWorld(true);
  const lb = new THREE.Box3().setFromObject(lo);
  near(lb.min.y, 2, 1e-5); near(lb.max.y, 2.5, 1e-5); near(lb.min.x, 0, 1e-5); near(lb.max.x, 4, 1e-5); near(lb.min.z, 0, 1e-5); near(lb.max.z, 3, 1e-5);
  // parametric rect: centre translate and resizing with the parameter
  const prg = S.newFamilyFromSketch({ id: "u.p", name: "P", shape: { kind: "rect", cx: 3, cy: 2, width: 2, length: 1 }, depth: 0.5 });
  let pg = G.buildParametricGeometry(prg.family.geometry, params(prg.family)); pg.updateMatrixWorld(true);
  let pb = new THREE.Box3().setFromObject(pg);
  near(pb.min.x, 2, 1e-5); near(pb.max.x, 4, 1e-5); near(pb.min.z, 1.5, 1e-5); near(pb.max.z, 2.5, 1e-5);
  const wider = { ...params(prg.family), sketchWidth: 6 };
  pg = G.buildParametricGeometry(prg.family.geometry, wider); pg.updateMatrixWorld(true); pb = new THREE.Box3().setFromObject(pg);
  near(pb.max.x - pb.min.x, 6, 1e-5);
  // hole: footprint unchanged but the solid has less volume-bearing triangles; check hole walls exist via vertex count growth
  const solid = S.newFamilyFromSketch({ id: "u.s", name: "S", points: outerSq, depth: 1 });
  const holed = S.newFamilyFromSketch({ id: "u.h", name: "H", points: outerSq, holes: [[[1, 1], [2, 1], [2, 2], [1, 2]]], depth: 1 });
  const cnt = (f) => { const g = G.buildParametricGeometry(f.family.geometry, params(f.family)); let c = 0; g.traverse((m) => { if (m.geometry) c += m.geometry.attributes.position.count; }); return c; };
  ok(cnt(holed) > cnt(solid), "hole adds wall geometry");
  console.log(`family-sketch: ${n} assertions passed (real geometry checked)`);
} else console.log(`family-sketch: ${n} assertions passed (real three.js absent: geometry checks skipped here, they run in CI)`);
