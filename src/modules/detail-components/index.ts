export * from "./types";

let installed = false;
export function setupDetailComponents() {
  if (installed) return;
  installed = true;
  (window as any).__obsDetailComponents = {
    list: () => require("./types").listComponents(),
    get: (id: string) => require("./types").getComponent(id),
  };
  console.log("[detail-components] ready. 6 built-in components (brick, block, joint, deck, bolt, angle).");
}
export function isReady() { return installed; }
