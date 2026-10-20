export * from "./types";

let installed = false;
export function setupModelCurves() {
  if (installed) return;
  installed = true;
  (window as any).__obsModelCurves = {
    add: (hostId: string, faceIdx: number, points: any, closed?: boolean, color?: string) =>
      require("./types").addModelCurve(hostId, faceIdx, points, closed, color),
    get: (hostId: string, faceIdx?: number) =>
      require("./types").getModelCurves(hostId, faceIdx),
    remove: (hostId: string, curveId: string) =>
      require("./types").removeModelCurve(hostId, curveId),
    clear: (hostId: string) => require("./types").clearModelCurves(hostId),
    list: () => require("./types").listElementsWithCurves(),
    has: (hostId: string) => require("./types").hasModelCurves(hostId),
    toWorld3D: (curve: any, origin: any, u: any, v: any) =>
      require("./types").curveToWorld3D(curve, origin, u, v),
  };
  console.log("[model-curves] ready. Draw curves on element faces for push-pull or hosted placement.");
}
export function isReady() { return installed; }
