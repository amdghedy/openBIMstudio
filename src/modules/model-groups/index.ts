export * from "./types";
let installed = false;
export function setupmodelGroups() {
  if (installed) return; installed = true;
  console.log("[model-groups] ready.");
}
