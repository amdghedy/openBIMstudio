/**
 * Room planner — turns a parsed {@link RoomRequest} into exact wall
 * segments and hosted-opening placements.
 *
 * Geometry (plan X/Z, origin = south-west corner, Y up):
 *   wall 0 south: (ox,oz) → (ox+W,oz)   — the door wall
 *   wall 1 east:  (ox+W,oz) → (ox+W,oz+D)
 *   wall 2 north: (ox+W,oz+D) → (ox,oz+D)
 *   wall 3 west:  (ox,oz+D) → (ox,oz)
 *
 * Doors go on the south wall, centred (or spread evenly when there are
 * several). Windows fill the north wall first, then east, then west, in
 * that order — never the door wall unless every other wall is full, in
 * which case the request is refused rather than crowding the door.
 * Openings on a wall are centred as a group with a 0.3 m margin at each
 * end and between neighbours; a wall that cannot fit its openings
 * is a clear error naming the wall and the numbers, not a silent squeeze.
 * Pure — no DOM, no THREE, no context — so the node suite can import it.
 */

import type { RoomRequest } from "./parse";

export interface WallSegment {
  /** Plan start [x, z] in metres. */
  start: [number, number];
  /** Plan end [x, z] in metres. */
  end: [number, number];
  thickness: number;
  height: number;
  /** Base elevation in metres (0 — ground floor). */
  elevation: number;
}

export interface OpeningPlacement {
  type: "door" | "window";
  /** Index into {@link RoomPlan.walls}. */
  hostIndex: number;
  /** Distance in metres from the wall start, along the wall. */
  offsetAlongHost: number;
  width: number;
  height: number;
  sillHeight: number;
}

export interface RoomPlan {
  walls: WallSegment[];
  openings: OpeningPlacement[];
  request: RoomRequest;
}

/** Clear gap kept at each wall end and between neighbouring openings. */
export const OPENING_MARGIN = 0.3;

const WALL_NAMES = ["south", "east", "north", "west"];

/** Length of a wall segment in metres. */
export function wallLength(wall: WallSegment): number {
  return Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
}

/**
 * Offsets for `n` openings of the given widths on a wall of `length`
 * metres, centred as a group with at least OPENING_MARGIN at each end
 * and between neighbours. Throws when they do not fit.
 */
export function layoutOpenings(
  wallName: string,
  length: number,
  widths: number[],
): number[] {
  const needed = widths.reduce((sum, w) => sum + w, 0) + OPENING_MARGIN * (widths.length + 1);
  if (needed > length + 1e-9) {
    throw new Error(
      `The ${widths.length} opening(s) (${widths.map((w) => `${w} m`).join(" + ")}) do not fit on the ${wallName} wall: ` +
        `they need ${needed.toFixed(2)} m with margins but the wall is ${length.toFixed(2)} m long. ` +
        `Use a longer wall or fewer / narrower openings.`,
    );
  }
  // Leftover space is shared equally at both ends, so the group is centred.
  const slack = length - needed;
  const offsets: number[] = [];
  let cursor = OPENING_MARGIN + slack / 2;
  for (const w of widths) {
    offsets.push(Math.round((cursor + w / 2) * 1000) / 1000);
    cursor += w + OPENING_MARGIN;
  }
  return offsets;
}

export function planRoom(req: RoomRequest): RoomPlan {
  const [ox, oz] = req.origin;
  const { width: W, depth: D } = req;

  const walls: WallSegment[] = [
    { start: [ox, oz], end: [ox + W, oz], thickness: req.wallThickness, height: req.wallHeight, elevation: 0 },
    { start: [ox + W, oz], end: [ox + W, oz + D], thickness: req.wallThickness, height: req.wallHeight, elevation: 0 },
    { start: [ox + W, oz + D], end: [ox, oz + D], thickness: req.wallThickness, height: req.wallHeight, elevation: 0 },
    { start: [ox, oz + D], end: [ox, oz], thickness: req.wallThickness, height: req.wallHeight, elevation: 0 },
  ];

  for (const opening of [req.doors, req.windows]) {
    if (opening.count === 0) continue;
    const top = opening.sillHeight + opening.height;
    if (top > req.wallHeight + 1e-9) {
      throw new Error(
        `A ${opening.height} m opening on a ${opening.sillHeight} m sill needs a ${top.toFixed(2)} m wall, ` +
          `but the room's walls are ${req.wallHeight} m high. Say e.g. "3 m high" for taller walls.`,
      );
    }
  }

  const openings: OpeningPlacement[] = [];

  // Doors on the south wall (index 0).
  if (req.doors.count > 0) {
    const widths = Array.from({ length: req.doors.count }, () => req.doors.width);
    const offsets = layoutOpenings("south", W, widths);
    offsets.forEach((offsetAlongHost) => {
      openings.push({
        type: "door",
        hostIndex: 0,
        offsetAlongHost,
        width: req.doors.width,
        height: req.doors.height,
        sillHeight: req.doors.sillHeight,
      });
    });
  }

  // Windows fill north (2), then east (1), then west (3) — never the door wall.
  let remaining = req.windows.count;
  for (const hostIndex of [2, 1, 3]) {
    if (remaining === 0) break;
    const length = hostIndex === 2 || hostIndex === 0 ? W : D;
    const capacity = Math.floor((length - OPENING_MARGIN) / (req.windows.width + OPENING_MARGIN));
    const take = Math.min(remaining, Math.max(0, capacity));
    if (take === 0) continue;
    const widths = Array.from({ length: take }, () => req.windows.width);
    const offsets = layoutOpenings(WALL_NAMES[hostIndex], length, widths);
    offsets.forEach((offsetAlongHost) => {
      openings.push({
        type: "window",
        hostIndex,
        offsetAlongHost,
        width: req.windows.width,
        height: req.windows.height,
        sillHeight: req.windows.sillHeight,
      });
    });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new Error(
      `${req.windows.count} window(s) of ${req.windows.width} m do not fit on the north, east and west walls ` +
        `of a ${W} × ${D} m room with ${OPENING_MARGIN} m margins — ${remaining} would have nowhere to go. ` +
        `Use a bigger room, fewer windows, or narrower windows.`,
    );
  }

  return { walls, openings, request: req };
}
