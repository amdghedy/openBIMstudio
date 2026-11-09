/**
 * Native adaptive-component integration tests.
 *
 * Verifies that adaptive definitions live on authored project elements,
 * rebuild through the existing mesh-builder hook, and remain editable after
 * JSON save/reopen. Also exercises undo/redo and atomic repeated placement.
 */
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-adaptive-native-"));
process.env.NODE_PATH = path.join(root, "node_modules");
Module._initPaths();

execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(out) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/adaptive/native-integration.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

// Establish the minimum browser globals before importing the feature.
global.window = {};
const { ctx } = require(path.join(out, "core/context.js"));
const { history } = require(path.join(out, "features/history.js"));
const adaptive = require(path.join(out, "modules/adaptive/native-integration.js"));

const elements = [];
const selected = [];
let rebuildCount = 0;
let failNextRebuild = false;
const authoring = {
  getElements: () => elements,
  getSelectedIds: () => selected.slice(),
  getActiveLevelId: () => "LEVEL-01",
  setSelectedAuthored(ids) { selected.splice(0, selected.length, ...ids); },
  rebuildAuthored() {
    rebuildCount++;
    if (failNextRebuild) {
      failNextRebuild = false;
      throw new Error("simulated adaptive rebuild failure");
    }
  },
};
ctx.features.authoring = authoring;

function square(size = 0.1) {
  const h = size / 2;
  return [
    { u: -h, v: -h }, { u: h, v: -h },
    { u: h, v: h }, { u: -h, v: h },
  ];
}
function p(x, y, z) { return { x, y, z }; }
function near(a, b, tol = 1e-6) {
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);
}
function meshPositions(object) {
  const values = [];
  object.traverse((node) => {
    if (node.isMesh) values.push(...node.geometry.getAttribute("position").array);
  });
  return values;
}

async function main() {
  const api = adaptive.setupAdaptiveAuthoring();
  assert.equal(typeof api.create, "function");
  assert.equal(typeof api.createMany, "function");
  assert.equal(typeof api.update, "function");
  assert.equal(ctx.features.meshBuilders["adaptive-component"], adaptive.buildAdaptiveElementMesh);

  const first = api.create({
    familyId: "test-rafter",
    familyName: "Test Rafter",
    points: [p(0, 0, 0), p(3, 0, 0), p(3, 0, 2)],
    profile: square(0.1),
    name: "Rafter A",
  });
  assert.equal(first.type, "adaptive-component");
  assert.equal(first.familyId, "test-rafter");
  assert.equal(first.levelId, "LEVEL-01");
  assert.equal(first.properties.adaptiveDefinition.pointCount, 3);
  assert.deepEqual(first.properties.adaptiveDefinition.points, [p(0, 0, 0), p(3, 0, 0), p(3, 0, 2)]);
  assert.equal(elements.length, 1);
  assert.deepEqual(selected, [first.id]);
  assert.ok(rebuildCount > 0);

  const initialPositions = meshPositions(api.buildMesh(first));
  assert.ok(initialPositions.length > 0, "native mesh has positions");

  // Save/reopen boundary: the definition survives ordinary ProjectDoc JSON.
  const reopenedElement = JSON.parse(JSON.stringify(first));
  assert.deepEqual(meshPositions(api.buildMesh(reopenedElement)), initialPositions);
  assert.equal(api.getDefinition(first.id).familyId, "test-rafter");

  // Point edits update the stored definition and regenerate the mesh.
  const updatedPoints = [p(0, 0, 0), p(4, 0, 0), p(4, 0, 2)];
  assert.equal(api.update(first.id, { points: updatedPoints, name: "Rafter A revised" }), true);
  assert.deepEqual(api.getDefinition(first.id).points, updatedPoints);
  assert.equal(first.name, "Rafter A revised");
  const updatedPositions = meshPositions(api.buildMesh(first));
  assert.notDeepEqual(updatedPositions, initialPositions);

  const updatedDefinition = api.getDefinition(first.id);
  const undoDepthBeforeFailedUpdate = history.depth().undo;
  failNextRebuild = true;
  await assert.rejects(history.undo(), /simulated adaptive rebuild failure/);
  assert.deepEqual(api.getDefinition(first.id), updatedDefinition, "failed undo restores the edited definition");
  assert.equal(first.name, "Rafter A revised", "failed undo restores the edited name");
  assert.equal(history.depth().undo, undoDepthBeforeFailedUpdate, "failed undo remains retryable");

  await history.undo();
  assert.deepEqual(api.getDefinition(first.id).points, [p(0, 0, 0), p(3, 0, 0), p(3, 0, 2)]);
  assert.equal(first.name, "Rafter A");

  failNextRebuild = true;
  await assert.rejects(history.redo(), /simulated adaptive rebuild failure/);
  assert.deepEqual(api.getDefinition(first.id).points, [p(0, 0, 0), p(3, 0, 0), p(3, 0, 2)], "failed redo keeps the pre-redo definition");
  await history.redo();
  assert.deepEqual(api.getDefinition(first.id).points, updatedPoints);

  // A failed initial rebuild must not insert a half-created authored element
  // or add an undo command.
  const createFailureBaseline = elements.length;
  const createUndoDepth = history.depth().undo;
  failNextRebuild = true;
  assert.throws(() => api.create({
    familyId: "failed-create",
    familyName: "Failed Create",
    points: [p(10, 0, 0), p(11, 0, 0)],
    profile: square(0.1),
  }), /simulated adaptive rebuild failure/);
  assert.equal(elements.length, createFailureBaseline, "failed creation leaves no project element");
  assert.equal(history.depth().undo, createUndoDepth, "failed creation adds no undo command");

  // One-point components extrude along local +Y and are regular authored elements.
  const post = api.create({
    familyId: "single-post",
    familyName: "Single Post",
    points: [p(5, 1, 2)],
    profile: square(0.2),
    pointLength: 2.5,
  });
  assert.equal(post.properties.adaptiveDefinition.pointCount, 1);
  assert.equal(post.properties.adaptiveDefinition.pointLength, 2.5);
  const postObject = api.buildMesh(post);
  const ys = [];
  postObject.traverse((node) => {
    if (!node.isMesh) return;
    const a = node.geometry.getAttribute("position").array;
    for (let i = 1; i < a.length; i += 3) ys.push(a[i]);
  });
  near(Math.min(...ys), 1);
  near(Math.max(...ys), 3.5);

  // Undo/redo rebuild failures must leave the one-point instance in its
  // original state and keep the failed command available for retry.
  const elementsWithPost = elements.length;
  failNextRebuild = true;
  await assert.rejects(history.undo(), /simulated adaptive rebuild failure/);
  assert.equal(elements.length, elementsWithPost, "failed undo restores the removed element");
  assert.ok(elements.some((element) => element.id === post.id));
  await history.undo();
  assert.ok(!elements.some((element) => element.id === post.id), "successful undo removes the post");
  failNextRebuild = true;
  await assert.rejects(history.redo(), /simulated adaptive rebuild failure/);
  assert.ok(!elements.some((element) => element.id === post.id), "failed redo removes the partially-added element");
  await history.redo();
  assert.ok(elements.some((element) => element.id === post.id), "successful redo restores the post");

  // A normal edit whose first rebuild fails must also restore the old model
  // definition before reporting the error.
  const beforeFailedEdit = api.getDefinition(first.id);
  const failedEditUndoDepth = history.depth().undo;
  failNextRebuild = true;
  assert.throws(() => api.update(first.id, {
    points: [p(0, 0, 0), p(9, 0, 0), p(9, 0, 2)],
  }), /simulated adaptive rebuild failure/);
  assert.deepEqual(api.getDefinition(first.id), beforeFailedEdit, "failed edit restores its prior definition");
  assert.equal(history.depth().undo, failedEditUndoDepth, "failed edit adds no undo command");

  // Invalid edits are rejected before mutating the authored element.
  const beforeInvalid = api.getDefinition(first.id);
  assert.throws(() => api.update(first.id, {
    profile: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 2, v: 0 }],
  }), /area|profile/i);
  assert.deepEqual(api.getDefinition(first.id), beforeInvalid);

  // Repeated placement is grouped into one undoable operation.
  const batchBefore = elements.length;
  const batch = await api.createMany([
    { familyId: "fin", familyName: "Fin", points: [p(0, 0, 0), p(1, 0, 0)], profile: square(0.05) },
    { familyId: "fin", familyName: "Fin", points: [p(1, 0, 0), p(2, 0, 0)], profile: square(0.05) },
    { familyId: "fin", familyName: "Fin", points: [p(2, 0, 0), p(3, 0, 0)], profile: square(0.05) },
  ]);
  assert.equal(batch.length, 3);
  assert.equal(elements.length, batchBefore + 3);
  await history.undo();
  assert.equal(elements.length, batchBefore, "one undo removes the repeated placement");
  await history.redo();
  assert.equal(elements.length, batchBefore + 3, "one redo restores the repeated placement");

  // A failed batch rolls back the earlier successful items.
  const failureBaseline = elements.length;
  await assert.rejects(api.createMany([
    { familyId: "valid", familyName: "Valid", points: [p(0, 0, 0), p(1, 0, 0)], profile: square() },
    { familyId: "invalid", familyName: "Invalid", points: [p(0, 0, 0)], profile: [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 2, v: 0 }] },
  ]));
  assert.equal(elements.length, failureBaseline, "failed batch must roll back earlier elements");

  console.log("PASS native adaptive creation, regeneration, JSON persistence, edit, undo/redo and batch rollback");
  fs.rmSync(out, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
