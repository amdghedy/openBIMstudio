/**
 * MEP connectivity, derived from geometry (no stored links), so existing models work.
 *
 * Linear runs (duct, pipe, cable tray, conduit) connect at their two ends. Fittings connect
 * through their centre and arms. Equipment is a terminal: it moves with the runs touching it
 * but does not pull their other connections along.
 */
import { fittingArmAngles, fittingArmLength } from "./fitting-outline";

export const LINEAR_MEP = new Set(["duct", "pipe", "cable-tray", "conduit"]);

export interface MepLike {
  id: string;
  type: string;
  properties?: Record<string, unknown>;
  params: {
    start?: [number, number]; end?: [number, number]; point?: [number, number];
    elevation: number; endElevation?: number; height: number; thickness: number; depth?: number;
    angleIn?: number; angleOut?: number; bendRadius?: number; fittingKind?: string; parentType?: string;
  };
}

export const isMepElement = (e: { type: string }): boolean => LINEAR_MEP.has(e.type) || e.type === "fitting" || e.type === "equipment";

export interface Pt3 { x: number; y: number; z: number }

/** Horizontal tolerance (m) and vertical tolerance (m) for two parts to count as connected. */
export const CONNECT_TOL = 0.12;
export const CONNECT_TOL_Y = 0.25;

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Both end points of a linear run, with elevation. */
export function linearEnds(e: MepLike): [Pt3, Pt3] | null {
  const { start, end, elevation, endElevation } = e.params;
  if (!start || !end) return null;
  return [{ x: start[0], y: elevation, z: start[1] }, { x: end[0], y: endElevation ?? elevation, z: end[1] }];
}

function fittingReach(p: MepLike["params"]): number {
  const isRound = p.parentType === "pipe" || p.parentType === "conduit";
  const arm = fittingArmLength(p.thickness, p.height, p.bendRadius, isRound);
  return Math.max(arm * 1.6, 2.5 * Math.max(p.thickness, p.height, 0.1));
}

/** Directions (radians) in which a fitting exposes a connection. */
export function fittingPortAngles(p: MepLike["params"]): number[] {
  const kind = p.fittingKind ?? "elbow";
  const aIn = p.angleIn ?? 0, aOut = p.angleOut ?? Math.PI / 2;
  if (kind === "elbow") return [aIn + Math.PI, aOut];
  if (kind === "cap") return [aIn + Math.PI];
  if (kind === "transition" || kind === "union") return [aIn, aIn + Math.PI];
  return fittingArmAngles(kind as any, aIn, aOut);
}

/** True when a free end point touches this element. */
function pointTouches(pt: Pt3, e: MepLike): boolean {
  const p = e.params;
  if (LINEAR_MEP.has(e.type)) {
    const ends = linearEnds(e);
    if (!ends) return false;
    const [a, b] = ends;
    const horiz = segDist(pt.x, pt.z, a.x, a.z, b.x, b.z);
    if (horiz > 0.05) return false;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const t = len < 1e-9 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * (b.x - a.x) + (pt.z - a.z) * (b.z - a.z)) / (len * len)));
    return Math.abs(pt.y - (a.y + (b.y - a.y) * t)) <= CONNECT_TOL_Y;
  }
  if (e.type === "fitting" && p.point) {
    if (Math.abs(pt.y - p.elevation) > CONNECT_TOL_Y + p.height / 2) return false;
    const [cx, cz] = p.point;
    if (Math.hypot(pt.x - cx, pt.z - cz) <= CONNECT_TOL) return true;
    const reach = fittingReach(p);
    return fittingPortAngles(p).some((ang) =>
      segDist(pt.x, pt.z, cx, cz, cx + Math.cos(ang) * reach, cz + Math.sin(ang) * reach) <= CONNECT_TOL);
  }
  if (e.type === "equipment" && p.point) {
    const half = Math.max(p.thickness, p.depth ?? p.thickness) / 2 + CONNECT_TOL;
    return Math.abs(pt.x - p.point[0]) <= half && Math.abs(pt.z - p.point[1]) <= half &&
      pt.y >= p.elevation - CONNECT_TOL_Y && pt.y <= p.elevation + p.height + CONNECT_TOL_Y;
  }
  return false;
}

/** Points through which `e` can attach to something else. */
function attachPoints(e: MepLike): Pt3[] {
  if (LINEAR_MEP.has(e.type)) return linearEnds(e) ?? [];
  const p = e.params;
  if (e.type === "fitting" && p.point) {
    const [cx, cz] = p.point;
    const reach = fittingReach(p);
    return [{ x: cx, y: p.elevation, z: cz },
      ...fittingPortAngles(p).map((a) => ({ x: cx + Math.cos(a) * reach * 0.5, y: p.elevation, z: cz + Math.sin(a) * reach * 0.5 }))];
  }
  if (e.type === "equipment" && p.point) return [{ x: p.point[0], y: p.elevation + p.height / 2, z: p.point[1] }];
  return [];
}

/** Whether two MEP elements are physically connected. */
export function areConnected(a: MepLike, b: MepLike): boolean {
  if (a.id === b.id) return false;
  // equipment never connects to equipment; fittings/linears connect through free ends touching the other part
  if (a.type === "equipment" && b.type === "equipment") return false;
  const aPts = LINEAR_MEP.has(a.type) ? attachPoints(a) : a.type === "fitting" ? [attachPoints(a)[0]] : [];
  const bPts = LINEAR_MEP.has(b.type) ? attachPoints(b) : b.type === "fitting" ? [attachPoints(b)[0]] : [];
  // linear ends and fitting centres touch the other element
  if (aPts.some((pt) => pt && pointTouches(pt, b))) return true;
  if (bPts.some((pt) => pt && pointTouches(pt, a))) return true;
  return false;
}

/**
 * Everything that should move with `startIds`: the connected network, spreading through
 * runs and fittings. Equipment that is reached moves too but does not spread further.
 * Pinned elements are neither moved nor spread through.
 */
export function expandConnected(startIds: Iterable<string>, elements: MepLike[]): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const mep = elements.filter((e) => isMepElement(e) && !e.properties?.pinned);
  const seen = new Set<string>();
  const queue: MepLike[] = [];
  for (const id of startIds) {
    const e = byId.get(id);
    if (!e) continue;
    seen.add(id);
    if (isMepElement(e) && !e.properties?.pinned) queue.push(e);
  }
  while (queue.length) {
    const cur = queue.pop()!;
    for (const other of mep) {
      if (seen.has(other.id) || !areConnected(cur, other)) continue;
      seen.add(other.id);
      if (other.type !== "equipment") queue.push(other);
    }
  }
  return [...seen];
}
