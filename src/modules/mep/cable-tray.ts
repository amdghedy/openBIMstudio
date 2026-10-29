/**
 * Cable Tray Sizing & Fill Ratio Engine (NEC Article 392).
 *
 * Checks cable tray capacity, calculates allowable fill percentages,
 * and recommends tray dimensions based on wire and cable bundles.
 */

export type WireGauge =
  | "14AWG"
  | "12AWG"
  | "10AWG"
  | "8AWG"
  | "6AWG"
  | "4AWG"
  | "2AWG"
  | "1/0"
  | "2/0"
  | "3/0"
  | "4/0";

export interface CableSpec {
  id: string;
  gauge: WireGauge;
  conductorCount: number;
  cableOuterDiameterMm: number;
  quantity: number;
}

export interface TrayFillResult {
  trayWidthMm: number;
  trayDepthMm: number;
  trayAreaMm2: number;
  totalCableAreaMm2: number;
  allowableFillPercent: number;
  actualFillPercent: number;
  status: "ok" | "warning" | "overfill";
  recommendation: string;
}

// Standard wire dimensions (approx outside diameters in mm including insulation)
export const WIRE_DATA: Record<WireGauge, { singleCoreODMm: number; weightKgPerM: number }> = {
  "14AWG": { singleCoreODMm: 4.5, weightKgPerM: 0.05 },
  "12AWG": { singleCoreODMm: 5.2, weightKgPerM: 0.07 },
  "10AWG": { singleCoreODMm: 6.0, weightKgPerM: 0.11 },
  "8AWG": { singleCoreODMm: 8.5, weightKgPerM: 0.18 },
  "6AWG": { singleCoreODMm: 10.2, weightKgPerM: 0.28 },
  "4AWG": { singleCoreODMm: 12.0, weightKgPerM: 0.42 },
  "2AWG": { singleCoreODMm: 14.5, weightKgPerM: 0.65 },
  "1/0": { singleCoreODMm: 17.0, weightKgPerM: 0.95 },
  "2/0": { singleCoreODMm: 18.5, weightKgPerM: 1.20 },
  "3/0": { singleCoreODMm: 20.5, weightKgPerM: 1.50 },
  "4/0": { singleCoreODMm: 23.0, weightKgPerM: 1.90 },
};

export function calcCableArea(cable: CableSpec): number {
  const r = cable.cableOuterDiameterMm / 2;
  const singleArea = Math.PI * r * r;
  return singleArea * cable.quantity;
}

export function calcTrayFill(
  trayWidthMm: number,
  trayDepthMm: number,
  cables: CableSpec[],
  singleLayerOnly: boolean = false
): TrayFillResult {
  const trayAreaMm2 = trayWidthMm * trayDepthMm;
  let totalCableAreaMm2 = 0;

  for (const c of cables) {
    totalCableAreaMm2 += calcCableArea(c);
  }

  // NEC 392 limit: 40% for multi-conductor cables, 50% for single conductor or ventilated ladder
  const allowableFillPercent = singleLayerOnly ? 35 : 45;
  const actualFillPercent = Math.round((totalCableAreaMm2 / trayAreaMm2) * 1000) / 10;

  let status: TrayFillResult["status"] = "ok";
  let recommendation = "Tray sizing is compliant with NEC 392 fill requirements.";

  if (actualFillPercent > allowableFillPercent) {
    status = "overfill";
    recommendation = `Tray is overfilled (${actualFillPercent}% > ${allowableFillPercent}% max). Increase width or add a second tiered tray.`;
  } else if (actualFillPercent > allowableFillPercent - 8) {
    status = "warning";
    recommendation = `Tray is near maximum allowable capacity (${actualFillPercent}% fill). Consider next standard width for future expansion.`;
  }

  return {
    trayWidthMm,
    trayDepthMm,
    trayAreaMm2,
    totalCableAreaMm2: Math.round(totalCableAreaMm2),
    allowableFillPercent,
    actualFillPercent,
    status,
    recommendation,
  };
}

export function suggestTraySize(
  cables: CableSpec[],
  trayDepthMm: number = 100
): { widthMm: number; depthMm: number } {
  let totalArea = 0;
  for (const c of cables) totalArea += calcCableArea(c);

  // Require actualFill <= 40% => totalArea / (W * D) <= 0.40 => W >= totalArea / (0.40 * D)
  const reqWidth = totalArea / (0.4 * trayDepthMm);

  // Standard tray widths: 150, 200, 300, 450, 600, 750, 900 mm
  const standardWidths = [150, 200, 300, 450, 600, 750, 900];
  const chosen = standardWidths.find((w) => w >= reqWidth) || standardWidths[standardWidths.length - 1];

  return { widthMm: chosen, depthMm: trayDepthMm };
}
