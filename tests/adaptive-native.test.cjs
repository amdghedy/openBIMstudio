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
  assert.equal(typeof api.beginPointEdit, "function");
  assert.equal(typeof api.previewPointEdit, "function");
  assert.equal(typeof api.commitPointEdit, "function");
  assert.equal(typeof api.cancelPointEdit, "function");
  assert.equal(typeof api.bindFamilyType, "function");
  assert.equal(typeof api.propagateFamilyTypes, "function");
  assert.equal(typeof api.registerCustomFamilyProfileAdapter, "function");
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


  // Live viewport grip editing previews geometry without adding history until release.
  const gripBaseline = api.beginPointEdit(first.id);
  assert.ok(gripBaseline, "selected adaptive element exposes a point edit snapshot");
  const gripUndoBaseline = history.depth().undo;
  assert.equal(api.previewPointEdit(first.id, 1, p(5, 0, 0), gripBaseline), true);
  assert.deepEqual(api.getDefinition(first.id).points[1], p(5, 0, 0), "live preview updates stored point data");
  assert.equal(history.depth().undo, gripUndoBaseline, "pointer-move previews do not create undo entries");
  assert.equal(api.commitPointEdit(first.id, gripBaseline), true);
  assert.equal(history.depth().undo, gripUndoBaseline + 1, "pointer release commits exactly one undo entry");
  await history.undo();
  assert.deepEqual(api.getDefinition(first.id).points, updatedPoints, "undo restores the pre-drag points");
  await history.redo();
  assert.deepEqual(api.getDefinition(first.id).points[1], p(5, 0, 0), "redo reapplies the committed grip move");

  // Escape/cancel restores the baseline and does not add a history item.
  const cancelBaseline = api.beginPointEdit(first.id);
  const cancelUndoDepth = history.depth().undo;
  assert.equal(api.previewPointEdit(first.id, 1, p(6, 0, 0), cancelBaseline), true);
  assert.equal(api.cancelPointEdit(first.id, cancelBaseline), true);
  assert.deepEqual(api.getDefinition(first.id).points[1], p(5, 0, 0));
  assert.equal(history.depth().undo, cancelUndoDepth);

  // Geometric constraints are saved in the project definition and solved at creation.
  const constrained = api.create({
    familyId: "constrained-beam",
    familyName: "Constrained Beam",
    points: [p(0, 0, 0), p(3, 0, 0)],
    profile: square(0.1),
    constraints: [{ kind: "distance", a: 0, b: 1, distance: 5, driven: "b" }],
  });
  assert.deepEqual(constrained.properties.adaptiveDefinition.constraints, [
    { kind: "distance", a: 0, b: 1, distance: 5, driven: "b" },
  ]);
  near(constrained.properties.adaptiveDefinition.points[1].x, 5);
  const constrainedReopened = JSON.parse(JSON.stringify(constrained));
  assert.deepEqual(constrainedReopened.properties.adaptiveDefinition.constraints,
    constrained.properties.adaptiveDefinition.constraints, "constraints survive ordinary project JSON persistence");

  // Shared family-type binding drives the adaptive section and propagates type edits.
  let sharedWidth = 0.1;
  let familyChanged = null;
  const sharedFamily = {
    id: "catalog-box",
    name: "Catalog Box",
    types: [{ id: "type-a", name: "Type A" }],
    geometry: {
      kind: "box",
      w: { ref: "width" },
      d: { ref: "depth" },
      h: { ref: "height" },
    },
  };
  const composedFamily = {
    id: "catalog-composed",
    name: "Compound Bracket",
    types: [{ id: "type-a", name: "Type A" }],
    geometry: {
      kind: "composed",
      parts: [
        { kind: "box", w: { ref: "width" }, d: { const: 0.12 }, h: { const: 0.25 },
          transform: { translate: [{ const: 0 }, { const: 0 }, { const: 0 }] } },
        { kind: "cylinder", r: { ref: "radius" }, h: { const: 0.4 },
          transform: { translate: [{ const: 0.3 }, { const: 0 }, { const: 0 }] } },
      ],
    },
  };
  const customFamily = {
    id: "catalog-custom",
    name: "Custom Assembly",
    types: [{ id: "type-a", name: "Type A" }],
    geometry: { kind: "custom", builder: "test-custom-section" },
  };
  const sharedFamilies = [sharedFamily, composedFamily, customFamily];
  api.registerCustomFamilyProfileAdapter("test-custom-section", (params) => [
    { name: "Custom leg", profile: square(Number(params.width)) },
    { name: "Custom flange", profile: square(Number(params.depth)) },
  ]);
  ctx.features.family = {
    get: (id) => sharedFamilies.find((family) => family.id === id) ?? null,
    list: () => sharedFamilies,
    resolveParams: () => ({ width: sharedWidth, depth: 0.2, radius: 0.04, height: 3 }),
    onChange(callback) {
      familyChanged = callback;
      return () => { familyChanged = null; };
    },
  };
  api.connectFamilyTypePropagation();
  assert.ok(api.listFamilyTypeChoices().some((choice) =>
    choice.familyId === "catalog-box" && choice.typeId === "type-a"));
  assert.equal(api.bindFamilyType(constrained.id, "catalog-box", "type-a"), true);
  assert.deepEqual(api.getDefinition(constrained.id).familyBinding,
    { familyId: "catalog-box", typeId: "type-a" });
  assert.equal(constrained.familyId, "catalog-box");
  assert.equal(constrained.familyTypeId, "type-a");
  near(Math.max(...api.getDefinition(constrained.id).profile.map((point) => point.u)) -
    Math.min(...api.getDefinition(constrained.id).profile.map((point) => point.u)), 0.1);
  sharedWidth = 0.3;
  assert.equal(await api.propagateFamilyTypes(), 1, "shared type change updates linked adaptive instances");
  near(Math.max(...api.getDefinition(constrained.id).profile.map((point) => point.u)) -
    Math.min(...api.getDefinition(constrained.id).profile.map((point) => point.u)), 0.3);
  sharedWidth = 0.4;
  assert.equal(typeof familyChanged, "function", "family change listener is connected");
  familyChanged();
  await new Promise((resolve) => setTimeout(resolve, 0));
  near(Math.max(...api.getDefinition(constrained.id).profile.map((point) => point.u)) -
    Math.min(...api.getDefinition(constrained.id).profile.map((point) => point.u)), 0.4);

  // Composite family types preserve every independently swept part in the model.
  const compoundInstance = api.create({
    familyId: "compound-seed",
    familyName: "Compound seed",
    points: [p(0, 0, 0), p(2, 0, 0)],
    profile: square(0.1),
  });
  assert.equal(api.bindFamilyType(compoundInstance.id, "catalog-composed", "type-a"), true);
  const compoundDefinition = api.getDefinition(compoundInstance.id);
  assert.equal(compoundDefinition.profileParts.length, 2);
  assert.equal(api.buildMesh(elements.find((entry) => entry.id === compoundInstance.id)).children.length, 2);
  assert.equal(compoundDefinition.familyBinding.familyId, "catalog-composed");

  // Registered custom-family adapters map custom builder parameters to exact
  // profile parts; unsupported builders remain excluded from the type picker.
  const customInstance = api.create({
    familyId: "custom-seed",
    familyName: "Custom seed",
    points: [p(0, 0, 0), p(1, 0, 0)],
    profile: square(0.1),
  });
  assert.equal(api.bindFamilyType(customInstance.id, "catalog-custom", "type-a"), true);
  assert.equal(api.getDefinition(customInstance.id).profileParts.length, 2);
  assert.equal(api.buildMesh(elements.find((entry) => entry.id === customInstance.id)).children.length, 2);
  sharedWidth = 0.5;
  assert.equal(await api.propagateFamilyTypes(), 2, "compound and custom linked family sections update together");
  assert.equal(api.getDefinition(compoundInstance.id).profileParts.length, 2);
  near(Math.max(...api.getDefinition(customInstance.id).profileParts[0].profile.map((point) => point.u)) -
    Math.min(...api.getDefinition(customInstance.id).profileParts[0].profile.map((point) => point.u)), 0.5);

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
