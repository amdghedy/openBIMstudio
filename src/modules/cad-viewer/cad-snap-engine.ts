/**
 * CAD Object Snap (OSNAP) engine — AutoCAD-parity modes for the 2D CAD editor.
 *
 * Pure geometry / settings module. No DOM. Safe to unit-test in Node.
 *
 * Modes (AutoCAD names):
 *   Endpoint, Midpoint, Center, Node, Quadrant, Intersection, Extension,
 *   Insertion, Perpendicular, Tangent, Nearest, Apparent Intersection,
 *   Parallel, Geometric Center
 *
 * Also provides:
 *   - OSNAP settings (mode mask, aperture, polar angles, tracking)
 *   - Polar tracking (F10) candidate generation
 *   - Object snap tracking (OTRACK) deferred origin
 *   - Extension snap along infinite line rays past endpoints
 *   - Parallel / tangent construction helpers
 */

import type { DxfEntity } from "../drawings/dxf-types";

export type Pt = { x: number; y: number };

/** Full AutoCAD-style object-snap kinds for the CAD 2D engine. */
export type CadSnapKind =
  | "endpoint"
  | "midpoint"
  | "center"
  | "node"
  | "quadrant"
  | "intersection"
  | "extension"
  | "insertion"
  | "perpendicular"
  | "tangent"
  | "nearest"
  | "apparent"
  | "parallel"
  | "geometric-center";

export const ALL_CAD_SNAPS: CadSnapKind[] = [
  "endpoint",
  "midpoint",
  "center",
  "node",
  "quadrant",
  "intersection",
  "extension",
  "insertion",
  "perpendicular",
  "tangent",
  "nearest",
  "apparent",
  "parallel",
  "geometric-center",
];

/** Default enabled set (AutoCAD-like starter). */
export const DEFAULT_CAD_SNAP_MODES: CadSnapKind[] = [
  "endpoint",
  "midpoint",
  "center",
  "intersection",
  "perpendicular",
  "extension",
  "nearest",
];

/** Priority: lower number wins before distance tie-break (AutoCAD tiers). */
export const CAD_SNAP_TIER: Record<CadSnapKind, number> = {
  endpoint: 0,
  midpoint: 0,
  center: 0,
  node: 0,
  quadrant: 0,
  insertion: 0,
  "geometric-center": 0,
  intersection: 1,
  apparent: 1,
  extension: 1,
  perpendicular: 1,
  tangent: 1,
  parallel: 1,
  nearest: 2,
};

export const CAD_SNAP_LABEL: Record<CadSnapKind, string> = {
  endpoint: "Endpoint",
  midpoint: "Midpoint",
  center: "Center",
  node: "Node",
  quadrant: "Quadrant",
  intersection: "Intersection",
  extension: "Extension",
  insertion: "Insertion",
  perpendicular: "Perpendicular",
  tangent: "Tangent",
  nearest: "Nearest",
  apparent: "Apparent Int",
  parallel: "Parallel",
  "geometric-center": "Geometric Center",
};

export interface CadSnap {
  x: number;
  y: number;
  kind: CadSnapKind;
  /** Optional owning entity index in the current entity list. */
  entityIndex?: number;
  /** Direction for extension / parallel / polar (unit vector). */
  direction?: Pt;
}

export interface CadSnapSettings {
  /** Master OSNAP on/off (F3). */
  osnapOn: boolean;
  /** Enabled modes. */
  modes: Set<CadSnapKind>;
  /** Screen aperture in pixels (default 10). */
  aperturePx: number;
  /** Grid snap (F9) — separate from object snap. */
  gridSnapOn: boolean;
  gridSpacing: number;
  /** Polar tracking (F10). */
  polarOn: boolean;
  /** Polar increment in degrees (15, 30, 45, 90…). */
  polarAngleDeg: number;
  /** Additional polar angles (user list). */
  polarAdditionalDeg: number[];
  /** Object snap tracking (F11). */
  otrackOn: boolean;
  /** Ortho mode (F8) — constrains to X/Y of last point. */
  orthoOn: boolean;
}

export const DEFAULT_CAD_SNAP_SETTINGS: CadSnapSettings = {
  osnapOn: true,
  modes: new Set(DEFAULT_CAD_SNAP_MODES),
  aperturePx: 12,
  gridSnapOn: false,
  gridSpacing: 10,
  polarOn: false,
  polarAngleDeg: 90,
  polarAdditionalDeg: [30, 45, 60],
  otrackOn: false,
  orthoOn: false,
};

/* ── geometry helpers ──────────────────────────────────────────────────── */

const EPS = 1e-12;

export function dist2(a: Pt, b: Pt): number {
  const dx = a.x - b.x,
    dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function unit(dx: number, dy: number): Pt | null {
  const L = Math.hypot(dx, dy);
  if (L < EPS) return null;
  return { x: dx / L, y: dy / L };
}

export function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < EPS) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Foot of perpendicular from p onto infinite line ab (may lie outside segment). */
export function footOnLine(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < EPS) return { x: a.x, y: a.y };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

export function segIntersection(a: Pt, b: Pt, c: Pt, d: Pt, infinite = false): Pt | null {
  const r = { x: b.x - a.x, y: b.y - a.y },
    s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < EPS) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (!infinite) {
    if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  }
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

function arcPoint(cx: number, cy: number, r: number, deg: number): Pt {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function polySegs(e: DxfEntity & { type: "LWPOLYLINE" }): Array<[Pt, Pt]> {
  const pts = e.points;
  const out: Array<[Pt, Pt]> = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]]);
  if (e.closed && pts.length > 1) out.push([pts[pts.length - 1], pts[0]]);
  return out;
}

function entitySegments(e: DxfEntity): Array<[Pt, Pt]> {
  switch (e.type) {
    case "LINE":
      return [[e.start, e.end]];
    case "LWPOLYLINE":
      return polySegs(e as any);
    case "RAY":
    case "XLINE": {
      const dir = unit(e.direction?.x ?? 1, e.direction?.y ?? 0) ?? { x: 1, y: 0 };
      const far = 1e6;
      if (e.type === "XLINE") {
        return [
          [
            { x: e.start.x - dir.x * far, y: e.start.y - dir.y * far },
            { x: e.start.x + dir.x * far, y: e.start.y + dir.y * far },
          ],
        ];
      }
      return [[{ x: e.start.x, y: e.start.y }, { x: e.start.x + dir.x * far, y: e.start.y + dir.y * far }]];
    }
    default:
      return [];
  }
}

/** Key snap points contributed by a single entity (no intersection / extension). */
export function entityKeySnaps(e: DxfEntity, index: number, modes: Set<CadSnapKind>): CadSnap[] {
  const out: CadSnap[] = [];
  const add = (x: number, y: number, kind: CadSnapKind, direction?: Pt) => {
    if (!modes.has(kind)) return;
    out.push({ x, y, kind, entityIndex: index, direction });
  };

  switch (e.type) {
    case "LINE": {
      add(e.start.x, e.start.y, "endpoint");
      add(e.end.x, e.end.y, "endpoint");
      add((e.start.x + e.end.x) / 2, (e.start.y + e.end.y) / 2, "midpoint");
      const d = unit(e.end.x - e.start.x, e.end.y - e.start.y);
      if (d) {
        // Extension anchors (cursor will project onto the ray later)
        if (modes.has("extension")) {
          out.push({ x: e.start.x, y: e.start.y, kind: "extension", entityIndex: index, direction: { x: -d.x, y: -d.y } });
          out.push({ x: e.end.x, y: e.end.y, kind: "extension", entityIndex: index, direction: d });
        }
      }
      break;
    }
    case "CIRCLE": {
      add(e.center.x, e.center.y, "center");
      for (const q of [0, 90, 180, 270]) {
        const p = arcPoint(e.center.x, e.center.y, e.radius, q);
        add(p.x, p.y, "quadrant");
      }
      add(e.center.x, e.center.y, "geometric-center");
      break;
    }
    case "ARC": {
      add(e.center.x, e.center.y, "center");
      const sa = e.startAngle,
        ea = e.endAngle;
      const p0 = arcPoint(e.center.x, e.center.y, e.radius, sa);
      const p1 = arcPoint(e.center.x, e.center.y, e.radius, ea);
      add(p0.x, p0.y, "endpoint");
      add(p1.x, p1.y, "endpoint");
      let sweep = ea - sa;
      while (sweep < 0) sweep += 360;
      const mid = sa + sweep / 2;
      const pm = arcPoint(e.center.x, e.center.y, e.radius, mid);
      add(pm.x, pm.y, "midpoint");
      for (const q of [0, 90, 180, 270]) {
        // Only if quadrant lies on the arc
        let rel = q - sa;
        while (rel < 0) rel += 360;
        if (rel <= sweep + 1e-6) {
          const pq = arcPoint(e.center.x, e.center.y, e.radius, q);
          add(pq.x, pq.y, "quadrant");
        }
      }
      break;
    }
    case "LWPOLYLINE": {
      const pts = e.points;
      for (const p of pts) add(p.x, p.y, "endpoint");
      for (const [a, b] of polySegs(e as any)) {
        add((a.x + b.x) / 2, (a.y + b.y) / 2, "midpoint");
      }
      if (pts.length >= 3 && modes.has("geometric-center")) {
        let sx = 0,
          sy = 0;
        for (const p of pts) {
          sx += p.x;
          sy += p.y;
        }
        add(sx / pts.length, sy / pts.length, "geometric-center");
      }
      break;
    }
    case "POINT":
      add(e.position.x, e.position.y, "node");
      add(e.position.x, e.position.y, "endpoint");
      break;
    case "TEXT":
      add(e.position.x, e.position.y, "insertion");
      add(e.position.x, e.position.y, "endpoint");
      break;
    case "RAY":
    case "XLINE":
      add(e.start.x, e.start.y, "endpoint");
      break;
    default:
      break;
  }
  return out;
}

export interface SpatialIndexLike {
  boxes: Array<{ minX: number; minY: number; maxX: number; maxY: number }>;
}

export type QueryFn = (idx: SpatialIndexLike, x: number, y: number, radius: number) => number[];

/**
 * Rank and pick the best object snap under the cursor.
 * Optional `fromPt` enables perpendicular / tangent / parallel from the last pick.
 */
export function findCadSnap(opts: {
  entities: DxfEntity[];
  x: number;
  y: number;
  tol: number;
  modes: Iterable<CadSnapKind>;
  visible?: (e: DxfEntity) => boolean;
  fromPt?: Pt | null;
  /** Optional broad-phase: returns candidate entity indices near (x,y). */
  queryNear?: (x: number, y: number, radius: number) => number[];
}): CadSnap | null {
  const modes = new Set(opts.modes);
  const visible = opts.visible ?? (() => true);
  const { entities, x, y, tol, fromPt } = opts;
  const cursor: Pt = { x, y };

  let ids: number[];
  if (opts.queryNear) {
    ids = opts.queryNear(x, y, tol * 2).filter((i) => entities[i] && visible(entities[i]));
  } else {
    ids = [];
    for (let i = 0; i < entities.length; i++) if (visible(entities[i])) ids.push(i);
  }

  let best: CadSnap | null = null;
  let bestD = tol;
  let bestTier = 99;

  const consider = (s: CadSnap) => {
    const d = Math.hypot(s.x - x, s.y - y);
    if (d > tol + 1e-12) return;
    const tier = CAD_SNAP_TIER[s.kind] ?? 2;
    if (tier < bestTier || (tier === bestTier && d < bestD - 1e-12)) {
      best = s;
      bestD = d;
      bestTier = tier;
    }
  };

  // Key points
  for (const i of ids) {
    for (const s of entityKeySnaps(entities[i], i, modes)) {
      if (s.kind === "extension") continue; // handled below with projection
      consider(s);
    }
  }

  // Segment intersections among nearby entities
  if (modes.has("intersection") || modes.has("apparent")) {
    const segs: Array<{ a: Pt; b: Pt; i: number }> = [];
    for (const i of ids) {
      for (const [a, b] of entitySegments(entities[i])) segs.push({ a, b, i });
    }
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const hit = segIntersection(segs[i].a, segs[i].b, segs[j].a, segs[j].b, false);
        if (hit) consider({ x: hit.x, y: hit.y, kind: "intersection", entityIndex: segs[i].i });
        else if (modes.has("apparent")) {
          const app = segIntersection(segs[i].a, segs[i].b, segs[j].a, segs[j].b, true);
          if (app) consider({ x: app.x, y: app.y, kind: "apparent", entityIndex: segs[i].i });
        }
      }
    }
  }

  // Extension: project cursor onto infinite rays past endpoints
  if (modes.has("extension")) {
    for (const i of ids) {
      for (const s of entityKeySnaps(entities[i], i, new Set(["extension"]))) {
        if (!s.direction) continue;
        // project cursor onto ray origin + t * direction, t >= 0
        const ox = s.x,
          oy = s.y;
        const dx = s.direction.x,
          dy = s.direction.y;
        const t = (x - ox) * dx + (y - oy) * dy;
        if (t < 0) continue;
        const px = ox + t * dx,
          py = oy + t * dy;
        consider({ x: px, y: py, kind: "extension", entityIndex: i, direction: s.direction });
      }
    }
  }

  // Perpendicular from fromPt
  if (modes.has("perpendicular") && fromPt) {
    for (const i of ids) {
      for (const [a, b] of entitySegments(entities[i])) {
        const foot = footOnLine(fromPt, a, b);
        // prefer foot on segment or short extension
        const onSeg = nearestOnSegment(foot, a, b);
        const use = dist(foot, onSeg) < tol * 2 ? foot : onSeg;
        consider({ x: use.x, y: use.y, kind: "perpendicular", entityIndex: i });
      }
      const e = entities[i];
      if (e.type === "CIRCLE" || e.type === "ARC") {
        // line from center through fromPt intersects circle at tangent feet for perp? use radial
        const d = unit(fromPt.x - e.center.x, fromPt.y - e.center.y);
        if (d) {
          const p = { x: e.center.x + d.x * e.radius, y: e.center.y + d.y * e.radius };
          consider({ x: p.x, y: p.y, kind: "perpendicular", entityIndex: i });
        }
      }
    }
  }

  // Tangent from fromPt to circle/arc
  if (modes.has("tangent") && fromPt) {
    for (const i of ids) {
      const e = entities[i];
      if (e.type !== "CIRCLE" && e.type !== "ARC") continue;
      const cx = e.center.x,
        cy = e.center.y,
        r = e.radius;
      const dx = fromPt.x - cx,
        dy = fromPt.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r + EPS) continue;
      const d = Math.sqrt(d2);
      const a = Math.asin(r / d);
      const base = Math.atan2(dy, dx);
      for (const sign of [-1, 1]) {
        const ang = base + sign * (Math.PI / 2 - a);
        const tx = cx + r * Math.cos(ang),
          ty = cy + r * Math.sin(ang);
        consider({ x: tx, y: ty, kind: "tangent", entityIndex: i });
      }
    }
  }

  // Parallel: when fromPt exists, snap to a point that keeps the new segment parallel to a nearby segment
  if (modes.has("parallel") && fromPt) {
    for (const i of ids) {
      for (const [a, b] of entitySegments(entities[i])) {
        const d = unit(b.x - a.x, b.y - a.y);
        if (!d) continue;
        // Project cursor onto line through fromPt with direction d
        const t = (x - fromPt.x) * d.x + (y - fromPt.y) * d.y;
        const px = fromPt.x + t * d.x,
          py = fromPt.y + t * d.y;
        consider({ x: px, y: py, kind: "parallel", entityIndex: i, direction: d });
      }
    }
  }

  // Nearest
  if (!best && modes.has("nearest")) {
    let nd = tol;
    for (const i of ids) {
      for (const [a, b] of entitySegments(entities[i])) {
        const p = nearestOnSegment(cursor, a, b);
        const d = dist(p, cursor);
        if (d < nd) {
          nd = d;
          best = { x: p.x, y: p.y, kind: "nearest", entityIndex: i };
          bestD = d;
          bestTier = CAD_SNAP_TIER.nearest;
        }
      }
      const e = entities[i];
      if (e.type === "CIRCLE" || e.type === "ARC") {
        const d = unit(x - e.center.x, y - e.center.y);
        if (!d) continue;
        const p = { x: e.center.x + d.x * e.radius, y: e.center.y + d.y * e.radius };
        const dd = dist(p, cursor);
        if (dd < nd) {
          nd = dd;
          best = { x: p.x, y: p.y, kind: "nearest", entityIndex: i };
        }
      }
    }
  }

  return best;
}

/** Apply ortho constraint relative to fromPt. */
export function applyOrtho(from: Pt, to: Pt): Pt {
  const dx = Math.abs(to.x - from.x),
    dy = Math.abs(to.y - from.y);
  if (dx >= dy) return { x: to.x, y: from.y };
  return { x: from.x, y: to.y };
}

/** Apply polar tracking: snap angle from fromPt to nearest polar increment. */
export function applyPolar(from: Pt, to: Pt, settings: CadSnapSettings): Pt {
  if (!settings.polarOn) return to;
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return to;
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (ang < 0) ang += 360;
  const increments = [0, 90, 180, 270];
  const step = settings.polarAngleDeg > 0 ? settings.polarAngleDeg : 90;
  for (let a = 0; a < 360; a += step) increments.push(a);
  for (const a of settings.polarAdditionalDeg) increments.push(((a % 360) + 360) % 360);
  let bestA = 0,
    bestDiff = 1e9;
  for (const a of increments) {
    let diff = Math.abs(ang - a);
    if (diff > 180) diff = 360 - diff;
    if (diff < bestDiff) {
      bestDiff = diff;
      bestA = a;
    }
  }
  // Only lock if within a reasonable screen-angle threshold (~8°)
  if (bestDiff > 8) return to;
  const rad = (bestA * Math.PI) / 180;
  return { x: from.x + Math.cos(rad) * len, y: from.y + Math.sin(rad) * len };
}

/** Apply grid snap. */
export function applyGridSnap(p: Pt, spacing: number): Pt {
  if (!(spacing > 0)) return p;
  return {
    x: Math.round(p.x / spacing) * spacing,
    y: Math.round(p.y / spacing) * spacing,
  };
}

/**
 * Full point resolution pipeline for a drafting tool:
 *   object snap → ortho → polar → grid
 */
export function resolveDraftPoint(opts: {
  raw: Pt;
  settings: CadSnapSettings;
  entities: DxfEntity[];
  fromPt?: Pt | null;
  worldTol: number;
  visible?: (e: DxfEntity) => boolean;
  queryNear?: (x: number, y: number, radius: number) => number[];
}): { point: Pt; snap: CadSnap | null } {
  const { raw, settings, entities, fromPt, worldTol, visible, queryNear } = opts;
  let point = { ...raw };
  let snap: CadSnap | null = null;

  if (settings.osnapOn && settings.modes.size > 0) {
    snap = findCadSnap({
      entities,
      x: raw.x,
      y: raw.y,
      tol: worldTol,
      modes: settings.modes,
      visible,
      fromPt,
      queryNear,
    });
    if (snap) point = { x: snap.x, y: snap.y };
  }

  if (settings.orthoOn && fromPt && !snap) {
    point = applyOrtho(fromPt, point);
  }

  if (settings.polarOn && fromPt && !snap) {
    point = applyPolar(fromPt, point, settings);
  }

  if (settings.gridSnapOn) {
    point = applyGridSnap(point, settings.gridSpacing);
  }

  return { point, snap };
}

/** Toggle a single mode in settings (returns new settings object). */
export function toggleSnapMode(settings: CadSnapSettings, kind: CadSnapKind): CadSnapSettings {
  const modes = new Set(settings.modes);
  if (modes.has(kind)) modes.delete(kind);
  else modes.add(kind);
  return { ...settings, modes };
}

/** Set absolute mode mask. */
export function setSnapModes(settings: CadSnapSettings, kinds: CadSnapKind[]): CadSnapSettings {
  return { ...settings, modes: new Set(kinds) };
}

/** Serialize settings for localStorage / project file. */
export function serializeSnapSettings(s: CadSnapSettings): string {
  return JSON.stringify({
    osnapOn: s.osnapOn,
    modes: [...s.modes],
    aperturePx: s.aperturePx,
    gridSnapOn: s.gridSnapOn,
    gridSpacing: s.gridSpacing,
    polarOn: s.polarOn,
    polarAngleDeg: s.polarAngleDeg,
    polarAdditionalDeg: s.polarAdditionalDeg,
    otrackOn: s.otrackOn,
    orthoOn: s.orthoOn,
  });
}

export function parseSnapSettings(json: string | null | undefined): CadSnapSettings {
  if (!json) return { ...DEFAULT_CAD_SNAP_SETTINGS, modes: new Set(DEFAULT_CAD_SNAP_MODES) };
  try {
    const o = JSON.parse(json);
    const modes = new Set<CadSnapKind>(
      (Array.isArray(o.modes) ? o.modes : DEFAULT_CAD_SNAP_MODES).filter((k: string) =>
        ALL_CAD_SNAPS.includes(k as CadSnapKind),
      ),
    );
    return {
      osnapOn: o.osnapOn !== false,
      modes,
      aperturePx: Number(o.aperturePx) > 0 ? Number(o.aperturePx) : 12,
      gridSnapOn: !!o.gridSnapOn,
      gridSpacing: Number(o.gridSpacing) > 0 ? Number(o.gridSpacing) : 10,
      polarOn: !!o.polarOn,
      polarAngleDeg: Number(o.polarAngleDeg) > 0 ? Number(o.polarAngleDeg) : 90,
      polarAdditionalDeg: Array.isArray(o.polarAdditionalDeg) ? o.polarAdditionalDeg.map(Number) : [30, 45, 60],
      otrackOn: !!o.otrackOn,
      orthoOn: !!o.orthoOn,
    };
  } catch {
    return { ...DEFAULT_CAD_SNAP_SETTINGS, modes: new Set(DEFAULT_CAD_SNAP_MODES) };
  }
}
