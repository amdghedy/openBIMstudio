/**
 * Editing Modify commands: Offset, Trim/Extend, Split
 * (MASTER PROMPT MODULE 2C.6, 2C.7, 2C.10).
 *
 * Offset (spec): P'(s) = P(s) + d·n(s) with corner intersection handling
 * and self-intersection detection (reuses the solid-kernel ring test).
 *
 * Trim/Extend (spec): line-segment model — intersect with the boundary
 * line, pick the near side by the user's pick point, trim or extend to
 * the intersection parameter. MEP fitting reconciliation is the caller's
 * concern through the relationships registry.
 *
 * Split (spec 2C.10): the original element KEEPS its identity; the second
 * part receives a NEW id (identifier policy) and inherits parameters;
 * endpoint relationships of the original end move to the split point.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import {
  ModifyCommandBase,
  type CommandInput, type ElementPatch, type ModifyContext, type PendingChange, type ModifyElement,
} from "./command";
import { selfIntersects } from "../solid-kernel/forms";

// ── Offset (2C.6) ────────────────────────────────────────────────────────

/** Offset a closed or open polyline in plan by a signed distance. */
export function offsetPolyline(
  pts: Array<[number, number]>,
  distance: number,
  closed: boolean,
): { polyline: Array<[number, number]>; selfIntersects: boolean; corners: Array<[number, number]> } {
  const n = pts.length;
  if (n < 2) throw new Error("offsetPolyline: needs at least 2 points");
  // Per-segment normals (left normal = rotate dir +90°).
  const segNormal = (a: [number, number], b: [number, number]): [number, number] => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dy / l, -dx / l];
  };
  const segs: Array<[number, number]> = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const [nx, ny] = segNormal(a, b);
    segs.push([nx * distance, ny * distance]);
  }
  // Offset each segment, then intersect adjacent offset segments (corners).
  // Corner lines run along the EDGE direction through the offset endpoints.
  const edgeDirAt = (i: number): [number, number] => {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const line = (p: [number, number], d: [number, number]) => ({ p, d });
  const intersectLines = (
    l1: { p: [number, number]; d: [number, number] },
    l2: { p: [number, number]; d: [number, number] },
  ): [number, number] | null => {
    // t = ((p2−p1)×d2) / (d1×d2), cross products in 2D.
    const d = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
    if (Math.abs(d) < 1e-12) return null;
    const rx = l2.p[0] - l1.p[0];
    const ry = l2.p[1] - l1.p[1];
    const t = (rx * l2.d[1] - ry * l2.d[0]) / d;
    return [l1.p[0] + l1.d[0] * t, l1.p[1] + l1.d[1] * t];
  };
  const out: Array<[number, number]> = [];
  const corners: Array<[number, number]> = [];
  if (!closed) {
    out.push([pts[0][0] + segs[0][0], pts[0][1] + segs[0][1]]);
    for (let i = 0; i < count - 1; i++) {
      const l1 = line([pts[i][0] + segs[i][0], pts[i][1] + segs[i][1]], edgeDirAt(i));
      const l2 = line([pts[i + 1][0] + segs[i + 1][0], pts[i + 1][1] + segs[i + 1][1]], edgeDirAt(i + 1));
      const x = intersectLines(l1, l2) ?? [pts[i + 1][0] + segs[i][0], pts[i + 1][1] + segs[i][1]];
      out.push(x);
      corners.push(x);
    }
    const last = pts[n - 1];
    out.push([last[0] + segs[count - 1][0], last[1] + segs[count - 1][1]]);
  } else {
    for (let i = 0; i < n; i++) {
      const prevIdx = (i - 1 + n) % n;
      const l1 = line([pts[prevIdx][0] + segs[prevIdx][0], pts[prevIdx][1] + segs[prevIdx][1]], edgeDirAt(prevIdx));
      const l2 = line([pts[i][0] + segs[i][0], pts[i][1] + segs[i][1]], edgeDirAt(i));
      const x = intersectLines(l1, l2) ?? [pts[i][0] + segs[i][0], pts[i][1] + segs[i][1]];
      out.push(x);
      corners.push(x);
    }
  }
  // Closed-ring degeneracy (spec 2C.6 "self-intersections"):
  //   1. Orientation flip — the offset ring winds the opposite way.
  //   2. Erosion collapse — for a CONVEX ring, an inward offset deeper
  //      than the inradius (A/s, exact for tangential polygons such as
  //      rectangles) leaves an EMPTY offset region; the pairwise-corner
  //      construction would otherwise emit a spurious smaller ring.
  let degenerate = false;
  if (closed) {
    const area = (ring: Array<[number, number]>): number => {
      let a = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        a += p[0] * q[1] - q[0] * p[1];
      }
      return a / 2;
    };
    const a0 = area(pts);
    const a1 = area(out);
    if (a0 * a1 < 0) degenerate = true;
    else {
      // Convexity: consecutive edge cross products share one sign.
      let convex = true;
      let sign = 0;
      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const c = pts[(i + 2) % n];
        const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cr) < 1e-12) continue;
        const s = Math.sign(cr);
        if (sign === 0) sign = s;
        else if (s !== sign) { convex = false; break; }
      }
      if (convex && a0 !== 0) {
        let perimeter = 0;
        for (let i = 0; i < n; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % n];
          perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        const inradius = Math.abs(a0) / (perimeter / 2);
        // Inward offset opposes the ring orientation (right-normal
        // convention: positive distance moves outward for CCW rings).
        const inward = (a0 > 0 && distance < 0) || (a0 < 0 && distance > 0);
        if (inward && Math.abs(distance) > inradius) degenerate = true;
      }
    }
  }
  return { polyline: out, selfIntersects: selfIntersects(out.map(([x, y]) => ({ u: x, v: y }))) || degenerate, corners };
}

export class OffsetCommand extends ModifyCommandBase {
  readonly name = "offset";
  private resultPolyline: Array<[number, number]> | null = null;

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type !== "offset") throw new Error("OffsetCommand: input must be 'offset'");
    if (!this.ids.length) throw new Error("OffsetCommand: Begin first");
    const el = this.ctx.store.get(this.ids[0])!;
    if (!el.curve) {
      this.err("not-offsettable", `element '${el.id}' has no plan curve to offset`, [el.id]);
      return [];
    }
    const world = (p: [number, number]): [number, number] => [
      el.position[0] + p[0] * Math.cos(el.rotationZ) - p[1] * Math.sin(el.rotationZ),
      el.position[1] + p[0] * Math.sin(el.rotationZ) + p[1] * Math.cos(el.rotationZ),
    ];
    const poly: Array<[number, number]> = [world(el.curve.start), world(el.curve.end)];
    const r = offsetPolyline(poly, input.distance, false);
    if (r.selfIntersects) {
      this.err("offset-self-intersection", "offset distance produces a self-intersecting profile; reduce the distance", [el.id]);
      return [];
    }
    this.resultPolyline = r.polyline;
    const toLocal = (p: [number, number]): [number, number] => {
      const wx = p[0] - el.position[0], wy = p[1] - el.position[1];
      const c = Math.cos(-el.rotationZ), s = Math.sin(-el.rotationZ);
      return [wx * c - wy * s, wx * s + wy * c];
    };
    this.pending = [
      {
        elementId: el.id,
        patch: {
          curve: { start: toLocal(r.polyline[0]), end: toLocal(r.polyline[1]) },
          reason: "offset",
        },
      },
    ];
    return this.pending;
  }

  GetRequiredReferences(): string[] {
    return ["offset-distance", "offset-side"];
  }

  get previewPolyline(): Array<[number, number]> | null {
    return this.resultPolyline ? this.resultPolyline.map((p) => [...p] as [number, number]) : null;
  }
}

// ── Trim / Extend (2C.7) ─────────────────────────────────────────────────

export interface TrimExtendResult {
  /** New start/end in world coordinates. */
  start: [number, number];
  end: [number, number];
  /** true when the element was extended (not shortened). */
  extended: boolean;
  parameter: number;
}

/** Core math: trim or extend segment a→b to the boundary line. */
export function trimExtendSegment(
  a: [number, number],
  b: [number, number],
  boundary: { point: [number, number]; dir: [number, number] },
  pick: [number, number],
  mode: "trim" | "extend",
): TrimExtendResult | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const det = dx * boundary.dir[1] - dy * boundary.dir[0];
  if (Math.abs(det) < 1e-12) return null; // parallel: no intersection
  const rx = boundary.point[0] - a[0];
  const ry = boundary.point[1] - a[1];
  const t = (rx * boundary.dir[1] - ry * boundary.dir[0]) / det;
  const ix = a[0] + dx * t;
  const iy = a[1] + dy * t;
  // Side of the boundary the pick is on decides which end is modified.
  const cross = (p: [number, number]): number =>
    boundary.dir[0] * (p[1] - boundary.point[1]) - boundary.dir[1] * (p[0] - boundary.point[0]);
  const pickSide = cross(pick);
  const trimStart = pickSide * cross(a) < 0; // pick and start on opposite sides
  const wasInside = t >= 0 && t <= 1;
  if (mode === "trim") {
    if (!wasInside) return null;
    return trimStart
      ? { start: [ix, iy], end: [...b] as [number, number], extended: false, parameter: t }
      : { start: [...a] as [number, number], end: [ix, iy], extended: false, parameter: t };
  }
  // Extend: the intersection must be OUTSIDE the segment; the end the
  // extension reaches is determined by the parameter sign (the pick only
  // disambiguates when multiple boundaries exist — line model has one).
  if (wasInside) return null;
  return t > 1
    ? { start: [...a] as [number, number], end: [ix, iy], extended: true, parameter: t }
    : { start: [ix, iy], end: [...b] as [number, number], extended: true, parameter: t };
}

export class TrimExtendCommand extends ModifyCommandBase {
  readonly name: string;
  private boundary: { point: [number, number]; dir: [number, number] } | null = null;
  private mode: "trim" | "extend";
  private lastInput: { boundary: { point: [number, number]; dir: [number, number] }; pick: [number, number] } | null = null;

  constructor(ctx: ModifyContext, mode: "trim" | "extend") {
    super(ctx);
    this.mode = mode;
    this.name = mode;
  }

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type !== "trim") throw new Error("TrimExtendCommand: input must be 'trim'");
    this.boundary = input.boundary;
    this.lastInput = { boundary: input.boundary, pick: input.pick };
    const el = this.ctx.store.get(this.ids[0])!;
    if (!el.curve) {
      this.err("not-trimmable", `element '${el.id}' has no plan curve`, [el.id]);
      return [];
    }
    const world = (p: [number, number]): [number, number] => [
      el.position[0] + p[0] * Math.cos(el.rotationZ) - p[1] * Math.sin(el.rotationZ),
      el.position[1] + p[0] * Math.sin(el.rotationZ) + p[1] * Math.cos(el.rotationZ),
    ];
    const a = world(el.curve.start);
    const b = world(el.curve.end);
    const r = trimExtendSegment(a, b, input.boundary, input.pick, this.mode);
    if (!r) {
      this.err(
        this.mode === "trim" ? "no-intersection-in-range" : "no-intersection-outside",
        this.mode === "trim"
          ? "boundary does not intersect the element between its endpoints"
          : "boundary intersection is not beyond the element endpoints",
        [el.id],
      );
      return [];
    }
    const toLocal = (p: [number, number]): [number, number] => {
      const wx = p[0] - el.position[0], wy = p[1] - el.position[1];
      const c = Math.cos(-el.rotationZ), s = Math.sin(-el.rotationZ);
      return [wx * c - wy * s, wx * s + wy * c];
    };
    this.pending = [
      {
        elementId: el.id,
        patch: { curve: { start: toLocal(r.start), end: toLocal(r.end) }, reason: this.mode },
      },
    ];
    if (r.extended) this.info("extended", `element extended to the boundary (t = ${r.parameter.toFixed(3)})`, [el.id]);
    return this.pending;
  }

  GetRequiredReferences(): string[] {
    return ["boundary-reference", "pick-side"];
  }
}

// ── Split (2C.10) ────────────────────────────────────────────────────────

export class SplitCommand extends ModifyCommandBase {
  readonly name = "split";

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type !== "split") throw new Error("SplitCommand: input must be 'split'");
    const t = input.parameter;
    if (!(t > 0 && t < 1)) {
      this.err("split-parameter-out-of-range", `split parameter must be in (0, 1), got ${t}`);
      return [];
    }
    const el = this.ctx.store.get(this.ids[0])!;
    if (!el.curve) {
      this.err("not-splittable", `element '${el.id}' has no plan curve`, [el.id]);
      return [];
    }
    const { start, end } = el.curve;
    const mid: [number, number] = [
      start[0] + (end[0] - start[0]) * t,
      start[1] + (end[1] - start[1]) * t,
    ];
    // First part keeps the element id; second part gets a NEW id (2C.10).
    const newId = this.ctx.allocateId?.() ?? `${el.id}-b`;
    const first: PendingChange = {
      elementId: el.id,
      patch: { curve: { start: [...start] as [number, number], end: mid }, reason: "split-first" },
    };
    const second: ModifyElement = {
      ...el,
      id: newId,
      curve: { start: mid, end: [...end] as [number, number] },
      pinned: false,
    };
    this.pending = [first, { elementId: el.id, patch: {}, newElement: second }];
    this.info("split-created", `new element '${newId}' created from split at t = ${t.toFixed(3)}`, [el.id, newId]);
    return this.pending;
  }

  GetAffectedElements(): string[] {
    return [...super.GetAffectedElements(), ...this.pending.filter((p) => p.newElement).map((p) => p.newElement!.id)];
  }

  GetRequiredReferences(): string[] {
    return ["split-point"];
  }
}
