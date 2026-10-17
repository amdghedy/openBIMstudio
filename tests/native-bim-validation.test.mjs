import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/modules/native-bim/model-validation.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const mod = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const { validateNativeModel, isNativeModelValid, summarizeDiagnostics } = mod;

const wall = {
  id: "wall-1", type: "wall", name: "Wall 1",
  params: { start: [0, 0], end: [5, 0], height: 3, thickness: 0.2, elevation: 0 },
};
const door = {
  id: "door-1", type: "door", name: "Door 1", hostId: "wall-1",
  params: { point: [2, 0], width: 0.9, height: 2.1, thickness: 0.05, elevation: 0, offsetAlongHost: 2.5, sillHeight: 0 },
};
const valid = { elements: [wall, door], levels: [{ id: "L0", name: "Ground", elevation: 0 }] };
assert.equal(isNativeModelValid(valid), true, "valid hosted wall/door should pass");
assert.deepEqual(summarizeDiagnostics(validateNativeModel(valid)), { total: 0, errors: 0, warnings: 0, info: 0 });

const badLinear = { ...wall, params: { ...wall.params, end: [0, 0] } };
assert.ok(validateNativeModel({ elements: [badLinear] }).some((d) => d.code === "LINEAR_LENGTH_ZERO"));
assert.equal(isNativeModelValid({ elements: [badLinear] }), false);

const missingHost = { ...door, hostId: "missing-wall" };
assert.ok(validateNativeModel({ elements: [wall, missingHost] }).some((d) => d.code === "HOST_REFERENCE_MISSING"));

const wrongHost = { ...door, hostId: "door-1" };
assert.ok(validateNativeModel({ elements: [wall, wrongHost] }).some((d) => d.code === "HOST_SELF_REFERENCE"));

const duplicateIfc = [
  wall,
  { ...wall, id: "wall-2", ifc: { entity: "IfcWall", globalId: "same-guid" } },
  { ...wall, id: "wall-3", ifc: { entity: "IfcWall", globalId: "same-guid" } },
];
assert.ok(validateNativeModel({ elements: duplicateIfc }).some((d) => d.code === "IFC_GLOBAL_ID_DUPLICATE"));

const badMesh = { ...wall, nativeGeometry: { positions: [0, 0, 0, 1, 0, 0] } };
assert.ok(validateNativeModel({ elements: [badMesh] }).some((d) => d.code === "NATIVE_GEOMETRY_TRIANGLES_INVALID"));

const badTransform = { ...wall, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 0], scale: [1, 1, 1] } };
assert.ok(validateNativeModel({ elements: [badTransform] }).some((d) => d.code === "TRANSFORM_QUATERNION_INVALID"));

const badGrid = { id: "grid-1", label: "A", start: [1, 1], end: [1, 1] };
assert.ok(validateNativeModel({ elements: [], grids: [badGrid] }).some((d) => d.code === "GRID_LENGTH_ZERO"));

console.log("PASS native BIM validation: valid model, degenerate geometry, hosted relationships, IFC identity, mesh payload, transforms and grids");
