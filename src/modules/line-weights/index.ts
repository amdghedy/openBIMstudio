export * from "./types";
let installed = false;
export function setuplineWeights() {
  if (installed) return; installed = true;
  console.log("[line-weights] ready.");
}
