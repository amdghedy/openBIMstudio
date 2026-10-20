export * from "./types";
let installed = false;
export function setupMaterialAssignment() {
  if (installed) return; installed = true;
  (window as any).__obsMaterials = { assign: (e: string, m: string) => require("./types").assignMaterial(e, m), get: (e: string) => require("./types").getMaterial(e), list: () => require("./types").listMaterials(), getDef: (id: string) => require("./types").getMaterialDef(id), all: () => require("./types").getAllAssignments() };
  console.log("[materials] ready. 9 built-in materials (concrete, steel, rebar, brick, glass, wood, aluminium, gypsum, insulation).");
}
