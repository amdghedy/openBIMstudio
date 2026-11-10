/**
 * Work-plane geometry and persistence regression tests.
 * Run: node tests/work-planes.test.cjs
 */
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-work-planes-"));
const root = path.resolve(__dirname, "..");

execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(out) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck " +
  "src/modules/work-planes/types.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const wp = require(path.join(out, "modules/work-planes/types.js"));

function near(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, actual + " != " + expected);
}

try {
  const horizontal = wp.createWorkPlane("Level 02", [0, 3, 0], [0, 4, 0]);
  assert.equal(horizontal.active, true);
  assert.deepEqual(horizontal.normal, [0, 1, 0]);
  near(wp.distanceToWorkPlane([1, 5, 2]), 2);
  assert.deepEqual(wp.projectWorldPoint([1, 5, 2]), [1, 3, 2]);

  const facePlane = wp.createWorkPlane("Picked sloped face", [1, 2, 3], [0, 1, 1], {
    elementId: "wall-01",
    meshIndex: 2,
    faceIndex: 8,
    localOrigin: [0.2, 0.4, 0.6],
    localNormal: [0, 1, 0],
  });
  near(Math.hypot(...facePlane.normal), 1);
  near(wp.distanceToWorkPlane([1, 4, 5]), 2 * Math.SQRT2);
  const projected = wp.projectWorldPoint([1, 4, 5]);
  near(projected[1] - facePlane.origin[1] + projected[2] - facePlane.origin[2], 0);
  assert.equal(facePlane.face.elementId, "wall-01");
  assert.deepEqual(facePlane.face.localOrigin, [0.2, 0.4, 0.6]);

  const uvPlane = wp.createWorkPlane("Facade elevation", [1, 2, 5], [0, 0, 3]);
  assert.deepEqual(wp.projectOntoWorkPlane(3, 4, 99), [2, 2]);

  const snapshot = wp.serializeWorkPlanes();
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.activeId, uvPlane.id);
  assert.equal(snapshot.planes.length, 3);
  wp.removeWorkPlane(uvPlane.id);
  assert.equal(wp.getActiveWorkPlane(), null);
  wp.restoreWorkPlanes(snapshot);
  assert.equal(wp.getActiveWorkPlane().id, uvPlane.id);
  assert.equal(wp.get("wp-2").face.elementId, "wall-01");
  assert.equal(wp.setActiveWorkPlane("missing"), false);

  assert.throws(() => wp.createWorkPlane("bad", [0, 0, 0], [0, 0, 0]), /zero vector/);
  assert.throws(() => wp.createWorkPlane("", [0, 0, 0]), /name is required/);

  console.log("PASS arbitrary work planes, face references, projections and JSON snapshot restore");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
