/**
 * Create floor/slab elements from closed wall loops (Revit-style "floor by walls").
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { detectAllRooms, type RoomWall } from "./room-detect";
import { wallsAtCut } from "./room-tool";

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

export async function createFloorsFromWalls(opts?: {
  levelElevation?: number;
  thickness?: number;
}): Promise<number> {
  const a = authoring();
  if (!a?.createElement && !a?.addElement) {
    // fallback via getElements + internal create if exposed
  }
  const elev = opts?.levelElevation ?? 0;
  const cutY = elev + 1.2;
  const walls: RoomWall[] = wallsAtCut(cutY);
  if (!walls.length) {
    notify("warn", "No walls on this level — draw walls first");
    return 0;
  }
  const rooms = detectAllRooms(walls, { minArea: 0.5 });
  if (!rooms.length) {
    notify("warn", "No closed wall loops found");
    return 0;
  }
  let n = 0;
  const thickness = opts?.thickness ?? 0.2;
  for (const r of rooms) {
    if (!r.boundary || r.boundary.length < 3) continue;
    const polygon = r.boundary.map(([x, z]) => [x, z] as [number, number]);
    try {
      const id = await a?.createElementByType?.("slab", {
        polygon,
        height: thickness,
        elevation: elev,
      });
      if (id) n++;
    } catch (e) {
      console.warn("[floor-from-walls]", e);
    }
  }
  if (n) {
    try {
      a?.rebuild?.();
      a?.rebuildAuthored?.();
    } catch { /* */ }
    notify("success", `Created ${n} floor(s) from wall loops`);
  } else {
    notify("warn", "Could not create floors — authoring API unavailable");
  }
  return n;
}

export function setupFloorFromWalls(): void {
  try {
    const cmds = (ctx as Any).commands ?? (window as Any).__obsCommands;
    cmds?.register?.("FLOORFROMWALLS", () => void createFloorsFromWalls());
    cmds?.register?.("SLABFROMWALLS", () => void createFloorsFromWalls());
  } catch { /* */ }
  (window as Any).__obsFloorFromWalls = { createFloorsFromWalls };
  try {
    window.dispatchEvent(
      new CustomEvent("obs-register-command", {
        detail: {
          id: "floor-from-walls",
          label: "Floor from walls",
          category: "Architecture",
          run: () => void createFloorsFromWalls(),
        },
      }),
    );
  } catch { /* */ }
  console.log("[floor-from-walls] FLOORFROMWALLS / SLABFROMWALLS ready");
}
