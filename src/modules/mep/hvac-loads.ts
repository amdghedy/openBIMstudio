/**
 * Zone HVAC Heating & Cooling Load Analysis — CLTD-style, orientation-aware.
 *
 * Reference workflow: engineering heating and cooling load analysis. The old
 * mechanical-loads.ts rule-of-thumb (W/m² by occupancy) is kept for quick
 * estimates; this module is the engineering upgrade: it accepts the actual
 * envelope construction (U-values, areas, orientations), glazing (SHGC),
 * internal gains (people / lighting / equipment), ventilation outdoor air
 * and infiltration, and produces a transparent sensible / latent breakdown
 * plus the supply airflow from the zone supply ΔT.
 *
 * Method (documented, ASHRAE Fundamentals — simplified heat balance):
 *   - Conduction: Q = U·A·ΔT. Walls/roof use the sol-air temperature:
 *     Tsa = Tout + α·E/hO − ε·ΔR/hO with α = 0.26 (light-coloured), hO =
 *     22.7 W/m²K, ΔR/hO ≈ 4 K (long-wave correction to sky). Peak clear-sky
 *     irradiance E per orientation for a vertical surface at ~40°N in July
 *     is interpolated from the table below; the roof uses the horizontal
 *     peak (900 W/m²).
 *   - Glazing solar: Q = SHGC·A·E_peak(orientation). Glazing conduction is
 *     U·A·ΔT like any surface.
 *   - Internal gains: people 75 W sensible + 55 W latent each (office,
 *     ASHRAE Fundamentals Ch.18 seated-light work); lighting W/m² and
 *     equipment W/m² over the zone area (all sensible).
 *   - Ventilation outdoor air: L/s per person (default 10 L/s ≈ ASHRAE 62.1
 *     office classroom rate), sensible ρ·cp·ΔT and latent ρ·hfg·Δw with
 *     ρ = 1.2 kg/m³, cp = 1005 J/kgK, hfg = 2450 kJ/kg.
 *   - Infiltration: ACH × volume → m³/s, same sensible/latent split.
 *   - Heating: envelope + ventilation sensible + infiltration sensible
 *     only (no solar, no internal gains — conservative standard practice),
 *     with an optional documented safety factor.
 *   - Supply airflow: Q_sensible / (ρ·cp·ΔT_supply); default ΔT = 12 K.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 */

import type { OccupancyType } from "./mechanical-loads";

// ── Physical constants (documented) ─────────────────────────────────────

/** Air density (kg/m³) at 20 °C, sea level. */
export const AIR_DENSITY = 1.2;
/** Specific heat of air (J/kg·K). */
export const AIR_CP = 1005;
/** Latent heat of vapourisation of water (J/kg). */
export const WATER_HFG = 2_450_000;
/** Exterior film coefficient used for sol-air (W/m²K). */
export const HO_SOL_AIR = 22.7;
/** Solar absorptivity of a light-coloured wall. */
export const ALPHA_WALL = 0.26;
/** Long-wave correction to the sky (K). */
export const DELTA_R_SKY = 4;

/**
 * Peak clear-sky solar irradiance on a vertical surface (W/m²), ~40°N,
 * July, at the hour each façade peaks (ASHRAE Fundamentals clear-sky,
 * condensed to the 8 compass points).
 */
export const PEAK_SOLAR_VERTICAL: Record<string, number> = {
  N: 61, NE: 282, E: 446, SE: 402, S: 251, SW: 402, W: 446, NW: 282,
};
/** Peak clear-sky irradiance on a horizontal surface (roof) in W/m². */
export const PEAK_SOLAR_ROOF = 892;

/** Compass bucket for an orientation angle (deg, 0 = N, 90 = E). */
export function compassFor(orientationDeg: number): string {
  const oct = ((Math.round(orientationDeg / 45) % 8) + 8) % 8;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][oct];
}

/** Peak solar irradiance for a vertical surface facing `orientationDeg`. */
export function peakSolarFor(orientationDeg: number): number {
  return PEAK_SOLAR_VERTICAL[compassFor(orientationDeg)] ?? 250;
}

/** Sol-air temperature elevation over the dry-bulb (K) for a wall. */
export function solAirElevation(orientationDeg: number): number {
  return (ALPHA_WALL * peakSolarFor(orientationDeg)) / HO_SOL_AIR;
}

// ── Inputs ───────────────────────────────────────────────────────────────

export interface EnvelopeSurface {
  id: string;
  /** "wall" (vertical, orientation-aware), "roof" (horizontal up), "floor" (ground slab). */
  kind: "wall" | "roof" | "floor";
  /** Facing direction in degrees: 0 = N, 90 = E, 180 = S, 270 = W. */
  orientationDeg?: number;
  /** Net exterior area (m²). */
  areaM2: number;
  /** Overall heat-transfer coefficient (W/m²K). */
  uValueWm2K: number;
}

export interface GlazingSurface {
  id: string;
  orientationDeg: number;
  areaM2: number;
  uValueWm2K: number;
  /** Solar heat-gain coefficient, 0..1. Default 0.45 (double low-e). */
  shgc?: number;
}

export interface InternalGains {
  /** Number of occupants at design conditions. */
  people: number;
  /** Lighting power density (W/m²). Default 10 (office). */
  lightingWm2?: number;
  /** Receptacle/equipment power density (W/m²). Default 12 (office). */
  equipmentWm2?: number;
  /** Sensible heat per person (W). Default 75 (seated light work). */
  wattsPerPersonSensible?: number;
  /** Latent heat per person (W). Default 55. */
  wattsPerPersonLatent?: number;
}

export interface DesignConditions {
  /** Summer outdoor dry-bulb (°C). Default 35. */
  summerOutdoorC: number;
  /** Summer indoor setpoint (°C). Default 24. */
  summerIndoorC: number;
  /** Winter outdoor dry-bulb (°C). Default −5. */
  winterOutdoorC: number;
  /** Winter indoor setpoint (°C). Default 21. */
  winterIndoorC: number;
  /** Summer outdoor humidity ratio (kg/kg dry air). Default 0.014. */
  humidityRatioOutdoor: number;
  /** Summer indoor humidity ratio (kg/kg dry air). Default 0.0095. */
  humidityRatioIndoor: number;
  /** Ground temperature under slabs (°C). Default 18. */
  groundC: number;
}

export const DEFAULT_DESIGN_CONDITIONS: DesignConditions = {
  summerOutdoorC: 35,
  summerIndoorC: 24,
  winterOutdoorC: -5,
  winterIndoorC: 21,
  humidityRatioOutdoor: 0.014,
  humidityRatioIndoor: 0.0095,
  groundC: 18,
};

export interface ZoneLoadInput {
  id: string;
  name: string;
  areaM2: number;
  ceilingHeightM: number;
  /** Envelope constructions (walls / roof / floor) with U-values. */
  surfaces?: EnvelopeSurface[];
  /** Glazing per orientation. */
  glazing?: GlazingSurface[];
  gains: InternalGains;
  /** Outdoor-air rate per person (L/s). Default 10. */
  outdoorAirLsPerPerson?: number;
  /** Design infiltration rate (ACH). Default 0.5. */
  infiltrationAch?: number;
  /** Occupancy tag retained for the summary export (no W/m² shortcut here). */
  occupancy?: OccupancyType;
}

// ── Outputs ──────────────────────────────────────────────────────────────

export interface LoadBreakdown {
  /** Envelope conduction incl. sol-air (W). */
  envelopeW: number;
  /** Glazing conduction (W) — reported inside envelopeW, broken out here. */
  glazingConductionW: number;
  /** Glazing solar gain (W, cooling only). */
  solarW: number;
  /** Internal sensible: people + lighting + equipment (W, cooling only). */
  internalSensibleW: number;
  /** People latent (W, cooling only). */
  peopleLatentW: number;
  /** Ventilation outdoor-air sensible (W). */
  ventilationSensibleW: number;
  /** Ventilation outdoor-air latent (W, cooling only). */
  ventilationLatentW: number;
  /** Infiltration sensible (W). */
  infiltrationSensibleW: number;
  /** Infiltration latent (W, cooling only). */
  infiltrationLatentW: number;
}

export interface ZoneLoadResult {
  zoneId: string;
  zoneName: string;
  areaM2: number;
  cooling: {
    sensibleW: number;
    latentW: number;
    totalW: number;
    tons: number;
    shr: number;
    /** Supply airflow from the zone supply ΔT (L/s and CFM). */
    airflowLs: number;
    airflowCfm: number;
  };
  heating: {
    totalW: number;
    airflowLs: number;
    airflowCfm: number;
  };
  breakdown: { cooling: LoadBreakdown; heating: LoadBreakdown };
  /** Outdoor-air volume rate for the zone (L/s). */
  outdoorAirLs: number;
  /** Volume (m³) and design infiltration rate used. */
  volumeM3: number;
  infiltrationAch: number;
}

export interface ZoneLoadOptions {
  conditions?: Partial<DesignConditions>;
  /** Zone supply ΔT for cooling airflow (K). Default 12. */
  supplyDeltaTC?: number;
  /** Heating safety factor (default 1.0 — no hidden margins). */
  heatingSafetyFactor?: number;
}

// ── Core physics ─────────────────────────────────────────────────────────

/** Sensible load of an airflow (W) given a temperature difference (K). */
export function airflowSensibleW(flowLs: number, deltaTC: number): number {
  return AIR_DENSITY * (flowLs / 1000) * AIR_CP * deltaTC;
}

/** Latent load of an airflow (W) given a humidity-ratio difference. */
export function airflowLatentW(flowLs: number, deltaHumidityRatio: number): number {
  return AIR_DENSITY * (flowLs / 1000) * WATER_HFG * deltaHumidityRatio;
}

function surfaceConductionCooling(s: EnvelopeSurface, c: DesignConditions): number {
  const u = s.uValueWm2K, a = s.areaM2;
  if (s.kind === "roof") {
    // Sol-air on a horizontal surface sees the full horizontal peak.
    const tsa = c.summerOutdoorC + (ALPHA_WALL * PEAK_SOLAR_ROOF) / HO_SOL_AIR - DELTA_R_SKY;
    return u * a * (tsa - c.summerIndoorC);
  }
  if (s.kind === "floor") {
    return u * a * (c.groundC - c.summerIndoorC);
  }
  const tsa = c.summerOutdoorC + solAirElevation(s.orientationDeg ?? 0) - DELTA_R_SKY;
  return u * a * (tsa - c.summerIndoorC);
}

function surfaceConductionHeating(s: EnvelopeSurface, c: DesignConditions, factor: number): number {
  const out = s.kind === "floor" ? c.groundC : c.winterOutdoorC;
  return s.uValueWm2K * s.areaM2 * (c.winterIndoorC - out) * factor;
}

function glazingSolar(g: GlazingSurface): number {
  return (g.shgc ?? 0.45) * g.areaM2 * peakSolarFor(g.orientationDeg);
}

function roundW(w: number): number {
  return Math.round(w * 10) / 10;
}

// ── Zone analysis ────────────────────────────────────────────────────────

/** Compute the design heating & cooling loads of one zone. */
export function calcZoneLoadDetailed(zone: ZoneLoadInput, options: ZoneLoadOptions = {}): ZoneLoadResult {
  const c: DesignConditions = { ...DEFAULT_DESIGN_CONDITIONS, ...(options.conditions ?? {}) };
  const safety = options.heatingSafetyFactor ?? 1;
  const supplyDeltaT = options.supplyDeltaTC ?? 12;
  const volume = Math.max(0, zone.areaM2 * zone.ceilingHeightM);
  const oaLs = Math.max(0, zone.gains.people) * (zone.outdoorAirLsPerPerson ?? 10);
  const ach = zone.infiltrationAch ?? 0.5;
  const infilLs = (ach * volume * 1000) / 3600; // m³/h → L/s

  // ── Cooling ──
  const cb: LoadBreakdown = {
    envelopeW: 0, glazingConductionW: 0, solarW: 0, internalSensibleW: 0,
    peopleLatentW: 0, ventilationSensibleW: 0, ventilationLatentW: 0,
    infiltrationSensibleW: 0, infiltrationLatentW: 0,
  };
  for (const s of zone.surfaces ?? []) cb.envelopeW += surfaceConductionCooling(s, c);
  for (const g of zone.glazing ?? []) {
    cb.glazingConductionW += g.uValueWm2K * g.areaM2 * (c.summerOutdoorC - c.summerIndoorC);
    cb.solarW += glazingSolar(g);
  }
  const g = zone.gains;
  const ppSens = g.wattsPerPersonSensible ?? 75;
  const ppLat = g.wattsPerPersonLatent ?? 55;
  cb.internalSensibleW =
    Math.max(0, g.people) * ppSens +
    (g.lightingWm2 ?? 10) * zone.areaM2 +
    (g.equipmentWm2 ?? 12) * zone.areaM2;
  cb.peopleLatentW = Math.max(0, g.people) * ppLat;
  cb.ventilationSensibleW = airflowSensibleW(oaLs, c.summerOutdoorC - c.summerIndoorC);
  cb.ventilationLatentW = airflowLatentW(oaLs, c.humidityRatioOutdoor - c.humidityRatioIndoor);
  cb.infiltrationSensibleW = airflowSensibleW(infilLs, c.summerOutdoorC - c.summerIndoorC);
  cb.infiltrationLatentW = airflowLatentW(infilLs, c.humidityRatioOutdoor - c.humidityRatioIndoor);
  const clampedCb = (v: number) => roundW(Math.max(0, v));
  const sensibleCooling =
    clampedCb(cb.envelopeW) + clampedCb(cb.glazingConductionW) + clampedCb(cb.solarW) +
    clampedCb(cb.internalSensibleW) + clampedCb(cb.ventilationSensibleW) + clampedCb(cb.infiltrationSensibleW);
  const latentCooling = clampedCb(cb.peopleLatentW) + clampedCb(cb.ventilationLatentW) + clampedCb(cb.infiltrationLatentW);
  const totalCooling = sensibleCooling + latentCooling;
  const coolingAirLs = sensibleCooling > 0
    ? Math.ceil(sensibleCooling / (AIR_DENSITY * AIR_CP * supplyDeltaT) * 1000)
    : 0;

  // ── Heating ──
  const hb: LoadBreakdown = {
    envelopeW: 0, glazingConductionW: 0, solarW: 0, internalSensibleW: 0,
    peopleLatentW: 0, ventilationSensibleW: 0, ventilationLatentW: 0,
    infiltrationSensibleW: 0, infiltrationLatentW: 0,
  };
  for (const s of zone.surfaces ?? []) hb.envelopeW += surfaceConductionHeating(s, c, safety);
  for (const g2 of zone.glazing ?? []) {
    hb.glazingConductionW += g2.uValueWm2K * g2.areaM2 * (c.winterIndoorC - c.winterOutdoorC) * safety;
  }
  hb.ventilationSensibleW = airflowSensibleW(oaLs, c.winterIndoorC - c.winterOutdoorC) * safety;
  hb.infiltrationSensibleW = airflowSensibleW(infilLs, c.winterIndoorC - c.winterOutdoorC) * safety;
  const totalHeating =
    clampedCb(hb.envelopeW) + clampedCb(hb.glazingConductionW) +
    clampedCb(hb.ventilationSensibleW) + clampedCb(hb.infiltrationSensibleW);
  const heatAirLs = totalHeating > 0
    ? Math.ceil(totalHeating / (AIR_DENSITY * AIR_CP * supplyDeltaT) * 1000)
    : 0;

  return {
    zoneId: zone.id,
    zoneName: zone.name,
    areaM2: zone.areaM2,
    cooling: {
      sensibleW: sensibleCooling,
      latentW: latentCooling,
      totalW: totalCooling,
      tons: Math.round((totalCooling / 3517) * 100) / 100,
      shr: totalCooling > 0 ? Math.round((sensibleCooling / totalCooling) * 1000) / 1000 : 0,
      airflowLs: coolingAirLs,
      airflowCfm: Math.round(coolingAirLs * 2.11888),
    },
    heating: {
      totalW: totalHeating,
      airflowLs: heatAirLs,
      airflowCfm: Math.round(heatAirLs * 2.11888),
    },
    breakdown: { cooling: cb, heating: hb },
    outdoorAirLs: Math.round(oaLs * 10) / 10,
    volumeM3: Math.round(volume * 10) / 10,
    infiltrationAch: ach,
  };
}

/** Analyse a whole project: every zone independently, plus building totals. */
export function calcZoneLoadsDetailed(zones: ZoneLoadInput[], options: ZoneLoadOptions = {}): {
  zones: ZoneLoadResult[];
  totals: { coolingW: number; heatingW: number; tons: number; airflowLs: number; outdoorAirLs: number };
} {
  const zonesOut = zones.map((z) => calcZoneLoadDetailed(z, options));
  const coolingW = zonesOut.reduce((s, r) => s + r.cooling.totalW, 0);
  const heatingW = zonesOut.reduce((s, r) => s + r.heating.totalW, 0);
  const airflowLs = zonesOut.reduce((s, r) => s + r.cooling.airflowLs, 0);
  const outdoorAirLs = zonesOut.reduce((s, r) => s + r.outdoorAirLs, 0);
  return {
    zones: zonesOut,
    totals: {
      coolingW: Math.round(coolingW),
      heatingW: Math.round(heatingW),
      tons: Math.round((coolingW / 3517) * 100) / 100,
      airflowLs: Math.round(airflowLs),
      outdoorAirLs: Math.round(outdoorAirLs),
    },
  };
}

/** CSV summary compatible with the mechanical-loads export style. */
export function exportLoadReport(results: ZoneLoadResult[]): string {
  const headers = [
    "Zone ID", "Zone Name", "Cooling Sensible (W)", "Cooling Latent (W)", "Cooling Total (W)",
    "Tons", "SHR", "Cooling Airflow (L/s)", "Cooling Airflow (CFM)", "Heating (W)",
    "Heating Airflow (CFM)", "OA (L/s)", "ACH",
  ];
  const rows = results.map((r) => [
    r.zoneId, `"${r.zoneName}"`, r.cooling.sensibleW, r.cooling.latentW, r.cooling.totalW,
    r.cooling.tons, r.cooling.shr, r.cooling.airflowLs, r.cooling.airflowCfm, r.heating.totalW,
    r.heating.airflowCfm, r.outdoorAirLs, r.infiltrationAch,
  ]);
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}
