export * from "./types";
export * from "./fem";
export * from "./checks";
export * from "./sections";

let installed = false;
export function setupanalyticalModel() {
  if (installed) return; installed = true;
  console.log("[analytical-model] ready. Build FEM models via __obsAnalytical.");
}
