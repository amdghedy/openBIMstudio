export * from "./types";
let installed = false;
export function setupDimensionChains() {
  if (installed) return; installed = true;
  (window as any).__obsDimChains = { continuous: (v: string, r: any[], o: number, s?: string) => require("./types").createContinuousChain(v, r, o, s), baseline: (v: string, b: any, r: any[], o?: number, s?: number, st?: string) => require("./types").createBaselineChain(v, b, r, o, s, st) };
  console.log("[dimension-chains] ready. Continuous + baseline dimension strings.");
}
