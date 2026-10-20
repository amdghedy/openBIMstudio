export * from "./types";
let installed = false;
export function setupenergyAnalysis() {
  if (installed) return; installed = true;
  console.log("[energy-analysis] ready.");
}
