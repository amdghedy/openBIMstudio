/**
 * Wall sweeps & reveals — public barrel + boot.
 *
 * Registers the sweep/reveal service, exposes __obsWallSweeps global,
 * and provides the "Add Wall Sweep" command.
 */

import { generateWallSweep, generateAllWallSweeps } from "./geometry";
import { getProfile, listProfiles, listProfileOptions, BUILTIN_PROFILES } from "./types";
import type { WallSweepPlacement, SweepProfile } from "./types";

export * from "./types";
export { generateWallSweep, generateAllWallSweeps } from "./geometry";

/** Public WallSweep service. */
export interface WallSweepService {
  listProfiles(): Array<{ id: string; label: string }>;
  getProfile(id: string): SweepProfile | null;
  generateSweep(
    wallStart: [number, number],
    wallEnd: [number, number],
    wallThickness: number,
    wallHeight: number,
    wallElevation: number,
    placement: WallSweepPlacement,
  ): ReturnType<typeof generateWallSweep> | null;
}

let installed = false;

export function setupWallSweeps(): WallSweepService {
  if (installed) return (window as any).__obsWallSweeps as WallSweepService;
  installed = true;

  const svc: WallSweepService = {
    listProfiles: listProfileOptions,
    getProfile,
    generateSweep: generateWallSweep,
  };

  try { (window as any).__obsWallSweeps = svc; } catch { /* */ }
  console.log("[wall-sweeps] ready. 6 built-in profiles (baseboard, cornice, wainscot, reveal).");

  return svc;
}

export function isWallSweepsReady(): boolean {
  return installed;
}
