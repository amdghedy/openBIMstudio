// openbim-fix:v3:applied -- do not re-apply the earlier fix scripts
/**
 * Authoring v6 — hosted doors & windows + AccuDraw + property palette sync
 * + auto-fittings at chain bends.
 *
 * New in this revision:
 *   - chainStartDir tracks the direction of the last completed segment;
 *     when the next segment changes direction, a fitting is spawned at
 *     the bend for MEP types (duct, pipe, cable-tray, conduit).
 *   - buildFitting() constructs the elbow geometry — rectangular profiles
 *     use a lofted quad strip, circular profiles use TubeGeometry.
 *   - selectAllAuthored() is exported so select-all.ts can select both
 *     fragment and authored elements in one call.
 *   - Property palette state is published via onAuthoringChange.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { register, type AuthoringService } from "../core/services";
import { inputRouter, type Gesture, type Mods } from "../core/input-router";
import { notify } from "../core/notify";
import { setMeasureEnabled } from "./measure";
import { setSectionOn } from "./section";
import { markDirty } from "../modules/projects/projects";
import { history } from "./history";
import { snapping } from "./snapping";
import { gizmo } from "./gizmo";
import { accuDraw } from "./accudraw";
import type {
  AuthoredElement,
  DoorPanelType,
  ElementType,
  GridDatum,
  LevelDatum,
  Vec2,
  WindowPanelType,
} from "../modules/projects/types";
import { validateNativeModel } from "../modules/native-bim/model-validation";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════
type Tool =
  | "select" | "move" | "copy" | "rotate" | "mirror" | "array" | "offset"
  | "wall" | "slab" | "column" | "beam" | "brace" | "truss" | "footing" | "strip" | "mline"
  | "duct" | "pipe" | "cable-tray" | "conduit" | "equipment"
  | "door" | "window"
  | "grid" | "level";

interface GripSpec {
  elementId: string;
  kind: "start" | "end" | "vertex" | "point" | "hosted-offset";
  vertexIndex?: number;
  position: THREE.Vector3;
  mesh: THREE.Mesh;
}

interface WallOpening {
  offset: number;
  width: number;
  height: number;
  sill: number;
}

type PendingOp =
  | { kind: "none" }
  | { kind: "move-copy"; mode: "move" | "copy"; id: string | null; base: THREE.Vector3 | null }
  | { kind: "rotate"; ids: string[]; center: THREE.Vector3 | null; ref: THREE.Vector3 | null }
  | { kind: "mirror"; ids: string[]; axisA: THREE.Vector3 | null; axisB: THREE.Vector3 | null }
  | { kind: "array"; ids: string[]; mode: "linear" | "radial"; base: THREE.Vector3 | null }
  | { kind: "offset"; id: string | null; base: THREE.Vector3 | null; side: 1 | -1 | null };

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════
let activeTool: Tool | null = null;
let level = 0;
let activeLevelId: string | null = null;
let activeFamilyId: string | null = null;
let activeFamilyTypeId: string | null = null;

const selectedIds = new Set<string>();
const elements: AuthoredElement[] = [];
let grids: GridDatum[] = [];
let levels: LevelDatum[] = [];
let gridIdx = 0;
let levelIdx = 0;
const counters: Record<string, number> = {};

const group = new THREE.Group();
const datumGroup = new THREE.Group();
const previewGroup = new THREE.Group();
const gripGroup = new THREE.Group();

let chainStart: THREE.Vector3 | null = null;
let chainStartDir: number | null = null;   // ← direction of last completed segment
let poly: THREE.Vector3[] = [];
let pendingOp: PendingOp = { kind: "none" };

let preview: THREE.Object3D | null = null;
let polyLine: THREE.Line | null = null;
let polyStartMarker: THREE.Mesh | null = null;

let gripDrag: {
  grip: GripSpec;
  snapshot: AuthoredElement["params"];
  original: THREE.Vector3;
} | null = null;

let lastSnapValid = false;
let lastSnapResult: import("./snapping").SnapResult | null = null;

let hoveredWall: { wallId: string; offset: number; point: THREE.Vector3 } | null = null;

/* ═════════════════════════════════════════════════════════════════════════
   Palette state — defaults per element type + current palette target.
   ═════════════════════════════════════════════════════════════════════════ */
type PaletteTarget =
  | { mode: "defaults"; type: ElementType }
  | { mode: "edit"; elementId: string; type: ElementType }
  | null;

interface TypeDefaults {
  params: Record<string, any>;
  properties: Record<string, any>;
  name?: string;
  color?: string;
}

const typeDefaults = new Map<string, TypeDefaults>();
let paletteTarget: PaletteTarget = null;
const authoringListeners = new Set<() => void>();

function notifyAuthoringChange(): void {
  for (const cb of authoringListeners) {
    try { cb(); } catch { /* */ }
  }
}

export function onAuthoringChange(cb: () => void): () => void {
  authoringListeners.add(cb);
  return () => authoringListeners.delete(cb);
}

export function getTypeDefaults(type: string): TypeDefaults {
  let d = typeDefaults.get(type);
  if (!d) {
    const defaults = DEFAULTS[type] ?? { height: 1, thickness: 0.2 };
    d = {
      params: { ...defaults },
      properties: {},
      color: COLORS[type] ?? "#cccccc",
    };
    typeDefaults.set(type, d);
  }
  return d;
}

export function setTypeDefault(
  type: string,
  target: "params" | "properties" | "root",
  key: string,
  value: any,
): void {
  const d = getTypeDefaults(type);
  if (target === "params") d.params[key] = value;
  else if (target === "properties") d.properties[key] = value;
  else if (key === "name") d.name = value;
  else if (key === "color") d.color = value;
  typeDefaults.set(type, d);
  notifyAuthoringChange();
}

export function getPaletteTarget(): PaletteTarget {
  return paletteTarget;
}

export function setPaletteTarget(t: PaletteTarget): void {
  paletteTarget = t;
  notifyAuthoringChange();
}

export function markAuthoringDirty(): void {
  markDirty();
}

// ═══════════════════════════════════════════════════════════════════════════
// Defaults & colors
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULTS: Record<string, { height: number; thickness: number; width?: number }> = {
  wall: { height: 3.0, thickness: 0.2 },
  slab: { height: 0.2, thickness: 0.2 },
  column: { height: 3.0, thickness: 0.3 },
  beam: { height: 0.5, thickness: 0.25 },
  brace: { height: 1.5, thickness: 0.15 },
  truss: { height: 1.2, thickness: 0.1 },
  footing: { height: 0.4, thickness: 1.2 },
  strip: { height: 0.4, thickness: 0.6 },
  mline: { height: 0.02, thickness: 0.02 },
  duct: { height: 0.4, thickness: 0.6 },
  pipe: { height: 0.1, thickness: 0.1 },
  "cable-tray": { height: 0.1, thickness: 0.3 },
  conduit: { height: 0.05, thickness: 0.05 },
  equipment: { height: 1.2, thickness: 0.8 },
  door: { height: 2.1, thickness: 0.2, width: 0.9 },
  window: { height: 1.4, thickness: 0.2, width: 1.2 },
  fitting: { height: 0.4, thickness: 0.6 },
  // Discipline presets (map to base geometry via TOOL_ALIASES)
  pile: { height: 8.0, thickness: 0.4 },
  "air-terminal": { height: 0.15, thickness: 0.4 },
  "duct-accessory": { height: 0.35, thickness: 0.5 },
  "plumbing-fixture": { height: 0.85, thickness: 0.5 },
  sprinkler: { height: 0.12, thickness: 0.12 },
  "fire-pump": { height: 1.0, thickness: 0.9 },
  panel: { height: 1.8, thickness: 0.5 },
  switch: { height: 0.1, thickness: 0.1 },
  outlet: { height: 0.1, thickness: 0.1 },
  "junction-box": { height: 0.12, thickness: 0.12 },
  "lighting-fixture": { height: 0.15, thickness: 0.6 },
  "emergency-light": { height: 0.12, thickness: 0.25 },
  transformer: { height: 1.5, thickness: 1.2 },
  generator: { height: 1.8, thickness: 2.0 },
  opening: { height: 2.1, thickness: 0.9, width: 0.9 },
  shaft: { height: 3.0, thickness: 1.2 },
  stairs: { height: 3.0, thickness: 0.2, width: 1.2 },
  railing: { height: 1.1, thickness: 0.08, width: 1.0 },
  ramp: { height: 1.5, thickness: 0.2, width: 1.5 },
  "curtain-wall": { height: 3.0, thickness: 0.12 },
  "duct-insulation": { height: 0.05, thickness: 0.7 },
  "pipe-insulation": { height: 0.025, thickness: 0.15 },

  // ── Professional openBIM family catalog (point/host/linear presets) ──
  tank: { height: 2.2, thickness: 1.4 },
  fan: { height: 0.7, thickness: 0.65 },
  pump: { height: 0.8, thickness: 0.65 },
  "air-handler": { height: 1.8, thickness: 1.2 },
  chiller: { height: 1.7, thickness: 1.6 },
  boiler: { height: 1.8, thickness: 1.3 },
  "cooling-tower": { height: 2.2, thickness: 1.5 },
  "heat-exchanger": { height: 1.1, thickness: 0.8 },
  valve: { height: 0.25, thickness: 0.2 },
  damper: { height: 0.3, thickness: 0.5 },
  diffuser: { height: 0.12, thickness: 0.35 },
  grille: { height: 0.15, thickness: 0.45 },
  filter: { height: 0.25, thickness: 0.45 },
  silencer: { height: 0.4, thickness: 0.5 },
  "fan-coil": { height: 0.5, thickness: 0.8 },
  vav: { height: 0.45, thickness: 0.45 },
  "exhaust-fan": { height: 0.35, thickness: 0.35 },
  toilet: { height: 0.8, thickness: 0.55 },
  washbasin: { height: 0.5, thickness: 0.55 },
  sink: { height: 0.25, thickness: 0.55 },
  shower: { height: 2.1, thickness: 0.1 },
  "floor-drain": { height: 0.08, thickness: 0.12 },
  "water-heater": { height: 1.0, thickness: 0.5 },
  "sanitary-stack": { height: 3.0, thickness: 0.15 },
  "fire-hydrant": { height: 0.8, thickness: 0.3 },
  "fire-extinguisher": { height: 0.7, thickness: 0.18 },
  "hose-reel": { height: 0.7, thickness: 0.5 },
  "alarm-device": { height: 0.1, thickness: 0.12 },
  "smoke-detector": { height: 0.08, thickness: 0.12 },
  "heat-detector": { height: 0.08, thickness: 0.12 },
  camera: { height: 0.15, thickness: 0.12 },
  "access-point": { height: 0.06, thickness: 0.18 },
  "data-outlet": { height: 0.1, thickness: 0.1 },
  "telephone-outlet": { height: 0.1, thickness: 0.1 },
  speaker: { height: 0.08, thickness: 0.18 },
  luminaire: { height: 0.1, thickness: 0.6 },
  "exit-sign": { height: 0.12, thickness: 0.35 },
  battery: { height: 0.25, thickness: 0.18 },
  busbar: { height: 0.12, thickness: 0.18 },
  ups: { height: 1.2, thickness: 0.7 },
  switchgear: { height: 2.2, thickness: 1.0 },
  "distribution-board": { height: 1.8, thickness: 0.55 },
  "fire-alarm-panel": { height: 1.0, thickness: 0.25 },
  "access-control": { height: 0.1, thickness: 0.15 },
  "cctv-rack": { height: 2.0, thickness: 0.65 },
  rack: { height: 2.0, thickness: 0.6 },
  "telecom-rack": { height: 2.0, thickness: 0.6 },
  "communication-panel": { height: 1.5, thickness: 0.45 },
  "structural-connection": { height: 0.2, thickness: 0.25 },
  bearing: { height: 0.25, thickness: 0.35 },
  "rebar-host": { height: 0.15, thickness: 0.15 },
  "anchor-bolt": { height: 0.3, thickness: 0.06 },
  bollard: { height: 1.0, thickness: 0.15 },
  "landscape-component": { height: 0.8, thickness: 0.6 },
  furniture: { height: 0.75, thickness: 0.7 },
  "generic-model": { height: 1.0, thickness: 0.5 },
};

/** Ribbon tool name → internal draw tool. */
export const TOOL_ALIASES: Record<string, Tool> = {
  roof: "slab",
  ceiling: "slab",
  floor: "slab",
  mat: "slab",
  stairs: "equipment",
  railing: "equipment",
  ramp: "equipment",
  "curtain-wall": "wall",
  pad: "footing",
  pile: "footing",
  opening: "door",
  shaft: "column",
  "ref-plane": "level",
  "duct-fitting": "duct",
  "flex-duct": "duct",
  "air-terminal": "equipment",
  "duct-accessory": "equipment",
  "pipe-fitting": "pipe",
  "pipe-accessory": "pipe",
  "plumbing-fixture": "equipment",
  sprinkler: "equipment",
  "sprinkler-main": "pipe",
  "fire-pump": "equipment",
  "cable-tray-fitting": "cable-tray",
  "conduit-fitting": "conduit",
  wire: "conduit",
  panel: "equipment",
  switch: "equipment",
  outlet: "equipment",
  "junction-box": "equipment",
  "lighting-fixture": "equipment",
  "emergency-light": "equipment",
  "lighting-switch": "equipment",
  transformer: "equipment",
  generator: "equipment",

  // ── Extended family aliases ──────────────────────────────────────────
  tank: "equipment", fan: "equipment", pump: "equipment",
  "air-handler": "equipment", chiller: "equipment", boiler: "equipment",
  "cooling-tower": "equipment", "heat-exchanger": "equipment", valve: "equipment",
  damper: "equipment", diffuser: "equipment", grille: "equipment", filter: "equipment",
  silencer: "equipment", "fan-coil": "equipment", vav: "equipment", "exhaust-fan": "equipment",
  toilet: "equipment", washbasin: "equipment", sink: "equipment", shower: "equipment",
  "floor-drain": "equipment", "water-heater": "equipment", "sanitary-stack": "pipe",
  "fire-hydrant": "equipment", "fire-extinguisher": "equipment", "hose-reel": "equipment",
  "alarm-device": "equipment", "smoke-detector": "equipment", "heat-detector": "equipment",
  camera: "equipment", "access-point": "equipment", "data-outlet": "equipment",
  "telephone-outlet": "equipment", speaker: "equipment", luminaire: "equipment",
  "exit-sign": "equipment", battery: "equipment", busbar: "cable-tray", ups: "equipment",
  switchgear: "equipment", "distribution-board": "equipment", "fire-alarm-panel": "equipment",
  "access-control": "equipment", "cctv-rack": "equipment", rack: "equipment",
  "telecom-rack": "equipment", "communication-panel": "equipment",
  "structural-connection": "equipment", bearing: "equipment", "rebar-host": "equipment",
  "anchor-bolt": "equipment", bollard: "equipment", "landscape-component": "equipment",
  furniture: "equipment", "generic-model": "equipment",
  "duct-insulation": "equipment", "pipe-insulation": "equipment",
};

/** Active ribbon preset (for naming / sizing equipment variants). */
let activePreset: string | null = null;
export function getActivePreset() { return activePreset; }

/**
 * Last command for Space-bar repeat (Revit behaviour).
 * Stores the tool/preset string the user last activated (not select/null).
 */
let lastCommand: string | null = null;
export function getLastCommand() { return lastCommand; }
export function setLastCommand(cmd: string | null) { lastCommand = cmd; }

const COLORS: Record<string, string> = {
  wall: "#cbd5e1", slab: "#94a3b8", column: "#64748b",
  beam: "#94a3b8", brace: "#a3b3c2", truss: "#8ea3b8",
  footing: "#78849a", strip: "#8792a3", mline: "#facc15",
  duct: "#38bdf8", pipe: "#22c55e", "cable-tray": "#f59e0b",
  conduit: "#a3e635", equipment: "#c084fc",
  door: "#92400e", window: "#0369a1",
  fitting: "#38bdf8",
};

const DOOR_COLOR_PANEL = "#fde68a";
const WINDOW_COLOR_GLASS = "#bae6fd";

const GRIP_SIZE = 0.15;
const GRIP_COLOR = 0xfacc15;

/* ═════════════════════════════════════════════════════════════════════════
   Draw tools set — controls palette visibility + fitting generation.
   ═════════════════════════════════════════════════════════════════════════ */
const DRAW_TOOLS = new Set<Tool>([
  "wall", "slab", "column", "beam", "brace", "truss",
  "footing", "strip", "mline",
  "duct", "pipe", "cable-tray", "conduit", "equipment",
  "door", "window",
]);

/** Element types whose chains get an auto-fitting at every bend. */
const FITTED_TYPES: Set<ElementType> = new Set([
  "duct", "pipe", "cable-tray", "conduit",
]);

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════
const uid = () =>
  (crypto as any).randomUUID?.() ??
  `el-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const snap = (v: number, step = 0.01) => Math.round(v / step) * step;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

function nextName(type: string) {
  counters[type] = (counters[type] ?? 0) + 1;
  return `${cap(type)} ${String(counters[type]).padStart(3, "0")}`;
}

// ═══════════════════════════════════════════════════════════════════════════

/* ── Wall placement options (Revit Modify | Place Wall) ───────────────── */
export type WallLocationLine =
  | "wall-centerline"
  | "core-centerline"
  | "finish-exterior"
  | "finish-interior"
  | "core-exterior"
  | "core-interior";

export type WallJoinStatus = "allow" | "disallow" | "chamfer" | "extended" | "butt";

let wallLocationLine: WallLocationLine = "wall-centerline";
let wallChain = true;
let wallOffset = 0; // m additional offset
let wallJoinStatus: WallJoinStatus = "allow";
let wallRadius = 0; // for future arc walls
/** Last linear segment from plan (for auto MEP fittings on chain). */
let lastPlanLinear: {
  type: string;
  end: [number, number];
  dir: number;
  thickness: number;
  height: number;
  elevation: number;
  id: string;
} | null = null;
export function clearLastPlanLinear() { lastPlanLinear = null; }


export function getWallLocationLine() { return wallLocationLine; }
export function setWallLocationLine(v: WallLocationLine) { wallLocationLine = v; }
export function getWallChain() { return wallChain; }
export function setWallChain(v: boolean) { wallChain = v; }
export function getWallOffset() { return wallOffset; }
export function setWallOffset(v: number) { wallOffset = v; }
export function getWallJoinStatus() { return wallJoinStatus; }
export function setWallJoinStatus(v: WallJoinStatus) { wallJoinStatus = v; }
export function getWallRadius() { return wallRadius; }
export function setWallRadius(v: number) { wallRadius = v; }

/** Shift start/end so the drawn line is the selected location line. */
export function applyWallLocationOffset(
  x1: number, z1: number, x2: number, z2: number, thickness: number,
): { start: [number, number]; end: [number, number] } {
  const dx = x2 - x1, dz = z2 - z1;
  const L = Math.hypot(dx, dz) || 1;
  const nx = -dz / L, nz = dx / L; // left normal
  const t = thickness;
  let shift = 0;
  switch (wallLocationLine) {
    case "wall-centerline":
    case "core-centerline":
      shift = 0; break;
    case "finish-exterior":
    case "core-exterior":
      shift = t / 2; break;
    case "finish-interior":
    case "core-interior":
      shift = -t / 2; break;
  }
  shift += wallOffset;
  return {
    start: [x1 + nx * shift, z1 + nz * shift],
    end: [x2 + nx * shift, z2 + nz * shift],
  };
}

/**
 * Revit Join Status at a corner.
 * IMPORTANT: location-line endpoints must NOT shift for Allow/Disallow —
 * that caused walls to jog. Only snap both ends to the shared corner.
 * Extended/Chamfer may extend slightly for special cases.
 */
/**
 * Pin two wall location-line ends to a shared corner (for chain drawing only).
 * Does not skew walls — only moves the listed endpoints to the corner point.
 */
export function applyWallJoinAtCorner(
  prev: { start: [number, number]; end: [number, number] },
  next: { start: [number, number]; end: [number, number] },
  _thickness: number,
  _status: WallJoinStatus = wallJoinStatus,
): void {
  // Shared corner = exact meeting point of the two location lines
  const cx = next.start[0];
  const cz = next.start[1];
  prev.end = [cx, cz];
  next.start = [cx, cz];
}

/**
 * Project point P onto segment AB. Returns { point, t, dist }.
 */
function projectOntoSegment(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number,
): { x: number; z: number; t: number; dist: number } {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz || 1;
  let t = ((px - ax) * dx + (pz - az) * dz) / L2;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, z = az + t * dz;
  return { x, z, t, dist: Math.hypot(px - x, pz - z) };
}

/**
 * Revit-style join for a NEWLY placed wall only.
 *
 * CRITICAL RULE (matches Revit): existing walls are NEVER moved or rotated.
 * Only the new wall's start/end may snap onto:
 *   - an existing wall endpoint (corner / L-join)
 *   - a point on an existing wall centerline (T-join)
 *
 * Centerline is used (location line). Thickness is visual only.
 */
export function autoJoinWallToNeighbors(wallId: string): void {
  const wall = elements.find((e) => e.id === wallId);
  if (!wall || wall.type !== "wall" || !wall.params.start || !wall.params.end) return;

  const thick = wall.params.thickness ?? 0.2;
  // Snap tolerance ≈ half thickness + small slack (Revit endpoint snap feel)
  const endTol = Math.max(0.12, thick * 0.85);
  const faceTol = Math.max(0.14, thick * 0.95);

  let changed = false;
  const trySnapEnd = (which: "start" | "end"): void => {
    const pt = which === "start" ? wall.params.start! : wall.params.end!;
    let best: { x: number; z: number; score: number } | null = null;

    for (const other of elements) {
      if (other.id === wallId || other.type !== "wall") continue;
      if (!other.params.start || !other.params.end) continue;
      // Skip if other is extremely short
      const [ax, az] = other.params.start;
      const [bx, bz] = other.params.end;
      if (Math.hypot(bx - ax, bz - az) < 0.02) continue;

      // Prefer endpoint snaps (clean L/corner)
      for (const ep of [other.params.start!, other.params.end!] as [number, number][]) {
        const d = Math.hypot(pt[0] - ep[0], pt[1] - ep[1]);
        if (d <= endTol && (!best || d < best.score)) {
          best = { x: ep[0], z: ep[1], score: d };
        }
      }
      // Else T-join onto centerline (only if closer to face than any end)
      const proj = projectOntoSegment(pt[0], pt[1], ax, az, bx, bz);
      if (proj.t > 0.02 && proj.t < 0.98 && proj.dist <= faceTol) {
        if (!best || proj.dist < best.score) {
          best = { x: proj.x, z: proj.z, score: proj.dist };
        }
      }
    }

    if (!best) return;
    // Only move THIS wall — never the neighbor
    if (which === "start") wall.params.start = [best.x, best.z];
    else wall.params.end = [best.x, best.z];
    changed = true;
  };

  trySnapEnd("start");
  trySnapEnd("end");

  // Guard: do not collapse the wall to a point
  const [sx, sz] = wall.params.start!;
  const [ex, ez] = wall.params.end!;
  if (Math.hypot(ex - sx, ez - sz) < 0.05) {
    // Revert is not tracked here; skip if degenerate — caller should avoid
    return;
  }

  if (changed) {
    rebuild();
    markDirty();
    notifyAuthoringChange();
  }
}

// Geometry helpers
// ═══════════════════════════════════════════════════════════════════════════
function memberMesh(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, mat: THREE.Material): THREE.Mesh {
  const len = a.distanceTo(b);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, h, w), mat);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  return mesh;
}

function buildTruss(el: AuthoredElement): THREE.Group {
  const g = new THREE.Group();
  const [ax, az] = el.params.start!;
  const [bx, bz] = el.params.end!;
  const t = Math.max(el.params.thickness, 0.03);
  const H = el.params.height;
  const panels = Math.max(2, Number(el.properties?.panels ?? 4));
  const A = new THREE.Vector3(ax, el.params.elevation, az);
  const B = new THREE.Vector3(bx, el.params.elevation, bz);
  const L = A.distanceTo(B);
  if (L < 0.5) return g;
  const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(el.color || COLORS.truss) });
  const up = new THREE.Vector3(0, 1, 0);
  const M = A.clone().add(B).multiplyScalar(0.5).add(up.clone().multiplyScalar(H));
  g.add(memberMesh(A, B, t, t, mat));
  g.add(memberMesh(A, M, t, t, mat));
  g.add(memberMesh(M, B, t, t, mat));
  const dir = B.clone().sub(A).normalize();
  const topAt = (x: number) => {
    const half = L / 2;
    const base = A.clone().add(dir.clone().multiplyScalar(x));
    const h = H * (1 - Math.abs(x - half) / half);
    return base.add(up.clone().multiplyScalar(h));
  };
  const bottomAt = (x: number) => A.clone().add(dir.clone().multiplyScalar(x));
  for (let i = 1; i < panels; i++) {
    const x = (L * i) / panels;
    const h = H * (1 - Math.abs(x - L / 2) / (L / 2));
    if (h > 0.05) {
      const p = bottomAt(x).add(up.clone().multiplyScalar(h / 2));
      const post = new THREE.Mesh(new THREE.BoxGeometry(t, h, t), mat);
      post.position.copy(p);
      g.add(post);
    }
    if (i < panels - 1) {
      const x2 = (L * (i + 1)) / panels;
      const diag = i % 2 === 0
        ? memberMesh(bottomAt(x), topAt(x2), t * 0.8, t * 0.8, mat)
        : memberMesh(topAt(x), bottomAt(x2), t * 0.8, t * 0.8, mat);
      g.add(diag);
    }
  }
  return g;
}

/* ═════════════════════════════════════════════════════════════════════════
   Fittings — auto-generated elbows at chain bends
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Insert a fitting at a chain bend.
 * Copies the parent's cross-section and stores the incoming / outgoing
 * direction angles so the geometry can be built as a proper swept elbow.
 */
export type FittingKind = "elbow" | "tee" | "cross" | "transition" | "cap" | "union" | "wye";

function spawnFitting(
  parentType: ElementType,
  parentEl: AuthoredElement | null,
  bendX: number,
  bendZ: number,
  angleIn: number,
  angleOut: number,
  kind: FittingKind = "elbow",
  size?: { thickness?: number; height?: number; elevation?: number; bendRadius?: number },
): AuthoredElement | null {
  if (!FITTED_TYPES.has(parentType) && parentType !== "fitting") return null;

  const p = parentEl?.params;
  const thick = size?.thickness ?? p?.thickness ?? 0.3;
  const height = size?.height ?? p?.height ?? thick;
  const elev = size?.elevation ?? p?.elevation ?? level;
  const fitting: AuthoredElement = {
    id: uid(),
    type: "fitting",
    name: `${cap(parentType)} ${kind} ${String((counters.fitting ?? 0) + 1).padStart(3, "0")}`,
    color: parentEl?.color || COLORS[parentType] || "#cccccc",
    params: {
      point: [bendX, bendZ],
      height,
      thickness: thick,
      depth: p?.depth,
      elevation: elev,
      angleIn,
      angleOut,
      bendRadius: size?.bendRadius, 
      parentType: parentType as any,
      fittingKind: kind as any,
    },
    properties: {
      ifcType: (() => {
        const root = parentType === "pipe" ? "IfcPipeFitting" :
          parentType === "cable-tray" ? "IfcCableCarrierFitting" :
          parentType === "conduit" ? "IfcCableCarrierFitting" :
          "IfcDuctFitting";
        const suffix = kind === "elbow" ? "Elbow" : kind === "tee" ? "Tee" : kind === "cross" ? "Cross" :
          kind === "transition" ? "Transition" : kind === "cap" ? "EndCap" : kind === "wye" ? "Junction" : "Union";
        return `${root}/${suffix}`;
      })(),
    },
  };
  counters.fitting = (counters.fitting ?? 0) + 1;

  history.exec({
    label: `Create ${cap(parentType)} fitting`,
    apply: () => {
      if (!elements.includes(fitting)) elements.push(fitting);
      rebuild();
      markDirty();
    },
    revert: () => {
      const i = elements.indexOf(fitting);
      if (i >= 0) elements.splice(i, 1);
      rebuild();
      markDirty();
    },
  });
  return fitting;
}

/**
 * Build the swept elbow geometry.
 * Rectangular profiles use a lofted quad strip; circular profiles use a
 * Tube along a quadratic Bezier from the incoming to the outgoing tangent.
 */
function buildFitting(el: AuthoredElement): THREE.Object3D | null {
  const p = el.params;
  if (!p.point) return null;
  const aIn = p.angleIn ?? 0;
  const aOut = p.angleOut ?? Math.PI / 2;
  const parentType = (p.parentType as string) || "duct";
  const isRound = parentType === "pipe" || parentType === "conduit";
  const kind = String((p as any).fittingKind ?? el.properties?.fittingKind ?? "elbow");
  const cx = p.point[0];
  const cz = p.point[1];
  const yCenter = p.elevation + (isRound ? 0 : p.height / 2);
  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(el.color || COLORS[parentType] || "#38bdf8"),
  });
  const r = Math.max(Number(p.bendRadius ?? ((isRound ? p.thickness : Math.max(p.thickness, p.height)) / 2)), 0.04);

  // ── Revit-style MEP fittings ──────────────────────────────────────────
  // Tee / Cross / Wye: continuous body + branch arms matching duct/pipe profile
  if (kind === "tee" || kind === "cross" || kind === "wye") {
    const g = new THREE.Group();
    const w = isRound ? r * 1.85 : Math.max(p.thickness, 0.08);
    const h = isRound ? r * 1.85 : Math.max(p.height, 0.08);
    // Center body (junction cube / sphere)
    const body = new THREE.Mesh(
      isRound
        ? new THREE.SphereGeometry(r * 1.05, 20, 16)
        : new THREE.BoxGeometry(w * 1.15, h * 1.15, w * 1.15),
      mat.clone(),
    );
    body.position.set(cx, yCenter, cz);
    body.userData.elementId = el.id;
    g.add(body);

    const armLen = Math.max(r * 2.4, w * 1.6);
    const placeArm = (angle: number) => {
      const ax = Math.cos(angle);
      const az = Math.sin(angle);
      let mesh: THREE.Mesh;
      if (isRound) {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 0.95, armLen, 20), mat.clone());
        // Cylinder default Y-up → align to horizontal direction (ax, 0, az)
        mesh.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(ax, 0, az).normalize(),
        );
      } else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(armLen, h, w), mat.clone());
        mesh.rotation.y = -angle;
      }
      mesh.position.set(cx + ax * armLen * 0.45, yCenter, cz + az * armLen * 0.45);
      mesh.userData.elementId = el.id;
      g.add(mesh);
    };

    // Main run through + branch (Revit duct/pipe fitting orientation)
    placeArm(aIn);
    placeArm(aIn + Math.PI);
    placeArm(aOut);
    if (kind === "cross") {
      placeArm(aOut + Math.PI);
    } else if (kind === "wye") {
      // 45° branch between main and branch
      placeArm((aIn + aOut) / 2);
    }
    g.userData.elementId = el.id;
    g.userData.baseColor = el.color || COLORS[parentType] || "#38bdf8";
    return g;
  }
  if (kind === "cap") {
    const mesh = new THREE.Mesh(
      isRound
        ? new THREE.SphereGeometry(r * 1.05, 20, 14)
        : new THREE.BoxGeometry(Math.max(p.thickness, 0.08), Math.max(p.height, 0.08), r * 0.7),
      mat,
    );
    mesh.position.set(cx, yCenter, cz);
    mesh.userData.elementId = el.id;
    return mesh;
  }
  if (kind === "transition" || kind === "union") {
    const mesh = new THREE.Mesh(
      isRound
        ? new THREE.CylinderGeometry(r * 0.55, r * 1.15, r * 2.8, 20)
        : new THREE.BoxGeometry(r * 2.8, p.height, p.thickness * 1.15),
      mat,
    );
    mesh.position.set(cx, yCenter, cz);
    mesh.rotation.y = -aIn;
    if (isRound) {
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(Math.cos(aIn), 0, Math.sin(aIn)).normalize(),
      );
    }
    mesh.userData.elementId = el.id;
    return mesh;
  }

  // Elbow (default) — skip only if angles nearly equal (straight)
  if (Math.abs(((aIn - aOut + Math.PI) % (2 * Math.PI)) - Math.PI) < 0.05) return null;

  const bendR = Math.max(r * 1.15, 0.06);
  const inStartX = cx - Math.cos(aIn) * bendR;
  const inStartZ = cz - Math.sin(aIn) * bendR;
  const outEndX = cx + Math.cos(aOut) * bendR;
  const outEndZ = cz + Math.sin(aOut) * bendR;

  // Smoother elbow (more segments = Revit-like curved fitting)
  const N = isRound ? 16 : 14;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const oneT = 1 - t;
    const x = oneT * oneT * inStartX + 2 * oneT * t * cx + t * t * outEndX;
    const z = oneT * oneT * inStartZ + 2 * oneT * t * cz + t * t * outEndZ;
    pts.push(new THREE.Vector3(x, yCenter, z));
  }

  if (isRound) {
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo = new THREE.TubeGeometry(curve, Math.max(N, 18), Math.max(p.thickness / 2, 0.02), 18, false);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.elementId = el.id;
    mesh.userData.baseColor = el.color || COLORS[parentType] || "#38bdf8";
    return mesh;
  }

  // Rectangular: loft four corner rails along the sampled curve.
  const up = new THREE.Vector3(0, 1, 0);
  const halfW = p.thickness / 2;
  const halfH = p.height / 2;
  const rings: THREE.Vector3[][] = [];

  for (let i = 0; i < pts.length; i++) {
    const t = i / N;
    const oneT = 1 - t;
    const dx = 2 * (oneT * (cx - inStartX) + t * (outEndX - cx));
    const dz = 2 * (oneT * (cz - inStartZ) + t * (outEndZ - cz));
    let tan = new THREE.Vector3(dx, 0, dz);
    if (tan.lengthSq() < 1e-9) tan.set(1, 0, 0);
    tan.normalize();

    const right = new THREE.Vector3().crossVectors(up, tan);
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();

    const c = pts[i];
    rings.push([
      c.clone().add(right.clone().multiplyScalar(halfW)).add(up.clone().multiplyScalar(-halfH)),
      c.clone().add(right.clone().multiplyScalar(halfW)).add(up.clone().multiplyScalar(halfH)),
      c.clone().add(right.clone().multiplyScalar(-halfW)).add(up.clone().multiplyScalar(halfH)),
      c.clone().add(right.clone().multiplyScalar(-halfW)).add(up.clone().multiplyScalar(-halfH)),
    ]);
  }

  const verts: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const base = verts.length / 3;
      verts.push(a[k].x, a[k].y, a[k].z);
      verts.push(a[k2].x, a[k2].y, a[k2].z);
      verts.push(b[k2].x, b[k2].y, b[k2].z);
      verts.push(b[k].x, b[k].y, b[k].z);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  for (const [ring, reverse] of [[rings[0], true], [rings[rings.length - 1], false]] as const) {
    const base = verts.length / 3;
    verts.push(ring[0].x, ring[0].y, ring[0].z);
    verts.push(ring[1].x, ring[1].y, ring[1].z);
    verts.push(ring[2].x, ring[2].y, ring[2].z);
    verts.push(ring[3].x, ring[3].y, ring[3].z);
    if (reverse) {
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    } else {
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.elementId = el.id;
  mesh.userData.baseColor = el.color || COLORS[parentType] || "#38bdf8";
  return mesh;
}

// ═══════════════════════════════════════════════════════════════════════════
// Hosted element helpers
// ═══════════════════════════════════════════════════════════════════════════
function getHostedForWall(wallId: string): AuthoredElement[] {
  return elements.filter(
    (e) => (e.type === "door" || e.type === "window") && e.hostId === wallId,
  );
}

function openingsForWall(wallId: string): WallOpening[] {
  // hosted-recut: clamp each opening to the host's CURRENT length so a moved or
  // resized wall re-cuts its door/window holes in-bounds on every rebuild, and
  // write the clamp back to the hosted element params so the door/window mesh
  // (built from the same offsetAlongHost) stays glued to the wall in one pass.
  // hosted-recut: skip full-face opening so a bad/degenerate opening can never
  // hollow the wall solid into a thin frame (the door mesh still draws on top).
  const out: WallOpening[] = [];
  const wall = elements.find((e) => e.id === wallId);
  const wp = wall?.params;
  let L = 0;
  let ax = 0, az = 0, dx = 0, dz = 0;
  if (wp && wp.start && wp.end) {
    ax = wp.start[0]; az = wp.start[1];
    dx = wp.end[0] - ax; dz = wp.end[1] - az;
    L = Math.hypot(dx, dz);
  }
  const angle = L > 1e-6 ? Math.atan2(dz, dx) : 0;
  const H = Number(wp?.height ?? 3);
  for (const el of getHostedForWall(wallId)) {
    const p = el.params;
    const w = p.width ?? DEFAULTS[el.type]?.width ?? 0.9;
    const h = p.height;
    const sill = el.type === "window" ? (p.sillHeight ?? 0.9) : (p.sillHeight ?? 0);
    let offset = p.offsetAlongHost ?? (L > 0 ? L / 2 : 0);
    if (L > 1e-6) {
      const half = w / 2;
      if (L <= w + 0.02) offset = L / 2;
      else offset = Math.max(half, Math.min(L - half, offset));
      offset = Math.round(offset * 1000) / 1000;
      p.offsetAlongHost = offset;
      const t01 = offset / L;
      const cx = ax + dx * t01;
      const cz = az + dz * t01;
      if ("x" in p) p.x = Math.round(cx * 1000) / 1000;
      if ("z" in p) p.z = Math.round(cz * 1000) / 1000;
      const hostAngle = Math.round(angle * 10000) / 10000;
      if ("hostAngle" in p) (p as any).hostAngle = hostAngle;
      if ("rotation" in p) (p as any).rotation = hostAngle;
      if ("angle" in p) (p as any).angle = hostAngle;
    }
    // full-face skip: compute the hole rect exactly as the legacy builder does,
    // and drop the opening if it would erase >= 90% of the wall face.
    const u0 = Math.max(0, offset - w / 2);
    const u1 = Math.min(L, offset + w / 2);
    const v0 = Math.max(0, sill);
    const v1 = Math.min(H, sill + h);
    const holeW = u1 - u0;
    const holeH = v1 - v0;
    const degenerate = holeW < 0.02 || holeH < 0.02;
    const fullFace = L > 0.05 && H > 0.05 && holeW >= L * 0.9 && holeH >= H * 0.9;
    if (degenerate || fullFace) continue;
    out.push({ offset, width: w, height: h, sill });
  }
  return out;
}

/* ── Revit-style wall join ─────────────────────────────────────────── */

function computeWallEndFaces(
  endX: number,
  endZ: number,
  dirX: number,
  dirZ: number,
  halfT: number,
  selfId: string,
  joinStatus: string,
  allWalls: AuthoredElement[],
): { left: [number, number]; right: [number, number]; joined: boolean } {
  const nx = -dirZ, nz = dirX;
  const plainLeft: [number, number] = [endX + nx * halfT, endZ + nz * halfT];
  const plainRight: [number, number] = [endX - nx * halfT, endZ - nz * halfT];

  if (joinStatus === "disallow" || joinStatus === "butt") {
    return { left: plainLeft, right: plainRight, joined: false };
  }

  const lineHit = (
    px: number, pz: number, dx: number, dz: number,
    qx: number, qz: number, ex: number, ez: number,
  ): [number, number] | null => {
    const det = dx * ez - dz * ex;
    if (Math.abs(det) < 1e-9) return null;
    const t = ((qx - px) * ez - (qz - pz) * ex) / det;
    return [px + t * dx, pz + t * dz];
  };

  // L-corner: neighbour's endpoint coincides with ours
  const endpointTol = Math.max(0.20, halfT * 3.0);
  let nbEnd: AuthoredElement | null = null;
  let nbEndDist = endpointTol;
  for (const o of allWalls) {
    if (o.id === selfId) continue;
    if (!o.params.start || !o.params.end) continue;
    const s = String(o.properties?.joinStatus ?? "allow");
    if (s === "disallow" || s === "butt") continue;
    for (const ep of [o.params.start, o.params.end]) {
      const d = Math.hypot(ep[0] - endX, ep[1] - endZ);
      if (d < nbEndDist) { nbEndDist = d; nbEnd = o; }
    }
  }

  if (nbEnd?.params.start && nbEnd.params.end) {
    const [sx, sz] = nbEnd.params.start;
    const [ex, ez] = nbEnd.params.end;
    const ndx = ex - sx, ndz = ez - sz;
    const nL = Math.hypot(ndx, ndz) || 1;
    const nux = ndx / nL, nuz = ndz / nL;
    const nnx = -nuz, nnz = nux;
    const nt2 = Math.max(0.01, (nbEnd.params.thickness ?? 0.2) / 2);

    const nl = lineHit(plainLeft[0],  plainLeft[1],  dirX, dirZ, sx + nnx * nt2, sz + nnz * nt2, nux, nuz);
    const nr = lineHit(plainLeft[0],  plainLeft[1],  dirX, dirZ, sx - nnx * nt2, sz - nnz * nt2, nux, nuz);
    const ml = lineHit(plainRight[0], plainRight[1], dirX, dirZ, sx + nnx * nt2, sz + nnz * nt2, nux, nuz);
    const mr = lineHit(plainRight[0], plainRight[1], dirX, dirZ, sx - nnx * nt2, sz - nnz * nt2, nux, nuz);

    const pickNear = (
      cands: ([number, number] | null)[],
      fallback: [number, number],
    ): [number, number] => {
      const c = cands.filter(Boolean) as [number, number][];
      if (!c.length) return fallback;
      c.sort((a, b) =>
        Math.hypot(a[0] - endX, a[1] - endZ) - Math.hypot(b[0] - endX, b[1] - endZ));
      const best = c[0];
      const maxD = Math.max(halfT, nt2) * 4;
      if (Math.hypot(best[0] - endX, best[1] - endZ) > maxD) return fallback;
      return best;
    };

    return {
      left: pickNear([nl, nr], plainLeft),
      right: pickNear([ml, mr], plainRight),
      joined: true,
    };
  }

  // T-junction: our endpoint lands on another wall's centerline
  for (const o of allWalls) {
    if (o.id === selfId) continue;
    if (!o.params.start || !o.params.end) continue;
    const s = String(o.properties?.joinStatus ?? "allow");
    if (s === "disallow" || s === "butt") continue;
    const [ox1, oz1] = o.params.start;
    const [ox2, oz2] = o.params.end;
    const odx = ox2 - ox1, odz = oz2 - oz1;
    const oL2 = odx * odx + odz * odz || 1;
    const t = ((endX - ox1) * odx + (endZ - oz1) * odz) / oL2;
    if (t <= 0.02 || t >= 0.98) continue;
    const px = ox1 + t * odx;
    const pz = oz1 + t * odz;
    const distC = Math.hypot(endX - px, endZ - pz);
    const oT2 = Math.max(0.01, (o.params.thickness ?? 0.2) / 2);
    if (distC > oT2 + halfT) continue;

    const oL = Math.hypot(odx, odz) || 1;
    const oux = odx / oL, ouz = odz / oL;
    const onx = -ouz, onz = oux;
    const side = Math.sign((endX - px) * onx + (endZ - pz) * onz) || 1;
    const faceX = px + onx * side * oT2;
    const faceZ = pz + onz * side * oT2;

    const hl = lineHit(plainLeft[0],  plainLeft[1],  dirX, dirZ, faceX, faceZ, oux, ouz);
    const hr = lineHit(plainRight[0], plainRight[1], dirX, dirZ, faceX, faceZ, oux, ouz);

    return { left: hl ?? plainLeft, right: hr ?? plainRight, joined: true };
  }

  return { left: plainLeft, right: plainRight, joined: false };
}

function buildWallWithOpenings(
  el: AuthoredElement,
  openings: WallOpening[],
): THREE.Object3D | null {
  const p = el.params;
  if (!p.start || !p.end) return null;
  const [ax, az] = p.start;
  const [bx, bz] = p.end;
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 0.05) return null;
  const H = p.height;
  const T = p.thickness;

  if (openings.length) return buildWallWithOpeningsLegacy(el, openings);

  const dirX = (bx - ax) / L;
  const dirZ = (bz - az) / L;
  const halfT = T / 2;
  const joinStatus = String(el.properties?.joinStatus ?? "allow");

  const sameKind = elements.filter(
    (e) => e.type === el.type && e.params.start && e.params.end,
  );

  const startFaces = computeWallEndFaces(ax, az, dirX, dirZ, halfT, el.id, joinStatus, sameKind);
  const endFaces   = computeWallEndFaces(bx, bz, dirX, dirZ, halfT, el.id, joinStatus, sameKind);

  const normalX = dirZ, normalZ = -dirX;
  const posX = ax + normalX * (-T / 2);
  const posZ = az + normalZ * (-T / 2);

  const toLocal = (wx: number, wz: number): [number, number] => {
    const dx = wx - posX;
    const dz = wz - posZ;
    return [dx * dirX + dz * dirZ, dx * normalX + dz * normalZ];
  };

  const sL = toLocal(startFaces.left[0],  startFaces.left[1]);
  const sR = toLocal(startFaces.right[0], startFaces.right[1]);
  const eL = toLocal(endFaces.left[0],    endFaces.left[1]);
  const eR = toLocal(endFaces.right[0],   endFaces.right[1]);

  const shape = new THREE.Shape();
  shape.moveTo(sL[0], sL[1]);
  shape.lineTo(eL[0], eL[1]);
  shape.lineTo(eR[0], eR[1]);
  shape.lineTo(sR[0], sR[1]);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false });
  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(el.color || COLORS[el.type] || COLORS.wall),
  });
  const mesh = new THREE.Mesh(geo, mat);

  const wallDirV = new THREE.Vector3(dirX, 0, dirZ);
  const normalV  = new THREE.Vector3(normalX, 0, normalZ);
  const upV      = new THREE.Vector3(0, 1, 0);
  const basis    = new THREE.Matrix4().makeBasis(wallDirV, normalV, upV);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.set(posX, p.elevation, posZ);

  mesh.userData.elementId = el.id;
  mesh.userData.baseColor = el.color || COLORS.wall;
  return mesh;
}

function buildWallWithOpeningsLegacy(
  el: AuthoredElement,
  openings: WallOpening[],
): THREE.Mesh | null {
  const p = el.params;
  if (!p.start || !p.end) return null;
  const [ax, az] = p.start;
  const [bx, bz] = p.end;
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 0.05) return null;
  const H = p.height;
  const T = p.thickness;

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(L, 0);
  shape.lineTo(L, H);
  shape.lineTo(0, H);
  shape.closePath();

  for (const op of openings) {
    const u0 = Math.max(0, op.offset - op.width / 2);
    const u1 = Math.min(L, op.offset + op.width / 2);
    const v0 = Math.max(0, op.sill);
    const v1 = Math.min(H, op.sill + op.height);
    if (u1 - u0 < 0.02 || v1 - v0 < 0.02) continue;
    const hole = new THREE.Path();
    hole.moveTo(u0, v0);
    hole.lineTo(u0, v1);
    hole.lineTo(u1, v1);
    hole.lineTo(u1, v0);
    hole.closePath();
    shape.holes.push(hole);
  }

  const geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false });
  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(el.color || COLORS[el.type] || COLORS.wall),
  });
  const mesh = new THREE.Mesh(geo, mat);

  const wallDir = new THREE.Vector3((bx - ax) / L, 0, (bz - az) / L);
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3().crossVectors(up, wallDir).normalize();
  const basis = new THREE.Matrix4().makeBasis(wallDir, up, normal);
  mesh.quaternion.setFromRotationMatrix(basis);

  const offset = normal.clone().multiplyScalar(-T / 2);
  mesh.position.set(ax + offset.x, p.elevation, az + offset.z);

  mesh.userData.elementId = el.id;
  mesh.userData.baseColor = el.color || COLORS.wall;
  return mesh;
}
function buildDoor(el: AuthoredElement, host: AuthoredElement): THREE.Group | null {
  const p = el.params;
  const w = p.width ?? DEFAULTS.door.width!;
  const h = p.height;
  const wallT = host.params.thickness;
  const frameT = Math.max(0.04, Math.min(0.1, p.frameThickness ?? 0.06));
  const panelType: DoorPanelType = p.doorPanel ?? "swing";

  const g = new THREE.Group();
  const frameMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(el.color || COLORS.door) });
  const panelMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(DOOR_COLOR_PANEL), side: THREE.DoubleSide });

  const panelT = Math.max(0.03, wallT * 0.28);
  const frameDepth = wallT * 0.92;

  const top = new THREE.Mesh(new THREE.BoxGeometry(w, frameT, frameDepth), frameMat);
  top.position.set(0, h - frameT / 2, 0);
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(w, frameT, frameDepth), frameMat);
  bottom.position.set(0, frameT / 2, 0);
  const left = new THREE.Mesh(new THREE.BoxGeometry(frameT, h - 2 * frameT, frameDepth), frameMat);
  left.position.set(-w / 2 + frameT / 2, h / 2, 0);
  const right = new THREE.Mesh(new THREE.BoxGeometry(frameT, h - 2 * frameT, frameDepth), frameMat);
  right.position.set(w / 2 - frameT / 2, h / 2, 0);
  g.add(top, bottom, left, right);

  const innerW = w - 2 * frameT;
  const innerH = h - 2 * frameT;

  if (panelType === "double") {
    const half = innerW / 2;
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(half, innerH, panelT), panelMat);
    p1.position.set(-half / 2, h / 2, 0);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(half, innerH, panelT), panelMat);
    p2.position.set(half / 2, h / 2, 0);
    g.add(p1, p2);
  } else if (panelType === "sliding") {
    const half = innerW / 2;
    const p1 = new THREE.Mesh(new THREE.BoxGeometry(half, innerH, panelT * 0.9), panelMat);
    p1.position.set(-half / 2, h / 2, panelT * 0.4);
    const p2 = new THREE.Mesh(new THREE.BoxGeometry(half, innerH, panelT * 0.9), panelMat);
    p2.position.set(half / 2, h / 2, -panelT * 0.4);
    g.add(p1, p2);
  } else if (panelType === "folding") {
    const q = innerW / 4;
    for (let i = 0; i < 4; i++) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(q * 0.95, innerH, panelT), panelMat);
      const z = i % 2 === 0 ? panelT * 0.35 : -panelT * 0.35;
      panel.position.set(-innerW / 2 + q / 2 + i * q, h / 2, z);
      g.add(panel);
    }
  } else if (panelType === "pocket") {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(innerW, innerH, panelT), panelMat);
    panel.position.set(-innerW / 4, h / 2, 0);
    g.add(panel);
  } else {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(innerW, innerH, panelT), panelMat);
    panel.position.set(0, h / 2, 0);
    g.add(panel);

    const arcPts: THREE.Vector3[] = [];
    const r = innerW;
    const hingeX = -innerW / 2;
    const hingeY = frameT;
    const N = 24;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * (Math.PI / 2);
      arcPts.push(new THREE.Vector3(hingeX + Math.sin(a) * r, hingeY, Math.cos(a) * r));
    }
    const arc = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(arcPts),
      new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.6 }),
    );
    g.add(arc);

    const leaf = new THREE.Mesh(new THREE.BoxGeometry(panelT, innerH, innerW), panelMat);
    leaf.position.set(hingeX + panelT / 2, h / 2, hingeY + innerW / 2);
    g.add(leaf);
  }

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, 0.1, 8),
    new THREE.MeshBasicMaterial({ color: 0x1f2937 }),
  );
  handle.rotation.z = Math.PI / 2;
  handle.position.set(w / 2 - frameT - 0.08, h / 2, panelT / 2 + 0.03);
  g.add(handle);

  return g;
}

// ═══════════════════════════════════════════════════════════════════════════
// Window geometry
// ═══════════════════════════════════════════════════════════════════════════
function buildWindow(el: AuthoredElement, host: AuthoredElement): THREE.Group | null {
  const p = el.params;
  const w = p.width ?? DEFAULTS.window.width!;
  const h = p.height;
  const wallT = host.params.thickness;
  const frameT = Math.max(0.04, Math.min(0.1, p.frameThickness ?? 0.05));
  const panelType: WindowPanelType = p.windowPanel ?? "casement";

  const g = new THREE.Group();
  const frameMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(el.color || COLORS.window) });
  const glassMat = new THREE.MeshPhongMaterial({
    color: new THREE.Color(WINDOW_COLOR_GLASS),
    transparent: true, opacity: 0.28, shininess: 90, side: THREE.DoubleSide,
  });

  const glassT = 0.015;
  const frameDepth = wallT * 0.92;

  const top = new THREE.Mesh(new THREE.BoxGeometry(w, frameT, frameDepth), frameMat);
  top.position.set(0, h - frameT / 2, 0);
  const bottom = new THREE.Mesh(new THREE.BoxGeometry(w, frameT, frameDepth), frameMat);
  bottom.position.set(0, frameT / 2, 0);
  const left = new THREE.Mesh(new THREE.BoxGeometry(frameT, h - 2 * frameT, frameDepth), frameMat);
  left.position.set(-w / 2 + frameT / 2, h / 2, 0);
  const right = new THREE.Mesh(new THREE.BoxGeometry(frameT, h - 2 * frameT, frameDepth), frameMat);
  right.position.set(w / 2 - frameT / 2, h / 2, 0);
  g.add(top, bottom, left, right);

  const innerW = w - 2 * frameT;
  const innerH = h - 2 * frameT;

  if (panelType === "double") {
    const mullion = new THREE.Mesh(new THREE.BoxGeometry(frameT * 0.8, innerH, frameDepth), frameMat);
    mullion.position.set(0, h / 2, 0);
    g.add(mullion);
    const gw = (innerW - frameT * 0.8) / 2;
    const gL = new THREE.Mesh(new THREE.BoxGeometry(gw, innerH, glassT), glassMat);
    gL.position.set(-gw / 2 - frameT * 0.4, h / 2, 0);
    const gR = new THREE.Mesh(new THREE.BoxGeometry(gw, innerH, glassT), glassMat);
    gR.position.set(gw / 2 + frameT * 0.4, h / 2, 0);
    g.add(gL, gR);
  } else if (panelType === "sliding") {
    const half = innerW / 2;
    const gL = new THREE.Mesh(new THREE.BoxGeometry(half * 0.98, innerH, glassT), glassMat);
    gL.position.set(-half / 2, h / 2, glassT * 2);
    const gR = new THREE.Mesh(new THREE.BoxGeometry(half * 0.98, innerH, glassT), glassMat);
    gR.position.set(half / 2, h / 2, -glassT * 2);
    g.add(gL, gR);
  } else {
    const glass = new THREE.Mesh(new THREE.BoxGeometry(innerW, innerH, glassT), glassMat);
    glass.position.set(0, h / 2, 0);
    g.add(glass);
  }

  if (p.mullion) {
    const transom = new THREE.Mesh(new THREE.BoxGeometry(innerW, frameT * 0.6, frameDepth), frameMat);
    transom.position.set(0, h * 0.65, 0);
    g.add(transom);
  }

  const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.06, 0.04, wallT * 1.15), frameMat);
  sill.position.set(0, -0.02, 0);
  g.add(sill);

  return g;
}

// ═══════════════════════════════════════════════════════════════════════════
// Professional BIM family mesh factory
// ═══════════════════════════════════════════════════════════════════════════
function buildBimFamilyMesh(el: AuthoredElement): THREE.Object3D | null {
  const p = el.params;
  const family = String(el.properties?.family ?? el.properties?.category ?? "").toLowerCase();
  if (!family || !p.point) return null;

  const color = new THREE.Color(el.color || COLORS.equipment);
  const mat = new THREE.MeshLambertMaterial({ color });
  const w = Math.max(0.05, p.thickness);
  const d = Math.max(0.05, p.depth ?? p.thickness);
  const h = Math.max(0.05, p.height);
  const group = new THREE.Group();

  const addBox = (sx: number, sy: number, sz: number, y = sy / 2, material = mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
    m.position.set(0, y, 0);
    group.add(m);
  };
  const addCylinder = (r: number, hh: number, y = hh / 2) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, hh, 32), mat);
    m.position.y = y;
    group.add(m);
  };

  if (["tank", "chiller", "boiler", "cooling-tower", "heat-exchanger", "water-heater"].includes(family)) {
    const r = Math.max(w, d) * 0.5;
    addCylinder(r, h);
    if (family === "cooling-tower") {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 0.72, Math.max(0.15, h * 0.25), 32), mat);
      cone.position.y = h * 0.88;
      group.add(cone);
    }
  } else if (["fan", "pump", "exhaust-fan", "fan-coil"].includes(family)) {
    addCylinder(Math.min(w, d) * 0.5, Math.max(0.18, h * 0.55), h * 0.28);
    addBox(w, Math.max(0.08, h * 0.28), d, h * 0.72);
    if (["fan", "exhaust-fan"].includes(family)) {
      const bladeMat = new THREE.MeshBasicMaterial({ color: 0xe5e7eb });
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(w * 0.75, 0.025, Math.max(0.03, d * 0.16)), bladeMat);
        blade.position.y = h * 0.18;
        blade.rotation.y = (Math.PI / 2) * i;
        group.add(blade);
      }
    }
  } else if (["diffuser", "grille", "luminaire", "exit-sign", "speaker", "access-point", "smoke-detector", "heat-detector"].includes(family)) {
    const face = new THREE.MeshLambertMaterial({ color: family === "luminaire" ? 0xf8fafc : color });
    addBox(w, Math.min(h, 0.12), d, Math.min(h, 0.12) / 2, face);
    const inset = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.03, w * 0.72), 0.02, Math.max(0.03, d * 0.72)), new THREE.MeshBasicMaterial({ color: 0x111827 }));
    inset.position.y = Math.min(h, 0.12) + 0.012;
    group.add(inset);
  } else if (["vav", "filter", "damper", "silencer", "valve", "heat-exchanger", "duct-accessory"].includes(family)) {
    addBox(w, h, d);
    const marker = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.02, w * 0.72), Math.max(0.02, h * 0.08), Math.max(0.02, d * 0.72)), new THREE.MeshBasicMaterial({ color: 0xe2e8f0 }));
    marker.position.y = h * 0.5;
    group.add(marker);
  } else if (["toilet", "washbasin", "sink", "shower"].includes(family)) {
    if (family === "toilet") {
      addBox(w * 0.8, h * 0.25, d * 0.9, h * 0.125);
      addCylinder(Math.min(w, d) * 0.42, h * 0.58, h * 0.55);
    } else if (family === "shower") {
      addBox(w, 0.08, d, 0.04);
      addCylinder(Math.min(w, d) * 0.06, h * 0.78, h * 0.4);
    } else {
      addBox(w, Math.min(0.18, h), d, Math.min(0.18, h) / 2);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) * 0.42, Math.min(w, d) * 0.35, Math.min(0.08, h), 32), new THREE.MeshLambertMaterial({ color: 0xf8fafc }));
      bowl.position.y = Math.min(0.18, h);
      group.add(bowl);
    }
  } else if (["fire-extinguisher", "fire-hydrant", "hose-reel", "battery", "anchor-bolt", "bearing", "bollard"].includes(family)) {
    addCylinder(Math.min(w, d) * 0.48, h);
    if (["fire-extinguisher", "bollard"].includes(family)) {
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) * 0.3, Math.min(w, d) * 0.3, Math.min(0.08, h * 0.08), 24), mat);
      cap.position.y = h + Math.min(0.04, h * 0.04);
      group.add(cap);
    }
  } else if (["panel", "switchgear", "distribution-board", "fire-alarm-panel", "ups", "communication-panel", "structural-connection"].includes(family)) {
    addBox(w, h, d);
    const front = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.03, w * 0.75), Math.max(0.03, h * 0.7), Math.max(0.015, d * 0.08)), new THREE.MeshLambertMaterial({ color: 0x334155 }));
    front.position.set(0, h * 0.52, d * 0.46);
    group.add(front);
    const indicator = new THREE.Mesh(new THREE.SphereGeometry(Math.min(w, d) * 0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0x22c55e }));
    indicator.position.set(w * 0.22, h * 0.72, d * 0.52);
    group.add(indicator);
  } else if (["rack", "cctv-rack", "telecom-rack", "furniture"].includes(family)) {
    addBox(w, h, d);
    for (let i = 1; i < 5; i++) {
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, 0.025, d * 0.08), new THREE.MeshBasicMaterial({ color: 0x94a3b8 }));
      shelf.position.set(0, (h / 5) * i, d * 0.47);
      group.add(shelf);
    }
  } else if (["camera"].includes(family)) {
    addCylinder(Math.min(w, d) * 0.4, Math.max(0.12, h * 0.55), h * 0.3);
    const head = new THREE.Mesh(new THREE.SphereGeometry(Math.min(w, d) * 0.38, 20, 14), mat);
    head.position.y = h * 0.75;
    group.add(head);
  } else if (["landscape-component", "furniture", "generic-model"].includes(family)) {
    addBox(w, h, d);
  } else {
    return null;
  }

  group.position.set(p.point[0], p.elevation, p.point[1]);
  group.traverse((m: any) => {
    if (m.isMesh) {
      m.userData.elementId = el.id;
      m.userData.baseColor = el.color || COLORS.equipment;
    }
  });
  return group;
}

// ═══════════════════════════════════════════════════════════════════════════
// General mesh factory
// ═══════════════════════════════════════════════════════════════════════════
function createMesh(el: AuthoredElement): THREE.Object3D | null {
  const p = el.params;

  // Exact native reconstruction path for IFC/FRAG Native Twins. The authored
  // project stores non-indexed triangle positions, so the object is rendered
  // by the same authored scene graph as normal BIM objects.
  if (el.nativeGeometry?.positions && el.nativeGeometry.positions.length >= 9) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(el.nativeGeometry.positions, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(el.color || COLORS[el.type] || "#a7b0be") });
    if (el.type === "slab" || el.type === "wall" || el.type === "roof") mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.elementId = el.id;
    mesh.userData.baseColor = el.color || COLORS[el.type] || "#a7b0be";
    mesh.userData.nativeTwin = true;
    mesh.userData.ifc = el.ifc;
    mesh.userData.sourceModelId = el.ifc?.sourceModelId;
    mesh.userData.sourceLocalId = el.ifc?.sourceLocalId;
    mesh.userData.sourceGlobalId = el.ifc?.sourceGlobalId || el.ifc?.globalId;
    if (el.transform) {
      mesh.position.set(...el.transform.position);
      mesh.quaternion.set(...el.transform.quaternion);
      mesh.scale.set(...el.transform.scale);
    }
    return mesh;
  }

  if (el.type === "fitting") return buildFitting(el);

  if (el.type === "wall" && p.start && p.end) {
    const openings = openingsForWall(el.id);
    return buildWallWithOpenings(el, openings);
  }

  // miter-beam-v1
  if (el.type === "beam" && p.start && p.end) {
    // Beams reuse the same mitered-linear builder as walls (with no
    // openings). Two beams meeting at an L-corner miter cleanly in both
    // 2D plan and 3D, matching Revit's structural framing behaviour.
    return buildWallWithOpenings(el, []);
  }

  if (el.type === "door") {
    const host = el.hostId ? elements.find((e) => e.id === el.hostId) : null;
    if (!host || !host.params.start || !host.params.end) return null;
    const g = buildDoor(el, host);
    if (!g) return null;
    placeHostedElement(g, el, host);
    return g;
  }

  if (el.type === "window") {
    const host = el.hostId ? elements.find((e) => e.id === el.hostId) : null;
    if (!host || !host.params.start || !host.params.end) return null;
    const g = buildWindow(el, host);
    if (!g) return null;
    placeHostedElement(g, el, host);
    return g;
  }

  const color = new THREE.Color(el.color || COLORS[el.type] || "#cccccc");
  if (el.type === "truss" && p.start && p.end) {
    const g = buildTruss(el);
    g.traverse((m: any) => {
      if (m.isMesh) {
        m.userData.elementId = el.id;
        m.userData.baseColor = el.color || COLORS.truss;
      }
    });
    return g;
  }

  const mat = new THREE.MeshLambertMaterial({ color });
  if (el.type === "slab") mat.side = THREE.DoubleSide;
  let mesh: THREE.Mesh | null = null;

  if (p.start && p.end) {
    const [ax, az] = p.start;
    const [bx, bz] = p.end;
    const len = Math.hypot(bx - ax, bz - az);
    if (
      len < 0.05 &&
      ["wall", "duct", "pipe", "cable-tray", "conduit", "beam", "strip", "mline"].includes(el.type)
    ) return null;

    if (el.type === "mline" && len >= 0.02) {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(len, 0.02, 0.02), new THREE.MeshBasicMaterial({ color }));
      mesh.position.set((ax + bx) / 2, p.elevation + 0.01, (az + bz) / 2);
      mesh.rotation.y = Math.atan2(-(bz - az), bx - ax);
    } else if (
      ["wall", "duct", "pipe", "cable-tray", "conduit", "strip", "beam"].includes(el.type) &&
      len >= 0.05
    ) {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(len, p.height, p.thickness), mat);
      mesh.position.set((ax + bx) / 2, p.elevation + p.height / 2, (az + bz) / 2);
      mesh.rotation.y = Math.atan2(-(bz - az), bx - ax);
    }
  }

  if (!mesh && el.type === "brace" && p.start && p.end) {
    const a = new THREE.Vector3(p.start[0], p.elevation, p.start[1]);
    const b = new THREE.Vector3(p.end[0], p.elevation + p.height, p.end[1]);
    if (a.distanceTo(b) < 0.05) return null;
    mesh = memberMesh(a, b, p.thickness, p.thickness, mat);
  }

  if (!mesh && el.type === "slab" && p.polygon && p.polygon.length >= 3) {
    const shape = new THREE.Shape();
    p.polygon.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: p.height, bevelEnabled: false });
    mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = p.elevation;
  }

  if (!mesh && el.type === "equipment" && p.point) {
    mesh = buildBimFamilyMesh(el) as THREE.Mesh | null;
    if (!mesh) {
      const d = p.depth ?? p.thickness;
      mesh = new THREE.Mesh(new THREE.BoxGeometry(p.thickness, p.height, d), mat);
      mesh.position.set(p.point[0], p.elevation + p.height / 2, p.point[1]);
    }
  }

  if (!mesh && el.type === "column" && p.point) {
    const d = p.depth ?? p.thickness;
    mesh = new THREE.Mesh(new THREE.BoxGeometry(p.thickness, p.height, d), mat);
    mesh.position.set(p.point[0], p.elevation + p.height / 2, p.point[1]);
  }

  if (!mesh && el.type === "footing" && p.point) {
    const d = p.depth ?? p.thickness;
    mesh = new THREE.Mesh(new THREE.BoxGeometry(p.thickness, p.height, d), mat);
    mesh.position.set(p.point[0], p.elevation - p.height / 2, p.point[1]);
  }

  if (!mesh) return null;
  mesh.userData.elementId = el.id;
  mesh.userData.baseColor = "#" + color.getHexString();
  return mesh;
}

function placeHostedElement(g: THREE.Group, el: AuthoredElement, host: AuthoredElement): void {
  const [ax, az] = host.params.start!;
  const [bx, bz] = host.params.end!;
  const dx = bx - ax;
  const dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < 0.01) return;

  const dir = new THREE.Vector3(dx / L, 0, dz / L);
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3().crossVectors(up, dir).normalize();

  const offset = el.params.offsetAlongHost ?? L / 2;
  const sill = el.params.sillHeight ?? 0;

  const pos = new THREE.Vector3(
    ax + dir.x * offset,
    host.params.elevation + sill,
    az + dir.z * offset,
  );

  const basis = new THREE.Matrix4().makeBasis(dir, up, normal);
  const quat = new THREE.Quaternion().setFromRotationMatrix(basis);

  g.position.copy(pos);
  g.quaternion.copy(quat);

  g.traverse((m: any) => {
    if (m.isMesh) {
      m.userData.elementId = el.id;
      m.userData.baseColor = el.color || COLORS[el.type];
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Rebuild
// ═══════════════════════════════════════════════════════════════════════════
function disposeObj(obj: THREE.Object3D) {
  obj.traverse((m: any) => {
    m.geometry?.dispose?.();
    if (Array.isArray(m.material)) m.material.forEach((x: any) => x.dispose?.());
    else m.material?.dispose?.();
  });
}

function rebuild() {
  while (group.children.length) {
    const ch = group.children[0];
    group.remove(ch);
    disposeObj(ch);
  }
  for (const el of elements) {
    if (el.type !== "wall") continue;
    const m = createMesh(el);
    if (m) group.add(m);
  }
  for (const el of elements) {
    if (el.type === "wall") continue;
    const m = createMesh(el);
    if (m) group.add(m);
  }
  applySelection();
  refreshGrips();
  // hosted-place-sync: reconcile hosted door/window mesh transforms to the
  // clamped offsetAlongHost (same source as the wall hole) so a freshly placed
  // opening cannot float off its host. No-op if the module is not loaded.
  (window as any).__obsSyncHostedPlacement?.();
}

function applySelection() {
  for (const child of group.children) {
    child.traverse((m: any) => {
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshLambertMaterial;
      if (!mat?.color) return;
      const id = m.userData.elementId;
      mat.color.set(id && selectedIds.has(id) ? "#2563eb" : m.userData.baseColor ?? "#cccccc");
    });
  }
  refreshEditor();
}

// ═══════════════════════════════════════════════════════════════════════════
// Grips
// ═══════════════════════════════════════════════════════════════════════════
function clearGrips() {
  while (gripGroup.children.length) {
    const ch = gripGroup.children[0];
    gripGroup.remove(ch);
    disposeObj(ch);
  }
}

function gripMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color: GRIP_COLOR, depthTest: false, transparent: true, opacity: 0.95 });
}

function buildGripsFor(el: AuthoredElement): GripSpec[] {
  const grips: GripSpec[] = [];
  const p = el.params;

  const addGrip = (kind: GripSpec["kind"], pos: THREE.Vector3, vertexIndex?: number) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(GRIP_SIZE, 12, 10), gripMaterial());
    mesh.position.copy(pos);
    mesh.renderOrder = 900;
    mesh.userData.gripElementId = el.id;
    mesh.userData.gripKind = kind;
    if (vertexIndex !== undefined) mesh.userData.gripVertexIndex = vertexIndex;
    gripGroup.add(mesh);
    grips.push({ elementId: el.id, kind, vertexIndex, position: pos.clone(), mesh });
  };

  if (p.start && p.end) {
    addGrip("start", new THREE.Vector3(p.start[0], p.elevation, p.start[1]));
    addGrip("end", new THREE.Vector3(p.end[0], p.elevation, p.end[1]));
  } else if (p.point) {
    addGrip("point", new THREE.Vector3(p.point[0], p.elevation, p.point[1]));
  } else if (p.polygon) {
    p.polygon.forEach((v, i) => addGrip("vertex", new THREE.Vector3(v[0], p.elevation, v[1]), i));
  }

  if ((el.type === "door" || el.type === "window") && el.hostId) {
    const host = elements.find((e) => e.id === el.hostId);
    if (host?.params.start && host?.params.end) {
      const [ax, az] = host.params.start;
      const [bx, bz] = host.params.end;
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L > 0.01) {
        const off = p.offsetAlongHost ?? L / 2;
        const sill = p.sillHeight ?? 0;
        const pos = new THREE.Vector3(
          ax + (dx / L) * off,
          host.params.elevation + sill + p.height / 2,
          az + (dz / L) * off,
        );
        addGrip("hosted-offset", pos);
      }
    }
  }
  return grips;
}

function refreshGrips() {
  clearGrips();
  if (activeTool !== "select") return;
  // Wall-handles module owns the visual for wall-like types when it is active.
  // openbim-fix: authoring.ts -- require the wall-handles overlay to be live
  const handlesActive = (window as any).__obsWallHandlesActive === true
    && !!document.getElementById("obs-wall-handles")?.isConnected;
  const skip = handlesActive
    ? new Set(["wall", "beam", "duct", "pipe", "cable-tray", "conduit", "strip", "mline"])
    : null;
  for (const el of elements) {
    if (!selectedIds.has(el.id)) continue;
    if (skip && skip.has(el.type)) continue;
    buildGripsFor(el);
  }
}

function gripAt(e: MouseEvent): GripSpec | null {
  if (!gripGroup.children.length) return null;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndcOf(e), ctx.world.camera.three);
  const hits = ray.intersectObjects(gripGroup.children, false);
  if (!hits.length) return null;
  const mesh = hits[0].object as THREE.Mesh;
  const id = mesh.userData.gripElementId as string;
  const kind = mesh.userData.gripKind as GripSpec["kind"];
  const vi = mesh.userData.gripVertexIndex as number | undefined;
  return { elementId: id, kind, vertexIndex: vi, position: mesh.position.clone(), mesh };
}

function startGripDrag(g: GripSpec, worldPt: THREE.Vector3) {
  const el = elements.find((e) => e.id === g.elementId);
  if (!el) return;
  gripDrag = {
    grip: g,
    snapshot: JSON.parse(JSON.stringify(el.params)),
    original: worldPt.clone(),
  };
}

function updateGripDrag(worldPt: THREE.Vector3) {
  if (!gripDrag) return;
  const el = elements.find((e) => e.id === gripDrag!.grip.elementId);
  if (!el) return;
  const p = el.params;
  const x = snap(worldPt.x);
  const z = snap(worldPt.z);
  const { kind, vertexIndex } = gripDrag.grip;

  if (kind === "hosted-offset" && el.hostId) {
    const host = elements.find((e) => e.id === el.hostId);
    if (host?.params.start && host?.params.end) {
      const [ax, az] = host.params.start;
      const [bx, bz] = host.params.end;
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L > 0.01) {
        const t = ((worldPt.x - ax) * dx + (worldPt.z - az) * dz) / (L * L);
        const half = (p.width ?? 0.9) / 2;
        const clamped = Math.max(half, Math.min(L - half, t * L));
        p.offsetAlongHost = snap(clamped, 0.05);
      }
    }
  } else if (kind === "start" && p.start) p.start = [x, z];
  else if (kind === "end" && p.end) p.end = [x, z];
  else if (kind === "point" && p.point) p.point = [x, z];
  else if (kind === "vertex" && p.polygon && vertexIndex !== undefined) p.polygon[vertexIndex] = [x, z];

  while (group.children.length) {
    const ch = group.children[0];
    group.remove(ch);
    disposeObj(ch);
  }
  for (const e2 of elements) {
    if (e2.type !== "wall") continue;
    const m = createMesh(e2);
    if (m) group.add(m);
  }
  for (const e2 of elements) {
    if (e2.type === "wall") continue;
    const m = createMesh(e2);
    if (m) group.add(m);
  }
  applySelection();
}

function endGripDrag() {
  if (!gripDrag) return;
  const el = elements.find((e) => e.id === gripDrag!.grip.elementId);
  const before = gripDrag.snapshot;
  const after = el ? JSON.parse(JSON.stringify(el.params)) : null;
  gripDrag = null;
  if (!el || !after) return;
  if (JSON.stringify(before) === JSON.stringify(after)) return;

  history.push({
    label: `Move grip · ${el.name}`,
    apply: () => { el.params = JSON.parse(JSON.stringify(after)); rebuild(); markDirty(); },
    revert: () => { el.params = JSON.parse(JSON.stringify(before)); rebuild(); markDirty(); },
  });
  markDirty();
}

// ═══════════════════════════════════════════════════════════════════════════
// Picking / ground — AccuDraw-aware
// ═══════════════════════════════════════════════════════════════════════════
function ndcOf(e: MouseEvent): THREE.Vector2 {
  const rect = ctx.rightHost.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

function elementAt(e: MouseEvent): string | null {
  try {
    if (!ctx.world?.camera?.three || !group.children.length) return null;
    const ray = new THREE.Raycaster();
    ray.params.Line = { threshold: 0.15 };
    ray.params.Points = { threshold: 0.2 };
    ray.setFromCamera(ndcOf(e), ctx.world.camera.three);
    // Prefer authored group; include nested meshes
    const hits = ray.intersectObjects(group.children, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (o.userData?.elementId) return String(o.userData.elementId);
        o = o.parent;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function wallAtPoint(e: MouseEvent): { wallId: string; offset: number; point: THREE.Vector3 } | null {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndcOf(e), ctx.world.camera.three);
  const hits = ray.intersectObjects(group.children, true);
  for (const h of hits) {
    let o: THREE.Object3D | null = h.object;
    let elId: string | null = null;
    while (o && !elId) { elId = o.userData?.elementId ?? null; o = o.parent; }
    if (!elId) continue;
    const el = elements.find((e) => e.id === elId);
    if (!el || el.type !== "wall" || !el.params.start || !el.params.end) continue;
    const [ax, az] = el.params.start;
    const [bx, bz] = el.params.end;
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 0.05) continue;
    const t = ((h.point.x - ax) * dx + (h.point.z - az) * dz) / (L * L);
    const offset = Math.max(0, Math.min(L, t * L));
    return { wallId: el.id, offset, point: h.point.clone() };
  }
  return null;
}

function groundPoint(e: MouseEvent): THREE.Vector3 | null {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndcOf(e), ctx.world.camera.three);
  const hits = ray.intersectObjects([ctx.groundPlane], false);
  if (!hits.length) return null;

  let p = hits[0].point.clone();
  if (snapping.isEnabled() && lastSnapValid && lastSnapResult) {
    p = lastSnapResult.point.clone();
  } else {
    p.x = snap(p.x, snapping.getGridSize());
    p.z = snap(p.z, snapping.getGridSize());
  }
  p.y = 0;

  try {
    if (accuDraw.isActive()) p = accuDraw.constrain(p);
  } catch { /* */ }

  return p;
}

async function updateSnapAsync(e: MouseEvent, cursorWorld: THREE.Vector3 | null) {
  lastSnapValid = false;
  lastSnapResult = null;
  if (!snapping.isEnabled()) {
    snapping.hideIndicator();
    return;
  }
  try {
    const s = await snapping.query(e, cursorWorld);
    lastSnapResult = s;
    lastSnapValid = !!s;
    snapping.showIndicator(s);
  } catch {
    snapping.hideIndicator();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// History-wrapped mutations
// ═══════════════════════════════════════════════════════════════════════════
async function createElement(
  type: ElementType,
  params: Partial<AuthoredElement["params"]>,
  props?: Record<string, unknown>,
  hostId?: string,
): Promise<AuthoredElement | null> {
  const presetKey = activePreset && DEFAULTS[activePreset] ? activePreset : type;
  const baseDefaults = DEFAULTS[presetKey] ?? DEFAULTS[type] ?? { height: 1, thickness: 0.2 };
  const userDefaults = getTypeDefaults(type);
  const displayName = activePreset
    ? nextName(activePreset.replace(/-/g, " "))
    : (userDefaults.name || nextName(type));

  // openbim-family-placement: when a family is active, its resolved
  // parameters take precedence over the hardcoded DEFAULTS so the type
  // the user picked in the Family Browser actually drives the geometry
  // of the element that gets placed.
  let familyGeometry: Partial<AuthoredElement["params"]> = {};
  if (activeFamilyId) {
    try {
      const famMod: any = (ctx.features as any).family;
      const resolved = famMod?.resolveParams?.(activeFamilyId, activeFamilyTypeId, undefined);
      if (resolved) {
        const keys = ["height", "thickness", "width", "depth", "sillHeight", "frameThickness"];
        for (const k of keys) {
          const v = resolved[k];
          if (typeof v === "number" && Number.isFinite(v)) {
            (familyGeometry as any)[k] = v;
          }
        }
      }
    } catch (err) {
      console.warn("[authoring] family resolve failed", err);
    }
  }

  const el: AuthoredElement = {
    id: uid(),
    type,
    name: displayName,
    color: userDefaults.color || COLORS[type] || COLORS[presetKey] || "#cccccc",
    hostId,
    levelId: activeLevelId ?? undefined,
    // openbim-families:instance-wiring
    familyId: activeFamilyId ?? undefined,
    familyTypeId: activeFamilyTypeId ?? undefined,
    params: {
      height: baseDefaults.height,
      thickness: baseDefaults.thickness,
      elevation: level,
      ...familyGeometry,
      ...(baseDefaults.width !== undefined ? { width: baseDefaults.width } : {}),
      ...userDefaults.params,
      ...params,
    },
    properties: {
      ...userDefaults.properties,
      ...(activePreset ? { category: activePreset, family: activePreset } : {}),
      ...(props ?? {}),
    },
  };
  const validation = validateNativeModel({ elements: [...elements, el], levels, grids })
    .filter((diagnostic) => diagnostic.elementId === el.id && diagnostic.severity === "error");
  if (validation.length) {
    const details = validation.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n");
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: {
        message: `Cannot create ${el.name}. Correct the placement or dimensions first.\n${details}`,
        kind: "error",
      },
    }));
    return null;
  }

  await history.exec({
    label: `Create ${cap(type)}`,
    apply: () => {
      if (!elements.includes(el)) elements.push(el);
      rebuild();
      markDirty();
    },
    revert: () => {
      const i = elements.indexOf(el);
      if (i >= 0) elements.splice(i, 1);
      rebuild();
      markDirty();
    },
  });
  return el;
}

function deleteElements(ids: string[]) {
  if (!ids.length) return;
  const targets = elements.filter((e) => ids.includes(e.id));
  if (!targets.length) return;

  const cascade = new Set<string>(ids);
  for (const t of targets) {
    if (t.type === "wall") {
      for (const host of elements) if (host.hostId === t.id) cascade.add(host.id);
    }
  }
  const allTargets = elements.filter((e) => cascade.has(e.id));
  const indices = allTargets.map((t) => elements.indexOf(t));

  history.push({
    label: `Delete ${allTargets.length} element(s)`,
    apply: () => {
      for (const t of allTargets) {
        const i = elements.indexOf(t);
        if (i >= 0) elements.splice(i, 1);
      }
      selectedIds.clear();
      rebuild();
      markDirty();
    },
    revert: () => {
      const pairs = allTargets.map((t, i) => ({ t, idx: indices[i] })).sort((a, b) => a.idx - b.idx);
      for (const { t, idx } of pairs) elements.splice(Math.min(idx, elements.length), 0, t);
      rebuild();
      markDirty();
    },
  });
  for (const t of allTargets) {
    const i = elements.indexOf(t);
    if (i >= 0) elements.splice(i, 1);
  }
  selectedIds.clear();
  rebuild();
  markDirty();

  paletteTarget = null;
  notifyAuthoringChange();
}

// ═══════════════════════════════════════════════════════════════════════════
// Slab / params
// ═══════════════════════════════════════════════════════════════════════════
function finishSlab() {
  if (poly.length >= 3) {
    void createElement("slab", { polygon: poly.map((p) => [snap(p.x), snap(p.z)] as Vec2) });
  }
  poly = [];
  clearPreviews();
  try { accuDraw.end(); } catch { /* */ }
}

function shiftParams(el: AuthoredElement, dx: number, dz: number) {
  if (el.params.start) el.params.start = [el.params.start[0] + dx, el.params.start[1] + dz];
  if (el.params.end) el.params.end = [el.params.end[0] + dx, el.params.end[1] + dz];
  if (el.params.point) el.params.point = [el.params.point[0] + dx, el.params.point[1] + dz];
  if (el.params.polygon) el.params.polygon = el.params.polygon.map(([x, z]) => [x + dx, z + dz] as Vec2);
}

function rotateElement(el: AuthoredElement, center: THREE.Vector3, angle: number) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const rotatePt = (x: number, z: number): Vec2 => {
    const dx = x - center.x;
    const dz = z - center.z;
    return [center.x + dx * c - dz * s, center.z + dx * s + dz * c];
  };
  if (el.params.start) el.params.start = rotatePt(el.params.start[0], el.params.start[1]);
  if (el.params.end) el.params.end = rotatePt(el.params.end[0], el.params.end[1]);
  if (el.params.point) el.params.point = rotatePt(el.params.point[0], el.params.point[1]);
  if (el.params.polygon) el.params.polygon = el.params.polygon.map(([x, z]) => rotatePt(x, z));
}

function mirrorElement(el: AuthoredElement, a: THREE.Vector3, b: THREE.Vector3) {
  const ax = a.x, az = a.z, bx = b.x, bz = b.z;
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return;
  const mirrorPt = (x: number, z: number): Vec2 => {
    const t = ((x - ax) * dx + (z - az) * dz) / len2;
    const projX = ax + t * dx;
    const projZ = az + t * dz;
    return [2 * projX - x, 2 * projZ - z];
  };
  if (el.params.start) el.params.start = mirrorPt(el.params.start[0], el.params.start[1]);
  if (el.params.end) el.params.end = mirrorPt(el.params.end[0], el.params.end[1]);
  if (el.params.point) el.params.point = mirrorPt(el.params.point[0], el.params.point[1]);
  if (el.params.polygon) el.params.polygon = el.params.polygon.map(([x, z]) => mirrorPt(x, z)).reverse();
}

// ═══════════════════════════════════════════════════════════════════════════
// Click dispatch — AccuDraw anchored on chain starts + auto-fittings
// ═══════════════════════════════════════════════════════════════════════════
function onDrawClick(pt: THREE.Vector3, e?: MouseEvent) {
  if (activeTool === "door" || activeTool === "window") {
    if (!e) return;
    const wall = wallAtPoint(e);
    if (!wall) return;
    const d = DEFAULTS[activeTool];
    const w = d.width ?? 0.9;
    const hostEl = elements.find((x) => x.id === wall.wallId);
    if (!hostEl?.params.start || !hostEl.params.end) return;
    const [ax, az] = hostEl.params.start;
    const [bx, bz] = hostEl.params.end;
    const L = Math.hypot(bx - ax, bz - az);
    const half = w / 2;
    const offset = Math.max(half, Math.min(L - half, wall.offset));

    void createElement(
      activeTool,
      {
        width: w,
        offsetAlongHost: snap(offset, 0.05),
        sillHeight: activeTool === "window" ? 0.9 : 0,
        frameThickness: activeTool === "window" ? 0.05 : 0.06,
        doorPanel: activeTool === "door" ? "swing" : undefined,
        windowPanel: activeTool === "window" ? "casement" : undefined,
      },
      undefined,
      wall.wallId,
    );
    return;
  }

  switch (activeTool) {
    case "wall":
    case "strip":
    case "beam":
    case "mline":
    case "duct":
    case "pipe":
    case "cable-tray":
    case "conduit": {
      if (!chainStart) {
        chainStart = pt.clone();
        chainStartDir = null;
        try { accuDraw.begin(chainStart); } catch { /* */ }
      } else {
        if (Math.hypot(pt.x - chainStart.x, pt.z - chainStart.z) >= 0.1) {
          const startPt = chainStart.clone();
          const endPt = pt.clone();
          const newDir = Math.atan2(endPt.z - startPt.z, endPt.x - startPt.x);

          // Auto-fitting at the bend, if the direction changed.
          if (chainStartDir !== null && FITTED_TYPES.has(activeTool as ElementType)) {
            const angleDelta = Math.abs(
              ((newDir - chainStartDir + Math.PI) % (2 * Math.PI)) - Math.PI,
            );
            if (angleDelta > 0.05) {
              const parent = elements[elements.length - 1];
              if (parent) {
                spawnFitting(
                  activeTool as ElementType,
                  parent,
                  startPt.x,
                  startPt.z,
                  chainStartDir,
                  newDir,
                );
              }
            }
          }

          void createElement(activeTool as ElementType, {
            start: [startPt.x, startPt.z],
            end: [endPt.x, endPt.z],
          });
          chainStartDir = newDir;
          chainStart = endPt.clone();
          try { accuDraw.begin(chainStart); } catch { /* */ }
        }
      }
      break;
    }
    case "brace":
      if (!chainStart) {
        chainStart = pt.clone();
        chainStartDir = null;
        try { accuDraw.begin(chainStart); } catch { /* */ }
      } else {
        if (Math.hypot(pt.x - chainStart.x, pt.z - chainStart.z) >= 0.1) {
          void createElement("brace", { start: [chainStart.x, chainStart.z], end: [pt.x, pt.z] });
          chainStart = null;
          chainStartDir = null;
          try { accuDraw.end(); } catch { /* */ }
        }
      }
      break;
    case "truss":
      if (!chainStart) {
        chainStart = pt.clone();
        chainStartDir = null;
        try { accuDraw.begin(chainStart); } catch { /* */ }
      } else {
        if (Math.hypot(pt.x - chainStart.x, pt.z - chainStart.z) >= 0.5) {
          void createElement(
            "truss",
            { start: [chainStart.x, chainStart.z], end: [pt.x, pt.z] },
            { panels: 4 },
          );
          chainStart = null;
          chainStartDir = null;
          try { accuDraw.end(); } catch { /* */ }
        }
      }
      break;
    case "slab":
      if (poly.length && pt.distanceTo(poly[0]) < 0.3) {
        finishSlab();
        return;
      }
      if (poly.length === 0) {
        try { accuDraw.begin(pt); } catch { /* */ }
      }
      poly.push(pt.clone());
      break;
    case "column":
      void createElement("column", { point: [pt.x, pt.z] });
      break;
    case "equipment":
      void createElement("equipment", { point: [pt.x, pt.z] });
      break;
    case "footing":
      void createElement("footing", { point: [pt.x, pt.z] });
      break;
    case "grid": {
      if (!chainStart) {
        chainStart = pt.clone();
        chainStartDir = null;
        try { accuDraw.begin(chainStart); } catch { /* */ }
      } else {
        if (Math.hypot(pt.x - chainStart.x, pt.z - chainStart.z) >= 0.5) {
          const letter = String.fromCharCode(65 + (gridIdx % 26));
          grids.push({ id: uid(), label: letter, start: [chainStart.x, chainStart.z], end: [pt.x, pt.z] });
          gridIdx++;
          chainStart = null;
          chainStartDir = null;
          try { accuDraw.end(); } catch { /* */ }
          rebuildDatums();
          markDirty();
        }
      }
      break;
    }
    case "level": {
      levelIdx++;
      levels.push({ id: uid(), name: `Level ${levelIdx}`, elevation: level });
      rebuildDatums();
      markDirty();
      setAuthoringTool(null);
      break;
    }
  }
  clearPreviews();
}

// ═══════════════════════════════════════════════════════════════════════════
// Operation dispatch
// ═══════════════════════════════════════════════════════════════════════════
function onModifyClick(pt: THREE.Vector3, e: MouseEvent) {
  switch (pendingOp.kind) {
    case "move-copy": {
      const op = pendingOp;
      if (!op.id) { op.id = elementAt(e); updateLabel(); return; }
      if (!op.base) { op.base = pt.clone(); updateLabel(); return; }
      const dx = snap(pt.x - op.base.x);
      const dz = snap(pt.z - op.base.z);
      const src = elements.find((x) => x.id === op.id);
      if (src?.properties?.pinned) {
        window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `${src.name} is pinned — unpin before moving or copying.`, kind: "info" } }));
        pendingOp = { kind: "move-copy", mode: op.mode, id: null, base: null };
        updateLabel();
        break;
      }
      if (src && (dx !== 0 || dz !== 0)) {
        if (op.mode === "copy") {
          const clone: AuthoredElement = JSON.parse(JSON.stringify(src));
          clone.id = uid();
          clone.name = `${src.name} (copy)`;
          if (clone.hostId) clone.hostId = undefined;
          shiftParams(clone, dx, dz);
          history.exec({
            label: `Copy ${src.name}`,
            apply: () => { elements.push(clone); rebuild(); markDirty(); },
            revert: () => { const i = elements.indexOf(clone); if (i >= 0) elements.splice(i, 1); rebuild(); markDirty(); },
          });
        } else {
          const snapshot = JSON.parse(JSON.stringify(src.params));
          shiftParams(src, dx, dz);
          const final = JSON.parse(JSON.stringify(src.params));
          history.push({
            label: `Move ${src.name}`,
            apply: () => { src.params = JSON.parse(JSON.stringify(final)); rebuild(); markDirty(); },
            revert: () => { src.params = JSON.parse(JSON.stringify(snapshot)); rebuild(); markDirty(); },
          });
          rebuild();
          markDirty();
        }
      }
      pendingOp = { kind: "move-copy", mode: op.mode, id: null, base: null };
      updateLabel();
      break;
    }
    case "rotate": {
      const op = pendingOp;
      if (!op.center) { op.center = pt.clone(); updateLabel(); return; }
      if (!op.ref) { op.ref = pt.clone(); updateLabel(); return; }
      const v0 = new THREE.Vector2(op.ref.x - op.center.x, op.ref.z - op.center.z);
      const v1 = new THREE.Vector2(pt.x - op.center.x, pt.z - op.center.z);
      const angle = Math.atan2(v1.y, v1.x) - Math.atan2(v0.y, v0.x);
      const targets = elements.filter((el) => op.ids.includes(el.id) && !el.properties?.pinned);
      const before = targets.map((t) => JSON.parse(JSON.stringify(t.params)));
      const after: any[] = [];
      for (const t of targets) rotateElement(t, op.center, angle);
      for (const t of targets) after.push(JSON.parse(JSON.stringify(t.params)));
      history.push({
        label: `Rotate ${targets.length} element(s)`,
        apply: () => { targets.forEach((t, i) => (t.params = JSON.parse(JSON.stringify(after[i])))); rebuild(); markDirty(); },
        revert: () => { targets.forEach((t, i) => (t.params = JSON.parse(JSON.stringify(before[i])))); rebuild(); markDirty(); },
      });
      rebuild();
      markDirty();
      pendingOp = { kind: "none" };
      updateLabel();
      break;
    }
    case "mirror": {
      const op = pendingOp;
      if (!op.axisA) { op.axisA = pt.clone(); updateLabel(); return; }
      if (!op.axisB) {
        op.axisB = pt.clone();
        const targets = elements.filter((el) => op.ids.includes(el.id) && !el.properties?.pinned);
        const clones: AuthoredElement[] = [];
        for (const t of targets) {
          const c: AuthoredElement = JSON.parse(JSON.stringify(t));
          c.id = uid();
          c.name = `${t.name} (mirror)`;
          if (c.hostId) c.hostId = undefined;
          mirrorElement(c, op.axisA, op.axisB);
          clones.push(c);
        }
        history.exec({
          label: `Mirror ${clones.length} element(s)`,
          apply: () => { for (const c of clones) elements.push(c); rebuild(); markDirty(); },
          revert: () => { for (const c of clones) { const i = elements.indexOf(c); if (i >= 0) elements.splice(i, 1); } rebuild(); markDirty(); },
        });
        pendingOp = { kind: "none" };
        updateLabel();
      }
      break;
    }
    case "array": {
      const op = pendingOp;
      if (!op.base) {
        op.base = pt.clone();
        const countStr = prompt("Array: number of copies?", "3");
        if (!countStr) { pendingOp = { kind: "none" }; updateLabel(); return; }
        const count = Math.max(1, parseInt(countStr, 10) || 1);
        const spacingStr = prompt("Spacing (m)?", "3.0");
        const spacing = parseFloat(spacingStr ?? "3") || 3;
        const dir = new THREE.Vector2(pt.x - op.base.x, pt.z - op.base.z);
        dir.normalize();
        const targets = elements.filter((el) => op.ids.includes(el.id) && !el.properties?.pinned);
        const clones: AuthoredElement[] = [];
        for (let i = 1; i <= count; i++) {
          const dx = dir.x * spacing * i;
          const dz = dir.y * spacing * i;
          for (const t of targets) {
            const c: AuthoredElement = JSON.parse(JSON.stringify(t));
            c.id = uid();
            c.name = `${t.name} (${i})`;
            if (c.hostId) c.hostId = undefined;
            shiftParams(c, dx, dz);
            clones.push(c);
          }
        }
        history.exec({
          label: `Array ${targets.length} element(s) × ${count}`,
          apply: () => { for (const c of clones) elements.push(c); rebuild(); markDirty(); },
          revert: () => { for (const c of clones) { const i = elements.indexOf(c); if (i >= 0) elements.splice(i, 1); } rebuild(); markDirty(); },
        });
        pendingOp = { kind: "none" };
        updateLabel();
      }
      break;
    }
    case "offset": {
      const op = pendingOp;
      if (!op.id) { op.id = elementAt(e); updateLabel(); return; }
      if (!op.base) {
        op.base = pt.clone();
        const src = elements.find((x) => x.id === op.id);
        if (!src || !src.params.start || !src.params.end) { pendingOp = { kind: "none" }; updateLabel(); return; }
        const [ax, az] = src.params.start;
        const [bx, bz] = src.params.end;
        const side = Math.sign((pt.x - ax) * (bz - az) - (pt.z - az) * (bx - ax));
        op.side = (side || 1) as 1 | -1;
        const distanceStr = prompt("Offset distance (m)?", "0.2");
        const distance = parseFloat(distanceStr ?? "0.2") || 0.2;
        const dxv = (bz - az) / Math.hypot(bx - ax, bz - az);
        const dzv = -(bx - ax) / Math.hypot(bx - ax, bz - az);
        const ddx = dxv * distance * (op.side ?? 1);
        const ddz = dzv * distance * (op.side ?? 1);
        const clone: AuthoredElement = JSON.parse(JSON.stringify(src));
        clone.id = uid();
        clone.name = `${src.name} (offset)`;
        if (clone.hostId) clone.hostId = undefined;
        shiftParams(clone, ddx, ddz);
        history.exec({
          label: `Offset ${src.name}`,
          apply: () => { elements.push(clone); rebuild(); markDirty(); },
          revert: () => { const i = elements.indexOf(clone); if (i >= 0) elements.splice(i, 1); rebuild(); markDirty(); },
        });
        pendingOp = { kind: "none" };
        updateLabel();
      }
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Previews + Revit-style dashed alignment guides
// ═══════════════════════════════════════════════════════════════════════════
const guideGroup = new THREE.Group();
guideGroup.name = "obs-alignment-guides";

function clearGuides() {
  while (guideGroup.children.length) {
    const c = guideGroup.children[0];
    guideGroup.remove(c);
    disposeObj(c);
  }
}

function clearPreviews() {
  for (const obj of [preview, polyLine, polyStartMarker]) {
    if (!obj) continue;
    previewGroup.remove(obj);
    disposeObj(obj);
  }
  preview = polyLine = polyStartMarker = null as any;
  hoveredWall = null;
  clearGuides();
}

/** Dashed construction line (Revit-style). */
function dashedLine(
  a: THREE.Vector3,
  b: THREE.Vector3,
  color: number,
  dashSize = 0.25,
  gapSize = 0.15,
): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineDashedMaterial({
    color,
    dashSize,
    gapSize,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
  });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = 999;
  return line;
}

/**
 * Revit-like alignment guides while drawing:
 *  - Orthogonal dashed tracks from start
 *  - Extension rays along the draft direction
 *  - Parallel / colinear guides from existing walls
 *  - Temporary dimension ticks + offset length line
 */
function updateAlignmentGuides(start: THREE.Vector3, end: THREE.Vector3) {
  clearGuides();
  const y = level + 0.02;
  const s = new THREE.Vector3(start.x, y, start.z);
  const e = new THREE.Vector3(end.x, y, end.z);
  const dx = e.x - s.x;
  const dz = e.z - s.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.01) return;

  const EXT = 40;
  const dir = new THREE.Vector3(dx / len, 0, dz / len);

  // Orthogonal tracks from start
  guideGroup.add(dashedLine(
    new THREE.Vector3(s.x - EXT, y, s.z),
    new THREE.Vector3(s.x + EXT, y, s.z),
    0x38bdf8, 0.3, 0.2,
  ));
  guideGroup.add(dashedLine(
    new THREE.Vector3(s.x, y, s.z - EXT),
    new THREE.Vector3(s.x, y, s.z + EXT),
    0x38bdf8, 0.3, 0.2,
  ));

  // Draft direction extension beyond segment
  guideGroup.add(dashedLine(e.clone(), e.clone().addScaledVector(dir, EXT), 0xa78bfa, 0.25, 0.18));
  guideGroup.add(dashedLine(s.clone(), s.clone().addScaledVector(dir, -EXT), 0xa78bfa, 0.25, 0.18));

  // Strong ortho lock feedback (~2°)
  const ang = Math.abs(Math.atan2(dz, dx));
  const orthoTol = 0.04;
  if (ang < orthoTol || Math.abs(ang - Math.PI) < orthoTol) {
    guideGroup.add(dashedLine(
      new THREE.Vector3(s.x - EXT, y, s.z),
      new THREE.Vector3(s.x + EXT, y, s.z),
      0x22d3ee, 0.5, 0.12,
    ));
  } else if (Math.abs(ang - Math.PI / 2) < orthoTol) {
    guideGroup.add(dashedLine(
      new THREE.Vector3(s.x, y, s.z - EXT),
      new THREE.Vector3(s.x, y, s.z + EXT),
      0x22d3ee, 0.5, 0.12,
    ));
  }

  // Align / extend from existing linear elements
  const alignTol = 0.15;
  const parTol = 0.06;
  for (const el of elements) {
    if (!el.params.start || !el.params.end) continue;
    if (!["wall", "beam", "strip", "duct", "pipe", "cable-tray", "conduit", "mline"].includes(el.type)) {
      continue;
    }
    const [ax, az] = el.params.start;
    const [bx, bz] = el.params.end;
    const elLen = Math.hypot(bx - ax, bz - az);
    if (elLen < 0.05) continue;
    const elDirX = (bx - ax) / elLen;
    const elDirZ = (bz - az) / elLen;

    // Parallel
    const cross = Math.abs(dir.x * elDirZ - dir.z * elDirX);
    if (cross < parTol) {
      const mid = new THREE.Vector3((ax + bx) / 2, y, (az + bz) / 2);
      const ed = new THREE.Vector3(elDirX, 0, elDirZ);
      guideGroup.add(dashedLine(
        mid.clone().addScaledVector(ed, -EXT),
        mid.clone().addScaledVector(ed, EXT),
        0xf472b6, 0.35, 0.2,
      ));
    }

    // Endpoint horizontal / vertical extensions + colinear pull
    for (const [px, pz] of [[ax, az], [bx, bz]] as [number, number][]) {
      if (Math.abs(e.z - pz) < alignTol) {
        guideGroup.add(dashedLine(
          new THREE.Vector3(px - EXT, y, pz),
          new THREE.Vector3(px + EXT, y, pz),
          0x34d399, 0.3, 0.15,
        ));
      }
      if (Math.abs(e.x - px) < alignTol) {
        guideGroup.add(dashedLine(
          new THREE.Vector3(px, y, pz - EXT),
          new THREE.Vector3(px, y, pz + EXT),
          0x34d399, 0.3, 0.15,
        ));
      }
      const toC = new THREE.Vector3(e.x - px, 0, e.z - pz);
      const along = toC.x * elDirX + toC.z * elDirZ;
      const perp = Math.abs(toC.x * elDirZ - toC.z * elDirX);
      if (perp < alignTol && Math.abs(along) > 0.05) {
        guideGroup.add(dashedLine(new THREE.Vector3(px, y, pz), e.clone(), 0xfbbf24, 0.22, 0.14));
      }
    }
  }

  // Temporary dimension ticks + offset length line
  const tick = 0.12;
  const nx = -dir.z, nz = dir.x;
  guideGroup.add(dashedLine(
    s.clone().add(new THREE.Vector3(nx * tick, 0, nz * tick)),
    s.clone().add(new THREE.Vector3(-nx * tick, 0, -nz * tick)),
    0xfacc15, 1, 0,
  ));
  guideGroup.add(dashedLine(
    e.clone().add(new THREE.Vector3(nx * tick, 0, nz * tick)),
    e.clone().add(new THREE.Vector3(-nx * tick, 0, -nz * tick)),
    0xfacc15, 1, 0,
  ));
  const off = 0.35;
  guideGroup.add(dashedLine(
    s.clone().add(new THREE.Vector3(nx * off, 0, nz * off)),
    e.clone().add(new THREE.Vector3(nx * off, 0, nz * off)),
    0xfacc15, 0.4, 0.15,
  ));
}

function updatePreview(e: MouseEvent | null) {
  clearPreviews();
  if (!activeTool) return;

  if (activeTool === "door" || activeTool === "window") {
    if (!e) return;
    const wall = wallAtPoint(e);
    if (!wall) { hoveredWall = null; return; }
    hoveredWall = wall;
    const hostEl = elements.find((x) => x.id === wall.wallId);
    if (!hostEl?.params.start || !hostEl.params.end) return;
    const [ax, az] = hostEl.params.start;
    const [bx, bz] = hostEl.params.end;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.1) return;
    const d = DEFAULTS[activeTool];
    const w = d.width ?? 0.9;
    const half = w / 2;
    const offset = Math.max(half, Math.min(L - half, wall.offset));

    const temp: AuthoredElement = {
      id: "preview", type: activeTool as ElementType, name: "", color: "#38bdf8",
      hostId: wall.wallId,
      params: {
        height: d.height, thickness: d.thickness, width: w,
        elevation: hostEl.params.elevation,
        offsetAlongHost: offset,
        sillHeight: activeTool === "window" ? 0.9 : 0,
        frameThickness: 0.05,
      },
    };
    const g = activeTool === "door" ? buildDoor(temp, hostEl) : buildWindow(temp, hostEl);
    if (g) {
      placeHostedElement(g, temp, hostEl);
      g.traverse((m: any) => {
        if (m.isMesh) {
          const mm = m.material as THREE.MeshLambertMaterial;
          if (mm?.color) mm.color.set("#38bdf8");
          if (mm) { (mm as any).transparent = true; (mm as any).opacity = 0.55; }
        }
      });
      preview = g;
      previewGroup.add(g);
    }
    return;
  }

  const pt = e ? groundPoint(e) : null;
  const pm = new THREE.MeshLambertMaterial({ color: "#38bdf8", transparent: true, opacity: 0.55 });

  if (
    pt && chainStart &&
    (activeTool === "wall" || activeTool === "beam" || activeTool === "strip" ||
      activeTool === "mline" || activeTool === "duct" || activeTool === "pipe" ||
      activeTool === "cable-tray" || activeTool === "conduit")
  ) {
    const d = DEFAULTS[activeTool];
    const a = chainStart;
    const len = Math.hypot(pt.x - a.x, pt.z - a.z);
    if (len > 0.05) {
      preview = new THREE.Mesh(new THREE.BoxGeometry(len, d.height, d.thickness), pm);
      preview.position.set((a.x + pt.x) / 2, level + d.height / 2, (a.z + pt.z) / 2);
      (preview as THREE.Mesh).rotation.y = Math.atan2(-(pt.z - a.z), pt.x - a.x);
      previewGroup.add(preview);
      // Revit-style dashed alignment / extension guides
      try { updateAlignmentGuides(a, pt); } catch { /* */ }
    }
  } else if (pt && activeTool === "brace" && chainStart) {
    const a = new THREE.Vector3(chainStart.x, level, chainStart.z);
    const b = new THREE.Vector3(pt.x, level + DEFAULTS.brace.height, pt.z);
    preview = memberMesh(a, b, DEFAULTS.brace.thickness, DEFAULTS.brace.thickness, pm);
    previewGroup.add(preview);
    try { updateAlignmentGuides(chainStart, pt); } catch { /* */ }
  } else if (pt && activeTool === "truss" && chainStart) {
    const tmp: AuthoredElement = {
      id: "preview", type: "truss", name: "", color: "#38bdf8",
      params: {
        start: [chainStart.x, chainStart.z], end: [pt.x, pt.z],
        height: DEFAULTS.truss.height, thickness: DEFAULTS.truss.thickness, elevation: level,
      },
    };
    preview = buildTruss(tmp);
    preview.traverse((m: any) => { if (m.isMesh) m.material = pm; });
    previewGroup.add(preview);
  } else if (activeTool === "slab") {
    const pts = [...poly, ...(pt ? [pt] : [])];
    if (pts.length >= 1) {
      const g = new THREE.BufferGeometry().setFromPoints(
        pts.map((p) => new THREE.Vector3(p.x, level + 0.01, p.z)),
      );
      polyLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x38bdf8 }));
      previewGroup.add(polyLine);
    }
    if (poly.length) {
      polyStartMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08),
        new THREE.MeshBasicMaterial({ color: 0xfacc15 }),
      );
      polyStartMarker.position.set(poly[0].x, level + 0.05, poly[0].z);
      previewGroup.add(polyStartMarker);
    }
  } else if (pt && (activeTool === "column" || activeTool === "footing")) {
    const d = DEFAULTS[activeTool];
    preview = new THREE.Mesh(new THREE.BoxGeometry(d.thickness, d.height, d.thickness), pm);
    const y = activeTool === "footing" ? level - d.height / 2 : level + d.height / 2;
    preview.position.set(pt.x, y, pt.z);
    previewGroup.add(preview);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Datums
// ═══════════════════════════════════════════════════════════════════════════
function makeLabelSprite(text: string, color = "#f59e0b"): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.strokeStyle = color; g.lineWidth = 6;
  g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke();
  g.fillStyle = color;
  g.font = "700 56px system-ui,sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  spr.scale.set(0.9, 0.9, 1);
  spr.renderOrder = 900;
  return spr;
}

function rebuildDatums() {
  while (datumGroup.children.length) {
    const ch = datumGroup.children[0];
    datumGroup.remove(ch);
    disposeObj(ch);
  }
  for (const gr of grids) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(gr.start[0], -5, gr.start[1]),
      new THREE.Vector3(gr.end[0], 15, gr.end[1]),
    ]);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0xf59e0b, dashSize: 0.4, gapSize: 0.25 }));
    line.computeLineDistances();
    datumGroup.add(line);
    const spr = makeLabelSprite(gr.label);
    spr.position.set(gr.end[0], 15.6, gr.end[1]);
    datumGroup.add(spr);
  }
  for (const lv of levels) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-25, lv.elevation, 0),
      new THREE.Vector3(25, lv.elevation, 0),
    ]);
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x22d3ee, dashSize: 0.5, gapSize: 0.25 }));
    line.computeLineDistances();
    datumGroup.add(line);
    const spr = makeLabelSprite(lv.name.replace(/[^0-9]/g, "") || "L", "#22d3ee");
    spr.position.set(25.8, lv.elevation, 0);
    datumGroup.add(spr);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Properties editor (inline, bottom-left of viewport) — kept for A/B use.
// ═══════════════════════════════════════════════════════════════════════════
const INP = "width:100%;box-sizing:border-box;padding:4px 6px;background:#12131a;border:1px solid #3a3a4a;border-radius:4px;color:#e2e8f0;font-size:11px";

const editor = document.createElement("div");
editor.style.cssText =
  "position:absolute;left:12px;bottom:12px;z-index:60;display:none;width:250px;background:#1a1b23;border:1px solid #3a3a4a;border-radius:8px;padding:10px;font:12px system-ui,sans-serif;color:#e2e8f0;box-shadow:0 8px 24px rgba(0,0,0,.5);max-height:70vh;overflow:auto";
editor.addEventListener("mousedown", (e) => e.stopPropagation());

function field(label: string, input: HTMLElement) {
  const w = document.createElement("label");
  w.style.cssText = "display:grid;gap:2px;margin-bottom:6px;font-size:10px;opacity:.85";
  w.append(label, input);
  return w;
}

function numInput(value: number, step: number, on: (v: number) => void) {
  const i = document.createElement("input");
  i.type = "number"; i.step = String(step); i.value = String(value);
  i.style.cssText = INP;
  i.onchange = () => on(Number(i.value) || 0);
  return i;
}

function historyNum(
  labelOrFn: string | (() => string),
  el: AuthoredElement,
  mutate: (v: number) => void,
  value: number,
  step: number,
) {
  const getLabel = () => (typeof labelOrFn === "function" ? labelOrFn() : String(labelOrFn));
  const coalesceKey = `edit-${el.id}-${getLabel()}`;
  return numInput(value, step, (v) => {
    const before = JSON.parse(JSON.stringify(el.params));
    const candidate: AuthoredElement = { ...el, params: JSON.parse(JSON.stringify(el.params)) };
    const originalParams = el.params;
    try {
      el.params = candidate.params;
      mutate(v);
      candidate.params = el.params;
    } finally {
      el.params = originalParams;
    }
    const diagnostics = validateNativeModel({
      elements: elements.map((item) => item.id === el.id ? candidate : item),
      levels,
      grids,
    }).filter((diagnostic) => diagnostic.elementId === el.id && diagnostic.severity === "error");
    if (diagnostics.length) {
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: {
          message: "Cannot apply " + getLabel() + " to " + el.name + ".\n" + diagnostics.map((d) => d.code + ": " + d.message).join("\n"),
          kind: "error",
        },
      }));
      return;
    }
    const after = JSON.parse(JSON.stringify(candidate.params));
    history.push(
      {
        label: `Edit ${el.name} · ${getLabel()}`,
        apply: () => { el.params = JSON.parse(JSON.stringify(after)); rebuild(); markDirty(); },
        revert: () => { el.params = JSON.parse(JSON.stringify(before)); rebuild(); markDirty(); },
      },
      coalesceKey,
    );
    el.params = JSON.parse(JSON.stringify(after));
    rebuild();
    markDirty();
  });
}

function selectInput<T extends string>(
  value: T,
  options: { v: T; label: string }[],
  on: (v: T) => void,
): HTMLSelectElement {
  const s = document.createElement("select");
  s.style.cssText = INP;
  s.innerHTML = options.map((o) => `<option value="${o.v}" ${o.v === value ? "selected" : ""}>${o.label}</option>`).join("");
  s.onchange = () => on(s.value as T);
  return s;
}

function refreshEditor() {
  if (selectedIds.size === 0 || activeTool !== "select") { editor.style.display = "none"; return; }
  editor.style.display = "block";
  editor.innerHTML = "";

  if (selectedIds.size > 1) {
    const t = document.createElement("div");
    t.textContent = `${selectedIds.size} elements selected`;
    t.style.cssText = "font-weight:700;margin-bottom:8px";
    editor.appendChild(t);
    const del = document.createElement("button");
    del.textContent = "🗑 Delete selection";
    del.style.cssText = "width:100%;padding:6px;background:#3b0d0d;color:#fca5a5;border:1px solid #ef4444;border-radius:5px;cursor:pointer;font-size:11px";
    del.onclick = () => deleteElements([...selectedIds]);
    editor.appendChild(del);
    return;
  }

  const el = elements.find((x) => selectedIds.has(x.id));
  if (!el) { editor.style.display = "none"; return; }

  const title = document.createElement("div");
  title.textContent = `${cap(el.type)} properties`;
  title.style.cssText = "font-weight:700;margin-bottom:8px";
  editor.appendChild(title);

  const name = document.createElement("input");
  name.value = el.name;
  name.style.cssText = INP;
  name.onchange = () => {
    const before = el.name;
    const after = name.value;
    history.push({
      label: `Rename ${before}`,
      apply: () => { el.name = after; markDirty(); },
      revert: () => { el.name = before; markDirty(); },
    });
    markDirty();
  };
  editor.appendChild(field("Name", name));

  const addNum = (
    label: string,
    key: "height" | "thickness" | "depth" | "width" | "sillHeight" | "frameThickness" | "offsetAlongHost",
    step: number,
  ) => {
    const val =
      key === "depth"
        ? (el.params.depth ?? el.params.thickness)
        : (el.params[key] as number | undefined) ?? 0;
    editor.appendChild(field(label, historyNum(() => label, el, (v) => { (el.params as any)[key] = v; }, val, step)));
  };

  switch (el.type) {
    case "wall": addNum("Height (m)", "height", 0.1); addNum("Thickness (m)", "thickness", 0.05); break;
    case "door":
    case "window":
      addNum("Width (m)", "width", 0.05);
      addNum("Height (m)", "height", 0.05);
      addNum("Sill height (m)", "sillHeight", 0.05);
      addNum("Frame thickness (m)", "frameThickness", 0.005);
      addNum("Offset along wall (m)", "offsetAlongHost", 0.05);
      if (el.type === "door") {
        editor.appendChild(field("Panel type", selectInput<DoorPanelType>(
          el.params.doorPanel ?? "swing",
          [
            { v: "swing", label: "Swing" }, { v: "double", label: "Double" },
            { v: "sliding", label: "Sliding" }, { v: "folding", label: "Folding" },
            { v: "pocket", label: "Pocket" },
          ],
          (v) => {
            const before = el.params.doorPanel;
            el.params.doorPanel = v;
            history.push({
              label: `Door type · ${el.name}`,
              apply: () => { el.params.doorPanel = v; rebuild(); markDirty(); },
              revert: () => { el.params.doorPanel = before; rebuild(); markDirty(); },
            });
            rebuild(); markDirty();
          },
        )));
      } else {
        editor.appendChild(field("Panel type", selectInput<WindowPanelType>(
          el.params.windowPanel ?? "casement",
          [
            { v: "fixed", label: "Fixed" }, { v: "casement", label: "Casement" },
            { v: "sliding", label: "Sliding" }, { v: "awning", label: "Awning" },
            { v: "double", label: "Double" },
          ],
          (v) => {
            const before = el.params.windowPanel;
            el.params.windowPanel = v;
            history.push({
              label: `Window type · ${el.name}`,
              apply: () => { el.params.windowPanel = v; rebuild(); markDirty(); },
              revert: () => { el.params.windowPanel = before; rebuild(); markDirty(); },
            });
            rebuild(); markDirty();
          },
        )));
      }
      break;
    case "beam": addNum("Section depth (m)", "height", 0.05); addNum("Section width (m)", "thickness", 0.05); break;
    case "brace": addNum("Rise (m)", "height", 0.1); addNum("Member size (m)", "thickness", 0.05); break;
    case "truss":
      addNum("Truss height (m)", "height", 0.1);
      addNum("Member size (m)", "thickness", 0.01);
      editor.appendChild(field("Panels", numInput(Number(el.properties?.panels ?? 4), 1, (v) => {
        const before = JSON.stringify(el.properties ?? {});
        el.properties = { ...el.properties, panels: Math.max(2, Math.round(v)) };
        const after = JSON.stringify(el.properties ?? {});
        history.push({
          label: `Edit ${el.name} · panels`,
          apply: () => { el.properties = JSON.parse(after); rebuild(); markDirty(); },
          revert: () => { el.properties = JSON.parse(before); rebuild(); markDirty(); },
        });
        rebuild(); markDirty();
      })));
      break;
    case "column":
    case "equipment":
      addNum("Height (m)", "height", 0.1); addNum("Width (m)", "thickness", 0.05); addNum("Depth (m)", "depth", 0.05);
      break;
    case "footing":
      addNum("Pad thickness (m)", "height", 0.05); addNum("Width (m)", "thickness", 0.05); addNum("Depth (m)", "depth", 0.05);
      break;
    case "strip": addNum("Height (m)", "height", 0.05); addNum("Width (m)", "thickness", 0.05); break;
    case "slab": addNum("Thickness (m)", "height", 0.05); break;
    case "fitting":
      addNum("Height (m)", "height", 0.05);
      addNum("Width/diameter (m)", "thickness", 0.05);
      break;
  }

  editor.appendChild(field("Elevation (m)", historyNum("elevation", el, (v) => (el.params.elevation = v), el.params.elevation, 0.1)));

  const color = document.createElement("input");
  color.type = "color";
  color.value = el.color ?? "#cccccc";
  color.style.cssText = "width:100%;height:26px;background:none;border:none;cursor:pointer";
  color.oninput = () => {
    const before = el.color;
    el.color = color.value;
    rebuild(); markDirty();
    history.push({
      label: `Recolor ${el.name}`,
      apply: () => { el.color = color.value; rebuild(); markDirty(); },
      revert: () => { el.color = before; rebuild(); markDirty(); },
    });
  };
  editor.appendChild(field("Color", color));

  if (el.hostId) {
    const host = elements.find((x) => x.id === el.hostId);
    if (host) {
      const hostInfo = document.createElement("div");
      hostInfo.style.cssText = "font-size:10px;opacity:.65;margin-bottom:6px";
      hostInfo.textContent = `Hosted on: ${host.name}`;
      editor.appendChild(hostInfo);
    }
  }

  const del = document.createElement("button");
  del.textContent = "🗑 Delete element";
  del.style.cssText = "width:100%;padding:6px;background:#3b0d0d;color:#fca5a5;border:1px solid #ef4444;border-radius:5px;cursor:pointer;font-size:11px";
  del.onclick = () => deleteElements([el.id]);
  editor.appendChild(del);
}

// ═══════════════════════════════════════════════════════════════════════════
// Labels / tool state
// ═══════════════════════════════════════════════════════════════════════════
export const activeToolLabel = document.createElement("div");
activeToolLabel.style.cssText = "font-size:11px;margin-top:6px;color:#facc15";

const TOOL_HINTS: Record<string, string> = {
  wall: "Wall: click points to chain · Enter ends chain · X/Z/Y to lock axis",
  strip: "Strip footing: click start → end",
  beam: "Beam: click start → end",
  mline: "Model line: click start → end",
  brace: "Brace: click start → end",
  truss: "Truss: click start → end",
  column: "Column: click a point",
  footing: "Isolated footing: click a point",
  slab: "Slab: click points · click first point or Enter to close",
  grid: "Grid: click start → end",
  level: "Level: click anywhere",
  door: "Door: click on a wall to insert",
  window: "Window: click on a wall to insert",
  duct: "Duct: click points to chain · bends get auto-fittings",
  pipe: "Pipe: click points to chain · bends get auto-fittings",
  "cable-tray": "Cable tray: click points to chain · bends get auto-fittings",
  conduit: "Conduit: click points to chain · bends get auto-fittings",
  move: "Move: select → base point → target point",
  copy: "Copy: select → base point → target point",
  rotate: "Rotate: select element(s), then center → reference → target",
  mirror: "Mirror: select element(s), then two points defining the mirror line",
  array: "Array: select element(s), then base point (prompts for count/spacing)",
  offset: "Offset: click a wall/line, then click the side to offset toward",
  select: "Select: click elements · Ctrl add · Shift toggle · Alt remove · drag grips to reshape",
};

function updateLabel() {
  let suffix = "";
  switch (pendingOp.kind) {
    case "move-copy":
      if (!pendingOp.id) suffix = " — click an element";
      else if (!pendingOp.base) suffix = " — click base point";
      else suffix = " — click target point";
      break;
    case "rotate":
      if (!pendingOp.center) suffix = " — click center point";
      else if (!pendingOp.ref) suffix = " — click reference point";
      else suffix = " — click target angle";
      break;
    case "mirror":
      if (!pendingOp.axisA) suffix = " — click mirror line start";
      else if (!pendingOp.axisB) suffix = " — click mirror line end";
      break;
    case "array":
      if (!pendingOp.base) suffix = " — click base point";
      break;
    case "offset":
      if (!pendingOp.id) suffix = " — click a wall/line";
      else if (!pendingOp.base) suffix = " — click offset side";
      break;
  }
  activeToolLabel.textContent = `Active Tool: ${activeTool ? cap(activeTool) : "None"}${activeTool && TOOL_HINTS[activeTool] ? ` · ${TOOL_HINTS[activeTool]}${suffix}` : ""}`;
}

export function isDrawingActive() { return activeTool !== null && activeTool !== "select"; }

/**
 * Activate a modeling tool. Accepts internal Tool names or ribbon aliases
 * (e.g. "outlet", "sprinkler", "pile") which map via TOOL_ALIASES.
 */
export function setAuthoringTool(tool: Tool | string | null) {
  if (tool === null) {
    activePreset = null;
    activeTool = null;
  } else {
    const key = String(tool);
    activePreset = TOOL_ALIASES[key] ? key : (key in DEFAULTS ? key : null);
    const mapped = (TOOL_ALIASES[key] ?? key) as Tool;
    activeTool = mapped;
    // Remember for Space-bar repeat (skip pure select)
    if (mapped !== "select") {
      lastCommand = activePreset || mapped;
    }
  }

  chainStart = null;
  chainStartDir = null;
  poly = [];
  pendingOp = { kind: "none" };
  clearPreviews();
  snapping.hideIndicator();

  try { accuDraw.end(); } catch { /* */ }

  ctx.highlighter.enabled = activeTool === null || activeTool === "select";

  if (activeTool && activeTool !== "select") {
    setMeasureEnabled(false);
    setSectionOn(false);
  }
  if (activeTool !== "select") selectedIds.clear();
  if (activeTool === "select" || activeTool === null) {
    try { accuDraw.end(); } catch { /* */ }
  }

  const t = activeTool;
  if (t === "move" || t === "copy") {
    pendingOp = { kind: "move-copy", mode: t as "move" | "copy", id: null, base: null };
  } else if (t === "rotate") {
    pendingOp = { kind: "rotate", ids: [...selectedIds], center: null, ref: null };
  } else if (t === "mirror") {
    pendingOp = { kind: "mirror", ids: [...selectedIds], axisA: null, axisB: null };
  } else if (t === "array") {
    pendingOp = { kind: "array", ids: [...selectedIds], mode: "linear", base: null };
  } else if (t === "offset") {
    pendingOp = { kind: "offset", id: null, base: null, side: null };
  }

  // Palette sync.
  if (t && DRAW_TOOLS.has(t)) {
    paletteTarget = { mode: "defaults", type: t as ElementType };
  } else if (t === "select") {
    const ids = [...selectedIds];
    if (ids.length === 1) {
      const el = elements.find((e) => e.id === ids[0]);
      paletteTarget = el ? { mode: "edit", elementId: el.id, type: el.type } : null;
    } else {
      paletteTarget = null;
    }
  } else {
    paletteTarget = null;
  }

  applySelection();
  refreshGrips();
  updateLabel();
  notifyAuthoringChange();
}

export function getActiveTool() { return activeTool; }
export function setLevel(v: number) {
  level = v;
  // Revit-style: if a named level exists at this elevation, adopt it.
  const hit = levels.find((l) => Math.abs(l.elevation - v) <= 0.001);
  if (hit) activeLevelId = hit.id;
}
export function getLevel() { return level; }

/** Revit-style active level id. Null when no named level is selected. */
export function getActiveLevelId(): string | null { return activeLevelId; }

/** Activate a named level; also moves the numeric draw elevation to match. */
export function setActiveLevelById(id: string | null): void {
  if (!id) { activeLevelId = null; return; }
  const hit = levels.find((l) => l.id === id);
  if (!hit) return;
  activeLevelId = hit.id;
  level = hit.elevation;
}

// openbim-families:instance-wiring
/** Revit-style active family id. Null when no family is selected. */
export function getActiveFamilyId(): string | null { return activeFamilyId; }

/** Revit-style active family type id. Null when no type is selected. */
export function getActiveFamilyTypeId(): string | null { return activeFamilyTypeId; }

/** Revit-style: the family/type the NEXT placed element will adopt. */
export function setActiveFamily(familyId: string | null, familyTypeId: string | null): void {
  activeFamilyId = familyId;
  activeFamilyTypeId = familyTypeId;
}

/**
 * Re-resolve every instance of `familyId` (optionally restricted to one
 * type) from its family definition, propagating changed dimension
 * parameters. Placement coordinates, elevation, x/z, hostId are never
 * touched -- only the parametric size fields are synced.
 *
 * Returns the number of instances whose params actually changed.
 */
export function syncFamilyInstances(
  familyId: string,
  familyTypeId: string | null,
): number {
  const familyService: any = (ctx.features as any).family;
  if (!familyService) return 0;
  const def = familyService.get?.(familyId);
  if (!def) return 0;

  const targets = elements.filter((el) => {
    if (el.familyId !== familyId) return false;
    if (familyTypeId === null) return true;
    return el.familyTypeId === familyTypeId;
  });
  if (!targets.length) return 0;

  let changed = 0;
  for (const el of targets) {
    const resolved = familyService.resolveParams(
      familyId,
      el.familyTypeId ?? familyTypeId,
      undefined,
    ) as Record<string, any> | null;
    if (!resolved) continue;

    const before = JSON.stringify(el.params);
    // Only adopt the well-known dimensional keys. A family could expose
    // arbitrary parameters; we do not blindly overwrite the element.
    if (typeof resolved.thickness === "number") el.params.thickness = resolved.thickness;
    if (typeof resolved.height === "number")    el.params.height    = resolved.height;
    if (typeof resolved.width === "number")     el.params.width     = resolved.width;
    if (typeof resolved.depth === "number")     el.params.depth     = resolved.depth;
    if (typeof resolved.sillHeight === "number") el.params.sillHeight = resolved.sillHeight;
    if (typeof resolved.frameThickness === "number") el.params.frameThickness = resolved.frameThickness;
    if (before !== JSON.stringify(el.params)) changed++;
  }

  if (changed > 0) {
    rebuild();
    markDirty();
    notifyAuthoringChange();
  }
  return changed;
}
export function getElementCount() { return elements.length; }
export function getElements() { return elements; }

/** Expose the authored-elements THREE.Group for push/pull raycasting. */
export function getAuthoredGroup(): THREE.Group { return group; }
export function getSelectedIds(): string[] { return [...selectedIds]; }

function nativeElementTypeFromIfc(entity: string): ElementType {
  const e = String(entity || "").toLowerCase();
  if (e.includes("wall")) return "wall";
  if (e.includes("slab")) return "slab";
  if (e.includes("column")) return "column";
  if (e.includes("beam") || e.includes("member")) return "beam";
  if (e.includes("brace")) return "brace";
  if (e.includes("truss")) return "truss";
  if (e.includes("footing") || e.includes("pile")) return "footing";
  if (e.includes("door")) return "door";
  if (e.includes("window")) return "window";
  if (e.includes("roof")) return "roof";
  if (e.includes("ceiling")) return "ceiling";
  if (e.includes("stair")) return "stairs";
  if (e.includes("railing")) return "railing";
  if (e.includes("ramp")) return "ramp";
  if (e.includes("duct")) return "duct";
  if (e.includes("pipe")) return "pipe";
  if (e.includes("cable") && e.includes("tray")) return "cable-tray";
  if (e.includes("conduit")) return "conduit";
  if (e.includes("fitting") || e.includes("elbow") || e.includes("segment")) return "fitting";
  return "generic";
}

/** Create a persistent project object from an IFC/FRAG object's exact geometry. */
export function addNativeGeometryElement(input: {
  name: string;
  entity: string;
  globalId?: string;
  sourceGlobalId?: string;
  predefinedType?: string;
  tag?: string;
  description?: string;
  sourceModelId?: string;
  sourceLocalId?: number;
  sourceModelName?: string;
  propertySets?: Record<string, unknown>;
  quantities?: Record<string, unknown>;
  positions: number[];
  color?: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  dimensions?: { width: number; height: number; depth: number };
}): AuthoredElement {
  const id = uid();
  const type = nativeElementTypeFromIfc(input.entity);
  const pos = input.position;
  const el: AuthoredElement = {
    id, type,
    name: input.name || `${type} native twin`,
    color: input.color,
    params: {
      point: [pos[0], pos[2]],
      height: input.dimensions?.height ?? 0,
      thickness: input.dimensions?.depth ?? 0,
      elevation: pos[1],
      width: input.dimensions?.width,
      depth: input.dimensions?.depth,
    },
    properties: {
      nativeTwin: true,
      sourceModelId: input.sourceModelId,
      sourceLocalId: input.sourceLocalId,
      sourceGlobalId: input.sourceGlobalId || input.globalId,
      sourceModelName: input.sourceModelName,
      editable: true,
      pinned: false,
    },
    nativeGeometry: { positions: [...input.positions] },
    ifc: {
      entity: input.entity || "IfcBuildingElementProxy",
      globalId: input.globalId,
      sourceGlobalId: input.sourceGlobalId || input.globalId,
      predefinedType: input.predefinedType,
      tag: input.tag,
      description: input.description,
      sourceModelId: input.sourceModelId,
      sourceLocalId: input.sourceLocalId,
      sourceModelName: input.sourceModelName,
      propertySets: input.propertySets,
      quantities: input.quantities,
    },
    transform: { position: [...input.position], quaternion: [...input.quaternion], scale: [...input.scale] },
  };
  elements.push(el);
  rebuild();
  markDirty();
  notifyAuthoringChange();
  return el;
}

/** Update a reconstructed object's transform without rebuilding the complete scene. */
export function updateNativeGeometryElement(
  id: string,
  transform: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] },
  rebuildScene = false,
): boolean {
  const el = getElementById(id);
  if (!el?.nativeGeometry) return false;
  el.transform = {
    position: [...transform.position],
    quaternion: [...transform.quaternion],
    scale: [...transform.scale],
  };
  el.params.elevation = transform.position[1];
  if (!rebuildScene) {
    group.traverse((obj: any) => {
      if (obj?.isMesh && obj.userData?.elementId === id) {
        obj.position.set(...transform.position);
        obj.quaternion.set(...transform.quaternion);
        obj.scale.set(...transform.scale);
        obj.updateMatrixWorld(true);
      }
    });
    markDirty();
  } else {
    rebuild();
    markDirty();
    notifyAuthoringChange();
  }
  return true;
}

export function removeElementById(id: string): boolean {
  const idx = elements.findIndex((el) => el.id === id);
  if (idx < 0) return false;
  elements.splice(idx, 1);
  selectedIds.delete(id);
  rebuild();
  markDirty();
  notifyAuthoringChange();
  return true;
}

export function getElementById(id: string): AuthoredElement | null {
  return elements.find((el) => el.id === id) ?? null;
}

export function isElementPinned(id: string): boolean {
  const el = getElementById(id);
  return !!el?.properties?.pinned;
}

export function pinSelected(pinned = true): number {
  let changed = 0;
  const targets = elements.filter((el) => selectedIds.has(el.id));
  if (!targets.length) return 0;
  const before = targets.map((el) => JSON.parse(JSON.stringify(el.properties ?? {})));
  for (const el of targets) {
    const next = { ...(el.properties ?? {}) };
    if (!!next.pinned === pinned) continue;
    next.pinned = pinned;
    el.properties = next;
    changed += 1;
  }
  if (!changed) return 0;
  const after = targets.map((el) => JSON.parse(JSON.stringify(el.properties ?? {})));
  history.push({
    label: `${pinned ? "Pin" : "Unpin"} ${changed} element(s)`,
    apply: () => { targets.forEach((el, i) => { el.properties = JSON.parse(JSON.stringify(after[i])); }); markDirty(); notifyAuthoringChange(); },
    revert: () => { targets.forEach((el, i) => { el.properties = JSON.parse(JSON.stringify(before[i])); }); markDirty(); notifyAuthoringChange(); },
  });
  markDirty();
  notifyAuthoringChange();
  return changed;
}

export function createSimilarFromSelection(): string | null {
  const id = [...selectedIds][0];
  const el = id ? getElementById(id) : null;
  if (!el) return null;
  const type = el.type === "fitting" ? (el.params.parentType ?? "equipment") :
    (el.type === "room" || el.type === "area" || el.type === "stairs" || el.type === "railing" || el.type === "ramp" || el.type === "curtain-wall" || el.type === "generic" ? "equipment" : el.type);
  setAuthoringTool(type);
  return type;
}

export function joinSelectedWalls(): number {
  const walls = elements.filter((el) => selectedIds.has(el.id) && el.type === "wall" && !el.properties?.pinned);
  if (!walls.length) return 0;
  let changed = 0;
  for (const wall of walls) {
    const before = JSON.stringify(wall.params);
    autoJoinWallToNeighbors(wall.id);
    if (before !== JSON.stringify(wall.params)) changed += 1;
  }
  if (changed) {
    markDirty();
    notifyAuthoringChange();
  }
  return changed;
}

export function splitSelectedAtMidpoint(): number {
  const lineTypes = new Set<ElementType>([
    "wall", "beam", "brace", "duct", "pipe", "cable-tray", "conduit", "mline"
  ]);
  const targets = elements.filter((el) => selectedIds.has(el.id) && !el.properties?.pinned && lineTypes.has(el.type) && el.params.start && el.params.end);
  if (!targets.length) return 0;

  const clones: AuthoredElement[] = [];
  const originals = targets.map((el) => ({ el, params: JSON.parse(JSON.stringify(el.params)) }));
  for (const el of targets) {
    const [sx, sz] = el.params.start!;
    const [ex, ez] = el.params.end!;
    const mid: Vec2 = [(sx + ex) / 2, (sz + ez) / 2];
    el.params.end = mid;
    const clone: AuthoredElement = {
      ...JSON.parse(JSON.stringify(el)),
      id: uid(),
      name: `${el.name} B`,
      params: { ...JSON.parse(JSON.stringify(el.params)), start: mid, end: [ex, ez] },
      properties: { ...(el.properties ?? {}), splitFrom: el.id },
    };
    clones.push(clone);
  }
  const splitParams = targets.map((el) => JSON.parse(JSON.stringify(el.params)));
  elements.push(...clones);
  rebuild();
  history.push({
    label: `Split ${targets.length} element(s)`,
    apply: () => {
      originals.forEach(({ el }, i) => { el.params = JSON.parse(JSON.stringify(splitParams[i])); });
      for (const c of clones) if (!elements.includes(c)) elements.push(c);
      rebuild(); markDirty();
    },
    revert: () => {
      for (const c of clones) {
        const idx = elements.findIndex((x) => x.id === c.id);
        if (idx >= 0) elements.splice(idx, 1);
      }
      originals.forEach(({ el, params }) => { el.params = JSON.parse(JSON.stringify(params)); });
      rebuild(); markDirty();
    },
  });
  markDirty();
  notifyAuthoringChange();
  return targets.length;
}

export function alignSelectedAxis(axis: "x" | "z"): number {
  const targets = elements.filter((el) => selectedIds.has(el.id) && !el.properties?.pinned);
  if (targets.length < 2) return 0;
  const coord = (el: AuthoredElement): number => {
    if (el.params.point) return axis === "x" ? el.params.point[0] : el.params.point[1];
    if (el.params.start && el.params.end) return axis === "x" ? (el.params.start[0] + el.params.end[0]) / 2 : (el.params.start[1] + el.params.end[1]) / 2;
    return 0;
  };
  const target = coord(targets[0]);
  transformElements(targets.map((el) => el.id), (el) => {
    if (el.params.point) {
      if (axis === "x") el.params.point[0] = target; else el.params.point[1] = target;
    }
    if (el.params.start && el.params.end) {
      const delta = target - coord(el);
      if (axis === "x") { el.params.start[0] += delta; el.params.end[0] += delta; }
      else { el.params.start[1] += delta; el.params.end[1] += delta; }
    }
  });
  return targets.length - 1;
}

export function deleteSelectedElement() { deleteElements([...selectedIds]); }

/**
 * Bulk-select authored elements by id, replacing the current authored
 * selection. Pass an empty array to clear the authored selection.
 *
 * Used by select-all.ts to combine fragment + authored selection.
 */
export function selectAllAuthored(ids: string[]): void {
  selectedIds.clear();
  for (const id of ids) selectedIds.add(id);
  applySelection();
  refreshGrips();
  updateLabel();
  // Sync the property palette.
  if (selectedIds.size === 1) {
    const el = elements.find((e) => e.id === [...selectedIds][0]);
    paletteTarget = el ? { mode: "edit", elementId: el.id, type: el.type } : null;
  } else {
    paletteTarget = null;
  }
  notifyAuthoringChange();
}

export function clearAllElements(force = false) {
  if (!elements.length) return;
  if (!force && !confirm(`Delete all ${elements.length} authored objects?`)) return;
  const snapshot = JSON.parse(JSON.stringify(elements));
  history.exec({
    label: `Clear all ${elements.length} elements`,
    apply: () => {
      elements.length = 0;
      selectedIds.clear();
      for (const k of Object.keys(counters)) delete counters[k];
      rebuild(); markDirty();
      paletteTarget = null;
      notifyAuthoringChange();
    },
    revert: () => {
      elements.length = 0;
      for (const el of snapshot) elements.push(el);
      for (const el of elements) {
        const n = parseInt(el.name.split(" ").pop() ?? "0", 10);
        if (Number.isFinite(n)) counters[el.type] = Math.max(counters[el.type] ?? 0, n);
      }
      rebuild(); markDirty();
    },
  });
}

export function clearDatums() {
  grids = []; levels = []; gridIdx = 0; levelIdx = 0;
  rebuildDatums(); markDirty();
}

export function getGrids() { return grids; }
export function setGrids(list: GridDatum[] | undefined | null) {
  grids = Array.isArray(list) ? list : [];
  gridIdx = grids.length;
  rebuildDatums();
}
export function getLevels() { return levels; }
export function setLevels(list: LevelDatum[] | undefined | null) {
  levels = Array.isArray(list) ? list : [];
  levelIdx = levels.length;
  rebuildDatums();
}

export function setElements(list: AuthoredElement[]) {
  elements.length = 0;
  for (const el of list) elements.push(el);
  for (const k of Object.keys(counters)) delete counters[k];
  for (const el of elements) {
    const n = parseInt(el.name.split(" ").pop() ?? "0", 10);
    if (Number.isFinite(n)) counters[el.type] = Math.max(counters[el.type] ?? 0, n);
  }
  selectedIds.clear();
  rebuild();
  paletteTarget = null;
  notifyAuthoringChange();
}
export function clearElements() { setElements([]); }
/**
 * Bulk-select authored elements with explicit mode control.
 * Used by box-selection.ts to combine a rubber band with the current
 * selection (add / remove / replace).
 */
/** Return the authored element id under the supplied viewport pointer, without changing selection. */
export function pickAuthoredElementAt(e: MouseEvent): string | null {
  return elementAt(e);
}

export function setSelectedAuthored(
  ids: string[],
  mode: "replace" | "add" | "remove" = "replace",
): void {
  if (mode === "replace") {
    selectedIds.clear();
    for (const id of ids) selectedIds.add(id);
  } else if (mode === "add") {
    for (const id of ids) selectedIds.add(id);
  } else {
    for (const id of ids) selectedIds.delete(id);
  }
  applySelection();
  refreshGrips();
  updateLabel();
  if (selectedIds.size === 1) {
    const el = elements.find((e) => e.id === [...selectedIds][0]);
    paletteTarget = el ? { mode: "edit", elementId: el.id, type: el.type } : null;
  } else {
    paletteTarget = null;
  }
  notifyAuthoringChange();
}

/**
 * Compute the world-space AABB of one authored element.
 * Builds a temporary mesh, measures it, then disposes it — no scene
 * mutation. Used by box-selection.ts during rubber-band queries.
 */
export function getElementWorldBox(el: AuthoredElement): THREE.Box3 | null {
  let mesh: THREE.Object3D | null = null;
  try {
    mesh = createMesh(el);
  } catch {
    mesh = null;
  }
  if (!mesh) return null;
  const box = new THREE.Box3().setFromObject(mesh);
  disposeObj(mesh);
  return box.isEmpty() ? null : box;
}
export function rebuildAuthored(): void { rebuild(); markDirty(); }

/**
 * Place a linear authored element from plan coordinates (Floor Plan modeling).
 * Used by Plan View Wall tool — draw in plan → creates 3D wall.
 */
export async function addLinearElement(
  type: "wall" | "beam" | "strip" | "duct" | "pipe" | "cable-tray" | "conduit" | "mline",
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  elev?: number,
  size?: { thickness?: number; height?: number },
): Promise<void> {
  if (elev != null) level = elev;
  const d = DEFAULTS[type] ?? { height: 3, thickness: 0.2 };
  const thick = size?.thickness ?? d.thickness;
  const height = size?.height ?? d.height;
  let sx = x1, sz = z1, ex = x2, ez = z2;
  const props: Record<string, unknown> = type === "wall"
    ? {
        locationLine: wallLocationLine,
        joinStatus: wallJoinStatus,
        chain: wallChain,
        offset: wallOffset,
      }
    : {};
  // Location-line offset is wall-only. MEP runs stay on the drawn centerline.
  if (type === "wall") {
    const off = applyWallLocationOffset(x1, z1, x2, z2, thick);
    sx = off.start[0]; sz = off.start[1];
    ex = off.end[0]; ez = off.end[1];
  }
  const dir = Math.atan2(ez - sz, ex - sx);
  let bendInfo: {
    parent: AuthoredElement;
    originalEnd: [number, number];
    trimmedEnd: [number, number];
    bendX: number;
    bendZ: number;
    angleIn: number;
    angleOut: number;
    bendRadius: number;
  } | null = null;

  // Auto MEP fitting at chain bend. The linear runs terminate exactly at the
  // fitting connection planes so the duct/pipe/tray/conduit never penetrates
  // the elbow. The same connection sequence is used for every fitted MEP type.
  if (FITTED_TYPES.has(type as ElementType) && lastPlanLinear && lastPlanLinear.type === type) {
    const dEnd = Math.hypot(sx - lastPlanLinear.end[0], sz - lastPlanLinear.end[1]);
    if (dEnd < 0.15) {
      const angDiff = ((dir - lastPlanLinear.dir + Math.PI) % (2 * Math.PI)) - Math.PI;
      if (Math.abs(angDiff) > 0.15 && Math.abs(Math.abs(angDiff) - Math.PI) > 0.15) {
        const parent = elements.find((e) => e.id === lastPlanLinear!.id) ?? null;
        if (parent?.params?.start && parent.params.end) {
          const prevLen = Math.hypot(
            lastPlanLinear.end[0] - parent.params.start[0],
            lastPlanLinear.end[1] - parent.params.start[1],
          );
          const nextLen = Math.hypot(ex - sx, ez - sz);
          const baseRadius = Math.max(0.04, Math.max(thick, height) / 2);
          // Keep enough straight run on both sides of the fitting.
          const bendRadius = Math.max(0.025, Math.min(baseRadius, prevLen * 0.42, nextLen * 0.42));
          const bendX = lastPlanLinear.end[0];
          const bendZ = lastPlanLinear.end[1];
          const inX = bendX - Math.cos(lastPlanLinear.dir) * bendRadius;
          const inZ = bendZ - Math.sin(lastPlanLinear.dir) * bendRadius;
          const outX = bendX + Math.cos(dir) * bendRadius;
          const outZ = bendZ + Math.sin(dir) * bendRadius;

          // Trim the previous run back to the elbow's inlet connection.
          // The mutation is committed atomically with the fitting + new run below.
          const originalEnd: [number, number] = [parent.params.end[0], parent.params.end[1]];
          const trimmedEnd: [number, number] = [inX, inZ];
          parent.params.end = trimmedEnd;
          sx = outX;
          sz = outZ;
          bendInfo = {
            parent, originalEnd, trimmedEnd, bendX, bendZ,
            angleIn: lastPlanLinear.dir, angleOut: dir, bendRadius,
          };
        }
      }
    }
  }

  // Tee: new run starts on an existing MEP segment mid-point
  if (FITTED_TYPES.has(type as ElementType)) {
    for (const el of elements) {
      if (el.type !== type || !el.params.start || !el.params.end) continue;
      const [ax, az] = el.params.start;
      const [bx, bz] = el.params.end;
      const dx = bx - ax, dz = bz - az;
      const L2 = dx * dx + dz * dz || 1;
      let t = ((sx - ax) * dx + (sz - az) * dz) / L2;
      if (t > 0.12 && t < 0.88) {
        const px = ax + t * dx, pz = az + t * dz;
        if (Math.hypot(sx - px, sz - pz) < Math.max(0.2, thick)) {
          const hostDir = Math.atan2(dz, dx);
          spawnFitting(
            type as ElementType,
            el,
            px, pz,
            hostDir,
            dir,
            "tee",
            { thickness: thick, height, elevation: level },
          );
          break;
        }
      }
    }
  }

  // Chain: snap NEW wall start to previous end only — previous wall stays fixed
  if (lastPlanLinear && lastPlanLinear.type === type && wallChain) {
    const dEnd = Math.hypot(sx - lastPlanLinear.end[0], sz - lastPlanLinear.end[1]);
    if (dEnd < 0.35) {
      sx = lastPlanLinear.end[0];
      sz = lastPlanLinear.end[1];
      // Do NOT mutate previous element endpoints (that skewed existing walls)
    }
  }

  // End-point snap onto any existing wall centerline / end (new wall only)
  if (type === "wall") {
    const endTol = Math.max(0.12, thick * 0.85);
    const faceTol = Math.max(0.14, thick * 0.95);
    const snapPt = (px: number, pz: number): [number, number] => {
      let best: { x: number; z: number; d: number } | null = null;
      for (const other of elements) {
        if (other.type !== "wall" || !other.params.start || !other.params.end) continue;
        const [ax, az] = other.params.start;
        const [bx, bz] = other.params.end;
        for (const ep of [[ax, az], [bx, bz]] as [number, number][]) {
          const d = Math.hypot(px - ep[0], pz - ep[1]);
          if (d <= endTol && (!best || d < best.d)) best = { x: ep[0], z: ep[1], d };
        }
        const proj = projectOntoSegment(px, pz, ax, az, bx, bz);
        if (proj.t > 0.02 && proj.t < 0.98 && proj.dist <= faceTol) {
          if (!best || proj.dist < best.d) best = { x: proj.x, z: proj.z, d: proj.dist };
        }
      }
      return best ? [best.x, best.z] : [px, pz];
    };
    [sx, sz] = snapPt(sx, sz);
    [ex, ez] = snapPt(ex, ez);
  }

  let el: AuthoredElement | null = null;
  if (bendInfo) {
    await history.transaction(`Create ${cap(type)} with connected elbow`, async () => {
      history.push({
        label: `Trim ${cap(type)} to fitting`,
        apply: () => { bendInfo!.parent.params.end = [...bendInfo!.trimmedEnd]; rebuild(); markDirty(); },
        revert: () => { bendInfo!.parent.params.end = [...bendInfo!.originalEnd]; rebuild(); markDirty(); },
      });
      spawnFitting(
        type as ElementType,
        bendInfo.parent,
        bendInfo.bendX,
        bendInfo.bendZ,
        bendInfo.angleIn,
        bendInfo.angleOut,
        "elbow",
        { thickness: thick, height, elevation: level, bendRadius: bendInfo.bendRadius },
      );
      el = await createElement(type as any, {
        start: [sx, sz],
        end: [ex, ez],
        height,
        thickness: thick,
        elevation: level,
      }, props);
    });
  } else {
    el = await createElement(type as any, {
      start: [sx, sz],
      end: [ex, ez],
      height,
      thickness: thick,
      elevation: level,
    }, props);
  }

  if (!el) return;

  if (type === "wall" && wallJoinStatus !== "disallow") {
    try { autoJoinWallToNeighbors(el.id); } catch { /* */ }
  }

  lastPlanLinear = {
    type,
    end: [ex, ez],
    dir,
    thickness: thick,
    height,
    elevation: level,
    id: el.id,
  };

  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", {
        detail: { message: `${type} placed` + (FITTED_TYPES.has(type as ElementType) ? " (+ fittings)" : ""), kind: "success" },
      }),
    );
  } catch { /* */ }
}

/** Place a standalone IFC-style fitting (elbow, tee, cross…). */
export async function addFittingElement(
  parentType: "duct" | "pipe" | "cable-tray" | "conduit",
  kind: FittingKind,
  x: number,
  z: number,
  elev?: number,
  size?: { thickness?: number; height?: number },
): Promise<void> {
  if (elev != null) level = elev;
  const d = DEFAULTS[parentType] ?? { height: 0.3, thickness: 0.3 };
  spawnFitting(
    parentType as ElementType,
    null,
    x, z,
    0,
    Math.PI / 2,
    kind,
    {
      thickness: size?.thickness ?? d.thickness,
      height: size?.height ?? d.height,
      elevation: level,
    },
  );
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", {
        detail: { message: `${parentType} ${kind} placed`, kind: "success" },
      }),
    );
  } catch { /* */ }
}


/** Place a point element from plan (column, footing, equipment…). */
export async function addPointElement(
  type: "column" | "footing" | "equipment",
  x: number,
  z: number,
  elev?: number,
  preset?: string,
): Promise<void> {
  if (elev != null) level = elev;
  if (preset) activePreset = preset;
  const d = (preset && DEFAULTS[preset]) || DEFAULTS[type] || { height: 3, thickness: 0.3 };
  await createElement(type as any, {
    point: [x, z],
    height: d.height,
    thickness: d.thickness,
    elevation: level,
  });
  activePreset = null;
  try {
    window.dispatchEvent(
      new CustomEvent("obs-toast", {
        detail: { message: `${preset || type} placed from Floor Plan`, kind: "success" },
      }),
    );
  } catch { /* */ }
}

export function transformElements(
  ids: string[],
  transform: (el: AuthoredElement, idx: number) => void,
): void {
  const targets = elements.filter((el) => ids.includes(el.id));
  if (!targets.length) return;
  const before = targets.map((t) => JSON.parse(JSON.stringify(t.params)));
  let i = 0;
  for (const el of targets) transform(el, i++);
  const after = targets.map((t) => JSON.parse(JSON.stringify(t.params)));
  history.push({
    label: `Transform ${targets.length} element(s)`,
    apply: () => { targets.forEach((t, i) => (t.params = JSON.parse(JSON.stringify(after[i])))); rebuild(); markDirty(); },
    revert: () => { targets.forEach((t, i) => (t.params = JSON.parse(JSON.stringify(before[i])))); rebuild(); markDirty(); },
  });
  rebuild(); markDirty();
}

// ═══════════════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════════════
/* ── MEP fitting radius migration ─────────────────────────────────────
   Normalizes every elbow fitting's bendRadius to at least one duct
   width (Revit default) and re-trims the two ducts that feed the
   fitting so their ends meet the new tangent points. Idempotent —
   safe to call repeatedly. Returns the number of fittings changed. */
/* ── MEP fitting migration + connector enforcement ─────────────────────
   mep-connector-v2

   Two responsibilities, both idempotent:

   1. Radius normalisation — every elbow's bendRadius is bumped to at
      least one duct width (Revit default). Fittings already at or above
      the floor are left alone.

   2. Connector enforcement — for every elbow, any same-type duct whose
      endpoint sits near the corner OR near either tangent point is
      snapped exactly onto the elbow's connection plane. This is what
      Revit calls a connector: the duct terminates at the fitting, not at
      the corner, so the two never overlap.

   The duct snap uses a generous tolerance (max of 1.5× radius,
   2.5× duct width, 0.5 m) so it also repairs ducts drawn before the
   current elbow geometry existed. Ducts deliberately detached from the
   elbow (endpoint further away) are never touched.

   Returns the total number of mutations (fittings + duct endpoints). */
export function migrateMepFittingRadii(): number {
  const mepTypes = new Set(["duct", "pipe", "cable-tray", "conduit"]);
  const fittings = elements.filter(
    (e) => e.type === "fitting" &&
           String((e.params as any).fittingKind || "elbow") === "elbow" &&
           mepTypes.has(String((e.params as any).parentType ?? "duct")),
  );

  let changedFittings = 0;
  let changedDuctEnds = 0;

  for (const f of fittings) {
    const t = f.params.thickness ?? 0.3;
    const ductWidth = Math.max(t, 0.05);
    const stored = Number((f.params as any).bendRadius);
    const oldR = Number.isFinite(stored) && stored > 0 ? stored : ductWidth / 2;
    const newR = Math.max(oldR, ductWidth);

    const cx = (f.params as any).point?.[0];
    const cz = (f.params as any).point?.[1];
    if (cx == null || cz == null) continue;
    const aIn  = Number((f.params as any).angleIn  ?? 0);
    const aOut = Number((f.params as any).angleOut ?? Math.PI / 2);

    const oldT1: [number, number] = [cx - Math.cos(aIn)  * oldR, cz - Math.sin(aIn)  * oldR];
    const oldT2: [number, number] = [cx + Math.cos(aOut) * oldR, cz + Math.sin(aOut) * oldR];
    const newT1: [number, number] = [cx - Math.cos(aIn)  * newR, cz - Math.sin(aIn)  * newR];
    const newT2: [number, number] = [cx + Math.cos(aOut) * newR, cz + Math.sin(aOut) * newR];

    const parentType = String((f.params as any).parentType ?? "duct");
    const tol = Math.max(newR * 1.5, ductWidth * 2.5, 0.5);

    for (const e of elements) {
      if (e.id === f.id) continue;
      if (e.type !== parentType) continue;
      if (!e.params.start || !e.params.end) continue;
      const [sx, sz] = e.params.start;
      const [ex, ez] = e.params.end;

      // Duct END → fitting INLET (tangent point OR corner)
      const dEndNewT1 = Math.hypot(ex - newT1[0], ez - newT1[1]);
      const dEndOldT1 = Math.hypot(ex - oldT1[0], ez - oldT1[1]);
      const dEndCorner = Math.hypot(ex - cx, ez - cz);
      if (
        dEndNewT1 > 0.005 &&
        (dEndNewT1 < tol || dEndOldT1 < tol || dEndCorner < ductWidth * 2)
      ) {
        e.params.end = [newT1[0], newT1[1]];
        changedDuctEnds++;
      }

      // Duct START → fitting OUTLET (tangent point OR corner)
      const dStartNewT2 = Math.hypot(sx - newT2[0], sz - newT2[1]);
      const dStartOldT2 = Math.hypot(sx - oldT2[0], sz - oldT2[1]);
      const dStartCorner = Math.hypot(sx - cx, sz - cz);
      if (
        dStartNewT2 > 0.005 &&
        (dStartNewT2 < tol || dStartOldT2 < tol || dStartCorner < ductWidth * 2)
      ) {
        e.params.start = [newT2[0], newT2[1]];
        changedDuctEnds++;
      }
    }

    if (Math.abs(oldR - newR) > 1e-6) {
      (f.params as any).bendRadius = newR;
      changedFittings++;
    }
  }

  const total = changedFittings + changedDuctEnds;
  if (total > 0) {
    rebuild();
    markDirty();
    notifyAuthoringChange();
  }

  console.log(
    `[mep-connector] ${changedFittings} fitting(s) resized, ` +
    `${changedDuctEnds} duct endpoint(s) re-trimmed onto connection planes`,
  );
  return total;
}
export function setupAuthoring() {
  ctx.world.scene.three.add(group);
  try { ctx.world.scene.three.add(guideGroup); } catch { /* */ }
  ctx.world.scene.three.add(datumGroup);
  ctx.world.scene.three.add(previewGroup);
  ctx.world.scene.three.add(gripGroup);
  ctx.rightHost.appendChild(editor);

  gizmo.setOverrideProvider(async () => {
    if (selectedIds.size === 0) return null;
    const box = new THREE.Box3();
    for (const el of elements) {
      if (!selectedIds.has(el.id)) continue;
      const m = createMesh(el);
      if (!m) continue;
      box.union(new THREE.Box3().setFromObject(m));
      disposeObj(m);
    }
    if (box.isEmpty()) return null;
    return { center: box.getCenter(new THREE.Vector3()), box };
  });

  let gizmoBaseline: Record<string, AuthoredElement["params"]> | null = null;

  gizmo.setCallbacks({
    onStart: () => {
      gizmoBaseline = {};
      for (const el of elements) {
        if (selectedIds.has(el.id) && !el.properties?.pinned) {
          gizmoBaseline[el.id] = JSON.parse(JSON.stringify(el.params));
        }
      }
    },
    onUpdate: (delta) => {
      if (!gizmoBaseline) return;
      for (const el of elements) {
        if (!selectedIds.has(el.id) || !!el.properties?.pinned) continue;
        const base = gizmoBaseline[el.id];
        if (!base) continue;
        const p = JSON.parse(JSON.stringify(base)) as AuthoredElement["params"];
        if (p.start) p.start = [p.start[0] + delta.x, p.start[1] + delta.z] as Vec2;
        if (p.end) p.end = [p.end[0] + delta.x, p.end[1] + delta.z] as Vec2;
        if (p.point) p.point = [p.point[0] + delta.x, p.point[1] + delta.z] as Vec2;
        if (p.polygon) p.polygon = p.polygon.map(([x, z]) => [x + delta.x, z + delta.z] as Vec2);
        p.elevation += delta.y;
        el.params = p;
      }
      rebuild();
    },
    onEnd: (delta) => {
      if (!gizmoBaseline) return;
      const moved = Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.z) > 1e-6;
      if (!moved) { gizmoBaseline = null; return; }
      const before = gizmoBaseline;
      const after: Record<string, AuthoredElement["params"]> = {};
      for (const el of elements) {
        if (selectedIds.has(el.id)) after[el.id] = JSON.parse(JSON.stringify(el.params));
      }
      for (const el of elements) {
        if (before[el.id]) el.params = JSON.parse(JSON.stringify(before[el.id]));
      }
      rebuild();
      history.push({
        label: `Transform ${Object.keys(after).length} element(s)`,
        apply: () => {
          for (const el of elements) if (after[el.id]) el.params = JSON.parse(JSON.stringify(after[el.id]));
          rebuild(); markDirty();
        },
        revert: () => {
          for (const el of elements) if (before[el.id]) el.params = JSON.parse(JSON.stringify(before[el.id]));
          rebuild(); markDirty();
        },
      });
      for (const el of elements) if (after[el.id]) el.params = JSON.parse(JSON.stringify(after[el.id]));
      rebuild(); markDirty();
      gizmoBaseline = null;
      void gizmo.refresh();
    },
  });

  /** Select authored element under cursor; returns true if handled. */
  function pickSelect(e: MouseEvent): boolean {
    const grip = gripAt(e);
    if (grip && (activeTool === "select" || activeTool === null)) {
      e.stopPropagation();
      e.preventDefault();
      const pt = groundPoint(e);
      if (pt) {
        startGripDrag(grip, pt);
        (ctx.world.camera.controls as any).enabled = false;
        ctx.rightHost.style.cursor = "grabbing";
      }
      return true;
    }

    const hitId = elementAt(e);
    // Only consume the click as selection when in select mode, or no tool,
    // or user holds Ctrl/Shift/Alt while a draw tool is active (force-select).
    const forceSelect = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
    const selectMode = !activeTool || activeTool === "select" || forceSelect;
    if (!selectMode) return false;

    e.stopPropagation();
    e.preventDefault();

    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const alt = e.altKey;
    if (!hitId) {
      if (!ctrl && !shift) {
        selectedIds.clear();
        try {
          const sel: any = (ctx.features as any).selection;
          sel?.replace?.({});
          void sel?.applyToHighlighter?.();
        } catch { /* optional fragment bridge */ }
      }
    } else {
      // Keep the 3D viewport selection unified: authored elements and linked
      // IFC/fragment elements cannot remain selected simultaneously.
      if (!ctrl && !shift && !alt) {
        try {
          const sel: any = (ctx.features as any).selection;
          sel?.replace?.({});
          void sel?.applyToHighlighter?.();
        } catch { /* optional fragment bridge */ }
      }
      if (alt || shift) selectedIds.delete(hitId);
      else if (ctrl) selectedIds.add(hitId);
      else {
        selectedIds.clear();
        selectedIds.add(hitId);
      }
      // Enter select mode when user picks an element
      if (activeTool && activeTool !== "select") {
        activeTool = "select";
        activePreset = null;
      }
    }
    applySelection();
    refreshGrips();
    updateLabel();
    {
      const ids = [...selectedIds];
      if (ids.length === 1) {
        const el2 = elements.find((x) => x.id === ids[0]);
        paletteTarget = el2 ? { mode: "edit", elementId: el2.id, type: el2.type } : null;
      } else {
        paletteTarget = null;
      }
      notifyAuthoringChange();
    }
    return true;
  }

  // Priority 10 — lowest; only sees gestures that gizmo, box-select/nav and
  // context-menu have declined.
  const unsubGesture = inputRouter.subscribe(handleAuthoringGesture, 10);
  const unsubHover = inputRouter.subscribeHover(handleAuthoringHover);
  const unsubCancel = inputRouter.registerCancel(handleAuthoringCancel);

  // Space / Enter only — Escape is owned by registerCancel.
  window.addEventListener("keydown", onAuthoringKeys);

  /* ── Gesture dispatch ──────────────────────────────────────────────── */

  function handleAuthoringGesture(g: Gesture): boolean {
    // Grip drag owns its own gesture from drag-start to drag-end.
    if (g.kind === "drag-start") {
      const grip = gripAt(g.event);
      if (grip && (activeTool === "select" || activeTool === null)) {
        const pt = groundPoint(g.event);
        if (pt) {
          startGripDrag(grip, pt);
          ctx.rightHost.style.cursor = "grabbing";
          return true;
        }
      }
      return false;
    }

    if (g.kind === "drag-move" && gripDrag) {
      const pt = groundPoint(g.event);
      if (pt) updateGripDrag(pt);
      return true;
    }

    if (g.kind === "drag-end" && gripDrag) {
      endGripDrag();
      ctx.rightHost.style.cursor = "";
      return true;
    }

    // Plain left click — place, select, or modify.
    if (g.kind === "click" && g.button === 0) {
      return handleLeftClick(g.event, g.mods);
    }

    return false;
  }

  function handleLeftClick(e: PointerEvent, mods: Mods): boolean {
    const forceSelect = mods.ctrl || mods.meta || mods.shift || mods.alt;
    const selectMode = !activeTool || activeTool === "select" || forceSelect;

    if (selectMode) {
      if (pickSelect(e)) return true;
      if (!activeTool || activeTool === "select") return true;
      // Fall through to tool placement when force-select found no element.
    }

    if (!activeTool) return true;

    if (
      activeTool === "move" || activeTool === "copy" ||
      activeTool === "rotate" || activeTool === "mirror" ||
      activeTool === "array" || activeTool === "offset"
    ) {
      const pt = groundPoint(e);
      if (pt) onModifyClick(pt, e);
      return true;
    }

    if (activeTool === "door" || activeTool === "window") {
      onDrawClick(new THREE.Vector3(), e);
      return true;
    }

    const pt = groundPoint(e);
    if (pt) onDrawClick(pt, e);
    return true;
  }

  /* ── Hover (preview + snap indicator) ───────────────────────────────── */

  function handleAuthoringHover(e: PointerEvent): void {
    if (gripDrag) return;

    // Snap indicator updates regardless of tool.
    try {
      if (ctx.world?.camera?.three) {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndcOf(e), ctx.world.camera.three);
        const hits = ctx.groundPlane ? ray.intersectObjects([ctx.groundPlane], false) : [];
        const base = hits.length ? hits[0].point.clone() : null;
        void updateSnapAsync(e, base);
      }
    } catch { /* */ }

    if (!activeTool) return;
    if (
      activeTool === "select" || activeTool === "move" || activeTool === "copy" ||
      activeTool === "rotate" || activeTool === "mirror" ||
      activeTool === "array" || activeTool === "offset"
    ) return;

    updatePreview(e);
  }

  /* ── Cancel (Escape) ─────────────────────────────────────────────────── */

  function handleAuthoringCancel(): boolean {
    try {
      if ((window as any).__obsPlanVisible?.()) return false;
    } catch { /* */ }

    const hasSomething =
      (activeTool !== null && activeTool !== "select") ||
      chainStart !== null ||
      poly.length > 0 ||
      pendingOp.kind !== "none" ||
      gripDrag !== null;

    if (!hasSomething) {
      // Already select with nothing in-progress: clear selection like before.
      if (selectedIds.size) {
        selectedIds.clear();
        applySelection();
        refreshGrips();
        paletteTarget = null;
        notifyAuthoringChange();
        updateLabel();
        return true;
      }
      return false;
    }

    chainStart = null;
    chainStartDir = null;
    poly = [];
    pendingOp = { kind: "none" };
    clearPreviews();
    try { accuDraw.end(); } catch { /* */ }
    try { snapping.hideIndicator(); } catch { /* */ }

    if (gripDrag) {
      try { endGripDrag(); } catch { /* */ }
      ctx.rightHost.style.cursor = "";
    }

    const preserved = lastCommand;
    setAuthoringTool("select");
    lastCommand = preserved;
    notify("info", "Cancelled — Select");
    try { (window as any).obsRefreshRibbon?.(); } catch { /* */ }
    return true;
  }

  /* ── Key handling (Space / Enter only — Escape is in the router) ────── */

  function onAuthoringKeys(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || (e.target as HTMLElement)?.isContentEditable) return;

    try { if ((window as any).__obsPlanVisible?.()) return; } catch { /* */ }

    if (e.key === "Backspace" || e.code === "Space" || e.key === " ") {
      if (tag === "button") return;
      e.preventDefault();
      e.stopPropagation();
      const cmd = lastCommand;
      if (!cmd) {
        notify("info", "No previous command to repeat — pick a tool first");
        return;
      }
      try {
        setAuthoringTool(cmd);
        notify("success", `Repeat: ${cmd}`);
        try { (window as any).obsRefreshRibbon?.(); } catch { /* */ }
        try {
          import("../core/context").then(({ ctx }) => {
            if ((ctx.features as any)?.planView?.isVisible?.()) {
              (ctx.features as any).planView.setTool?.(cmd);
            }
          }).catch(() => {});
        } catch { /* */ }
      } catch (err) {
        console.warn("[authoring] repeat failed", err);
      }
      return;
    }

    if (e.key === "Enter" && activeTool) {
      if (
        activeTool === "wall" || activeTool === "beam" || activeTool === "strip" ||
        activeTool === "mline" || activeTool === "duct" || activeTool === "pipe" ||
        activeTool === "cable-tray" || activeTool === "conduit" ||
        activeTool === "brace" || activeTool === "truss" || activeTool === "grid"
      ) {
        chainStart = null;
        chainStartDir = null;
        clearPreviews();
        try { accuDraw.end(); } catch { /* */ }
        updateLabel();
      }
      if (activeTool === "slab") finishSlab();
    }
  }

  // Snaps ON with all modes + visible markers
  try {
    snapping.enableAllTypes();
    snapping.setEnabled(true);
    snapping.setGridSize(0.1);
    snapping.setPixelTolerance(18);
  } catch { /* */ }

  // Default tool = Select so drawn elements are immediately clickable
  try {
    setAuthoringTool("select");
  } catch { /* */ }

  const api: AuthoringService & Record<string, any> = {
    isActive: isDrawingActive,
    getActiveTool, setAuthoringTool, setLevel, getLevel,
    getActivePreset, getLastCommand, setLastCommand,
    getElementCount, getElements, getSelectedIds,
    getElementById,
    pickAuthoredElementAt,
    deleteSelectedElement, clearAllElements, clearDatums,
    rebuildAuthored, transformElements,
    selectAllAuthored,
    setSelectedAuthored,
    getElementWorldBox,
    getAuthoredGroup,

    pinSelected,
    createSimilarFromSelection,
    splitSelectedAtMidpoint,
    joinSelectedWalls,
    alignSelectedAxis,

    getWallLocationLine,
    setWallLocationLine: (v) => setWallLocationLine(v as any),
    getWallChain, setWallChain,
    getWallOffset, setWallOffset,
    getWallJoinStatus,
    setWallJoinStatus: (v) => setWallJoinStatus(v as any),

    getGrids, setGrids, getLevels, setLevels,
    getActiveLevelId, setActiveLevelById,
    getActiveFamilyId, getActiveFamilyTypeId, setActiveFamily,
    syncFamilyInstances,

    onAuthoringChange,
    migrateMepFittingRadii,
  };
  ctx.features.authoring = api;
  register("authoring", api);
  try { (window as any).__obsAuthoring = api; } catch { /* */ }
}