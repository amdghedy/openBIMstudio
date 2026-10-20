export * from "./types";
let installed = false;
export function setupdwgLinking() {
  if (installed) return; installed = true;
  console.log("[dwg-linking] ready.");
}
