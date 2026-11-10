/**
 * Curtain Wall System - grid of mullions + panels (BIM-style).
 *
 * Defines a rectangular curtain wall on a vertical plane, subdivided by
 * horizontal and vertical grid lines. Generates mullion boxes + panel faces.
 *
 * DEPTH PACK (advanced authoring update):
 *  - mullion CROSS-SECTIONS: rect / L / T / I extruded profiles (not boxes);
 *  - per-panel TYPES: glazed / solid / door / void with type-aware materials
 *    and IFC mapping metadata;
 *  - CURVED curtain walls wrapping a plan arc (true arc-length panels);
 *  - CORNER mullions for L-plans (bisector-yawed post at the shared end).
 */

import * as THREE from "three";
import { ctx } from "../../core/context";
import {
  mullionProfileDims,
  resolvePanelTypes,
  panelIfcEntity,
  curvedPanelSpecs,
  curvedMullionSpecs,
  cornerMullionPlacement,
  arcSpan,
  type MullionProfile,
  type PanelType,
  type PlanArc,
} from "./depth";
import { parseCurtainGridProps } from "./grid-props";

export interface CurtainWallParams {
  /** Width along local X (m). */
  width: number;
  /** Height along local Y (m). */
  height: number;
  /** Origin (bottom-left of wall in world). */
  origin: { x: number; y: number; z: number };
  /** Facing angle in XZ (radians). */
  angle: number;
  /** Number of vertical divisions (columns of panels). */
  vDivisions: number;
  /** Number of horizontal divisions (rows of panels). */
  hDivisions: number;
  /** Mullion depth (projection from plane). */
  mullionDepth: number;
  /** Mullion thickness. */
  mullionThickness: number;
  /** Panel thickness. */
  panelThickness: number;
  /** Mullion cross-section profile (default rect = legacy box). */
  mullionProfile?: MullionProfile;
  /** Default panel type (default glazed). */
  panelType?: PanelType;
  /** Per-cell panel type overrides. */
  panelOverrides?: Array<{ col: number; row: number; type: PanelType }>;
  /** Optional custom V-grid positions 0-1 (overrides even divisions). */
  vGrid?: number[];
  /** Optional custom H-grid positions 0-1. */
  hGrid?: number[];
}

export interface CurtainWallResult {
  panelCount: number;
  mullionCount: number;
  object: THREE.Object3D;
  panels: Array<{
    u0: number; u1: number; v0: number; v1: number;
    center: THREE.Vector3;
  }>;
  /** Panel type grid actually used (row-major). */
  panelTypeGrid?: PanelType[][];
  /** Mullion profile in use. */
  mullionProfile?: MullionProfile;
}

const DEFAULTS: CurtainWallParams = {
  width: 6,
  height: 3.5,
  origin: { x: 0, y: 0, z: 0 },
  angle: 0,
  vDivisions: 4,
  hDivisions: 2,
  mullionDepth: 0.12,
  mullionThickness: 0.05,
  panelThickness: 0.02,
};

function gridLines(count: number, custom?: number[]): number[] {
  if (custom && custom.length >= 2) {
    return [...custom].sort((a, b) => a - b);
  }
  const lines: number[] = [];
  for (let i = 0; i <= count; i++) lines.push(i / count);
  return lines;
}

// ── Extruded mullion profiles ───────────────────────────────────────────

/**
 * Cross-section outlines in the mullion's face plane (x = face width,
 * y = depth). Returns a THREE.Shape per profile, centred on the face.
 */
function profileShape(profile: MullionProfile, size: number, depth: number): THREE.Shape {
  const s = Math.max(0.02, size);
  const d = Math.max(0.02, depth);
  const shape = new THREE.Shape();
  if (profile === "rect") {
    shape.moveTo(-s / 2, -d / 2);
    shape.lineTo(s / 2, -d / 2);
    shape.lineTo(s / 2, d / 2);
    shape.lineTo(-s / 2, d / 2);
    shape.closePath();
    return shape;
  }
  const f = mullionProfileDims(profile, s).flange;
  if (profile === "L") {
    // └ rotated: leg along face + leg into depth
    shape.moveTo(-s / 2, -d / 2);
    shape.lineTo(s / 2, -d / 2);
    shape.lineTo(s / 2, -d / 2 + f);
    shape.lineTo(-s / 2 + f, -d / 2 + f);
    shape.lineTo(-s / 2 + f, d / 2);
    shape.lineTo(-s / 2, d / 2);
    shape.closePath();
    return shape;
  }
  if (profile === "T") {
    // flange across the face + web into depth
    shape.moveTo(-s / 2, d / 2 - f);
    shape.lineTo(s / 2, d / 2 - f);
    shape.lineTo(s / 2, d / 2);
    shape.lineTo(-s / 2, d / 2);
    shape.closePath();
    const webW = Math.max(0.01, s * 0.3);
    shape.moveTo(-webW / 2, -d / 2);
    shape.lineTo(webW / 2, -d / 2);
    shape.lineTo(webW / 2, d / 2 - f);
    shape.lineTo(-webW / 2, d / 2 - f);
    shape.closePath();
    return shape;
  }
  // I / H: two face flanges + web
  const webW = Math.max(0.01, s * 0.28);
  shape.moveTo(-s / 2, d / 2 - f);
  shape.lineTo(s / 2, d / 2 - f);
  shape.lineTo(s / 2, d / 2);
  shape.lineTo(-s / 2, d / 2);
  shape.closePath();
  shape.moveTo(-s / 2, -d / 2);
  shape.lineTo(s / 2, -d / 2);
  shape.lineTo(s / 2, -d / 2 + f);
  shape.lineTo(-s / 2, -d / 2 + f);
  shape.closePath();
  shape.moveTo(-webW / 2, -d / 2 + f);
  shape.lineTo(webW / 2, -d / 2 + f);
  shape.lineTo(webW / 2, d / 2 - f);
  shape.lineTo(-webW / 2, d / 2 - f);
  shape.closePath();
  return shape;
}

/**
 * Mullion geometry: profile cross-section extruded along local +Y
 * (vertical), centred. For "rect" this is equivalent to a box of
 * thickness × depth × length.
 */
export function mullionGeometry(profile: MullionProfile, size: number, depth: number, length: number): THREE.BufferGeometry {
  const shape = profileShape(profile, size, depth);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2); // extrusion Z -> -Y? no: maps +Z to +Y for -90°
  geo.translate(0, -length / 2, 0);
  geo.computeVertexNormals();
  return geo;
}

const PANEL_MATERIALS: Record<PanelType, () => THREE.MeshLambertMaterial> = {
  glazed: () => new THREE.MeshLambertMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
  solid: () => new THREE.MeshLambertMaterial({ color: 0xd8d8d0, side: THREE.DoubleSide }),
  door: () => new THREE.MeshLambertMaterial({ color: 0x8a7a66, side: THREE.DoubleSide }),
  void: () => new THREE.MeshLambertMaterial({ visible: false }),
};

export function buildCurtainWall(input: Partial<CurtainWallParams> = {}): CurtainWallResult {
  const p: CurtainWallParams = {
    ...DEFAULTS,
    ...input,
    origin: { ...DEFAULTS.origin, ...input.origin },
  };
  const profile: MullionProfile = p.mullionProfile ?? "rect";
  const typeGrid = resolvePanelTypes(
    Math.max(0, gridLines(p.vDivisions, p.vGrid).length - 1),
    Math.max(0, gridLines(p.hDivisions, p.hGrid).length - 1),
    p.panelType ?? "glazed",
    p.panelOverrides ?? [],
  );

  const group = new THREE.Group();
  group.name = "obs-curtain-wall";

  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  // Local axes: U along width, V along height, N outward
  const uAxis = new THREE.Vector3(cos, 0, sin);
  const vAxis = new THREE.Vector3(0, 1, 0);
  const nAxis = new THREE.Vector3(-sin, 0, cos);

  const vLines = gridLines(p.vDivisions, p.vGrid);
  const hLines = gridLines(p.hDivisions, p.hGrid);

  const mullionMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
  const dims = mullionProfileDims(profile, p.mullionThickness);
  const mullionDepth = profile === "rect" ? p.mullionDepth : Math.max(p.mullionDepth, dims.depth);

  let mullionCount = 0;
  const origin = new THREE.Vector3(p.origin.x, p.origin.y, p.origin.z);

  // Vertical mullions (profile extrusion runs along V)
  for (const u of vLines) {
    const base = origin.clone().addScaledVector(uAxis, u * p.width);
    const geo = mullionGeometry(profile, p.mullionThickness, mullionDepth, p.height);
    const mesh = new THREE.Mesh(geo, mullionMat);
    mesh.position.copy(base).addScaledVector(vAxis, p.height / 2).addScaledVector(nAxis, mullionDepth / 2);
    mesh.rotation.y = -p.angle;
    mesh.userData.curtainMullion = { kind: "vertical", u, profile };
    group.add(mesh);
    mullionCount++;
  }

  // Horizontal mullions (transoms; extrusion runs along U)
  for (const v of hLines) {
    const base = origin.clone().addScaledVector(vAxis, v * p.height);
    const geo = mullionGeometry(profile, p.mullionThickness, mullionDepth, p.width);
    const mesh = new THREE.Mesh(geo, mullionMat);
    mesh.position.copy(base).addScaledVector(uAxis, p.width / 2).addScaledVector(nAxis, mullionDepth / 2);
    mesh.rotation.y = -p.angle;
    mesh.rotation.z = Math.PI / 2; // stand the extrusion along U
    mesh.userData.curtainMullion = { kind: "horizontal", v, profile };
    group.add(mesh);
    mullionCount++;
  }

  // Panels (type-aware)
  const panels: CurtainWallResult["panels"] = [];
  for (let i = 0; i < vLines.length - 1; i++) {
    for (let j = 0; j < hLines.length - 1; j++) {
      const u0 = vLines[i];
      const u1 = vLines[i + 1];
      const v0 = hLines[j];
      const v1 = hLines[j + 1];
      const pw = (u1 - u0) * p.width - p.mullionThickness;
      const ph = (v1 - v0) * p.height - p.mullionThickness;
      if (pw <= 0.01 || ph <= 0.01) continue;

      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      const center = origin
        .clone()
        .addScaledVector(uAxis, cu * p.width)
        .addScaledVector(vAxis, cv * p.height)
        .addScaledVector(nAxis, p.panelThickness / 2);

      const pType = typeGrid[j]?.[i] ?? "glazed";
      if (pType !== "void") {
        const geo = new THREE.BoxGeometry(pw, ph, p.panelThickness);
        const mesh = new THREE.Mesh(geo, PANEL_MATERIALS[pType]());
        mesh.position.copy(center);
        mesh.rotation.y = -p.angle;
        mesh.userData.curtainPanel = { row: j, col: i, type: pType, ifc: panelIfcEntity(pType) };
        group.add(mesh);
      }

      panels.push({ u0, u1, v0, v1, center });
    }
  }

  return {
    panelCount: panels.length,
    mullionCount,
    object: group,
    panels,
    panelTypeGrid: typeGrid,
    mullionProfile: profile,
  };
}

/** Insert a grid line at normalized position (0-1). */
export function insertGridLine(
  lines: number[],
  position: number,
): number[] {
  const t = Math.max(0.01, Math.min(0.99, position));
  if (lines.some((l) => Math.abs(l - t) < 0.01)) return lines;
  return [...lines, t].sort((a, b) => a - b);
}

// ── Curved curtain walls ────────────────────────────────────────────────

export interface CurvedCurtainWallParams {
  arc: PlanArc;
  height: number;
  vDivisions: number;
  hDivisions: number;
  mullionThickness: number;
  mullionDepth: number;
  panelThickness: number;
  mullionProfile?: MullionProfile;
  panelType?: PanelType;
  panelOverrides?: Array<{ col: number; row: number; type: PanelType }>;
  vGrid?: number[];
  hGrid?: number[];
}

/**
 * Curtain wall wrapped on a plan arc: vertical mullions follow the arc
 * (position + yaw from the true tangent), panels are segmented chords per
 * cell with TRUE arc-length widths, transoms are per-column segments.
 */
export function buildCurvedCurtainWall(input: Partial<CurvedCurtainWallParams> = {}): CurtainWallResult {
  const arc: PlanArc = input.arc ?? { center: [0, 0], radius: 6, startAngle: 0, endAngle: Math.PI / 2 };
  const height = input.height ?? 3.5;
  const vLines = gridLines(input.vDivisions ?? 4, input.vGrid);
  const hLines = gridLines(input.hDivisions ?? 2, input.hGrid);
  const profile: MullionProfile = input.mullionProfile ?? "rect";
  const typeGrid = resolvePanelTypes(
    Math.max(0, vLines.length - 1),
    Math.max(0, hLines.length - 1),
    input.panelType ?? "glazed",
    input.panelOverrides ?? [],
  );

  const group = new THREE.Group();
  group.name = "obs-curtain-wall-curved";
  const mullionMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
  const dims = mullionProfileDims(profile, input.mullionThickness ?? 0.05);
  const mullionDepth = Math.max(input.mullionDepth ?? 0.12, profile === "rect" ? 0 : dims.depth);

  let mullionCount = 0;
  const t = input.mullionThickness ?? 0.05;

  // Vertical mullions along the arc
  for (const m of curvedMullionSpecs(arc, height, vLines)) {
    const geo = mullionGeometry(profile, t, mullionDepth, height);
    const mesh = new THREE.Mesh(geo, mullionMat);
    mesh.position.set(m.position[0], height / 2, m.position[1]);
    mesh.rotation.y = m.yaw;
    mesh.userData.curtainMullion = { kind: "vertical", u: m.u, profile, curved: true };
    group.add(mesh);
    mullionCount++;
  }

  // Transoms: per-column chord segments at each horizontal grid line
  const span = arcSpan(arc);
  for (const v of hLines) {
    for (let i = 0; i < vLines.length - 1; i++) {
      const u0 = vLines[i];
      const u1 = vLines[i + 1];
      const a0 = arc.startAngle + span * u0;
      const a1 = arc.startAngle + span * u1;
      const r = arc.radius;
      const p0 = new THREE.Vector3(arc.center[0] + r * Math.cos(a0), v * height, arc.center[1] + r * Math.sin(a0));
      const p1 = new THREE.Vector3(arc.center[0] + r * Math.cos(a1), v * height, arc.center[1] + r * Math.sin(a1));
      const segLen = p0.distanceTo(p1);
      if (segLen < 0.01) continue;
      const geo = new THREE.BoxGeometry(segLen, t, mullionDepth);
      const mesh = new THREE.Mesh(geo, mullionMat);
      mesh.position.copy(p0.clone().add(p1).multiplyScalar(0.5));
      mesh.rotation.y = -Math.atan2(p1.z - p0.z, p1.x - p0.x);
      mesh.userData.curtainMullion = { kind: "horizontal", v, profile, curved: true };
      group.add(mesh);
      mullionCount++;
    }
  }

  // Panels: chord boxes per cell, yawed to the cell-center tangent
  const cells = curvedPanelSpecs(arc, height, vLines, hLines);
  const panels: CurtainWallResult["panels"] = [];
  for (const cell of cells) {
    const pw = cell.width - t;
    const ph = (cell.z1 - cell.z0) - t;
    if (pw <= 0.01 || ph <= 0.01) continue;
    const center = new THREE.Vector3(cell.center[0], (cell.z0 + cell.z1) / 2, cell.center[1]);
    const pType = typeGrid[cell.row]?.[cell.col] ?? "glazed";
    if (pType !== "void") {
      const geo = new THREE.BoxGeometry(pw, ph, input.panelThickness ?? 0.02);
      const mesh = new THREE.Mesh(geo, PANEL_MATERIALS[pType]());
      mesh.position.copy(center);
      mesh.rotation.y = cell.yaw;
      mesh.userData.curtainPanel = { row: cell.row, col: cell.col, type: pType, ifc: panelIfcEntity(pType), curved: true };
      group.add(mesh);
    }
    panels.push({ u0: cell.u0, u1: cell.u1, v0: cell.z0 / height, v1: cell.z1 / height, center });
  }

  return {
    panelCount: panels.length,
    mullionCount,
    object: group,
    panels,
    panelTypeGrid: typeGrid,
    mullionProfile: profile,
  };
}

// ── Corner mullion (L-plans) ────────────────────────────────────────────

/**
 * Corner post where two straight curtain walls meet. The post is yawed to
 * the bisector of the two wall directions and sized from the profile.
 */
export function buildCurtainCorner(
  wallA: { end: { x: number; z: number }; other: { x: number; z: number } },
  wallB: { end: { x: number; z: number }; other: { x: number; z: number } },
  opts: { height?: number; mullionThickness?: number; mullionDepth?: number; profile?: MullionProfile } = {},
): { mullion: ReturnType<typeof cornerMullionPlacement>; object: THREE.Mesh } {
  const a = { end: [wallA.end.x, wallA.end.z] as [number, number], other: [wallA.other.x, wallA.other.z] as [number, number] };
  const b = { end: [wallB.end.x, wallB.end.z] as [number, number], other: [wallB.other.x, wallB.other.z] as [number, number] };
  const placement = cornerMullionPlacement(a, b);
  const height = opts.height ?? 3.5;
  const t = opts.mullionThickness ?? 0.05;
  const profile = opts.profile ?? "rect";
  const depth = Math.max(opts.mullionDepth ?? 0.12, mullionProfileDims(profile, t).depth);
  const geo = mullionGeometry(profile, t, depth, height);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x475569 }));
  mesh.position.set(placement.position[0], height / 2, placement.position[1]);
  mesh.rotation.y = placement.yaw;
  mesh.userData.curtainMullion = { kind: "corner", profile, interiorAngleDeg: +(placement.interiorAngle * 180 / Math.PI).toFixed(2) };
  return { mullion: placement, object: mesh };
}

/**
 * Parse + attach explicit grid lines / panel overrides from element properties.
 * Thin, exported wrapper so features/tests can validate curtain properties
 * without touching THREE.
 */
export function curtainEngineParamsFromProps(props: Record<string, unknown>): {
  vGrid?: number[];
  hGrid?: number[];
  panelOverrides?: Array<{ col: number; row: number; type: PanelType }>;
  warnings: string[];
} {
  const warnings: string[] = [];
  const gp = parseCurtainGridProps(props, warnings);
  return { vGrid: gp.vGrid, hGrid: gp.hGrid, panelOverrides: gp.panelOverrides, warnings };
}

/**
 * Build a curtain-wall system from an authored linear element (start/end/height).
 * Maps the wall path to a vertical plane of mullions + glazed panels.
 * Explicit grid lines / per-panel types persisted on the element are honored
 * (sanitized through grid-props.ts; invalid data warns and falls back).
 */
export function buildCurtainFromElement(el: {
  id?: string;
  params?: {
    start?: [number, number];
    end?: [number, number];
    height?: number;
    elevation?: number;
    thickness?: number;
  };
  properties?: Record<string, unknown>;
}): THREE.Object3D | null {
  const p = el.params;
  if (!p?.start || !p?.end) return null;
  const [ax, az] = p.start;
  const [bx, bz] = p.end;
  const width = Math.hypot(bx - ax, bz - az);
  if (width < 0.2) return null;
  const height = Number(p.height) || 3;
  const elevation = Number(p.elevation) || 0;
  const angle = Math.atan2(bz - az, bx - ax);
  const vDiv = Math.max(2, Math.min(12, Math.round(width / 1.2)));
  const hDiv = Math.max(1, Math.min(6, Math.round(height / 1.4)));
  const props = el.properties ?? {};
  // Explicit grid lines / per-panel types persisted on the element (Parametric
  // Toolkit → Curtain Grid Editor) — sanitized; invalid data falls back to
  // even divisions with a console warning instead of vanishing silently.
  const gridProps = curtainEngineParamsFromProps(props);
  if (gridProps.warnings.length) console.warn("[curtain-wall]", el.id ?? "(new)", gridProps.warnings.join("; "));
  const result = buildCurtainWall({
    width,
    height,
    origin: { x: ax, y: elevation, z: az },
    angle,
    vDivisions: Number(props.vDivisions) || vDiv,
    hDivisions: Number(props.hDivisions) || hDiv,
    mullionDepth: Number(p.thickness) || 0.12,
    mullionThickness: 0.06,
    panelThickness: 0.02,
    mullionProfile: (props.mullionProfile as MullionProfile) || "rect",
    panelType: (props.panelType as PanelType) || "glazed",
    vGrid: gridProps.vGrid,
    hGrid: gridProps.hGrid,
    panelOverrides: gridProps.panelOverrides,
  });
  result.object.userData.elementId = el.id;
  result.object.userData.curtainSystem = {
    panels: result.panelCount,
    mullions: result.mullionCount,
    width,
    height,
    vGrid: gridProps.vGrid ?? null,
    hGrid: gridProps.hGrid ?? null,
  };
  result.object.name = el.id ? `curtain-wall:${el.id}` : "curtain-wall";
  return result.object;
}

export function setupCurtainWall(): void {
  const api = {
    buildCurtainWall,
    buildCurvedCurtainWall,
    buildCurtainCorner,
    buildFromElement: buildCurtainFromElement,
    insertGridLine,
    mullionGeometry,
  };
  (ctx.features as any).curtainWall = api;
  console.log("[curtain-wall] system ready (profiles, panel types, curved, corners, authored path)");
}
