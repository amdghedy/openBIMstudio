/**
 * Area plans & color fill — boot + service.
 */

import { generateColorFill, autoAssignColors, getScheme, listSchemeOptions, DEFAULT_SCHEMES } from "./types";
import type { ColorScheme, ColorFillPolygon, ColorSchemeMode } from "./types";

export * from "./types";

export interface AreaPlanService {
  generateColorFill(rooms: any[], scheme: ColorScheme): ColorFillPolygon[];
  autoAssignColors(scheme: ColorScheme, rooms: any[]): ColorScheme;
  getScheme(id: string): ColorScheme | null;
  listSchemeOptions(): Array<{ id: string; label: string }>;
}

let installed = false;
let cached: AreaPlanService | null = null;

export function setupAreaPlans(): AreaPlanService {
  if (installed) return cached as AreaPlanService;
  installed = true;

  const svc: AreaPlanService = {
    generateColorFill,
    autoAssignColors,
    getScheme,
    listSchemeOptions,
  };

  cached = svc;
  console.log("[area-plans] ready. Color fill by department/occupancy/area type.");

  return svc;
}

export function isAreaPlansReady(): boolean {
  return installed;
}
