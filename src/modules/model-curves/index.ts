export * from "./types";
// NOTE: the old setup bag called require("./types") at runtime, which does not
// exist in a Vite ESM browser bundle. Static imports instead.
import {
  addModelCurve,
  getModelCurves,
  removeModelCurve,
  clearModelCurves,
  listElementsWithCurves,
  hasModelCurves,
  curveToWorld3D,
} from "./types";

let installed = false;
let modelCurvesApi: any = null;
export function setupModelCurves() {
  if (installed) return modelCurvesApi;
  installed = true;
  modelCurvesApi = {
    add: (hostId: string, faceIdx: number, points: any, closed?: boolean, color?: string) =>
      addModelCurve(hostId, faceIdx, points, closed, color),
    get: (hostId: string, faceIdx?: number) =>
      getModelCurves(hostId, faceIdx),
    remove: (hostId: string, curveId: string) =>
      removeModelCurve(hostId, curveId),
    clear: (hostId: string) => clearModelCurves(hostId),
    list: () => listElementsWithCurves(),
    has: (hostId: string) => hasModelCurves(hostId),
    toWorld3D: (curve: any, origin: any, u: any, v: any) =>
      curveToWorld3D(curve, origin, u, v),
  };
  console.log("[model-curves] ready. Draw curves on element faces for push-pull or hosted placement.");
  return modelCurvesApi;
}
export function isReady() { return installed; }
