/**
 * Room executor — commits a {@link RoomPlan} through the real authoring
 * engine, wall by wall, then hosts each opening on its wall.
 *
 * It only talks to the authoring feature's `createElementByType`, the same
 * history-wrapped `createElement` the draw tools use (type defaults,
 * family overrides, hosting, snap relationships) — so a modelled room is
 * a native authored room: undoable, selectable, schedulable, exportable.
 * A wall or opening the engine refuses (null id) fails the whole call
 * with the wall/opening named; elements already committed stay committed
 * (undo removes them in one step — the caller reports that).
 */

import type { RoomPlan } from "./plan";

export interface AuthoringLike {
  createElementByType(
    type: string,
    params: Record<string, unknown>,
    hostId?: string,
  ): Promise<string | null>;
}

export interface RoomBuildResult {
  wallIds: string[];
  openingIds: string[];
}

export async function executeRoomPlan(
  authoring: AuthoringLike,
  plan: RoomPlan,
): Promise<RoomBuildResult> {
  if (!authoring || typeof authoring.createElementByType !== "function") {
    throw new Error("The authoring engine is not ready — cannot model the room.");
  }
  const wallIds: string[] = [];
  for (let i = 0; i < plan.walls.length; i++) {
    const wall = plan.walls[i];
    const id = await authoring.createElementByType("wall", {
      start: wall.start,
      end: wall.end,
      elevation: wall.elevation,
      thickness: wall.thickness,
      height: wall.height,
    });
    if (!id) {
      throw new Error(
        `The authoring engine refused wall ${i + 1} of the room (${wall.start} → ${wall.end}). ` +
          `${wallIds.length} wall(s) were already created — undo removes them.`,
      );
    }
    wallIds.push(id);
  }
  const openingIds: string[] = [];
  for (const opening of plan.openings) {
    const hostId = wallIds[opening.hostIndex];
    const id = await authoring.createElementByType(
      opening.type,
      {
        offsetAlongHost: opening.offsetAlongHost,
        width: opening.width,
        height: opening.height,
        sillHeight: opening.sillHeight,
      },
      hostId,
    );
    if (!id) {
      throw new Error(
        `The authoring engine refused the ${opening.type} on wall ${opening.hostIndex + 1} ` +
          `(offset ${opening.offsetAlongHost} m). ${wallIds.length} wall(s) and ` +
          `${openingIds.length} opening(s) were already created — undo removes them.`,
      );
    }
    openingIds.push(id);
  }
  return { wallIds, openingIds };
}
