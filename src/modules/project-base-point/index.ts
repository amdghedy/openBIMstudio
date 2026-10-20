export * from "./types";
let installed = false;
export function setupprojectBasePoint() {
  if (installed) return; installed = true;
  console.log("[project-base-point] ready.");
}
