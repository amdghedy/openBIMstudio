/**
 * MEP unit & cross-section conversions.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * Duct equivalents:
 *   The hydraulic equivalent diameter (ASHRAE Handbook — Fundamentals,
 *   Duct Design) converts a rectangular duct to the round duct with the
 *   same pressure drop per metre at the same flow:
 *       De = 1.30 · (w·h)^0.625 / (w + h)^0.25
 *   The equal-area diameter is the geometric conversion (same cross-section
 *   area, not same friction) and is kept available because schedules and
 *   takeoffs sometimes want it.
 */

import type { Vec3 } from "./types";

// ── Duct cross-section conversions ───────────────────────────────────────

/** ASHRAE hydraulic equivalent round diameter (m) of a rectangular duct. */
export function equivalentDiameter(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0;
  return (1.3 * Math.pow(w * h, 0.625)) / Math.pow(w + h, 0.25);
}

/** Equal-area round diameter (m): the round duct with the same free area. */
export function equalAreaDiameter(w: number, h: number): number {
  if (w <= 0 || h <= 0) return 0;
  return Math.sqrt((4 * w * h) / Math.PI);
}

/**
 * Smallest rectangular duct pair with the given aspect ratio whose
 * hydraulic equivalent diameter matches the target round diameter.
 * Solved by bisection on the width (De is strictly increasing in w).
 */
export function roundToRectEquivalent(
  roundDiameterM: number,
  aspectRatio: number = 2,
): { w: number; h: number } {
  if (!(roundDiameterM > 0) || !(aspectRatio >= 1)) return { w: 0, h: 0 };
  const a = aspectRatio;
  const target = roundDiameterM;
  let lo = target / 4;
  let hi = target * 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const de = equivalentDiameter(mid, mid / a);
    if (de < target) lo = mid; else hi = mid;
  }
  const w = (lo + hi) / 2;
  return { w, h: w / a };
}

/** Round up to a listed standard size (m) — used after equivalent conversions. */
export function snapToStandard(sizeM: number, standards: number[]): number {
  for (const s of standards) if (s >= sizeM - 1e-9) return s;
  return sizeM;
}

// ── Air-change helpers ───────────────────────────────────────────────────

/** Airflow (m^3/s) needed to deliver `ach` air changes per hour in a volume. */
export function achToAirflow(volumeM3: number, ach: number): number {
  if (volumeM3 <= 0 || ach < 0) return 0;
  return (volumeM3 * ach) / 3600;
}

/** Air changes per hour achieved by an airflow (m^3/s) in a volume. */
export function airflowToAch(airflowM3s: number, volumeM3: number): number {
  if (volumeM3 <= 0) return 0;
  return (airflowM3s * 3600) / volumeM3;
}

/** Room volume from floor area + ceiling height. */
export function roomVolume(areaM2: number, heightM: number): number {
  return areaM2 * Math.max(0, heightM);
}

/**
 * Airflow for a room from area, height and ACH target — the common
 * "ventilation rate by air changes" sizing path.
 */
export function airflowFromRoom(areaM2: number, heightM: number, ach: number): number {
  return achToAirflow(roomVolume(areaM2, heightM), ach);
}

// ── Unit conversions ─────────────────────────────────────────────────────

export const CFM_TO_LS = 0.4719474;
export const LMIN_TO_LS = 1 / 60;
export const FPM_TO_MS = 0.00508;
export const IN_WG_TO_PA = 249.0889;
export const PSI_TO_KPA = 6.894757;
export const FT_TO_M = 0.3048;

export function cfmToLs(cfm: number): number { return cfm * CFM_TO_LS; }
export function lsToCfm(ls: number): number { return ls / CFM_TO_LS; }
export function gpmToLs(gpm: number): number { return gpm * 0.0630902; }
export function lsToGpm(ls: number): number { return ls / 0.0630902; }
export function lminToLs(lmin: number): number { return lmin / 60; }
export function lsToLmin(ls: number): number { return ls * 60; }
export function fpmToMs(fpm: number): number { return fpm * FPM_TO_MS; }
export function msToFpm(ms: number): number { return ms / FPM_TO_MS; }
export function inWgToPa(inWg: number): number { return inWg * IN_WG_TO_PA; }
export function paToInWg(pa: number): number { return pa / IN_WG_TO_PA; }
export function psiToKpa(psi: number): number { return psi * PSI_TO_KPA; }
export function kpaToPsi(kpa: number): number { return kpa / PSI_TO_KPA; }

/**
 * Midpoint of a plan run — used by takeoff/tap annotations.
 */
export function runMidpoint(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}
