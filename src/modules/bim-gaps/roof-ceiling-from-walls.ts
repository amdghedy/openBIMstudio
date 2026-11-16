/**
 * Roof / Ceiling by footprint — closed wall loops → roof or ceiling elements.
 * Complements FLOORFROMWALLS for a full vertical enclosure workflow.
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { detectAllRooms, type RoomWall } from "./room-detect";
import { wallsAtCut } from "./room-tool";

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function activeLevelElev(): number {
  const a = authoring();
  try {
    const id = a?.getActiveLevelId?.() ?? null;
    const lv = (a?.getLevels?.() ?? []).find((l: Any) => l.id === id);
    if (lv) return Number(lv.elevation) || 0;
  } catch { /* */ }
  return 0;
}

/** Typical wall top on active level (base + height). */
function estimateWallTop(elev: number): number {
  const a = authoring();
  const els: Any[] = a?.getElements?.() ?? [];
  let maxTop = elev + 3;
  for (const e of els) {
    if (e.type !== "wall" && e.type !== "curtain-wall") continue;
    const base = Number(e.params?.elevation) || elev;
    const h = Number(e.params?.height) || 3;
    maxTop = Math.max(maxTop, base + h);
  }
  return maxTop;
}

export type EnclosureKind = "roof" | "ceiling";

export async function createEnclosureFromWalls(
  kind: EnclosureKind,
  opts?: { levelElevation?: number; thickness?: number; pitchPct?: number },
): Promise<number> {
  const a = authoring();
  if (!a?.createElementByType) {
    notify("warn", "Authoring not ready");
    return 0;
  }
  const elev = opts?.levelElevation ?? activeLevelElev();
  const walls: RoomWall[] = wallsAtCut(elev + 1.2);
  if (!walls.length) {
    notify("warn", "No walls on this level — draw walls first");
    return 0;
  }
  const rooms = detectAllRooms(walls, { minArea: 0.5 });
  if (!rooms.length) {
    notify("warn", "No closed wall loops found");
    return 0;
  }

  const thickness = opts?.thickness ?? (kind === "roof" ? 0.25 : 0.12);
  const wallTop = estimateWallTop(elev);
  // Ceiling sits under slab/roof; roof sits on wall top
  const placementZ =
    kind === "roof" ? wallTop : Math.max(elev + 2.6, wallTop - 0.15);

  let n = 0;
  for (const r of rooms) {
    if (!r.boundary || r.boundary.length < 3) continue;
    const polygon = r.boundary.map(([x, z]) => [x, z] as [number, number]);
    const params: Record<string, unknown> = {
      polygon,
      height: thickness,
      elevation: placementZ,
    };
    if (kind === "roof" && opts?.pitchPct != null && opts.pitchPct > 0) {
      params.slopePct = opts.pitchPct;
    }
    try {
      const id = await a.createElementByType(kind, params);
      if (id) n++;
    } catch (e) {
      console.warn(`[${kind}-from-walls]`, e);
    }
  }

  if (n) {
    try {
      a.rebuild?.();
      a.rebuildAuthored?.();
    } catch { /* */ }
    notify(
      "success",
      kind === "roof"
        ? `Created ${n} roof(s) on wall tops (${placementZ.toFixed(2)} m)`
        : `Created ${n} ceiling(s) at ${placementZ.toFixed(2)} m`,
    );
  } else {
    notify("warn", `Could not create ${kind}(s) from wall loops`);
  }
  return n;
}

export const createRoofsFromWalls = (opts?: { pitchPct?: number; thickness?: number }) =>
  createEnclosureFromWalls("roof", opts);

export const createCeilingsFromWalls = (opts?: { thickness?: number }) =>
  createEnclosureFromWalls("ceiling", opts);

export function setupRoofCeilingFromWalls(): void {
  // Published as a service key, not a window global: the create functions are
  // imported directly by bim-gaps-boot (rg-roof-walls / rg-ceiling-walls /
  // rg-ceiling-rooms command-palette entries) and reachable via ctx.features.
  (ctx.features as Any).roofCeilingFromWalls = {
    createRoofsFromWalls,
    createCeilingsFromWalls,
    createEnclosureFromWalls,
  };

  console.log("[roof-ceiling-from-walls] ROOFFROMWALLS / CEILINGFROMWALLS ready");
}
