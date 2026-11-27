export * from "./types";
// NOTE: the old setup bag called require("./types") at runtime, which does not
// exist in a Vite ESM browser bundle. Static imports instead.
import { assignMaterial, getMaterial, listMaterials, getMaterialDef, getAllAssignments } from "./types";
let installed = false;
let materialsApi: any = null;
export function setupMaterialAssignment() {
  if (installed) return materialsApi; installed = true;
  materialsApi = { assign: assignMaterial, get: getMaterial, list: listMaterials, getDef: getMaterialDef, all: getAllAssignments };
  console.log("[materials] ready. 9 built-in materials (concrete, steel, rebar, brick, glass, wood, aluminium, gypsum, insulation).");
  return materialsApi;
}
