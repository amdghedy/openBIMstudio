// hidden-line: the current 3D view as 2D lines (pure logic).
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(root, ".hlr-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try {
  execSync(`npx tsc src/modules/export/hidden-line.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --lib es2020`, { stdio: "pipe", cwd: root });
  const H = require(path.join(out, "hidden-line.js"));
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
  const box = (x0, y0, z0, x1, y1, z1, layer) => ({ layer, positions: [x0,y0,z0, x1,y0,z0, x1,y1,z0, x0,y1,z0, x0,y0,z1, x1,y0,z1, x1,y1,z1, x0,y1,z1],
    index: [0,2,1,0,3,2, 4,5,6,4,6,7, 0,1,5,0,5,4, 2,3,7,2,7,6, 1,2,6,1,6,5, 3,0,4,3,4,7] });
  // Orthographic camera looking down -Z from z=+20 (view = translate(0,0,-20)); half-height 2.
  const view = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-20,1];
  const ortho = (hh, aspect) => [1/(hh*aspect),0,0,0, 0,1/hh,0,0, 0,0,-0.05,0, 0,0,-1.1,1];
  const cam = { view, proj: ortho(2, 1.5) };
  // 1) A single unit cube seen head-on: 4 outline edges visible, the back ones hidden behind the front face.
  const one = H.hiddenLineProject([box(-0.5,-0.5,-0.5, 0.5,0.5,0.5, "A-WALL")], cam, { includeHidden: true, width: 600 });
  const len = (arr) => arr.reduce((s, e) => s + Math.hypot(e.x2 - e.x1, e.y2 - e.y1), 0);
  ok(Math.abs(len(one.visible) - 4) < 0.15, "front square outline is 4 m long, got " + len(one.visible));
  ok(len(one.hidden) > 3.5, "the four rear edges are hidden behind the face, got " + len(one.hidden));
  ok(one.visible.every((e) => e.layer === "A-WALL"), "layer kept");
  // 2) A large plate in front of the cube hides it completely.
  const occ = H.hiddenLineProject([box(-0.5,-0.5,-0.5, 0.5,0.5,0.5, "A-WALL"), box(-1,-1,2, 1,1,2.1, "A-FLOR")], cam, { includeHidden: true, width: 600 });
  ok(!occ.visible.some((e) => e.layer === "A-WALL"), "cube behind the plate has no visible edges");
  ok(occ.hidden.some((e) => e.layer === "A-WALL"), "cube edges behind the plate are reported hidden");
  ok(Math.abs(len(occ.visible.filter((e) => e.layer === "A-FLOR")) - 8.2) < 0.4, "plate outline visible, got " + len(occ.visible.filter((e) => e.layer === "A-FLOR")));
  // 3) Plate beside the cube does not hide it.
  const side = H.hiddenLineProject([box(-0.5,-0.5,-0.5, 0.5,0.5,0.5, "A-WALL"), box(1.5,-1,2, 2.5,1,2.1, "A-FLOR")], cam, { includeHidden: false, width: 600 });
  ok(Math.abs(len(side.visible.filter((e) => e.layer === "A-WALL")) - 4) < 0.15, "cube stays visible beside the plate");
  // 4) Without includeHidden nothing hidden is returned.
  ok(H.hiddenLineProject([box(-0.5,-0.5,-0.5, 0.5,0.5,0.5, "A")], cam, { width: 600 }).hidden.length === 0, "hidden dropped when not requested");
  // 5) Coplanar triangle diagonals are not drawn (a quad face made of 2 triangles shows no diagonal).
  ok(one.visible.length <= 8, "no diagonal lines on flat faces, segments=" + one.visible.length);
  // 6) DXF text: LINE entities, dashed hidden layer, ends with EOF.
  const d = H.hlrToDxf(occ);
  ok(d.dxf.includes("\nLINE\n") && d.dxf.includes("A-WALL-HIDDEN") && d.dxf.includes("DASHED") && d.dxf.trimEnd().endsWith("EOF"), "DXF has LINEs, a dashed hidden layer and EOF");
  let pairs = true; const lines = d.dxf.split("\n"); for (let i = 0; i + 1 < lines.length - 1; i += 2) if (!/^\s*-?\d+$/.test(lines[i])) { pairs = false; break; }
  ok(pairs, "well-formed group-code pairs");
  // 7) Perspective camera: a cube in front of the camera is projected, one behind it is dropped, nothing throws.
  const f = 1 / Math.tan(Math.PI / 8), pn = 0.1, pf = 100;
  const persp = [f/1.5,0,0,0, 0,f,0,0, 0,0,(pf+pn)/(pn-pf),-1, 0,0,2*pf*pn/(pn-pf),0];
  const pr = H.hiddenLineProject([box(-0.5,-0.5,-0.5, 0.5,0.5,0.5, "A"), box(-0.5,-0.5,25,0.5,0.5,26, "B")], { view, proj: persp, distance: 20 }, { width: 600 });
  ok(pr.stats.perspective && pr.visible.length > 0, "perspective: visible lines");
  ok(!pr.visible.some((e) => e.layer === "B"), "a cube entirely behind the camera contributes nothing");
  // 8) Geometry crossing the camera plane is clipped, not dropped: a long wall from z=-10 to z=+30 seen from z=20 still draws its front part.
  const wall = H.hiddenLineProject([box(-3, -1, -10, -2.8, 1, 30, "A-WALL")], { view, proj: persp, distance: 10 }, { width: 600 });
  ok(wall.stats.droppedNearPlane > 0 && wall.visible.length > 0, "wall crossing the camera plane keeps its front part, clipped=" + wall.stats.droppedNearPlane + " lines=" + wall.visible.length);
  ok(wall.visible.every((e) => [e.x1, e.y1, e.x2, e.y2].every(Number.isFinite)), "all clipped coordinates are finite");
  // 9) A wall with a window opening (four slabs around a 1x1 hole) in front of a cube: edges show through the hole and are hidden behind the wall.
  const holeWall = [box(-2,-2,2, -0.5,2,2.2, "A-WALL"), box(0.5,-2,2, 2,2,2.2, "A-WALL"), box(-0.5,0.5,2, 0.5,2,2.2, "A-WALL"), box(-0.5,-2,2, 0.5,-0.5,2.2, "A-WALL")];
  const behind = box(-0.25,-0.25,-1, 0.25,0.25,0, "A-PROXY"); // seen through the opening
  const behindWall = box(1,-0.25,-1, 1.5,0.25,0, "A-DOOR"); // hidden behind the solid part of the wall
  const op = H.hiddenLineProject([...holeWall, behind, behindWall], cam, { includeHidden: true, width: 800 });
  const vis = (layer) => len(op.visible.filter((e) => e.layer === layer)), hid = (layer) => len(op.hidden.filter((e) => e.layer === layer));
  ok(vis("A-PROXY") > 1.5, "cube seen through the opening has visible edges, got " + vis("A-PROXY"));
  ok(vis("A-DOOR") < 0.1 && hid("A-DOOR") > 1.5, "cube behind solid wall is hidden, visible=" + vis("A-DOOR") + " hidden=" + hid("A-DOOR"));
  ok(vis("A-WALL") > 9, "wall outline and opening edge are drawn, got " + vis("A-WALL"));
  // 10) Seams: two pieces of one layer in one plane whose vertices do not meet (a T-junction) leave no line between them;
  //     the real outline beyond the joint stays; a different layer or a height step keeps the joint line.
  const along = (res, layer, x, y0, y1) => len(res.visible.filter((e) => e.layer === layer && Math.abs(e.x1 - x) < 0.03 && Math.abs(e.x2 - x) < 0.03 && Math.min(e.y1, e.y2) >= y0 - 0.03 && Math.max(e.y1, e.y2) <= y1 + 0.03));
  const pieceA = (layer) => box(-2, -1.5, 0, 0, 1.5, 1, layer), pieceB = (layer, top = 1) => box(0, -1.5, 0, 2, 0.5, top, layer);
  const seam = H.hiddenLineProject([pieceA("A-SLAB"), pieceB("A-SLAB")], cam, { width: 900 });
  ok(along(seam, "A-SLAB", 0, -1.5, 0.5) < 0.1, "no seam line where two coplanar same-layer pieces meet, got " + along(seam, "A-SLAB", 0, -1.5, 0.5));
  ok(along(seam, "A-SLAB", 0, 0.5, 1.5) > 0.8, "the real outline beyond the joint is kept, got " + along(seam, "A-SLAB", 0, 0.5, 1.5));
  const diff = H.hiddenLineProject([pieceA("A-SLAB"), pieceB("A-WALL")], cam, { width: 900 });
  ok(along(diff, "A-SLAB", 0, -1.5, 0.5) + along(diff, "A-WALL", 0, -1.5, 0.5) > 1.2, "joint between different layers stays drawn");
  const step = H.hiddenLineProject([pieceA("A-SLAB"), pieceB("A-SLAB", 1.5)], cam, { width: 900 });
  ok(along(step, "A-SLAB", 0, -1.5, 0.5) > 1.2, "a height step is a real edge and stays drawn, got " + along(step, "A-SLAB", 0, -1.5, 0.5));
  console.log(`hidden-line: ${n} assertions passed`);
} finally { fs.rmSync(out, { recursive: true, force: true }); }
