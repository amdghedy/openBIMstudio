// model-to-dxf3d: mesh -> DXF R12 3DFACE text (pure logic).
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(root, ".m3d-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try {
  execSync(`npx tsc src/modules/export/model-to-dxf3d.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --lib es2020`, { stdio: "pipe", cwd: root });
  const M = require(path.join(out, "model-to-dxf3d.js"));
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
  // unit cube 1 m, 12 triangles, translated by (10, 2, 5): x east, y up, z north.
  const pos = [0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1];
  const idx = [0,2,1,0,3,2, 4,5,6,4,6,7, 0,1,5,0,5,4, 2,3,7,2,7,6, 1,2,6,1,6,5, 3,0,4,3,4,7];
  const tr = [1,0,0,0, 0,1,0,0, 0,0,1,0, 10,2,5,1];
  const r = M.meshesToDxf3d([{ layer: "A-WALL", positions: pos, index: idx, matrix: tr }], { units: "mm" });
  ok(r.faces === 12 && r.byLayer["A-WALL"] === 12, "12 faces on A-WALL");
  ok(r.bounds.min[0] === 10000 && r.bounds.max[0] === 11000, "X east in mm");
  ok(r.bounds.min[1] === 5000 && r.bounds.max[1] === 6000, "CAD Y is app Z (north)");
  ok(r.bounds.min[2] === 2000 && r.bounds.max[2] === 3000, "CAD Z is app Y (up)");
  const lines = r.dxf.split("\n");
  ok(lines.filter((l) => l === "3DFACE").length === 12 && lines[lines.length - 2] === "EOF", "12 3DFACE records, ends with EOF");
  // group codes alternate: every even index is a numeric code
  let pairsOk = true; for (let i = 0; i + 1 < lines.length - 1; i += 2) if (!/^\s*-?\d+$/.test(lines[i])) { pairsOk = false; break; }
  ok(pairsOk, "well-formed code/value pairs");
  ok(r.dxf.includes("$ACADVER\n1\nAC1009") && r.dxf.includes("$INSUNITS\n70\n4"), "R12 header with mm units");
  ok(M.meshesToDxf3d([{ layer: "x", positions: pos, index: idx }], { units: "m" }).dxf.includes("$INSUNITS\n70\n6"), "metre units");
  const bad = M.meshesToDxf3d([{ layer: "L", positions: [0,0,0, 1,1,1, 2,2,2, NaN,0,0], index: [0,1,2, 0,1,3, 0,1,9] }]);
  ok(bad.faces === 0 && bad.skippedDegenerate === 3, "collinear, NaN and out-of-range triangles skipped");
  const nonIdx = M.meshesToDxf3d([{ layer: "L", positions: [0,0,0, 1,0,0, 0,1,0] }]);
  ok(nonIdx.faces === 1, "non-indexed triangle");
  ok(M.layerForElementType("Wall") === "A-WALL" && M.layerForElementType("column") === "S-COLS" && M.layerForElementType("weird type!") === "A-WEIRD-TYPE" && M.layerForElementType(undefined) === "A-MODEL", "layer by element type");
  ok(M.meshesToDxf3d([{ layer: "a/b:c", positions: pos, index: idx }], { layerPrefix: "P-" }).byLayer["P-a_b_c"] === 12, "layer name sanitised + prefix");
  console.log(`model-to-dxf3d: ${n} assertions passed`);
} finally { fs.rmSync(out, { recursive: true, force: true }); }
