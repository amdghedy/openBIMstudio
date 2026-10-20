export * from "./types";
let installed = false;
export function setupworkPlanes() {
  if (installed) return; installed = true;
  console.log("[work-planes] ready.");
}
