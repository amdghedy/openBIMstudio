// Regression coverage for native 2D dimension geometry and object snaps.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-dim-"));
try {
  execSync("npx tsc src/modules/cad-viewer/dimension-tools.ts src/modules/cad-viewer/viewer-math.ts --outDir " + out + " --module commonjs --target es2020 --skipLibCheck", { cwd: root, stdio: "inherit" });
  const locate = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = locate(p, name); if (found) return found; }
      else if (entry.name === name) return p;
    }
    return null;
  };
  const dimPath = locate(out, "dimension-tools.js");
  const mathPath = locate(out, "viewer-math.js");
  assert.ok(dimPath && mathPath, "compiled CAD modules should exist");
  const { buildLinearDimension } = require(dimPath);
  const M = require(mathPath);

  const aligned = buildLinearDimension({
    first: { x: 0, y: 0 }, second: { x: 4, y: 3 }, placement: { x: 0, y: 5 },
    mode: "aligned", layer: "DIMENSIONS", text: "5.000 m", textHeight: 0.0025,
  });
  assert.strictEqual(aligned.length, 8, "aligned dimension should include two witnesses, a dimension line, four ticks and text");
  assert.strictEqual(aligned.filter(e => e.type === "LINE").length, 7);
  assert.strictEqual(aligned.filter(e => e.type === "TEXT").length, 1);
  assert.ok(aligned.every(e => e.layer === "DIMENSIONS"));
  assert.strictEqual(aligned.find(e => e.type === "TEXT").value, "5.000 m");

  const horizontal = buildLinearDimension({
    first: { x: 0, y: 0 }, second: { x: 5, y: 2 }, placement: { x: 2, y: 4 },
    mode: "linear", layer: "0", text: "5", textHeight: 0.1,
  });
  assert.ok(horizontal.length >= 6);
  const dimLine = horizontal.filter(e => e.type === "LINE").find(e => Math.abs(e.start.y - e.end.y) < 1e-9);
  assert.ok(dimLine, "linear dimension should create a horizontal dimension line");
  assert.strictEqual(buildLinearDimension({
    first: { x: 1, y: 1 }, second: { x: 1, y: 1 }, placement: { x: 2, y: 2 },
    mode: "aligned", layer: "0", text: "0", textHeight: 1,
  }).length, 0, "zero-length dimensions should be rejected");

  const line = { type: "LINE", layer: "0", start: { x: -5, y: 0 }, end: { x: 5, y: 0 } };
  const circle = { type: "CIRCLE", layer: "0", center: { x: 0, y: 5 }, radius: 1 };
  const entities = [line, circle];
  const index = M.buildIndex(entities, { minX: -6, minY: -2, maxX: 6, maxY: 7 });
  const perp = M.findSnap(index, entities, 2, 0.02, 0.1, ["perpendicular"], () => true, { x: 2, y: 3 });
  assert.ok(perp && perp.kind === "perpendicular" && Math.abs(perp.x - 2) < 1e-8 && Math.abs(perp.y) < 1e-8);
  const parallel = M.findSnap(index, entities, 3, 3.04, 0.1, ["parallel"], () => true, { x: 0, y: 3 });
  assert.ok(parallel && parallel.kind === "parallel" && Math.abs(parallel.y - 3) < 1e-8);
  const tangent = M.findSnap(index, entities, 0.8, 4.4, 0.15, ["tangent"], () => true, { x: -3, y: 5 });
  assert.ok(tangent && tangent.kind === "tangent", "tangent snap should find a circle tangent point");
  console.log("CAD dimension and object-snap regression tests passed.");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
