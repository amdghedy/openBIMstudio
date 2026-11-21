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
    elevation: number; endElevation?: number; height: number; thickness: number; depth?: number; width?: number;
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
export function pointTouches(pt: Pt3, e: MepLike): boolean {
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

// ── Indexed pair search (uniform grid over plan cells) ────────────────────
//
// The old callers scanned every pair (O(n²)) on every recompute. The
// geometry gate in areConnected/pointTouches is LOCAL: a connection needs
// an attach point of one element to land inside the other element's touch
// region (segment body ± CONNECT_TOL, fitting disc of fittingReach +
// CONNECT_TOL, equipment box + CONNECT_TOL). Two elements whose touch
// regions do not overlap in plan CANNOT be connected, so a uniform grid
// over touch-region bounding boxes finds exactly the same pairs as the
// brute-force scan — average O(n + k) for k true neighbours — while
// areConnected stays the sole connection predicate. Vertical filtering
// stays inside areConnected; the grid is plan-only by design (multi-storey
// models still compare across floors, but only within the same plan cell).
// Oversize regions (long runs) fall back to a global list so no element
// can blow up the cell count. Equivalence with the brute-force scan is
// pinned by tests/mep-connectivity-index.test.cjs on seeded random models.

const INDEX_CELL_M = 2;
const INDEX_MAX_CELLS_PER_ELEMENT = 256;

/** Plan bounding box (m) of the region in which `e` can be touched. */
function touchRegion(e: MepLike): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  const p = e.params;
  if (LINEAR_MEP.has(e.type)) {
    const ends = linearEnds(e);
    if (!ends) return null;
    const [a, b] = ends;
    return {
      minX: Math.min(a.x, b.x) - CONNECT_TOL, maxX: Math.max(a.x, b.x) + CONNECT_TOL,
      minZ: Math.min(a.z, b.z) - CONNECT_TOL, maxZ: Math.max(a.z, b.z) + CONNECT_TOL,
    };
  }
  if (e.type === "fitting" && p.point) {
    const r = fittingReach(p) + CONNECT_TOL;
    return { minX: p.point[0] - r, maxX: p.point[0] + r, minZ: p.point[1] - r, maxZ: p.point[1] + r };
  }
  if (e.type === "equipment" && p.point) {
    const half = Math.max(p.thickness, p.depth ?? p.thickness) / 2 + CONNECT_TOL;
    return { minX: p.point[0] - half, maxX: p.point[0] + half, minZ: p.point[1] - half, maxZ: p.point[1] + half };
  }
  return null;
}

/**
 * All connected pairs in `elements`, in input order (i < j), using the
 * grid index. Returns EXACTLY the pairs the O(n²) double loop over
 * areConnected would return — the index only prunes pairs that cannot
 * touch; every surviving candidate is still decided by areConnected.
 */
export function connectedPairs(elements: MepLike[]): Array<[MepLike, MepLike]> {
  const n = elements.length;
  const cells = new Map<string, number[]>();
  const oversize: number[] = [];
  const cellOf = (v: number): number => Math.floor(v / INDEX_CELL_M);
  for (let i = 0; i < n; i++) {
    const region = touchRegion(elements[i]);
    if (!region) continue;
    const x0 = cellOf(region.minX), x1 = cellOf(region.maxX);
    const z0 = cellOf(region.minZ), z1 = cellOf(region.maxZ);
    const count = (x1 - x0 + 1) * (z1 - z0 + 1);
    if (count > INDEX_MAX_CELLS_PER_ELEMENT) { oversize.push(i); continue; }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = cx + "," + cz;
        const list = cells.get(key);
        if (list) list.push(i);
        else cells.set(key, [i]);
      }
    }
  }
  const seen = new Set<string>();
  const idxPairs: Array<[number, number]> = [];
  const consider = (i: number, j: number): void => {
    if (i === j) return;
    const a = Math.min(i, j), b = Math.max(i, j);
    const key = a + ":" + b;
    if (seen.has(key)) return;
    seen.add(key);
    if (areConnected(elements[a], elements[b])) idxPairs.push([a, b]);
  };
  for (const list of cells.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) consider(list[x], list[y]);
    }
  }
  for (const i of oversize) {
    for (let j = 0; j < n; j++) consider(i, j);
  }
  // Deterministic input order regardless of cell iteration order.
  idxPairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return idxPairs.map(([a, b]) => [elements[a], elements[b]] as [MepLike, MepLike]);
}

/** Adjacency (element id → neighbour ids) built once from connectedPairs. */
export function connectivityAdjacency(elements: MepLike[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of elements) adj.set(e.id, []);
  for (const [a, b] of connectedPairs(elements)) {
    adj.get(a.id)!.push(b.id);
    adj.get(b.id)!.push(a.id);
  }
  return adj;
}

/**
 * Everything that should move with `startIds`: the connected network, spreading through
 * runs and fittings. Equipment that is reached moves too but does not spread further.
 * Pinned elements are neither moved nor spread through.
 */
export function expandConnected(startIds: Iterable<string>, elements: MepLike[]): string[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const mep = elements.filter((e) => isMepElement(e) && !e.properties?.pinned);
  const adj = connectivityAdjacency(mep);
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
    for (const nid of adj.get(cur.id) ?? []) {
      if (seen.has(nid)) continue;
      const other = byId.get(nid)!;
      seen.add(nid);
      if (other.type !== "equipment") queue.push(other);
    }
  }
  return [...seen];
}

/**
 * Tab-selection helper. `branch` follows the run through plain connections and stops at
 * junction fittings (tee / cross / wye: 3+ ports) — the junction is included, the other
 * branches are not. `network` follows everything, including through junctions. Equipment
 * is included but never spread through. Pinned parts are selectable, so they are included.
 */
export function connectedSelection(startId: string, elements: MepLike[], mode: "branch" | "network"): string[] {
  const mep = elements.filter(isMepElement);
  const byId = new Map(mep.map((e) => [e.id, e]));
  const start = byId.get(startId);
  if (!start) return [startId];
  const adj = connectivityAdjacency(mep);
  const seen = new Set<string>([startId]);
  const queue: MepLike[] = [start];
  const isJunction = (e: MepLike) => e.type === "fitting" && fittingPortAngles(e.params).length >= 3;
  while (queue.length) {
    const cur = queue.pop()!;
    for (const nid of adj.get(cur.id) ?? []) {
      const o = byId.get(nid)!;
      if (seen.has(o.id)) continue;
      // Two runs meeting at a tee also touch each other directly; in branch mode they only
      // count as connected THROUGH the junction, which ends the branch.
      if (mode === "branch" && !isJunction(cur) && !isJunction(o) &&
          mep.some((j) => j !== cur && j !== o && isJunction(j) && areConnected(j, cur) && areConnected(j, o))) continue;
      seen.add(o.id);
      if (o.type === "equipment") continue;
      if (mode === "branch" && isJunction(o)) continue;
      queue.push(o);
    }
  }
  return [...seen];
}
