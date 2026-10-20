export * from "./types";
let installed = false;
export function setupinPlaceMass() {
  if (installed) return; installed = true;
  console.log("[in-place-mass] ready.");
}
