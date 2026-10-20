export * from "./types";
let installed = false;
export function setupgridBubbles() {
  if (installed) return; installed = true;
  console.log("[grid-bubbles] ready.");
}
