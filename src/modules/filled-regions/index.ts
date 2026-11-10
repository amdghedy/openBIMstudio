import {
  addRegion, getRegions, removeRegion, updateRegion, regionsToEntities,
  serializeRegions, loadRegions, countRegions,
} from "./types";

export * from "./types";
export * from "./polygon";

let installed = false;

/**
 * Boot wiring: exposes the region store on `window` for ribbon/panel code
 * that loads before this module. All functions are real imports — no CJS
 * `require()` (which would throw in the browser bundle).
 */
export function setupFilledRegions() {
  if (installed) return;
  installed = true;
  (window as any).__obsFilledRegions = {
    add: (r: any) => addRegion(r),
    get: (v: string) => getRegions(v),
    remove: (v: string, id: string) => removeRegion(v, id),
    update: (v: string, id: string, patch: any) => updateRegion(v, id, patch),
    toEntities: (v: string, unitPerMm?: number) => regionsToEntities(v, unitPerMm),
    serialize: () => serializeRegions(),
    load: (data: unknown) => loadRegions(data),
    count: () => countRegions(),
  };
  try {
    console.log("[filled-regions] ready (pattern-backed, persistent).");
  } catch { /* */ }
}
