export * from "./types";
let installed = false;
export function setuppluginMarketplace() {
  if (installed) return; installed = true;
  console.log("[plugin-marketplace] ready.");
}
