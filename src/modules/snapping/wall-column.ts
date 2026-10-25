/**
 * Automatic wall-to-column connection (MASTER PROMPT MODULE 2B.3).
 *
 * When a wall is drawn toward (or ends at) a column, the wall endpoint is
 * resolved against the column's actual boundary geometry — not against a
 * naive centerline/edge-box assumption (spec: "do not assume every wall
 * connects at its centerline or that every column is rectangular").
 *
 * Geometry (spec formulas, level E):
 *   Wall centerline L(t) = P0 + t·d.  Target plane through Q with normal n:
 *       t = ((Q − P0) · n) / (d · n)
 *   Used only when |d·n| > EPS (wall actually approaches the plane) and
 *   the resulting t > 0 (forward). Curved/irregular column boundaries are
 *   reported as unsupported by this analytic path (repair/recovery path
 *   returns a diagnostic rather than a wrong endpoint).
 *
 * Compound walls (spec): the contact offset accounts for the wall's
 * location-line justification (core centerline vs finish faces) so the
 * endpoint lands on the chosen face, not the location line.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import type { GeometricReference, RelationshipRegistry } from "../relationships";
import { COINCIDENT_TOL } from "../solid-kernel/brep";

export interface ColumnReferenceGeometry {
  elementId: string;
  /** Column footprint polygon in plan (metres, CCW). */
  footprint: Array<[number, number]>;
  /** Base/top elevations. */
  baseZ: number;
  topZ: number;
  /** True when the footprint is an exact rectangle (fast analytic path). */
  isRectangle: boolean;
}

export interface WallLocationLine {
  start: [number, number];
  direction: [number, number];
  /** Wall width (metres) — used for compound contact offsets. */
  width: number;
  /** Where the location line sits within the wall thickness. */
  justification: "core-centerline" | "finish-face-exterior" | "finish-face-interior";
}

export interface ContactCandidate {
  /** Footprint edge index. */
  edgeIndex: number;
  /** Point on the edge (metres). */
  point: [number, number];
  /** Outward normal of the contact face. */
  normal: [number, number];
  /** Ray parameter t along the wall direction (metres). */
  t: number;
  /** Signed perpendicular distance from wall centerline to contact point. */
  lateralOffset: number;
}

// ── Reference geometry (spec 2B.3 step 1) ────────────────────────────────

/** GetColumnReferenceGeometry: rectangle detection + validity. */
export function getColumnReferenceGeometry(args: {
  elementId: string;
  footprint: Array<[number, number]>;
  baseZ: number;
  topZ: number;
}): ColumnReferenceGeometry {
  const fp = args.footprint;
  if (fp.length < 3) throw new Error("GetColumnReferenceGeometry: footprint needs >= 3 points");
  if (args.topZ <= args.baseZ) throw new Error("GetColumnReferenceGeometry: topZ must exceed baseZ");
  const isRectangle = detectRectangle(fp);
  return {
    elementId: args.elementId,
    footprint: fp,
    baseZ: args.baseZ,
    topZ: args.topZ,
    isRectangle,
  };
}

/** Rectangle detection: 4 edges, opposite edges parallel and equal. */
export function detectRectangle(fp: Array<[number, number]>): boolean {
  if (fp.length !== 4) return false;
  const [a, b, c, d] = fp;
  const sub = (p: [number, number], q: [number, number]): [number, number] => [p[0] - q[0], p[1] - q[1]];
  const dot = (p: [number, number], q: [number, number]) => p[0] * q[0] + p[1] * q[1];
  const cross = (p: [number, number], q: [number, number]) => p[0] * q[1] - p[1] * q[0];
  const len = (p: [number, number]) => Math.hypot(p[0], p[1]);
  const ab = sub(b, a), bc = sub(c, b), cd = sub(d, c), da = sub(a, d);
  // Right angles at each corner (within tolerance).
  for (const [u, v] of [[ab, bc], [bc, cd], [cd, da], [da, ab]] as const) {
    if (Math.abs(dot(u, v)) > 1e-9 * len(u) * len(v)) return false;
  }
  // Opposite sides equal.
  if (Math.abs(len(ab) - len(cd)) > COINCIDENT_TOL) return false;
  if (Math.abs(len(bc) - len(da)) > COINCIDENT_TOL) return false;
  // Convex order (positive area).
  if (cross(ab, bc) <= 0) return false;
  return true;
}

/** GetWallLocationLine: normalize direction. */
export function getWallLocationLine(args: {
  start: [number, number];
  end: [number, number];
  width: number;
  justification: WallLocationLine["justification"];
}): WallLocationLine {
  const dx = args.end[0] - args.start[0];
  const dy = args.end[1] - args.start[1];
  const l = Math.hypot(dx, dy);
  if (l < COINCIDENT_TOL) throw new Error("GetWallLocationLine: zero-length wall");
  return {
    start: args.start,
    direction: [dx / l, dy / l],
    width: args.width,
    justification: args.justification,
  };
}

// ── Contact resolution (spec 2B.3 steps 2–7) ─────────────────────────────

/** Footprint edge with outward normal (CCW polygon → outward normals). */
function edgeNormal(a: [number, number], b: [number, number]): [number, number] {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const l = Math.hypot(ex, ey);
  // Outward normal for CCW: rotate edge by -90°.
  return [ey / l, -ex / l];
}

/** FindWallColumnContactCandidates: all forward edge hits of the wall ray. */
export function findWallColumnContactCandidates(
  wall: WallLocationLine,
  col: ColumnReferenceGeometry,
): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  for (let i = 0; i < col.footprint.length; i++) {
    const a = col.footprint[i];
    const b = col.footprint[(i + 1) % col.footprint.length];
    const n = edgeNormal(a, b);
    const dn = wall.direction[0] * n[0] + wall.direction[1] * n[1];
    // Spec formula requires the wall to approach the plane: d·n < 0 means
    // the ray travels INTO this face (outward normal points away).
    if (dn >= -1e-12) continue;
    const t = ((a[0] - wall.start[0]) * n[0] + (a[1] - wall.start[1]) * n[1]) / dn;
    if (t <= 0) continue; // behind the start
    const px = wall.start[0] + wall.direction[0] * t;
    const py = wall.start[1] + wall.direction[1] * t;
    // Point must lie on the edge segment.
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const s = ((px - a[0]) * ex + (py - a[1]) * ey) / (ex * ex + ey * ey);
    if (s < -1e-9 || s > 1 + 1e-9) continue;
    const lateralOffset =
      (px - wall.start[0]) * -wall.direction[1] + (py - wall.start[1]) * wall.direction[0];
    out.push({ edgeIndex: i, point: [px, py], normal: n, t, lateralOffset });
  }
  return out.sort((p, q) => p.t - q.t);
}

/**
 * CalculateCompoundWallContactOffset: longitudinal pull-back of the wall
 * endpoint so that the ENTIRE end cap clears the column face plane.
 *
 * Derivation (level E, exact for planar faces): let d be the wall
 * direction, p its right perpendicular, n the outward contact normal, and
 * ℓ the largest lateral distance from the location line to the wall face
 * on the side whose corners would penetrate (side where p·n < 0). A corner
 * at lateral offset ℓ sits inside the face plane by ℓ·|p·n| when the
 * location-line endpoint is on the face; pulling the endpoint back along
 * −d by Δ moves the corner out by Δ·|d·n|. Clearance requires
 *
 *   Δ = ℓ · |p·n| / |d·n|        (0 for perpendicular approach)
 *
 * The lateral extent per justification (documented level-E assumption:
 * "exterior" = the side the wall is approached from):
 *   core-centerline        → w/2 on both sides
 *   finish-face-exterior   → 0 on the approach side, w on the far side
 *   finish-face-interior   → w on the approach side, 0 on the far side
 * Pull-backs beyond 2×wall width are reported as unsupported (near-parallel
 * approach) by returning requested=false.
 */
export function calculateCompoundWallContactOffset(
  wall: WallLocationLine,
  contactNormal: [number, number],
): { pullback: number; supported: boolean; contactFace: "exterior" | "interior" } {
  const px = -wall.direction[1], py = wall.direction[0]; // right perpendicular
  const dn = wall.direction[0] * contactNormal[0] + wall.direction[1] * contactNormal[1]; // < 0 approaching
  const pn = px * contactNormal[0] + py * contactNormal[1];
  // Side of the location line whose corners penetrate: offset ℓ has
  // corner·n = ℓ·pn; penetration when ℓ·pn < 0.
  const penetratingNegativeSide = pn > 0;
  const half = wall.width / 2;
  // Extent of material on the approach side and the far side.
  let approachExtent: number, farExtent: number;
  if (wall.justification === "core-centerline") {
    approachExtent = half;
    farExtent = half;
  } else if (wall.justification === "finish-face-exterior") {
    approachExtent = 0; // location line sits on the (assumed) exterior face
    farExtent = wall.width;
  } else {
    approachExtent = wall.width;
    farExtent = 0;
  }
  // Penetrating side: negative offsets reach the approach-side face when
  // the location line is inside the wall on that side.
  const ℓ = penetratingNegativeSide ? approachExtent : farExtent;
  const face: "exterior" | "interior" = penetratingNegativeSide ? "exterior" : "interior";
  const denom = Math.abs(dn);
  if (denom < 1e-9) {
    return { pullback: 0, supported: false, contactFace: face };
  }
  const pullback = (ℓ * Math.abs(pn)) / denom;
  const supported = pullback <= 2 * wall.width + COINCIDENT_TOL;
  return { pullback: supported ? pullback : 0, supported, contactFace: face };
}

/**
 * CalculateWallEndpoint: the wall endpoint on the column contact face,
 * pulled back by the compound clearance so the full end cap stays outside
 * the column. Returns null when no valid contact exists or the approach
 * is analytically unsupported.
 */
export function calculateWallEndpoint(
  wall: WallLocationLine,
  col: ColumnReferenceGeometry,
): { endpoint: [number, number]; contact: ContactCandidate; pullback: number } | null {
  const candidates = findWallColumnContactCandidates(wall, col);
  if (!candidates.length) return null;
  const contact = candidates[0]; // nearest forward contact
  const { pullback, supported } = calculateCompoundWallContactOffset(wall, contact.normal);
  if (!supported) return null; // near-parallel approach: analytic path refuses
  const endpoint: [number, number] = [
    contact.point[0] - wall.direction[0] * pullback,
    contact.point[1] - wall.direction[1] * pullback,
  ];
  return { endpoint, contact, pullback };
}

/** PreviewWallColumnJoin: pure preview data for the view layer. */
export function previewWallColumnJoin(
  wall: WallLocationLine,
  col: ColumnReferenceGeometry,
): {
  hasContact: boolean;
  endpoint: [number, number] | null;
  contactFace: [number, number] | null;
  contactNormal: [number, number] | null;
  compoundPullback: number | null;
} {
  const r = calculateWallEndpoint(wall, col);
  if (!r) {
    return { hasContact: false, endpoint: null, contactFace: null, contactNormal: null, compoundPullback: null };
  }
  return {
    hasContact: true,
    endpoint: r.endpoint,
    contactFace: r.contact.point,
    contactNormal: r.contact.normal,
    compoundPullback: r.pullback,
  };
}

/**
 * CreateWallColumnRelationship: persist an endpoint-constraint between
 * the wall's resolved endpoint and the column's contact edge.
 */
export function createWallColumnRelationship(
  registry: RelationshipRegistry,
  wall: WallLocationLine,
  col: ColumnReferenceGeometry,
  wallElementId: string,
  endpoint: [number, number],
  contact: ContactCandidate,
  z: number,
): ReturnType<RelationshipRegistry["createRelationship"]> {
  return registry.createRelationship({
    type: "endpoint-constraint",
    source: {
      elementId: col.elementId,
      kind: "edge",
      name: `footprint-edge-${contact.edgeIndex}`,
      position: [contact.point[0], contact.point[1], z],
      direction: [contact.normal[0], contact.normal[1], 0],
    },
    target: {
      elementId: wallElementId,
      kind: "endpoint",
      position: [endpoint[0], endpoint[1], z],
    },
    reconnection: "follow-source",
    deletionPolicy: "break",
    origin: "automatic",
  });
}

/** UpdateWallAfterColumnChange: re-resolve the endpoint for a moved column. */
export function updateWallAfterColumnChange(args: {
  wall: WallLocationLine;
  newColumn: ColumnReferenceGeometry;
  relationship: RelationshipRecordLike;
}): { endpoint: [number, number] | null; note: string } {
  const resolved = calculateWallEndpoint(args.wall, args.newColumn);
  if (!resolved) {
    return { endpoint: null, note: "column moved away from the wall; relationship must be reported for repair" };
  }
  return { endpoint: resolved.endpoint, note: `contact now at edge ${resolved.contact.edgeIndex}` };
}

export interface RelationshipRecordLike {
  id: string;
  source: GeometricReference;
  target: GeometricReference;
}

/**
 * ValidateWallColumnConnection: endpoint must lie on the referenced edge
 * (within tolerance) and the wall must not penetrate the column.
 */
export function validateWallColumnConnection(
  wall: WallLocationLine,
  col: ColumnReferenceGeometry,
  endpoint: [number, number],
  contact: ContactCandidate,
): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  const a = col.footprint[contact.edgeIndex];
  const b = col.footprint[(contact.edgeIndex + 1) % col.footprint.length];
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const s = ((endpoint[0] - a[0]) * ex + (endpoint[1] - a[1]) * ey) / (ex * ex + ey * ey);
  if (s < -1e-6 || s > 1 + 1e-6) problems.push("endpoint is not on the referenced edge");
  // Penetration check: endpoint must not be strictly inside the footprint.
  if (pointInPolygon(endpoint, col.footprint)) problems.push("endpoint penetrates the column footprint");
  // Pull-back can legitimately exceed the width for oblique approaches;
  // only flag absurd distances (> 10× width).
  if (Math.hypot(endpoint[0] - contact.point[0], endpoint[1] - contact.point[1]) > 10 * wall.width) {
    problems.push("endpoint is implausibly far from the contact point");
  }
  return { valid: problems.length === 0, problems };
}

/**
 * RepairOrReportInvalidWallColumnConnection: attempt a deterministic
 * repair (re-resolve the endpoint against current geometry); when repair
 * is impossible, return the diagnostic for the caller to surface.
 */
export function repairOrReportInvalidWallColumnConnection(
  wall: WallLocationLine,
  col: ColumnReferenceGeometry,
): { repaired: boolean; endpoint: [number, number] | null; diagnostic: string | null } {
  const resolved = calculateWallEndpoint(wall, col);
  if (!resolved) {
    return { repaired: false, endpoint: null, diagnostic: "no contact between wall and column; cannot repair automatically" };
  }
  const v = validateWallColumnConnection(wall, col, resolved.endpoint, resolved.contact);
  if (!v.valid) {
    return { repaired: false, endpoint: null, diagnostic: `repair failed: ${v.problems.join("; ")}` };
  }
  return { repaired: true, endpoint: resolved.endpoint, diagnostic: null };
}

function pointInPolygon(p: [number, number], poly: Array<[number, number]>): boolean {
  // On-edge points are NOT interior (tolerant edge test first — the wall
  // endpoint legitimately lies ON the column face).
  const tol = 1e-9;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const apx = p[0] - a[0], apy = p[1] - a[1];
    const abLen2 = abx * abx + aby * aby;
    if (abLen2 < 1e-24) continue;
    const t = (apx * abx + apy * aby) / abLen2;
    if (t < -tol || t > 1 + tol) continue;
    const cx = a[0] + abx * t, cy = a[1] + aby * t;
    if (Math.hypot(p[0] - cx, p[1] - cy) <= tol) return false;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
