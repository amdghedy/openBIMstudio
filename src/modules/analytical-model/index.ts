export * from "./types";
let installed = false;
export function setupanalyticalModel() {
  if (installed) return; installed = true;
  console.log("[analytical-model] ready.");
}
