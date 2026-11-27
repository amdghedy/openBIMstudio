export * from "./types";
// NOTE: the old setup bag called require("./types") at runtime, which does not
// exist in a Vite ESM browser bundle. Static imports instead.
import { listComponents, getComponent } from "./types";

let installed = false;
let detailComponentsApi: any = null;
export function setupDetailComponents() {
  if (installed) return detailComponentsApi;
  installed = true;
  detailComponentsApi = {
    list: () => listComponents(),
    get: (id: string) => getComponent(id),
  };
  console.log("[detail-components] ready. 6 built-in components (brick, block, joint, deck, bolt, angle).");
  return detailComponentsApi;
}
export function isReady() { return installed; }
