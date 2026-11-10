/**
 * Energy analysis UI — the honest user surface for the energy-analysis
 * engine. The ribbon Analyze ▸ Energy buttons used to call
 * `__obsEnergyAnalysis`, a global that never existed, so both buttons
 * silently no-oped behind a success toast. They now build thermal zones
 * from the authored rooms and run the real engine functions
 * (computeHeatLoss / exportGbXML).
 *
 * Modeling assumptions — stated in every report, not hidden:
 *   - envelope U-values use ASHRAE-typical defaults (walls 0.35,
 *     windows 2.0 W/m²K) because material U-values are not yet assigned
 *     per element in the model;
 *   - envelope area = room perimeter × clear height (real room boundary);
 *   - window contributions are included when hosted window elements sit
 *     on walls whose midpoint falls inside the room boundary bbox;
 *   - roof / floor losses are excluded (no slab U-data yet).
 */
import { ctx } from "../core/context";
import { computeHeatLoss, exportGbXML, type ThermalZone } from "../modules/energy-analysis/types";
import { roomsStore, type Room } from "../modules/rooms/rooms";
import { notify } from "../core/notify";

type Any = Record<string, any>;

const DEFAULT_U = { wall: 0.35, window: 2.0 };
const DESIGN_IN = 21;
const DESIGN_OUT = 0;

function authoredElements(): Any[] {
  const f = (ctx as Any).features ?? {};
  const a = f.authoring;
  if (!a) return [];
  try {
    if (typeof a.getElements === "function") return (a.getElements() ?? []) as Any[];
    if (Array.isArray(a.elements)) return a.elements as Any[];
  } catch { /* boot order */ }
  return [];
}

function bboxOf(boundary: Array<{ x: number; z: number }>): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of boundary) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  return { minX, maxX, minZ, maxZ };
}

function segmentMid(x1: number, z1: number, x2: number, z2: number): [number, number] {
  return [(x1 + x2) / 2, (z1 + z2) / 2];
}

/** Map one authored room record to a ThermalZone the engine can consume. */
export function zoneFromRoom(room: Room, all: Any[]): ThermalZone {
  const boundary = room.boundary ?? [];
  const height = Number(room.height) || 2.8;
  const perimeter = Number(room.perimeter) || 0;
  const floorArea = Number(room.area) || 0;
  const bbox = boundary.length >= 3 ? bboxOf(boundary) : null;

  // Walls whose midpoint falls inside the room bbox (padded 0.6 m).
  const walls: ThermalZone["walls"] = [];
  const windows: ThermalZone["windows"] = [];
  if (bbox) {
    const pad = 0.6;
    for (const el of all) {
      const p = el?.params ?? {};
      if (!Array.isArray(p.start) || !Array.isArray(p.end)) continue;
      const [x1, z1] = p.start;
      const [x2, z2] = p.end;
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.05) continue;
      const [mx, mz] = segmentMid(x1, z1, x2, z2);
      if (mx < bbox.minX - pad || mx > bbox.maxX + pad || mz < bbox.minZ - pad || mz > bbox.maxZ + pad) continue;
      if (el.type === "wall") {
        const orientation = Math.atan2(z2 - z1, x2 - x1) * (180 / Math.PI);
        walls.push({ area: len * height, uValue: DEFAULT_U.wall, orientation });
      } else if (el.type === "window") {
        const w = Number(p.width) || 1.2;
        const h = Number(p.height) || 1.2;
        windows.push({ area: w * h, uValue: DEFAULT_U.window, orientation: 0, shgc: 0.6 });
      }
    }
  }

  const zone: ThermalZone = {
    id: `zone-${room.id}`,
    name: `${room.number} ${room.name}`.trim(),
    roomId: String(room.id),
    floorArea,
    volume: floorArea * height,
    walls,
    windows,
    designTempInterior: DESIGN_IN,
    designTempExterior: DESIGN_OUT,
  };
  // Perimeter-derived envelope (walls are often not authored inside rooms):
  // only used when no wall midpoint landed in the room bbox.
  if (!zone.walls.length && perimeter > 0) {
    zone.walls = [{ area: perimeter * height, uValue: DEFAULT_U.wall, orientation: 0 }];
  }
  return zone;
}

/** Build thermal zones from every authored room. */
export function zonesFromRooms(): ThermalZone[] {
  const all = authoredElements();
  return roomsStore.listRooms().map((r) => zoneFromRoom(r, all));
}

function fmtW(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)} kW` : `${Math.round(v)} W`;
}

/** Heat-loss report over the authored rooms — honest dialog, assumptions labeled. */
export async function runHeatLossReport(): Promise<void> {
  const zones = zonesFromRooms();
  if (!zones.length) {
    notify("warn", "Heat Loss: no rooms defined yet. Use the Room tool to place rooms first.");
    return;
  }
  const rows = zones.map((z) => {
    const loss = computeHeatLoss(z);
    return {
      zone: z.name,
      area: Number(z.floorArea.toFixed(1)),
      volume: Number(z.volume.toFixed(1)),
      walls: z.walls.length,
      windows: z.windows.length,
      "heat loss": fmtW(loss),
      "W/m²": z.floorArea > 0 ? (loss / z.floorArea).toFixed(1) : "0",
    };
  });
  const total = zones.reduce((s, z) => s + computeHeatLoss(z), 0);
  const { showObjectsDialog } = await import("./form-modal");
  await showObjectsDialog(
    "Heat Loss — steady state (ΔT 21/0 °C)",
    rows,
    `${zones.length} zone(s) · total ${fmtW(total)} · assumes U-values: walls ${DEFAULT_U.wall}, windows ${DEFAULT_U.window} W/m²K (no per-element U-data yet)`,
  );
}

/** gbXML export of the authored rooms (downloaded as a file). */
export async function exportGbXmlFile(): Promise<void> {
  const zones = zonesFromRooms();
  if (!zones.length) {
    notify("warn", "gbXML: no rooms defined yet. Use the Room tool to place rooms first.");
    return;
  }
  const xml = exportGbXML(zones, "OpenBIMStudio");
  const blob = new Blob([xml], { type: "application/xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "openbimstudio-model.gbxml";
  a.click();
  URL.revokeObjectURL(url);
  notify("success", `gbXML exported: ${zones.length} zone(s) → openbimstudio-model.gbxml`);
}
