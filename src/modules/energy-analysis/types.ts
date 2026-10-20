/** Energy analysis — gbXML export + thermal model. */
export interface ThermalZone {
  id: string;
  name: string;
  /** Room/area ID this zone represents. */
  roomId: string;
  /** Floor area (m²). */
  floorArea: number;
  /** Volume (m³). */
  volume: number;
  /** Walls bounding this zone (for heat loss calc). */
  walls: Array<{ area: number; uValue: number; orientation: number }>;
  /** Windows (for solar gain). */
  windows: Array<{ area: number; uValue: number; orientation: number; shgc: number }>;
  /** Roof. */
  roof?: { area: number; uValue: number };
  /** Floor. */
  floor?: { area: number; uValue: number };
  /** Design temp interior (°C). */
  designTempInterior: number;
  /** Design temp exterior (°C). */
  designTempExterior: number;
}

/** Compute heat loss for a zone (W). */
export function computeHeatLoss(zone: ThermalZone): number {
  const dT = zone.designTempInterior - zone.designTempExterior;
  let loss = 0;
  for (const w of zone.walls) loss += w.area * w.uValue * dT;
  for (const win of zone.windows) loss += win.area * win.uValue * dT;
  if (zone.roof) loss += zone.roof.area * zone.roof.uValue * dT;
  if (zone.floor) loss += zone.floor.area * zone.floor.uValue * dT;
  // Ventilation loss: 0.33 * volume * airChanges * dT
  const ventLoss = 0.33 * zone.volume * 0.5 * dT;
  return loss + ventLoss;
}

/** Compute solar gain for a zone (W). */
export function computeSolarGain(zone: ThermalZone, solarRadiation: number = 300): number {
  let gain = 0;
  for (const win of zone.windows) {
    gain += win.area * win.shgc * solarRadiation * Math.cos(win.orientation * Math.PI / 180);
  }
  return Math.max(0, gain);
}

/** Export zones as gbXML (simplified). */
export function exportGbXML(zones: ThermalZone[], projectName: string = "OpenBIMStudio"): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<gbXML xmlns="http://www.gbxml.org/schema" temperatureUnit="C" lengthUnit="Meters">`);
  lines.push(`  <Campus><Building><Name>${projectName}</Name>`);
  for (const z of zones) {
    const heatLoss = computeHeatLoss(z);
    lines.push(`    <Space id="${z.id}"><Name>${z.name}</Name>`);
    lines.push(`      <Area>${z.floorArea.toFixed(2)}</Area><Volume>${z.volume.toFixed(2)}</Volume>`);
    lines.push(`      <HeatLoss>${heatLoss.toFixed(0)}</HeatLoss>`);
    lines.push(`    </Space>`);
  }
  lines.push(`  </Building></Campus>`);
  lines.push(`</gbXML>`);
  return lines.join("\n");
}

let installed = false;
export function setupEnergyAnalysis() {
  if (installed) return; installed = true;
  (window as any).__obsEnergy = { computeHeatLoss, computeSolarGain, exportGbXML };
  console.log("[energy-analysis] ready. Compute heat loss + export gbXML via __obsEnergy.");
}
