/**
 * Zone Mechanical Load Estimation (ASHRAE Rule-of-Thumb).
 *
 * Estimates sensible cooling and heating loads (W/m²), airflow rates (CFM & L/s),
 * and required duct airflow for HVAC zoning.
 */

export type OccupancyType =
  | "office"
  | "residential"
  | "retail"
  | "conference"
  | "server-room"
  | "kitchen"
  | "corridor";

export interface ZoneSpec {
  id: string;
  name: string;
  areaM2: number;
  ceilingHeightM: number;
  occupancy: OccupancyType;
  glazingRatio: number; // 0 to 1
  hasDirectSunlight: boolean;
}

export interface ZoneLoadResult {
  zoneId: string;
  zoneName: string;
  coolingLoadW: number;
  heatingLoadW: number;
  airFlowCfm: number;
  airFlowLs: number;
  sensibleHeatRatio: number;
  recommendedAirChangesPerHour: number;
}

// Base rule of thumb cooling load in W/m² per ASHRAE Fundamentals
const BASE_COOLING_W_M2: Record<OccupancyType, number> = {
  office: 110,
  residential: 80,
  retail: 140,
  conference: 180,
  "server-room": 450,
  kitchen: 350,
  corridor: 45,
};

const BASE_HEATING_W_M2: Record<OccupancyType, number> = {
  office: 60,
  residential: 70,
  retail: 55,
  conference: 50,
  "server-room": 20,
  kitchen: 40,
  corridor: 50,
};

export function calcZoneLoads(zones: ZoneSpec[]): ZoneLoadResult[] {
  return zones.map((z) => {
    let coolingPerM2 = BASE_COOLING_W_M2[z.occupancy] || 100;
    const heatingPerM2 = BASE_HEATING_W_M2[z.occupancy] || 60;

    // Adjust for glazing and solar exposure
    if (z.glazingRatio > 0.4) {
      coolingPerM2 *= 1.25;
    }
    if (z.hasDirectSunlight) {
      coolingPerM2 *= 1.15;
    }

    const coolingLoadW = Math.round(z.areaM2 * coolingPerM2);
    const heatingLoadW = Math.round(z.areaM2 * heatingPerM2);

    // Rule of thumb: approx 400 CFM per ton of cooling (1 ton = 3517 W)
    // or ~ 0.0009 m³/s per Watt of cooling with deltaT = 10K
    const tonnage = coolingLoadW / 3517;
    const airFlowCfm = Math.round(tonnage * 400);
    const airFlowLs = Math.round(airFlowCfm * 0.4719);

    const volumeM3 = z.areaM2 * z.ceilingHeightM;
    const ach = Math.round(((airFlowLs * 3.6) / Math.max(1, volumeM3)) * 10) / 10;

    return {
      zoneId: z.id,
      zoneName: z.name,
      coolingLoadW,
      heatingLoadW,
      airFlowCfm,
      airFlowLs,
      sensibleHeatRatio: 0.82,
      recommendedAirChangesPerHour: ach,
    };
  });
}

export function exportLoadSummary(results: ZoneLoadResult[]): string {
  const headers = ["Zone ID", "Zone Name", "Cooling (W)", "Heating (W)", "Airflow (CFM)", "Airflow (L/s)", "ACH"];
  const rows = results.map((r) => [
    r.zoneId,
    `"${r.zoneName}"`,
    r.coolingLoadW,
    r.heatingLoadW,
    r.airFlowCfm,
    r.airFlowLs,
    r.recommendedAirChangesPerHour,
  ]);
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}
