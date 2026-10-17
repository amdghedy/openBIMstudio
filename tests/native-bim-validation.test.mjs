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
const doorBeyondHost = {
  ...door,
  id: "door-too-wide",
  params: { ...door.params, width: 1.2, offsetAlongHost: 0.2 },
};
const hostExtentIssues = validateNativeModel({ elements: [wall, doorBeyondHost] });
assert.ok(hostExtentIssues.some(d => d.code === "HOSTED_ELEMENT_EXCEEDS_HOST_LENGTH" && d.elementId === "door-too-wide"),
  "hosted opening that extends beyond the wall end must be blocked");
assert.equal(isNativeModelValid({ elements: [wall, doorBeyondHost] }), false,
  "hosted opening outside the wall must fail blocking validation");
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

const { validateDocumentationSet, summarizeDocumentationDiagnostics } = await import(
  "data:text/javascript;base64," + Buffer.from(ts.transpileModule(
    fs.readFileSync(path.join(root, "src/modules/native-bim/documentation-validation.ts"), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
  ).outputText).toString("base64")
);
const docBase = {
  sheets: [{ id: "s1", number: "A-101", name: "Ground Plan", size: "A1", orientation: "landscape", viewports: [
    { id: "vp1", viewId: "v1", x: 20, y: 20, width: 300, height: 200, scale: "1:100" },
    { id: "vp2", viewId: "v2", x: 250, y: 100, width: 300, height: 200, scale: "1:50" },
  ] }],
  views: [{ id: "v1", name: "Ground Plan", scale: 100 }, { id: "v2", name: "Section A-A", scale: 50 }],
  sheetSizesMm: { s1: { w: 841, h: 594 } },
};
assert.ok(validateDocumentationSet(docBase).some(d => d.code === "VIEWPORT_OVERLAP"), "overlapping viewports should be reported");
assert.equal(validateDocumentationSet({ ...docBase, sheets: [{ ...docBase.sheets[0], viewports: [docBase.sheets[0].viewports[0]] }] }).length, 0, "valid documentation set should pass");
const brokenDoc = { ...docBase, sheets: [{ ...docBase.sheets[0], number: "A-101", viewports: [
  { id: "bad-vp", viewId: "missing-view", x: 900, y: 10, width: 20, height: 20, scale: "0:0" }
] }] };
const docIssues = validateDocumentationSet(brokenDoc);
for (const code of ["VIEWPORT_VIEW_MISSING", "VIEWPORT_OUTSIDE_SHEET", "VIEWPORT_SCALE_INVALID"]) {
  assert.ok(docIssues.some(d => d.code === code), "expected documentation diagnostic " + code);
}
assert.deepEqual(summarizeDocumentationDiagnostics(docIssues), {
  total: docIssues.length,
  errors: docIssues.filter(d => d.severity === "error").length,
  warnings: docIssues.filter(d => d.severity === "warning").length,
});
console.log("PASS documentation QA: valid layout, viewport overlap, missing views, sheet bounds and scales");
