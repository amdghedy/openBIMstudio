export * from "./types";
let installed = false;
export function setupFilledRegions() {
  if (installed) return; installed = true;
  (window as any).__obsFilledRegions = { add: (r: any) => require("./types").addRegion(r), get: (v: string) => require("./types").getRegions(v), remove: (v: string, id: string) => require("./types").removeRegion(v, id), toEntities: (v: string) => require("./types").regionsToEntities(v) };
  console.log("[filled-regions] ready.");
}
