/**
 * Curtain wall DEPTH pack — the pieces the evaluation flagged against
 * Revit: mullion profiles, per-panel types, curved (arc) curtain walls,
 * and corner mullions for L-plans.
 *
 * Pure math only (no THREE) so the grid/arc/profile logic is unit-testable
 * in Node; `curtain-wall.ts` consumes these helpers to build meshes.
 *
 * Conventions:
 *  - a straight curtain wall is the same parameterisation as before
 *    (u ∈ [0,1] along width, v ∈ [0,1] along height);
 *  - a curved curtain wall wraps a PLAN ARC (center, radius, angles, in
 *    the XZ plane, Y up) — u ∈ [0,1] maps to angle along the arc, so
 *    panel/mullion widths follow true arc length, matching Revit.
 */

export type MullionProfile = "rect" | "L" | "T" | "I";

export interface ProfileDims {
  /** Section width (along the wall face, m). */
  width: number;
  /** Section depth (perpendicular to the face, m). */
  depth: number;
  /** Flange/leg thickness (m). */
  flange: number;
  /** Number of visible legs (2 rect/L, 3 T, 4 I/H). */
  legs: number;
}

/** Cross-section dimensions for a nominal `size` (face width) per profile. */
export function mullionProfileDims(profile: MullionProfile, size: number): ProfileDims {
  const s = Math.max(0.02, size);
  switch (profile) {
    case "rect":
      return { width: s, depth: s, flange: s, legs: 2 };
    case "L":
      return { width: s, depth: s, flange: Math.max(0.006, s * 0.25), legs: 2 };
    case "T":
      return { width: s, depth: Math.max(0.04, s * 0.75), flange: Math.max(0.006, s * 0.25), legs: 3 };
    case "I":
      return { width: s, depth: Math.max(0.06, s * 1.2), flange: Math.max(0.006, s * 0.22), legs: 4 };
  }
}

/** Human label used by palettes / IFC property sets. */
export function mullionProfileLabel(profile: MullionProfile): string {
  switch (profile) {
    case "rect": return "Rectangular mullion";
    case "L": return "Angle (L) mullion";
    case "T": return "Tee (T) mullion";
    case "I": return "I-bar (H) mullion";
  }
}

export type PanelType = "glazed" | "solid" | "door" | "void";

export interface PanelSpec {
  /** Grid cell indices (col, row). */
  col: number;
  row: number;
  type: PanelType;
}

/**
 * Resolve the per-cell panel type from the wall-level default plus any
 * per-cell overrides. Overrides outside the grid are ignored.
 */
export function resolvePanelTypes(
  cols: number,
  rows: number,
  defaultType: PanelType = "glazed",
  overrides: PanelSpec[] = [],
): PanelType[][] {
  const grid: PanelType[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: PanelType[] = [];
    for (let c = 0; c < cols; c++) row.push(defaultType);
    grid.push(row);
  }
  for (const o of overrides) {
    if (o.col >= 0 && o.col < cols && o.row >= 0 && o.row < rows) {
      grid[o.row][o.col] = o.type;
    }
  }
  return grid;
}

/** True when the panel contributes geometry (void panels are openings). */
export function panelIsSolid(type: PanelType): boolean {
  return type !== "void";
}

// ── Arc (curved) curtain walls ──────────────────────────────────────────

export interface PlanArc {
  center: [number, number]; // [x, z]
  radius: number;
  /** Start angle (radians, XZ plane). */
  startAngle: number;
  /** End angle (radians). */
  endAngle: number;
}

/** Sweep span in radians (always positive, shortest-way handling like hosting/index.ts). */
export function arcSpan(arc: PlanArc): number {
  let span = arc.endAngle - arc.startAngle;
  if (span < 0) span += 2 * Math.PI;
  return span;
}

/** True arc length of the sweep (m) — panel widths follow this, not the chord. */
export function arcLength(arc: PlanArc): number {
  return arcSpan(arc) * arc.radius;
}

/** World plan position at normalized u ∈ [0,1] along the arc. */
export function arcPointAt(arc: PlanArc, u: number): [number, number] {
  const ang = arc.startAngle + arcSpan(arc) * u;
  return [arc.center[0] + arc.radius * Math.cos(ang), arc.center[1] + arc.radius * Math.sin(ang)];
}

/** World plan tangent (unit) at normalized u, in the direction of increasing u. */
export function arcTangentAt(arc: PlanArc, u: number): [number, number] {
  const ang = arc.startAngle + arcSpan(arc) * u;
  return [-Math.sin(ang), Math.cos(ang)];
}

/** Facing (yaw) angle for a mesh at normalized u: atan2 of the tangent. */
export function arcYawAt(arc: PlanArc, u: number): number {
  const [tx, tz] = arcTangentAt(arc, u);
  return Math.atan2(-tz, tx) * -1; // matches curtain-wall.ts rotation.y = -angle convention
}

export interface CurvedCell {
  /** Normalized angle range [u0, u1]. */
  u0: number;
  u1: number;
  /** Height range (m). */
  z0: number;
  z1: number;
  col: number;
  row: number;
  /** True arc width of the cell (m). */
  width: number;
  /** Center plan position. */
  center: [number, number];
  /** Yaw at the cell center. */
  yaw: number;
}

/**
 * Grid a curved curtain wall: vLines × hLines cells with true arc widths.
 * `vGrid`/`hGrid` are normalized positions (0..1) like the straight wall.
 */
export function curvedPanelSpecs(
  arc: PlanArc,
  height: number,
  vGrid: number[],
  hGrid: number[],
): CurvedCell[] {
  const v = [...vGrid].sort((a, b) => a - b);
  const h = [...hGrid].sort((a, b) => a - b);
  const cells: CurvedCell[] = [];
  for (let i = 0; i < v.length - 1; i++) {
    for (let j = 0; j < h.length - 1; j++) {
      const u0 = v[i];
      const u1 = v[i + 1];
      const z0 = h[j] * height;
      const z1 = h[j + 1] * height;
      const um = (u0 + u1) / 2;
      cells.push({
        u0,
        u1,
        z0,
        z1,
        col: i,
        row: j,
        width: (u1 - u0) * arcLength(arc),
        center: arcPointAt(arc, um),
        yaw: arcYawAt(arc, um),
      });
    }
  }
  return cells;
}

/** Vertical mullion transforms for a curved wall: position + yaw per grid line. */
export function curvedMullionSpecs(
  arc: PlanArc,
  height: number,
  vGrid: number[],
): Array<{ u: number; position: [number, number]; yaw: number }> {
  return [...vGrid].sort((a, b) => a - b).map((u) => ({
    u,
    position: arcPointAt(arc, u),
    yaw: arcYawAt(arc, u),
  }));
}

/** Horizontal mullion transforms for a curved wall (ring segments per row). */
export function curvedTransomSpecs(
  arc: PlanArc,
  height: number,
  hGrid: number[],
): Array<{ v: number; z: number; radiusOffset: number }> {
  return [...hGrid].sort((a, b) => a - b).map((v) => ({
    v,
    z: v * height,
    radiusOffset: 0,
  }));
}

// ── Corner mullions (L-plans) ───────────────────────────────────────────

export interface CornerMullion {
  /** Corner point (shared end of the two walls). */
  position: [number, number];
  /** Yaw: bisector of the two wall directions (deg, plan radians out). */
  yaw: number;
  /** Interior angle between the walls (radians). */
  interiorAngle: number;
}

/**
 * Corner post where two straight curtain walls meet at a shared endpoint.
 * The post is centered on the corner and yawed to the bisector of the two
 * directions measured AWAY from the corner (Revit places the corner
 * mullion on the bisector of the interior angle).
 */
export function cornerMullionPlacement(
  wallA: { end: [number, number]; other: [number, number] },
  wallB: { end: [number, number]; other: [number, number] },
): CornerMullion {
  const dirA = unitAway(wallA.other, wallA.end);
  const dirB = unitAway(wallB.other, wallB.end);
  const interior = Math.acos(Math.max(-1, Math.min(1, dirA[0] * dirB[0] + dirA[1] * dirB[1])));
  const bis = unitAdd(dirA, dirB);
  const yaw = Math.atan2(-bis[1], bis[0]) * -1;
  return {
    position: [wallA.end[0], wallA.end[1]],
    yaw,
    interiorAngle: interior,
  };
}

function unitAway(from: [number, number], at: [number, number]): [number, number] {
  const dx = at[0] - from[0];
  const dz = at[1] - from[1];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

function unitAdd(a: [number, number], b: [number, number]): [number, number] {
  const x = a[0] + b[0];
  const z = a[1] + b[1];
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
}

// ── IFC mapping ─────────────────────────────────────────────────────────

/** IFC entity per panel type (exporters map these directly). */
export function panelIfcEntity(type: PanelType): string {
  switch (type) {
    case "glazed": return "IfcPlate";
    case "solid": return "IfcCovering";
    case "door": return "IfcDoor";
    case "void": return "IfcOpeningElement";
  }
}

/** The curtain wall itself exports as IfcCurtainWall (not IfcWall). */
export const CURTAIN_WALL_IFC_ENTITY = "IfcCurtainWall";
