export * from "./types";
let installed = false;
export function setupsunSettings() {
  if (installed) return; installed = true;
  console.log("[sun-settings] ready.");
}
