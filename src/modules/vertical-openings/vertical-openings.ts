/**
 * src/modules/vertical-openings/vertical-openings.ts
 *
 * Vertical openings through horizontal hosts — common "Shaft opening",
 * "Vertical opening" and "Skylight" family, closed as pure, dependency-free
 * geometry so it compiles alone in Node tests and runs in the browser.
 *
 * Model: a vertical opening is a plan footprint (polygon in XZ) with a Z
 * span [base, base + height]. Every slab / roof / ceiling whose Z span
 * intersects the opening's span AND whose outline overlaps the footprint
 * gets a hole cut through it (THREE.Shape holes in the viewport,
 * IFCARBITRARYPROFILEDEFWITHVOIDS + IfcOpeningElement/IfcRelVoidsElement
 * in the IFC export).
 *
 * Semantics implemented by this module:
 *   - One opening can cut MANY floors (shaft mode: tall Z span).
 *   - An opening whose footprint crosses the slab edge is clipped to the
 *     slab interior and the cut is reported honestly (warning), not faked.
 *   - An opening that cuts nothing is flagged as an orphan by the audit.
 *
 * Coordinate conventions
 *   - All polygons live in the XZ plan plane (metres).
 *   - `cutSlabHoles` returns the outline normalised CCW (positive signed
 *     doubled area in XZ) and every hole CW (negative) — the opposite
 *     winding three.js and IFC expect between outline and voids.
 */

export type Footprint = Array<[number, number]>;

/* ── Footprint helpers ──────────────────────────────────────────────── */

/** Axis-aligned / rotated rectangle centred at (cx, cz). */
export function rectFootprint(cx: number, cz: number, width: number, depth: number, rotationDeg = 0): Footprint {
  const w = Math.max(0.01, width) / 2;
  const d = Math.max(0.01, depth) / 2;
  const a = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const corners: Footprint = [
    [-w, -d], [w, -d], [w, d], [-w, d],
  ];
  return corners.map(([x, z]) => [cx + x * cos - z * sin, cz + x * sin + z * cos] as [number, number]);
}

/** Signed doubled area in the XZ plane (positive = CCW seen from +Y). */
export function footprintArea2(poly: Footprint): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

/** Winding-agnostic absolute area (m²). */
export function footprintArea(poly: Footprint): number {
  return Math.abs(footprintArea2(poly)) / 2;
}

/** Ray-cast point-in-polygon, winding agnostic. */
export function pointInFootprint(x: number, z: number, poly: Footprint): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Segment/segment intersection (returns true for a proper or touching cross). */
function segmentsIntersect(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
  const d = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
    (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d1 = d(b1[0], b1[1], b2[0], b2[1], a1[0], a1[1]);
  const d2 = d(b1[0], b1[1], b2[0], b2[1], a2[0], a2[1]);
  const d3 = d(a1[0], a1[1], a2[0], a2[1], b1[0], b1[1]);
  const d4 = d(a1[0], a1[1], a2[0], a2[1], b2[0], b2[1]);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Plan overlap: a vertex inside the other ring, or any proper edge cross. */
export function footprintsOverlap(a: Footprint, b: Footprint): boolean {
  if (a.length < 3 || b.length < 3) return false;
  for (const [x, z] of a) if (pointInFootprint(x, z, b)) return true;
  for (const [x, z] of b) if (pointInFootprint(x, z, a)) return true;
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i], a2v = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a1, a2v, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/* ── Clipping (Sutherland–Hodgman against a convex clip ring) ───────── */

function insideEdge(p: [number, number], e1: [number, number], e2: [number, number]): boolean {
  // clip ring is normalised CCW: interior is LEFT of every edge (cross >= 0)
  return (e2[0] - e1[0]) * (p[1] - e1[1]) - (e2[1] - e1[1]) * (p[0] - e1[0]) >= 0;
}

function lineHit(p1: [number, number], p2: [number, number], e1: [number, number], e2: [number, number]): [number, number] {
  const dx1 = p2[0] - p1[0], dz1 = p2[1] - p1[1];
  const dx2 = e2[0] - e1[0], dz2 = e2[1] - e1[1];
  const den = dx1 * dz2 - dz1 * dx2;
  if (Math.abs(den) < 1e-12) return [p2[0], p2[1]];
  const t = ((e1[0] - p1[0]) * dz2 - (e1[1] - p1[1]) * dx2) / den;
  return [p1[0] + t * dx1, p1[1] + t * dz1];
}

/**
 * Clip `subject` against `clip` (Sutherland–Hodgman; `clip` must be convex —
 * opening footprints are rectangles). Returns [] when there is no overlap.
 */
export function clipFootprint(subject: Footprint, clip: Footprint): Footprint {
  if (subject.length < 3 || clip.length < 3) return [];
  // normalise clip CCW so `insideEdge` means "left of every clip edge"
  let c = clip.slice();
  if (footprintArea2(c) < 0) c = c.reverse();
  let out: Footprint = subject.slice();
  for (let i = 0; i < c.length && out.length; i++) {
    const e1 = c[i], e2 = c[(i + 1) % c.length];
    const next: Footprint = [];
    for (let j = 0; j < out.length; j++) {
      const cur = out[j], prev = out[(j + out.length - 1) % out.length];
      const curIn = insideEdge(cur, e1, e2);
      const prevIn = insideEdge(prev, e1, e2);
      if (curIn) {
        if (!prevIn) next.push(lineHit(prev, cur, e1, e2));
        next.push(cur);
      } else if (prevIn) {
        next.push(lineHit(prev, cur, e1, e2));
      }
    }
    out = next;
  }
  // drop near-duplicate closing vertex
  if (out.length >= 2) {
    const [x0, z0] = out[0], [x1, z1] = out[out.length - 1];
    if (Math.hypot(x1 - x0, z1 - z0) < 1e-9) out.pop();
  }
  return out;
}

/* ── Hosts and openings ─────────────────────────────────────────────── */

/** Minimal structural view of a slab-like authored element. */
export interface SlabLike {
  id: string;
  type: string;
  params: {
    polygon?: Array<[number, number]>;
    elevation?: number;
    height?: number;
    thickness?: number;
  };
}

/** Minimal structural view of a vertical-opening authored element. */
export interface OpeningLike {
  id: string;
  type: string;
  params: {
    point?: [number, number];
    width?: number;
    depth?: number;
    rotation?: number;
    height?: number;
    elevation?: number;
  };
}

/** [bottom, top] of a slab in world Z; null when it has no usable polygon. */
export function slabZSpan(slab: SlabLike): [number, number] | null {
  const el = Number(slab.params.elevation ?? 0);
  const h = Number(slab.params.height ?? slab.params.thickness ?? 0.2);
  if (!Number.isFinite(el) || !Number.isFinite(h) || h <= 0) return null;
  return [el, el + h];
}

/** Plan footprint of the opening (centred rect from width/depth/rotation). */
export function openingFootprint(op: OpeningLike): Footprint {
  const [x, z] = op.params.point ?? [0, 0];
  return rectFootprint(x, z, Number(op.params.width ?? 1), Number(op.params.depth ?? 1), Number(op.params.rotation ?? 0));
}

/** [base, top] world Z span of the opening. */
export function openingZSpan(op: OpeningLike): [number, number] {
  const base = Number(op.params.elevation ?? 0);
  const h = Number(op.params.height ?? 3);
  return [base, base + Math.max(0.01, h)];
}

export function zSpansIntersect(a: [number, number], b: [number, number], eps = 1e-6): boolean {
  return a[0] < b[1] - eps && b[0] < a[1] + eps;
}

/* ── Hole cutting ───────────────────────────────────────────────────── */

export interface HoleInput {
  id: string;
  fp: Footprint;
}

export interface HoleResult {
  /** CW-wound rings (opposite the CCW outline), ready for Shape.holes / IFC voids. */
  holes: Footprint[];
  /** Honest report per discarded or adjusted opening. */
  warnings: string[];
}

const MIN_OPENING_AREA_M2 = 0.01;

/**
 * Cut holes in one slab outline for the given opening footprints.
 *   - opening fully inside            → hole = footprint
 *   - opening crossing the slab edge  → hole = clipped part (warning)
 *   - opening outside the outline     → no hole (warning)
 * Outline is normalised CCW; holes are returned CW.
 */
export function cutSlabHoles(outline: Footprint, openings: HoleInput[]): HoleResult {
  const warnings: string[] = [];
  if (!outline || outline.length < 3) return { holes: [], warnings };
  let outer = outline.slice();
  if (footprintArea2(outer) < 0) outer = outer.reverse();
  const holes: Footprint[] = [];
  for (const op of openings) {
    if (!op.fp || op.fp.length < 3) {
      warnings.push(`${op.id}: opening footprint is degenerate (< 3 points) — skipped`);
      continue;
    }
    const area = footprintArea(op.fp);
    if (area < MIN_OPENING_AREA_M2) {
      warnings.push(`${op.id}: opening area ${area.toFixed(3)} m² is below the 0.01 m² minimum — skipped`);
      continue;
    }
    let inside = true;
    for (const [x, z] of op.fp) if (!pointInFootprint(x, z, outer)) { inside = false; break; }
    if (inside) {
      let hole = op.fp.slice();
      if (footprintArea2(hole) > 0) hole = hole.reverse();
      holes.push(hole);
      continue;
    }
    const clipped = clipFootprint(op.fp, outer);
    const clippedArea = footprintArea(clipped);
    if (clipped.length < 3 || clippedArea < MIN_OPENING_AREA_M2) {
      warnings.push(`${op.id}: opening lies outside this slab outline — no cut here`);
      continue;
    }
    if (footprintArea2(clipped) > 0) clipped.reverse();
    holes.push(clipped);
    warnings.push(`${op.id}: opening crosses the slab edge — cut clipped to the slab interior (${clippedArea.toFixed(2)} m² of ${area.toFixed(2)} m²)`);
  }
  return { holes, warnings };
}

/** Net plan area of a slab after subtracting holes (never below 0). */
export function netSlabArea(outline: Footprint, holes: Footprint[]): number {
  const gross = footprintArea(outline ?? []);
  const cut = (holes ?? []).reduce((s, h) => s + footprintArea(h), 0);
  return Math.max(0, gross - cut);
}

/* ── Shaft semantics ────────────────────────────────────────────────── */

/** Slab ids a given opening cuts (Z-span intersect + plan overlap). */
export function cuttingSlabs(op: OpeningLike, slabs: SlabLike[]): string[] {
  const fp = openingFootprint(op);
  const zs = openingZSpan(op);
  const out: string[] = [];
  for (const slab of slabs) {
    if (!slab.params?.polygon || slab.params.polygon.length < 3) continue;
    const span = slabZSpan(slab);
    if (!span || !zSpansIntersect(zs, span)) continue;
    if (footprintsOverlap(fp, slab.params.polygon as Footprint)) out.push(slab.id);
  }
  return out;
}

/**
 * Suggested shaft Z span covering every level from `baseElev` upward:
 * [base − 0.3 m embed, highest level + 0.3 m] so newly added floors stay
 * inside the shaft until its Top Constraint is raised (standard host-span default).
 */
export function suggestShaftSpan(baseElev: number, levelElevations: number[]): [number, number] {
  const lv = levelElevations.filter((e) => Number.isFinite(e));
  const top = lv.length ? Math.max(...lv) : baseElev + 3;
  return [baseElev - 0.3, Math.max(top, baseElev) + 0.3];
}

/* ── Audit ──────────────────────────────────────────────────────────── */

export type VerticalOpeningIssueCode = "ORPHAN" | "DEGENERATE" | "SPAN_MISS";

export interface VerticalOpeningIssue {
  id: string;
  code: VerticalOpeningIssueCode;
  message: string;
}

export interface VerticalOpeningAudit {
  /** Openings that cut no slab at all. */
  orphaned: string[];
  issues: VerticalOpeningIssue[];
  /** openingId → slab ids it cuts. */
  cuts: Record<string, string[]>;
}

/**
 * Model-health audit for vertical openings:
 *   ORPHAN      — cuts nothing (host deleted, or moved off the slab)
 *   DEGENERATE  — footprint unusable (< 3 points / below minimum area)
 *   SPAN_MISS   — overlaps a slab in plan but the Z span never reaches it
 */
export function auditVerticalOpenings(openings: OpeningLike[], slabs: SlabLike[]): VerticalOpeningAudit {
  const orphaned: string[] = [];
  const issues: VerticalOpeningIssue[] = [];
  const cuts: Record<string, string[]> = {};
  for (const op of openings) {
    const fp = openingFootprint(op);
    if (op.params.point == null || fp.length < 3 || footprintArea(fp) < MIN_OPENING_AREA_M2) {
      issues.push({ id: op.id, code: "DEGENERATE", message: "Opening footprint is degenerate — set width/depth ≥ 0.1 m and place it on a slab" });
      continue;
    }
    const cut = cuttingSlabs(op, slabs);
    cuts[op.id] = cut;
    if (!cut.length) {
      orphaned.push(op.id);
      // more useful than ORPHAN: the opening sits over a slab in plan but its
      // Z span never reaches any of them — tell the user to fix the span
      const planOverlaps = slabs.some((slab) => {
        if (!slab.params?.polygon || slab.params.polygon.length < 3) return false;
        return footprintsOverlap(fp, slab.params.polygon as Footprint);
      });
      issues.push({
        id: op.id,
        code: planOverlaps ? "SPAN_MISS" : "ORPHAN",
        message: planOverlaps
          ? "Opening overlaps a slab in plan but its Z span reaches none of them — raise Cut Height or move Base Elevation"
          : "Opening cuts no slab/roof/ceiling — the host was deleted or the opening sits outside every slab",
      });
      continue;
    }
    // Partial cuts (a single-floor hole under a taller span) are healthy:
    // the per-host cut list in `cuts` carries that information honestly.
  }
  return { orphaned, issues, cuts };
}
