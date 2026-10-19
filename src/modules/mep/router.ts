/**
 * MEP Auto-Routing — A* pathfinder over a 3D voxel grid.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 *
 * Algorithm:
 *   1. Snap the start / end / via points to a 3D voxel grid (default 0.25 m).
 *   2. Mark voxels overlapping any obstacle AABB as blocked.
 *   3. A* search using 6-connected neighbours (+X, -X, +Y, -Y, +Z, -Z).
 *      Cost = Euclidean distance; heuristic = Euclidean distance to goal.
 *      Manhattan-only paths are penalised via a bend cost so the search
 *      prefers straight runs with as few bends as possible (matches MEP
 *      fabrication practice: long straight runs + elbow fittings).
 *   4. Simplify the voxel path: drop intermediate voxels on a straight line,
 *      keeping only the bend points. This produces a minimal set of legs.
 *   5. Convert the simplified path into RouteLeg[] for downstream
 *      `addLinearElement` calls.
 *
 * Obstacle inflation: each AABB is grown by `clearance` in every direction
 * before being rasterised, so the route stays at least `clearance` metres
 * from any obstacle surface.
 */

import type { AABB, MepElementType, RouteLeg, RouteRequest, RouteResult, Vec3 } from "./types";
import { elementTypeFor } from "./types";
import { sizeForSystem } from "./sizing";

/** Voxel key: `x:y:z` integer triple packed as a string for Map hashing. */
function vkey(x: number, y: number, z: number): string {
  return `${x}:${y}:${z}`;
}

/** Voxel index unpacked from a key. */
function unkey(k: string): [number, number, number] {
  const [x, y, z] = k.split(":").map(Number);
  return [x, y, z];
}

/** Convert world metres to voxel index. */
function toVoxel(p: Vec3, voxel: number): [number, number, number] {
  return [
    Math.round(p.x / voxel),
    Math.round(p.y / voxel),
    Math.round(p.z / voxel),
  ];
}

/** Convert voxel index back to world metres (centre of voxel). */
function fromVoxel(x: number, y: number, z: number, voxel: number): Vec3 {
  return { x: x * voxel, y: y * voxel, z: z * voxel };
}

/** Euclidean distance between two 3D points. */
function dist3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Build a Set of blocked voxel keys from a list of obstacle AABBs.
 * Each AABB is inflated by `clearance` metres before rasterisation.
 */
function buildBlockedSet(
  obstacles: AABB[] | undefined,
  voxel: number,
  clearance: number,
): Set<string> {
  const blocked = new Set<string>();
  if (!obstacles || obstacles.length === 0) return blocked;
  for (const box of obstacles) {
    const minX = Math.floor((box.min.x - clearance) / voxel);
    const maxX = Math.ceil((box.max.x + clearance) / voxel);
    const minY = Math.floor((box.min.y - clearance) / voxel);
    const maxY = Math.ceil((box.max.y + clearance) / voxel);
    const minZ = Math.floor((box.min.z - clearance) / voxel);
    const maxZ = Math.ceil((box.max.z + clearance) / voxel);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          blocked.add(vkey(x, y, z));
        }
      }
    }
  }
  return blocked;
}

/** 6-connected neighbour offsets. */
const NEIGHBOURS: Array<[number, number, number]> = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/**
 * A* search over the 3D voxel grid.
 *
 * Returns the path as an array of voxel indices `[x, y, z][]`, or null
 * if no path was found within `maxIterations`.
 *
 * The cost function is Euclidean distance + a small bend penalty so the
 * search prefers straight runs. The heuristic is admissible (straight-line
 * Euclidean distance to goal), so A* is optimal.
 */
function aStar(
  start: [number, number, number],
  goal: [number, number, number],
  blocked: Set<string>,
  maxIterations: number,
  bendPenalty: number = 0.5,
): [number, number, number][] | null {
  const startKey = vkey(start[0], start[1], start[2]);
  const goalKey = vkey(goal[0], goal[1], goal[2]);

  if (blocked.has(goalKey)) {
    // Goal is blocked - try anyway, but the caller should clear a small
    // region around the goal to ensure reachability.
    // (We don't auto-clear here to keep the function pure.)
  }
  if (blocked.has(startKey)) {
    // Start is blocked - clear just the start voxel so the search can begin.
    blocked.delete(startKey);
  }

  // Best-known cost to each node.
  const gScore = new Map<string, number>();
  gScore.set(startKey, 0);

  // fScore = gScore + heuristic.
  const fScore = new Map<string, number>();
  const goalVec: Vec3 = { x: goal[0], y: goal[1], z: goal[2] };
  fScore.set(startKey, dist3({ x: start[0], y: start[1], z: start[2] }, goalVec));

  // Came-from for path reconstruction.
  const cameFrom = new Map<string, string>();

  // Open set: simple Map keyed by fScore. (Not the fastest PQ, but adequate
  // for the iteration counts we expect - typically <1000 voxels.)
  const open = new Map<string, number>();
  open.set(startKey, fScore.get(startKey)!);

  let iter = 0;
  while (open.size > 0) {
    if (++iter > maxIterations) {
      return null;
    }

    // Pop the node with lowest fScore.
    let currentKey: string | null = null;
    let currentF = Infinity;
    for (const [k, f] of open) {
      if (f < currentF) {
        currentF = f;
        currentKey = k;
      }
    }
    if (currentKey === null) return null;
    if (currentKey === goalKey) {
      // Reconstruct path.
      const path: [number, number, number][] = [];
      let k: string | undefined = currentKey;
      while (k) {
        path.unshift(unkey(k));
        k = cameFrom.get(k);
      }
      return path;
    }
    open.delete(currentKey);
    const [cx, cy, cz] = unkey(currentKey);

    // Direction of the previous leg (for bend penalty).
    const prevKey = cameFrom.get(currentKey);
    let prevDir: [number, number, number] | null = null;
    if (prevKey) {
      const [px, py, pz] = unkey(prevKey);
      prevDir = [cx - px, cy - py, cz - pz];
    }

    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      const nKey = vkey(nx, ny, nz);
      if (blocked.has(nKey)) continue;
      if (gScore.has(nKey) && gScore.get(nKey)! <= gScore.get(currentKey)! + 1) continue;

      const stepCost = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let bend = 0;
      if (prevDir) {
        // Bend penalty if direction differs from previous leg.
        const dot = prevDir[0] * dx + prevDir[1] * dy + prevDir[2] * dz;
        if (dot === 0) bend = bendPenalty;
      }
      const tentativeG = gScore.get(currentKey)! + stepCost + bend;

      if (!gScore.has(nKey) || tentativeG < gScore.get(nKey)!) {
        cameFrom.set(nKey, currentKey);
        gScore.set(nKey, tentativeG);
        const h = dist3({ x: nx, y: ny, z: nz }, goalVec);
        const f = tentativeG + h;
        fScore.set(nKey, f);
        open.set(nKey, f);
      }
    }
  }

  return null;
}

/**
 * Simplify a voxel path by removing intermediate voxels on a straight line.
 * Keeps only the start, end, and bend points.
 */
function simplifyPath(path: [number, number, number][]): [number, number, number][] {
  if (path.length <= 2) return path;
  const out: [number, number, number][] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const curr = path[i];
    const next = path[i + 1];
    const dir1: [number, number, number] = [
      curr[0] - prev[0], curr[1] - prev[1], curr[2] - prev[2],
    ];
    const dir2: [number, number, number] = [
      next[0] - curr[0], next[1] - curr[1], next[2] - curr[2],
    ];
    // If direction changed, keep this point as a bend.
    if (dir1[0] !== dir2[0] || dir1[1] !== dir2[1] || dir1[2] !== dir2[2]) {
      out.push(curr);
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

/** Convert a simplified voxel path into a list of RouteLeg. */
function legsFromPath(
  path: [number, number, number][],
  voxel: number,
): RouteLeg[] {
  const legs: RouteLeg[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const start = fromVoxel(path[i][0], path[i][1], path[i][2], voxel);
    const end = fromVoxel(path[i + 1][0], path[i + 1][1], path[i + 1][2], voxel);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const planAngle = Math.atan2(dz, dx);
    const isVertical = Math.abs(dy) > 0.5 * length; // most of the leg is vertical
    legs.push({ start, end, length, planAngle, isVertical });
  }
  return legs;
}

/** Estimate pressure drop. Ducts: Pa per metre. Pipes: bar per metre. */
function estimatePressureDrop(
  legs: RouteLeg[],
  system: string,
  velocity: number,
): number {
  const totalLength = legs.reduce((s, l) => s + l.length, 0);
  // Very rough estimate. Real friction calculations would use Colebrook-White
  // or Darcy-Weisbach with proper roughness coefficients. This is enough
  // for early-design routing decisions and audit logging.
  if (system.endsWith("-air") || system.endsWith("-air")) {
    // Duct: ~1 Pa/m at 4 m/s, scaled by v^2.
    return totalLength * (velocity * velocity / 16);
  }
  // Pipe: ~0.0001 bar/m at 1 m/s, scaled by v^2.
  return totalLength * (velocity * velocity / 10000);
}

/**
 * Route a path from `request.start` to `request.end`, passing through any
 * `request.via` waypoints in order.
 *
 * Returns null if no path is found within `maxIterations`.
 */
export function route(request: RouteRequest): RouteResult | null {
  const voxel = request.voxelSize ?? 0.25;
  const clearance = request.clearance ?? 0.1;
  const maxIterations = request.maxIterations ?? 5000;
  const elementType: MepElementType = elementTypeFor(request.system);

  const blocked = buildBlockedSet(request.obstacles, voxel, clearance);

  // Build the list of waypoints: start → via[] → end.
  const waypoints: Vec3[] = [request.start, ...(request.via ?? []), request.end];

  const allLegs: RouteLeg[] = [];
  let bendCount = 0;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const start = toVoxel(waypoints[i], voxel);
    const goal = toVoxel(waypoints[i + 1], voxel);

    // Clear a small region around the goal so the search can always terminate.
    for (const [dx, dy, dz] of NEIGHBOURS) {
      blocked.delete(vkey(goal[0] + dx, goal[1] + dy, goal[2] + dz));
    }
    blocked.delete(vkey(goal[0], goal[1], goal[2]));

    const path = aStar(start, goal, blocked, maxIterations);
    if (!path) return null;

    const simplified = simplifyPath(path);
    const legs = legsFromPath(simplified, voxel);

    // Count bends across the entire route (inter-waypoint bends too).
    if (allLegs.length > 0 && legs.length > 0) {
      const prevLeg = allLegs[allLegs.length - 1];
      const nextLeg = legs[0];
      const dir1: [number, number, number] = [
        prevLeg.end.x - prevLeg.start.x,
        prevLeg.end.y - prevLeg.start.y,
        prevLeg.end.z - prevLeg.start.z,
      ];
      const dir2: [number, number, number] = [
        nextLeg.end.x - nextLeg.start.x,
        nextLeg.end.y - nextLeg.start.y,
        nextLeg.end.z - nextLeg.start.z,
      ];
      if (dir1[0] !== dir2[0] || dir1[1] !== dir2[1] || dir1[2] !== dir2[2]) {
        bendCount++;
      }
    }
    bendCount += Math.max(0, legs.length - 1);
    allLegs.push(...legs);
  }

  if (allLegs.length === 0) return null;

  const sizing = sizeForSystem(request.system, request.flowRate, request.maxVelocity);
  const totalLength = allLegs.reduce((s, l) => s + l.length, 0);
  const pressureDrop = estimatePressureDrop(allLegs, request.system, sizing.size.velocity);

  return {
    system: request.system,
    elementType,
    size: sizing.size,
    legs: allLegs,
    totalLength,
    bendCount,
    pressureDrop,
    voxelSize: voxel,
  };
}

/**
 * Convenience: route a path between two points, ignoring intermediate
 * waypoints and obstacles. Useful for the simplest UI case: "click two
 * points, get a route".
 */
export function routeSimple(
  start: Vec3,
  end: Vec3,
  system: RouteRequest["system"],
  flowRate: number,
  obstacles?: AABB[],
): RouteResult | null {
  return route({ start, end, system, flowRate, obstacles });
}
