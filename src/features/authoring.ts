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
import { escapeHtml } from "../core/html-escape";
import { fittingArmLength } from "../modules/mep/fitting-outline";
import { clampBendRadius, defaultBendRadius, elbowGeometry, turnAngle, arcPoints as elbowArcPoints } from "../modules/mep/elbow-geometry";
import * as THREE from "three";
import { CSG } from "three-csg-ts";
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
import { expandConnected, isMepElement } from "../modules/mep/connectivity";
import { isValidBoundary } from "../modules/views/boundary-edit";
import { endElevationFromSlope, slopePercent, slopedRun } from "../modules/mep/slope";
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
import { deriveLinearParamsFromPositions } from "../modules/native-twin/linear-params";
import { heightResizeTransform, footprintCenterXZ } from "../modules/native-twin/vertical-resize";
import { deformPlanDimensions, planAxesFromBaseline, lengthRatioFromParams } from "../modules/native-twin/mesh-plan-deform";
import {
  classifyTwinCapabilities,
  elementTypeFromIfcEntity,
  shouldPreferParametricSolid,
  LINEAR_ELEMENT_TYPES,
} from "../modules/native-twin/capabilities";
import { derivePlanAabbPolygon } from "../modules/native-twin/plan-polygon";
import { buildSourceArchive, markNativeDimensionModified, type SourceArchive } from "../modules/native-twin/source-archive";
import {
  applyJustificationToSegment,
  coreThicknessFromLayers,
  justificationShiftMeters,
  resolveWallJustification,
  type WallLocationLine as JustificationLine,
} from "../modules/justification";
import {
  calculateWallEndpoint,
  getWallLocationLine as toWallColumnLine,
  type WallLocationLine as WallColumnLine,
} from "../modules/snapping/wall-column";
import {
  evaluateSmartPerpSnap,
  rectColumnFaces,
  smartSnapRadiusWorld,
  type SmartPerpSnapResult,
} from "../modules/snapping/smart-perp-snap";
import { snapFeedback } from "./snap-feedback";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════
type Tool =
  | "select" | "move" | "copy" | "rotate" | "mirror" | "array" | "offset"
  | "wall" | "slab" | "column" | "beam" | "brace" | "truss" | "footing" | "strip" | "mline"
  | "duct" | "pipe" | "cable-tray" | "conduit" | "equipment"
  | "door" | "window" | "curtain-wall"
  | "grid" | "level"
  | "terrain";

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
  | { kind: "array"; ids: string[]; mode: "linear" | "radial"; base: THREE.Vector3 | null; count?: number; spacing?: number }
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
/** Currently selected datum (grid line or level), if any. Mutually exclusive with element selection. */
let selectedDatum: { kind: "grid" | "level"; id: string } | null = null;
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
  smartSnap?: SmartPerpSnapResult | null;
} | null = null;

let lastSnapValid = false;
let lastSnapResult: import("./snapping").SnapResult | null = null;
/** Last hover event — used by refreshPreview() to redraw the ghost after
 *  a parameter change in the modeling panel (MASTER PROMPT §2.3). */
let lastHoverEvent: MouseEvent | null = null;

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
  "curtain-wall": "curtain-wall" as any,
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
 * Last command for Space-bar repeat (BIM behaviour).
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
  "door", "window", "curtain-wall", "terrain",
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

/* ── Wall placement options (BIM Modify | Place Wall) ───────────────── */
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
  endElevation?: number;
  id: string;
} | null = null;
/** Slope (%) applied to newly drawn pipes/ducts/trays/conduits; 0 = flat. */
let drawSlopePct = 0;
export function setDrawSlope(pct: number) { drawSlopePct = Number.isFinite(pct) ? pct : 0; }
export function getDrawSlope() { return drawSlopePct; }
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

/* ── Beam / MEP justification state (MASTER PROMPT §3) ─────────────── */
/** Horizontal justification across the profile width. */
export type HJustification = "center" | "outer" | "inner";
/** Vertical justification of a beam relative to the draw elevation. */
export type ZJustification = "bottom" | "center" | "top";
let beamJustification: HJustification = "center";
let beamZJustification: ZJustification = "bottom";
let mepJustification: HJustification = "center";
export function getBeamJustification() { return beamJustification; }
export function setBeamJustification(v: HJustification) { beamJustification = v; }
export function getBeamZJustification() { return beamZJustification; }
export function setBeamZJustification(v: ZJustification) { beamZJustification = v; }
export function getMepJustification() { return mepJustification; }
export function setMepJustification(v: HJustification) { mepJustification = v; }

/**
 * Reset a tool's type defaults (and tool-specific placement state) to the
 * built-in factory values. Used by the modeling panel's Reset action.
 */
export function resetTypeDefaults(type: string): void {
  const defaults = DEFAULTS[type] ?? { height: 1, thickness: 0.2 };
  typeDefaults.set(type, {
    params: { ...defaults },
    properties: {},
    color: COLORS[type] ?? "#cccccc",
  });
  if (type === "wall" || type === "curtain-wall") {
    wallLocationLine = "wall-centerline";
    wallOffset = 0;
    wallChain = true;
    wallJoinStatus = "allow";
  }
  if (type === "beam" || type === "strip") {
    beamJustification = "center";
    beamZJustification = "bottom";
  }
  if (type === "duct" || type === "pipe" || type === "cable-tray" || type === "conduit") {
    mepJustification = "center";
    drawSlopePct = 0;
  }
  notifyAuthoringChange();
}

/** Effective draw-time parameters (type defaults win over factory). */
function effectiveDrawParams(type: ElementType): {
  height: number; thickness: number; width?: number; elevation: number; layers?: string;
} {
  const presetKey = activePreset && DEFAULTS[activePreset] ? activePreset : type;
  const baseDefaults = DEFAULTS[presetKey] ?? DEFAULTS[type] ?? { height: 1, thickness: 0.2 };
  const userDefaults = getTypeDefaults(type);
  const pick = (k: "height" | "thickness" | "width", fallback: number | undefined): number | undefined => {
    const v = userDefaults.params[k] ?? (baseDefaults as any)[k] ?? fallback;
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const elevationRaw = userDefaults.params.elevation;
  return {
    height: pick("height", baseDefaults.height) ?? 1,
    thickness: pick("thickness", baseDefaults.thickness) ?? 0.2,
    width: pick("width", (baseDefaults as any).width),
    elevation:
      typeof elevationRaw === "number" && Number.isFinite(elevationRaw) ? elevationRaw : level,
    layers: typeof userDefaults.properties?.layers === "string" ? userDefaults.properties.layers as string : undefined,
  };
}

/**
 * MASTER PROMPT §3.2 — justification affects the ACTUAL construction:
 * resolve the per-tool justification against the reference segment and
 * return the placed start/end (+ elevation / endElevation adjustments).
 * The reference path itself is never moved (switching modes re-solves).
 */
function justifyLinearSegment(
  tool: ElementType,
  startPt: THREE.Vector3,
  endPt: THREE.Vector3,
  dp: ReturnType<typeof effectiveDrawParams>,
): {
  start: [number, number]; end: [number, number];
  elevation?: number; endElevation?: number;
} {
  const s: [number, number] = [startPt.x, startPt.z];
  const e: [number, number] = [endPt.x, endPt.z];
  if (tool === "wall" || tool === "curtain-wall") {
    const core = coreThicknessFromLayers(dp.layers, dp.thickness);
    const r = resolveWallJustification({
      start: s, end: e,
      locationLine: wallLocationLine as JustificationLine,
      thickness: dp.thickness,
      coreThickness: core,
      extraOffset: wallOffset,
    });
    return { start: r.start, end: r.end, elevation: dp.elevation };
  }
  if (tool === "beam" || tool === "strip") {
    const r = applyJustificationToSegment({
      start: s, end: e,
      shift: justificationShiftMeters(beamJustification, dp.thickness),
    });
    const zShift =
      beamZJustification === "center" ? -dp.height / 2 :
      beamZJustification === "top" ? -dp.height : 0;
    return { start: r.start, end: r.end, elevation: dp.elevation + zShift };
  }
  if (tool === "duct" || tool === "pipe" || tool === "cable-tray" || tool === "conduit") {
    const r = applyJustificationToSegment({
      start: s, end: e,
      shift: justificationShiftMeters(mepJustification, dp.thickness),
    });
    // Reuse the plan-path slope state so chained 3D runs accumulate
    // elevation exactly like plan-drawn runs (MASTER PROMPT §2.2 MEP).
    const sloped = slopedElevations(tool, s[0], s[1], e[0], e[1]);
    return {
      start: r.start, end: r.end,
      elevation: sloped.elevation,
      endElevation: drawSlopePct !== 0 ? sloped.endElevation : undefined,
    };
  }
  return { start: s, end: e, elevation: dp.elevation };
}

/** Shift start/end so the drawn line is the selected location line. */
export function applyWallLocationOffset(
  x1: number, z1: number, x2: number, z2: number, thickness: number,
): { start: [number, number]; end: [number, number] } {
  const layers = getTypeDefaults("wall").properties?.layers as string | undefined;
  const core = coreThicknessFromLayers(layers, thickness);
  const r = resolveWallJustification({
    start: [x1, z1], end: [x2, z2],
    locationLine: wallLocationLine as JustificationLine,
    thickness,
    coreThickness: core,
    extraOffset: wallOffset,
  });
  return { start: r.start, end: r.end };
}

/**
 * BIM Join Status at a corner.
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
 * BIM-style join for a NEWLY placed wall only.
 *
 * CRITICAL RULE (matches BIM): existing walls are NEVER moved or rotated.
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
  // Snap tolerance ≈ half thickness + small slack (BIM endpoint snap feel)
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

const MEP_LINEAR_TYPES = new Set(['duct', 'pipe', 'cable-tray', 'conduit']);

/** Start/end elevation for a run being drawn, honouring the draw slope and chain continuity. */
function slopedElevations(type: string, sx: number, sz: number, ex: number, ez: number): { elevation: number; endElevation?: number } {
  if (!MEP_LINEAR_TYPES.has(type) || Math.abs(drawSlopePct) < 1e-9) return { elevation: level };
  let start = level;
  const prev = lastPlanLinear;
  if (prev && prev.type === type && prev.endElevation != null &&
      Math.hypot(prev.end[0] - sx, prev.end[1] - sz) < 0.002) start = prev.endElevation;
  return { elevation: start, endElevation: endElevationFromSlope(start, Math.hypot(ex - sx, ez - sz), drawSlopePct) };
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

  // ── BIM-style MEP fittings ──────────────────────────────────────────
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

    const armLen = fittingArmLength(p.thickness, p.height, Number(p.bendRadius), isRound);
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

    // Main run through + branch (BIM duct/pipe fitting orientation)
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

  // True circular arc (same construction as the plan symbol and the duct trimming).
  const widthForDefault = isRound ? p.thickness : Math.max(p.thickness, p.height);
  const bendR = Number(p.bendRadius) > 0 ? Number(p.bendRadius) : defaultBendRadius(widthForDefault);
  const eg = elbowGeometry([cx, cz], aIn, aOut, bendR);
  if (!eg) return null;

  // Smoother elbow (more segments = BIM-like curved fitting)
  const N = isRound ? 20 : 18;
  const pts: THREE.Vector3[] = elbowArcPoints(eg, N).map(([x, z]) => new THREE.Vector3(x, yCenter, z));

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
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
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

/** Compute the wall-clamped offset for a hosted door/window. Pure - no mutations. */
function computeClampedOffset(el: AuthoredElement, wallLength: number): number {
  const w = el.params.width ?? (el.type === "door" ? 0.9 : 1.2);
  const half = w / 2;
  const raw = el.params.offsetAlongHost ?? wallLength / 2;
  if (wallLength <= w + 0.02) return wallLength / 2;
  const clamped = Math.max(half, Math.min(wallLength - half, raw));
  return Math.round(clamped * 1000) / 1000;
}

function openingsForWall(wallId: string): WallOpening[] {
  const out: WallOpening[] = [];
  const wall = elements.find((e) => e.id === wallId);
  const wp = wall?.params;
  let L = 0;
  if (wp && wp.start && wp.end) {
    const ax = wp.start[0], az = wp.start[1];
    const bx = wp.end[0],   bz = wp.end[1];
    L = Math.hypot(bx - ax, bz - az);
  }
  const H = Number(wp?.height ?? 3);
  for (const el of getHostedForWall(wallId)) {
    const p = el.params;
    const w = p.width ?? DEFAULTS[el.type]?.width ?? 0.9;
    const h = p.height;
    const sill = el.type === "window" ? (p.sillHeight ?? 0.9) : (p.sillHeight ?? 0);

    const offset = computeClampedOffset(el, L);

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

/* ── BIM-style wall join ─────────────────────────────────────────── */

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
  const arcH = Number((p as any).arcHeight ?? 0);

  if (Math.abs(arcH) > 0.05 && L > 0.5) {
    // Curved wall (segmented arc)
    const h = Math.abs(arcH);
    const R = (h * h + (L / 2) * (L / 2)) / (2 * h);
    const sign = Math.sign(arcH);
    const theta = 2 * Math.asin((L / 2) / R);
    const startAngle = -theta / 2;
    const segments = Math.max(12, Math.ceil(theta * 10));
    const cX = L / 2;
    const cY = T / 2 - sign * R;

    // Left face (start to end)
    shape.moveTo(0, T);
    for (let i = 1; i <= segments; i++) {
      const a = startAngle + (i / segments) * theta;
      const px = cX + (R + T / 2) * Math.sin(a);
      const py = cY + sign * (R + T / 2) * Math.cos(a);
      shape.lineTo(px, py);
    }
    shape.lineTo(L, T);
    shape.lineTo(L, 0);

    // Right face (end to start)
    for (let i = segments; i >= 0; i--) {
      const a = startAngle + (i / segments) * theta;
      const px = cX + (R - T / 2) * Math.sin(a);
      const py = cY + sign * (R - T / 2) * Math.cos(a);
      shape.lineTo(px, py);
    }
    shape.lineTo(0, 0);
    shape.closePath();
  } else {
    // Straight wall
    shape.moveTo(sL[0], sL[1]);
    shape.lineTo(eL[0], eL[1]);
    shape.lineTo(eR[0], eR[1]);
    shape.lineTo(sR[0], sR[1]);
    shape.closePath();
  }

  const geo = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false });
  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(el.color || COLORS[el.type] || COLORS.wall),
  });
  let mesh: THREE.Mesh = new THREE.Mesh(geo, mat);

  const wallDirV = new THREE.Vector3(dirX, 0, dirZ);
  const normalV  = new THREE.Vector3(normalX, 0, normalZ);
  const upV      = new THREE.Vector3(0, 1, 0);
  const basis    = new THREE.Matrix4().makeBasis(wallDirV, normalV, upV);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.set(posX, p.elevation, posZ);
  mesh.updateMatrixWorld(true);

  if (openings.length) {
    // CSG hole subtraction.
    //
    // The wall's local axes (after `mesh.quaternion` rotation) are:
    //   local X  ->  wall direction (horizontal, along the wall length)
    //   local Y  ->  wall normal    (horizontal, perpendicular to wall length)
    //   local Z  ->  world up       (vertical)
    //
    // Therefore the hole box's three dimensions must be:
    //   width  (along-wall)  -> opening width   (spans the wall length)
    //   depth  (wall-normal) -> wall thickness  (cuts all the way through)
    //   height (vertical)    -> opening height   (from sill to top)
    //
    // Previous code used `BoxGeometry(op.width, op.height, T+0.2)` which
    // swapped the wall-normal and vertical axes — the box was taller than
    // the wall and barely cut through its thickness, so doors/windows
    // appeared in front of an uncut wall. This is the hosted-element
    // recut regression: the opening was computed in the wrong plane.
    for (const op of openings) {
      const holeGeo = new THREE.BoxGeometry(op.width, T + 0.2, op.height);
      const holeMat = new THREE.MeshLambertMaterial({ visible: false });
      const holeMesh = new THREE.Mesh(holeGeo, holeMat);

      // Centre of the opening, in WORLD coordinates:
      //   cx, cz  : on the wall's centreline, at distance `op.offset` from start
      //   cy      : elevation + sill + half opening height (vertical mid-point)
      const cx = ax + dirX * op.offset;
      const cz = az + dirZ * op.offset;
      const cy = p.elevation + op.sill + op.height / 2;

      holeMesh.position.set(cx, cy, cz);
      holeMesh.quaternion.copy(mesh.quaternion);
      holeMesh.updateMatrixWorld(true);

      try {
        const bspA = CSG.fromMesh(mesh);
        const bspB = CSG.fromMesh(holeMesh);
        const resultBsp = bspA.subtract(bspB);
        mesh = CSG.toMesh(resultBsp, mesh.matrix, mat);
        mesh.updateMatrixWorld(true);
      } catch (err) {
        console.warn("[CSG] door subtraction failed", err);
      }
    }
  }

  mesh.userData.elementId = el.id;
  mesh.userData.baseColor = el.color || COLORS.wall;
  // Accelerate this mesh with BVH for fast raycasting (selection, snapping).
  try {
    if ((window as any).__obsPerf?.accelerateMesh) {
      (window as any).__obsPerf.accelerateMesh(mesh);
    }
  } catch { /* BVH not available yet — mesh still works, just slower raycast */ }
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
  // Parametric-linear Native Twins with a valid baseline regenerate via the
  // standard wall/beam builders so Height/Thickness edits change real solids.
  const editMode = String((el.properties as any)?.editMode ?? "");
  const hasLinearBaseline = !!(el.params.start && el.params.end);
  const hasPoint = !!(el.params.point);
  const hasPolygon = !!(el.params.polygon && el.params.polygon.length >= 3);
  const forceParametricSolid = !!(el.properties as any)?.forceParametricSolid;
  const preferParametricSolid = shouldPreferParametricSolid(
    el.type,
    editMode,
    hasLinearBaseline,
    hasPoint,
    hasPolygon,
    forceParametricSolid,
  );

  // Exact source geometry is the default for Digital Twins — preserves orientation,
  // openings, and profile. Parametric box rebuild only when explicitly forced.
  if (
    el.nativeGeometry?.positions &&
    el.nativeGeometry.positions.length >= 9 &&
    !preferParametricSolid
  ) {
    ensureNativeBaseDimensions(el);
    const props = el.properties as any;
    const baseH = Number(props.nativeBaseHeight) || 0;
    const baseT = Number(props.nativeBaseThickness) || 0;
    const baseLen = Number(props.nativeBaseLength) || 0;
    const h = Number(el.params.height) || baseH;
    const t = Number(el.params.thickness) || baseT;

    // Orientation-preserving plan deform (length + thickness) on a copy of source verts.
    let positions: ArrayLike<number> = el.nativeGeometry.positions;
    if (el.transform && el.params.start && el.params.end && (baseT > 1e-8 || baseLen > 1e-8)) {
      const axes = planAxesFromBaseline(el.params.start as [number, number], el.params.end as [number, number]);
      if (axes) {
        const tr = baseT > 1e-8 ? t / baseT : 1;
        const lr = baseLen > 1e-8
          ? lengthRatioFromParams(el.params.start as [number, number], el.params.end as [number, number], baseLen)
          : 1;
        if (Math.abs(tr - 1) > 1e-9 || Math.abs(lr - 1) > 1e-9) {
          positions = deformPlanDimensions(
            el.nativeGeometry.positions,
            axes,
            el.transform.position,
            lr,
            tr,
          );
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions as ArrayLike<number>, 3));
    try { geo.computeVertexNormals(); } catch { /* */ }
    try { geo.computeBoundingBox(); geo.computeBoundingSphere(); } catch { /* */ }
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
      const sx0 = el.transform.scale[0];
      const sy0 = el.transform.scale[1];
      const sz0 = el.transform.scale[2];
      // Height only via vertical resize — plan size handled by vertex deform above.
      const rs = baseH > 1e-8
        ? heightResizeTransform({
            positions: el.nativeGeometry.positions,
            position: el.transform.position,
            quaternion: el.transform.quaternion,
            scale: [sx0, sy0, sz0],
            baseHeight: baseH,
            newHeight: h,
          })
        : null;
      mesh.scale.set(sx0, rs ? rs.scale[1] : sy0, sz0);
      if (rs) mesh.position.set(rs.position[0], rs.position[1], rs.position[2]);
      else mesh.position.set(...el.transform.position);
    }
    return mesh;
  }

  if (el.type === "fitting") return buildFitting(el);

  if (el.type === "wall" && p.start && p.end) {
    const openings = openingsForWall(el.id);
    // BIM-style compound wall hook
    const __layerStr = (el.properties as any)?.layers as string | undefined;
    if (__layerStr) {
      try {
        const __w = window as any;
        const __builder = __w.__obsMeshBuilders?.["wall"];
        if (typeof __builder === "function") {
          const __mesh = __builder(el);
          if (__mesh) return __mesh;
        }
      } catch (__err) {
        console.warn("[authoring] compound wall builder failed", __err);
      }
    }
    return buildWallWithOpenings(el, openings);
  }

  // miter-beam-v1
  if (el.type === "beam" && p.start && p.end) {
    // Beams reuse the same mitered-linear builder as walls (with no
    // openings). Two beams meeting at an L-corner miter cleanly in both
    // 2D plan and 3D, matching BIM's structural framing behaviour.
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
      const sloped = p.endElevation != null && MEP_LINEAR_TYPES.has(el.type) &&
        Math.abs(p.endElevation - p.elevation) > 1e-6;
      if (sloped) {
        const run = slopedRun(p.elevation, p.endElevation, len);
        mesh = new THREE.Mesh(new THREE.BoxGeometry(run.length, p.height, p.thickness), mat);
        mesh.position.set((ax + bx) / 2, run.midElevation + p.height / 2, (az + bz) / 2);
        mesh.rotation.order = "YZX";
        mesh.rotation.set(0, Math.atan2(-(bz - az), bx - ax), run.pitch);
      } else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(len, p.height, p.thickness), mat);
        mesh.position.set((ax + bx) / 2, p.elevation + p.height / 2, (az + bz) / 2);
        mesh.rotation.y = Math.atan2(-(bz - az), bx - ax);
      }
    }
  }

  if (!mesh && el.type === "brace" && p.start && p.end) {
    const a = new THREE.Vector3(p.start[0], p.elevation, p.start[1]);
    const b = new THREE.Vector3(p.end[0], p.elevation + p.height, p.end[1]);
    if (a.distanceTo(b) < 0.05) return null;
    mesh = memberMesh(a, b, p.thickness, p.thickness, mat);
  }

  if (!mesh && el.type === "terrain" && p.polygon && p.polygon.length >= 3) {
    const shape = new THREE.Shape();
    p.polygon.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
    shape.closePath();
    const thickness = p.thickness ?? 1.0;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
    mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x8b5a2b }));
    mesh.rotation.x = -Math.PI / 2;
    const slopeDeg = Number(el.properties?.slope ?? 0);
    const dirDeg = Number(el.properties?.slopeDirection ?? 0);
    if (slopeDeg > 0) {
      const slopeRad = THREE.MathUtils.degToRad(slopeDeg);
      const dirRad = THREE.MathUtils.degToRad(dirDeg);
      const axis = new THREE.Vector3(Math.cos(dirRad), 0, Math.sin(dirRad));
      const q = new THREE.Quaternion().setFromAxisAngle(axis, slopeRad);
      mesh.applyQuaternion(q);
    }
    mesh.position.y = p.elevation;
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

  if (!mesh) {
    try {
      const __builders = (window as any).__obsMeshBuilders;
      if (__builders && typeof __builders[el.type] === "function") {
        const __custom = __builders[el.type](el);
        if (__custom) {
          __custom.traverse((m: any) => {
            if (m.isMesh) {
              m.userData.elementId = el.id;
              m.userData.baseColor = el.color || COLORS[el.type] || "#cccccc";
            }
          });
          return __custom;
        }
      }
    } catch (err) {
      console.warn("[authoring] custom mesh builder failed for " + el.type, err);
    }
    return null;
  }
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

  const offset = computeClampedOffset(el, L);
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

/** Write derived hosted-element params once per rebuild. The only place
 *  offsetAlongHost, x, z, hostAngle, rotation, angle are mutated. */
function syncHostedPositions(): void {
  for (const el of elements) {
    if ((el.type !== "door" && el.type !== "window") || !el.hostId) continue;
    const host = elements.find((e) => e.id === el.hostId);
    if (!host?.params.start || !host?.params.end) continue;
    const [ax, az] = host.params.start;
    const [bx, bz] = host.params.end;
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const offset = computeClampedOffset(el, L);
    const t01 = offset / L;
    const cx = ax + dx * t01;
    const cz = az + dz * t01;
    const hostAngle = Math.atan2(dz, dx);
    el.params.offsetAlongHost = offset;
    if ("x" in el.params)         (el.params as any).x         = Math.round(cx * 1000) / 1000;
    if ("z" in el.params)         (el.params as any).z         = Math.round(cz * 1000) / 1000;
    if ("hostAngle" in el.params) (el.params as any).hostAngle = Math.round(hostAngle * 10000) / 10000;
    if ("rotation" in el.params)  (el.params as any).rotation  = Math.round(hostAngle * 10000) / 10000;
    if ("angle" in el.params)     (el.params as any).angle     = Math.round(hostAngle * 10000) / 10000;
  }
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
  syncHostedPositions();
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
    addGrip("end", new THREE.Vector3(p.end[0], p.endElevation ?? p.elevation, p.end[1]));
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
  } else if ((kind === "start" || kind === "end") && (p.start || p.end) && el.type === "wall") {
    // Smart Snap & Perpendicular Link — magnetize wall endpoint to column face
    let sx = x, sz = z;
    gripDrag.smartSnap = null;
    try {
      const fixedArr = kind === "end" ? p.start : p.end;
      if (fixedArr) {
        const fixed = { x: fixedArr[0], z: fixedArr[1] };
        const free = { x, z };
        const faces = [];
        for (const other of elements) {
          if ((other.type !== "column" && other.type !== "footing") || !other.params.point) continue;
          const [cx, cz] = other.params.point as [number, number];
          const t = (other.params.thickness as number) ?? 0.3;
          const d = (other.params.depth as number) ?? t;
          faces.push(...rectColumnFaces(other.id, { x: cx, z: cz }, t, d));
        }
        if (faces.length) {
          const cam: any = ctx.world?.camera?.three;
          const host = ctx.rightHost;
          const at = new THREE.Vector3(x, (p.elevation as number) ?? 0, z);
          let radius = 0.15;
          if (cam && host) {
            const isOrtho = !!cam.isOrthographicCamera;
            const dist = cam.position.distanceTo(at);
            const fovY = THREE.MathUtils.degToRad(cam.fov ?? 60);
            const orthoH = isOrtho
              ? Math.abs((cam.top - cam.bottom) / (cam.zoom || 1))
              : 10;
            radius = smartSnapRadiusWorld({
              isOrtho,
              distance: dist,
              fovY,
              orthoHeight: orthoH,
              viewportHeightPx: host.clientHeight || 800,
            });
          }
          const hit = evaluateSmartPerpSnap(fixed, free, faces, radius);
          if (hit) {
            sx = hit.attach.x;
            sz = hit.attach.z;
            gripDrag.smartSnap = hit;
            snapFeedback.show(hit, fixed, (p.elevation as number) ?? 0);
          } else {
            snapFeedback.hide();
          }
        } else {
          snapFeedback.hide();
        }
      }
    } catch {
      try { snapFeedback.hide(); } catch { /* */ }
    }
    if (kind === "start" && p.start) p.start = [sx, sz];
    else if (kind === "end" && p.end) p.end = [sx, sz];
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
  const smart = gripDrag.smartSnap ?? null;
  const which = gripDrag.grip.kind === "start" || gripDrag.grip.kind === "end"
    ? gripDrag.grip.kind
    : null;
  gripDrag = null;
  try { snapFeedback.hide(); } catch { /* */ }
  if (!el || !after) return;
  if (JSON.stringify(before) === JSON.stringify(after)) return;

  history.push({
    label: `Move grip · ${el.name}`,
    apply: () => { el.params = JSON.parse(JSON.stringify(after)); rebuild(); markDirty(); },
    revert: () => { el.params = JSON.parse(JSON.stringify(before)); rebuild(); markDirty(); },
  });
  markDirty();

  // Persist wall–column link when the grip ended on a smart face/corner snap.
  if (smart && which && el.type === "wall" && el.params.start && el.params.end) {
    try {
      const fakeSnap: import("./snapping").SnapResult = {
        point: new THREE.Vector3(smart.attach.x, (el.params.elevation as number) ?? 0, smart.attach.z),
        type: smart.mode === "face" ? "face" : "corner",
        screenDist: 0,
        elementId: smart.columnId,
        refKind: smart.mode === "face" ? "face" : "corner",
      };
      void recordSnapRelationships(el, fakeSnap);
    } catch (err) {
      console.warn("[authoring] smart-perp link commit failed", err);
    }
  }
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
  if (!snapping.isEnabled() || (snapping as any).isSuspended?.()) {
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
// Snap-derived persistent relationships + dependent propagation
// (MASTER PROMPT §4.3 commit, §5 magnetic behavior, §6 update-on-modify)
// ═══════════════════════════════════════════════════════════════════════════

function snapRegistry(): any | null {
  try {
    const w = window as any;
    return w.__obsRelationships?.registry ?? null;
  } catch { return null; }
}

const dist2XZ = (ax: number, az: number, bx: number, bz: number) =>
  (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

/**
 * Called right after a draw-committed element. Converts the snap that
 * produced the placement into persistent relationships:
 *   • endpoint/corner snap onto another linear element → endpoint-constraint
 *   • snap onto a column/footing face                  → wall-column
 *     endpoint-constraint (via the wall-column module)
 *   • connector snap (MEP)                             → mep-connection
 */
async function recordSnapRelationships(
  el: AuthoredElement,
  snap: import("./snapping").SnapResult | null,
): Promise<void> {
  try {
    const registry = snapRegistry();
    if (!registry || !snap || !snap.elementId || snap.elementId === el.id) return;
    const z = (el.params.elevation ?? 0) as number;
    const other = elements.find((x) => x.id === snap.elementId);
    if (!other) return;

    // 1) Wall/beam endpoint landing on another linear element's endpoint.
    const linearTypes = new Set(["wall", "curtain-wall", "beam", "strip", "mline", "duct", "pipe", "cable-tray", "conduit"]);
    if (
      (snap.type === "endpoint" || snap.type === "corner") &&
      linearTypes.has(other.type) && linearTypes.has(el.type) &&
      other.params.start && other.params.end && el.params.start && el.params.end
    ) {
      registry.createRelationship({
        type: "endpoint-constraint",
        source: {
          elementId: other.id,
          kind: "endpoint",
          position: [snap.point.x, snap.point.z, z],
        },
        target: {
          elementId: el.id,
          kind: "endpoint",
          position: [snap.point.x, snap.point.z, z],
        },
        reconnection: "follow-source",
        deletionPolicy: "break",
        origin: "automatic",
      });
      return;
    }

    // 2) Linear element ending on a column / isolated footing face.
    if (
      el.params.start && el.params.end &&
      (other.type === "column" || other.type === "footing") &&
      other.params.point
    ) {
      const t = other.params.thickness ?? 0.3;
      const d = other.params.depth ?? t;
      const [cx, cz] = other.params.point;
      const baseZ = other.params.elevation ?? 0;
      const topZ = baseZ + (other.params.height ?? 3);
      const wc = await import("../modules/snapping/wall-column");
      const footprint: Array<[number, number]> = [
        [cx - t / 2, cz - d / 2], [cx + t / 2, cz - d / 2],
        [cx + t / 2, cz + d / 2], [cx - t / 2, cz + d / 2],
      ];
      const colRef = wc.getColumnReferenceGeometry({
        elementId: other.id, footprint, baseZ, topZ,
      });
      const justificationMap: Record<string, "core-centerline" | "finish-face-exterior" | "finish-face-interior"> = {
        "wall-centerline": "core-centerline",
        "core-centerline": "core-centerline",
        "finish-exterior": "finish-face-exterior",
        "finish-interior": "finish-face-interior",
        "core-exterior": "finish-face-exterior",
        "core-interior": "finish-face-interior",
      };
      const wl: import("../modules/projects/types").ElementType = el.type;
      void wl;
      const wallLine = wc.getWallLocationLine({
        start: el.params.start,
        end: el.params.end,
        width: el.params.thickness ?? 0.2,
        justification: justificationMap[(el.properties as any)?.locationLine as string] ?? "core-centerline",
      });
      const contacts = wc.findWallColumnContactCandidates(wallLine, colRef);
      if (!contacts.length) return;
      const contact = contacts[0];
      // Bind the wall endpoint that sits at the contact face.
      const startD = dist2XZ(el.params.start[0], el.params.start[1], contact.point[0], contact.point[1]);
      const endD = dist2XZ(el.params.end[0], el.params.end[1], contact.point[0], contact.point[1]);
      const endpoint: [number, number] = startD <= endD ? el.params.start : el.params.end;
      wc.createWallColumnRelationship(registry, wallLine, colRef, el.id, endpoint, contact, z);
      return;
    }

    // 3) MEP run started/ended on an equipment/fitting connector.
    if (snap.type === "connector" && linearTypes.has(el.type)) {
      const endPt = el.params.end ?? el.params.start;
      registry.createRelationship({
        type: "mep-connection",
        source: {
          elementId: other.id,
          kind: "connector",
          position: [snap.point.x, snap.point.y, snap.point.z],
        },
        target: {
          elementId: el.id,
          kind: "endpoint",
          position: [endPt?.[0] ?? snap.point.x, endPt?.[1] ?? snap.point.z, el.params.endElevation ?? z],
        },
        reconnection: "follow-source",
        deletionPolicy: "break",
        origin: "automatic",
      });
    }
  } catch (err) {
    console.warn("[authoring] snap relationship recording failed", err);
  }
}

export interface ParamPatch {
  el: AuthoredElement;
  before: AuthoredElement["params"];
  after: AuthoredElement["params"];
  relationshipId: string;
  endpoint: [number, number];
}

/**
 * MASTER PROMPT §6 — moving a referenced object updates dependent
 * geometry. Collects (without applying) the parameter patches for every
 * endpoint-constraint dependent of the moved elements:
 *   • wall-column constraints re-resolve the wall endpoint against the
 *     column's NEW footprint (already moved by the caller);
 *   • plain endpoint constraints translate the bound endpoint by the
 *     same delta so coincident corners stay coincident.
 * Callers fold the patches into the SAME undo transaction as the move.
 */
function collectDependentPatches(movedIds: string[], dx: number, dz: number): ParamPatch[] {
  const registry = snapRegistry();
  if (!registry) return [];
  const moved = new Set(movedIds);
  const seenRel = new Set<string>();
  const patches: ParamPatch[] = [];
  for (const mid of movedIds) {
    let deps: any[] = [];
    try { deps = registry.getRelationshipDependents(mid) ?? []; } catch { continue; }
    for (const rec of deps) {
      if (rec.type !== "endpoint-constraint" || seenRel.has(rec.id)) continue;
      seenRel.add(rec.id);
      const depId = rec.target?.elementId;
      if (!depId || moved.has(depId)) continue;
      const dep = elements.find((x) => x.id === depId);
      if (!dep || dep.properties?.pinned) continue;
      if (!dep.params.start || !dep.params.end) continue;

      let newEndpoint: [number, number] | null = null;

      if (rec.source?.kind === "edge") {
        // Wall-column: re-resolve the endpoint against the column's
        // CURRENT (already moved) footprint.
        const col = elements.find((x) => x.id === mid && (x.type === "column" || x.type === "footing"));
        if (col?.params.point) {
          try {
            const t = col.params.thickness ?? 0.3;
            const d = col.params.depth ?? t;
            const [cx, cz] = col.params.point;
            const baseZ = col.params.elevation ?? 0;
            const colRef = {
              elementId: col.id,
              footprint: [
                [cx - t / 2, cz - d / 2], [cx + t / 2, cz - d / 2],
                [cx + t / 2, cz + d / 2], [cx - t / 2, cz + d / 2],
              ] as Array<[number, number]>,
              baseZ,
              topZ: baseZ + (col.params.height ?? 3),
              isRectangle: true,
            };
            const justificationMap: Record<string, WallColumnLine["justification"]> = {
              "wall-centerline": "core-centerline",
              "core-centerline": "core-centerline",
              "finish-exterior": "finish-face-exterior",
              "finish-interior": "finish-face-interior",
              "core-exterior": "finish-face-exterior",
              "core-interior": "finish-face-interior",
            };
            const wallLine = toWallColumnLine({
              start: dep.params.start,
              end: dep.params.end,
              width: dep.params.thickness ?? 0.2,
              justification: justificationMap[(dep.properties as any)?.locationLine as string] ?? "core-centerline",
            });
            const resolved = calculateWallEndpoint(wallLine, colRef);
            if (resolved) {
              newEndpoint = resolved.endpoint;
            }
          } catch { /* fall through to plain follow */ }
        }
      }

      if (!newEndpoint) {
        // Plain follow-source: translate the bound endpoint by the delta.
        const tp = rec.target.position;
        const startD = dist2XZ(dep.params.start[0], dep.params.start[1], tp[0], tp[1]);
        const endD = dist2XZ(dep.params.end[0], dep.params.end[1], tp[0], tp[1]);
        newEndpoint = startD <= endD
          ? [dep.params.start[0] + dx, dep.params.start[1] + dz]
          : [dep.params.end[0] + dx, dep.params.end[1] + dz];
      }
      if (!newEndpoint) continue;

      const before = JSON.parse(JSON.stringify(dep.params)) as AuthoredElement["params"];
      const after = JSON.parse(JSON.stringify(dep.params)) as AuthoredElement["params"];
      const startIsBound = dist2XZ(after.start![0], after.start![1], newEndpoint[0], newEndpoint[1]) <=
        dist2XZ(after.end![0], after.end![1], newEndpoint[0], newEndpoint[1]);
      if (startIsBound) after.start = newEndpoint;
      else after.end = newEndpoint;
      patches.push({ el: dep, before, after, relationshipId: rec.id, endpoint: newEndpoint });
    }
  }
  return patches;
}

/** Push refreshed reference positions into the registry after a move. */
function refreshDependentRefs(patches: ParamPatch[]): void {
  const registry = snapRegistry();
  if (!registry) return;
  for (const p of patches) {
    try {
      registry.updateRelationshipReference(p.relationshipId, "target", {
        elementId: p.el.id,
        kind: "endpoint",
        position: [p.endpoint[0], p.endpoint[1], p.el.params.elevation ?? 0],
      });
    } catch { /* registry optional */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Slab / params
// ═══════════════════════════════════════════════════════════════════════════
function finishSlab() {
  if (poly.length >= 3) {
    const type = activeTool === "terrain" ? "terrain" : "slab";
    void createElement(type as any, { polygon: poly.map((p) => [snap(p.x), snap(p.z)] as Vec2) });
  }
  poly = [];
  clearPreviews();
  try { accuDraw.end(); } catch { /* */ }
}


function rejectInvalidOperation(
  candidateElements: AuthoredElement[],
  affectedIds: Set<string>,
  operation: string,
): boolean {
  const diagnostics = validateNativeModel({ elements: candidateElements, levels, grids })
    .filter((diagnostic) => diagnostic.elementId != null && affectedIds.has(diagnostic.elementId) && diagnostic.severity === "error");
  if (!diagnostics.length) return false;
  const details = diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\\n");
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: {
      message: `Cannot ${operation}. The operation would create invalid geometry.\\n${details}`,
      kind: "error",
    },
  }));
  return true;
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
    case "curtain-wall":
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

          const tool = activeTool as ElementType;
          const dp = effectiveDrawParams(tool);
          const placed = justifyLinearSegment(tool, startPt, endPt, dp);
          // MASTER PROMPT §3.3 — the committed element records HOW it sits
          // on the reference, so later edits can reproduce the offset.
          const drawProps: Record<string, unknown> = {};
          if (tool === "wall" || tool === "curtain-wall") {
            drawProps.locationLine = wallLocationLine;
            drawProps.joinStatus = wallJoinStatus;
            drawProps.chain = wallChain;
          }
          const snapAtClick = lastSnapResult;
          void createElement(tool, {
            start: placed.start,
            end: placed.end,
            elevation: placed.elevation,
            endElevation: placed.endElevation,
          }, drawProps).then((el) => {
            if (el) {
              void recordSnapRelationships(el, snapAtClick);
              // Keep the slope-chaining state coherent for 3D chains too
              // (reference-path end, so chained matches work under any
              // justification).
              if (FITTED_TYPES.has(tool)) {
                lastPlanLinear = {
                  type: tool,
                  end: [endPt.x, endPt.z],
                  dir: newDir,
                  thickness: dp.thickness,
                  height: dp.height,
                  elevation: placed.elevation ?? level,
                  endElevation: placed.endElevation,
                  id: el.id,
                };
              }
            }
          });
          chainStartDir = newDir;
          // Chain continues along the REFERENCE path (the justified face
          // stays bound to it), matching BIM chain drawing.
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
    case "terrain":
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
          if (!rejectInvalidOperation([...elements, clone], new Set([clone.id]), `copy ${src.name}`)) {
            history.exec({
              label: `Copy ${src.name}`,
              apply: () => { elements.push(clone); rebuild(); markDirty(); },
              revert: () => { const i = elements.indexOf(clone); if (i >= 0) elements.splice(i, 1); rebuild(); markDirty(); },
            });
          }
        } else {
          const movers = expandConnectedIds([src.id])
            .map((mid) => elements.find((x) => x.id === mid))
            .filter((x): x is AuthoredElement => !!x && !x.properties?.pinned);
          const candidates = movers.map((m0) => { const c = JSON.parse(JSON.stringify(m0)) as AuthoredElement; shiftParams(c, dx, dz); return c; });
          const candById = new Map(candidates.map((c) => [c.id, c]));
          if (!rejectInvalidOperation(elements.map((item) => candById.get(item.id) ?? item), new Set(movers.map((m0) => m0.id)), `move ${src.name}`)) {
            // MASTER PROMPT §6 — dependents follow the move in the SAME
            // undo transaction (endpoint constraints / wall-column binds).
            const depPatches = collectDependentPatches(movers.map((m0) => m0.id), dx, dz);
            const snaps = movers.map((m0) => ({ el: m0, before: JSON.parse(JSON.stringify(m0.params)), after: JSON.parse(JSON.stringify(candById.get(m0.id)!.params)) }));
            history.push({
              label: movers.length > 1 ? `Move ${src.name} + ${movers.length - 1} connected` : `Move ${src.name}`,
              apply: () => {
                for (const o of snaps) o.el.params = JSON.parse(JSON.stringify(o.after));
                for (const p of depPatches) p.el.params = JSON.parse(JSON.stringify(p.after));
                rebuild(); markDirty();
              },
              revert: () => {
                for (const o of snaps) o.el.params = JSON.parse(JSON.stringify(o.before));
                for (const p of depPatches) p.el.params = JSON.parse(JSON.stringify(p.before));
                rebuild(); markDirty();
              },
            });
            for (const o of snaps) o.el.params = JSON.parse(JSON.stringify(o.after));
            for (const p of depPatches) p.el.params = JSON.parse(JSON.stringify(p.after));
            refreshDependentRefs(depPatches);
            rebuild();
            markDirty();
          }
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
      const candidates = targets.map((t) => {
        const candidate: AuthoredElement = JSON.parse(JSON.stringify(t));
        rotateElement(candidate, op.center!, angle);
        return candidate;
      });
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const candidateElements = elements.map((item) => candidateById.get(item.id) ?? item);
      if (!rejectInvalidOperation(candidateElements, new Set(candidates.map((candidate) => candidate.id)), "rotate selected elements")) {
        const before = targets.map((t) => JSON.parse(JSON.stringify(t.params)));
        const after = candidates.map((candidate) => JSON.parse(JSON.stringify(candidate.params)));
        history.push({
          label: `Rotate ${targets.length} element(s)`,
          apply: () => { targets.forEach((t, i) => (t.params = JSON.parse(JSON.stringify(after[i])))); rebuild(); markDirty(); },
          revert: () => { targets.forEach((t, i) => (t.params = JSON.parse(JSON.stringify(before[i])))); rebuild(); markDirty(); },
        });
        targets.forEach((t, i) => (t.params = JSON.parse(JSON.stringify(after[i]))));
        rebuild();
        markDirty();
      }
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
        const axisLength = Math.hypot(op.axisB.x - op.axisA.x, op.axisB.z - op.axisA.z);
        if (axisLength < 1e-6) {
          window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Mirror axis must have a non-zero length.", kind: "error" } }));
        } else if (!rejectInvalidOperation([...elements, ...clones], new Set(clones.map((clone) => clone.id)), "mirror selected elements")) {
          history.exec({
            label: `Mirror ${clones.length} element(s)`,
            apply: () => { for (const c of clones) elements.push(c); rebuild(); markDirty(); },
            revert: () => { for (const c of clones) { const i = elements.indexOf(c); if (i >= 0) elements.splice(i, 1); } rebuild(); markDirty(); },
          });
        }
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
        const count = Math.floor(Number(countStr));
        const spacingStr = prompt("Spacing (m)?", "3.0");
        const spacing = Number(spacingStr);
        if (!Number.isFinite(count) || count < 1 || count > 500 ||
            !Number.isFinite(spacing) || spacing <= 0) {
          window.dispatchEvent(new CustomEvent("obs-toast", {
            detail: { message: "Array requires 1–500 copies and a positive spacing.", kind: "error" },
          }));
          pendingOp = { kind: "none" };
          updateLabel();
          return;
        }
        op.count = count;
        op.spacing = spacing;
        updateLabel();
        return;
      }

      const dxRaw = pt.x - op.base.x;
      const dzRaw = pt.z - op.base.z;
      const length = Math.hypot(dxRaw, dzRaw);
      if (length < 1e-6) {
        window.dispatchEvent(new CustomEvent("obs-toast", {
          detail: { message: "Choose a direction point different from the array base point.", kind: "error" },
        }));
        pendingOp = { kind: "none" };
        updateLabel();
        return;
      }

      const count = op.count ?? 3;
      const spacing = op.spacing ?? 3;
      const dirX = dxRaw / length;
      const dirZ = dzRaw / length;
      const targets = elements.filter((el) => op.ids.includes(el.id) && !el.properties?.pinned);
      const clones: AuthoredElement[] = [];
      for (let i = 1; i <= count; i++) {
        for (const t of targets) {
          const c: AuthoredElement = JSON.parse(JSON.stringify(t));
          c.id = uid();
          c.name = `${t.name} (${i})`;
          if (c.hostId) c.hostId = undefined;
          shiftParams(c, dirX * spacing * i, dirZ * spacing * i);
          clones.push(c);
        }
      }
      if (!clones.length) {
        window.dispatchEvent(new CustomEvent("obs-toast", {
          detail: { message: "Select at least one unpinned element before creating an array.", kind: "info" },
        }));
      } else if (!rejectInvalidOperation([...elements, ...clones], new Set(clones.map((clone) => clone.id)), "array selected elements")) {
        history.exec({
          label: `Array ${targets.length} element(s) × ${count}`,
          apply: () => { for (const c of clones) elements.push(c); rebuild(); markDirty(); },
          revert: () => { for (const c of clones) { const i = elements.indexOf(c); if (i >= 0) elements.splice(i, 1); } rebuild(); markDirty(); },
        });
      }
      pendingOp = { kind: "none" };
      updateLabel();
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
// Previews + BIM-style dashed alignment guides
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

/** Dashed construction line (BIM-style). */
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
 * BIM-like alignment guides while drawing:
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
    const toolKey = activeTool as ElementType;
    const d = effectiveDrawParams(toolKey);
    const a = chainStart;
    const len = Math.hypot(pt.x - a.x, pt.z - a.z);
    if (len > 0.05) {
      const placed = justifyLinearSegment(toolKey, a, pt, d);
      const [ax, az] = placed.start;
      const [bx, bz] = placed.end;
      const ghostLen = Math.max(Math.hypot(bx - ax, bz - az), 0.05);
      preview = new THREE.Mesh(new THREE.BoxGeometry(ghostLen, d.height, d.thickness), pm);
      preview.position.set((ax + bx) / 2, (placed.elevation ?? level) + d.height / 2, (az + bz) / 2);
      (preview as THREE.Mesh).rotation.y = Math.atan2(-(bz - az), bx - ax);
      previewGroup.add(preview);
      // BIM-style dashed alignment / extension guides, then the
      // MASTER PROMPT §3.3 reference-line visualisation on top: the
      // reference path (light), offset ties (yellow) to the justified face.
      try {
        updateAlignmentGuides(a, pt);
        const moved = Math.hypot(ax - a.x, az - a.z) + Math.hypot(bx - pt.x, bz - pt.z);
        if (moved > 1e-4) {
          const gy = level + 0.02;
          guideGroup.add(dashedLine(
            new THREE.Vector3(a.x, gy, a.z),
            new THREE.Vector3(pt.x, gy, pt.z),
            0xe2e8f0, 0.12, 0.08,
          ));
          guideGroup.add(dashedLine(
            new THREE.Vector3(a.x, gy, a.z),
            new THREE.Vector3(ax, gy, az),
            0xfacc15, 0.08, 0.05,
          ));
          guideGroup.add(dashedLine(
            new THREE.Vector3(pt.x, gy, pt.z),
            new THREE.Vector3(bx, gy, bz),
            0xfacc15, 0.08, 0.05,
          ));
        }
      } catch { /* */ }
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
  const SEL = 0x2563eb;
  const tag = (o: THREE.Object3D, kind: "grid" | "level", id: string) => { o.userData.datumKind = kind; o.userData.datumId = id; };
  for (const gr of grids) {
    const sel = selectedDatum?.kind === "grid" && selectedDatum.id === gr.id;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(gr.start[0], -5, gr.start[1]),
      new THREE.Vector3(gr.end[0], 15, gr.end[1]),
    ]);
    const mat = sel
      ? new THREE.LineBasicMaterial({ color: SEL, depthTest: false })
      : new THREE.LineDashedMaterial({ color: 0xf59e0b, dashSize: 0.4, gapSize: 0.25 });
    const line = new THREE.Line(geo, mat);
    if (sel) line.renderOrder = 950;
    line.computeLineDistances();
    tag(line, "grid", gr.id);
    datumGroup.add(line);
    const spr = makeLabelSprite(gr.label, sel ? "#60a5fa" : undefined);
    spr.position.set(gr.end[0], 15.6, gr.end[1]);
    if (sel) spr.scale.set(1.3, 1.3, 1);
    tag(spr, "grid", gr.id);
    datumGroup.add(spr);
  }
  for (const lv of levels) {
    const sel = selectedDatum?.kind === "level" && selectedDatum.id === lv.id;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-25, lv.elevation, 0),
      new THREE.Vector3(25, lv.elevation, 0),
    ]);
    const mat = sel
      ? new THREE.LineBasicMaterial({ color: SEL, depthTest: false })
      : new THREE.LineDashedMaterial({ color: 0x22d3ee, dashSize: 0.5, gapSize: 0.25 });
    const line = new THREE.Line(geo, mat);
    if (sel) line.renderOrder = 950;
    line.computeLineDistances();
    tag(line, "level", lv.id);
    datumGroup.add(line);
    const spr = makeLabelSprite(lv.name.replace(/[^0-9]/g, "") || "L", sel ? "#60a5fa" : "#22d3ee");
    spr.position.set(25.8, lv.elevation, 0);
    if (sel) spr.scale.set(1.3, 1.3, 1);
    tag(spr, "level", lv.id);
    datumGroup.add(spr);
  }
}

/** Pick a grid line or level under the cursor (screen-space tolerance ~1% of view distance). */
function datumAt(e: MouseEvent): { kind: "grid" | "level"; id: string } | null {
  try {
    if (!ctx.world?.camera?.three || !datumGroup.children.length) return null;
    const cam = ctx.world.camera.three as THREE.Camera;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndcOf(e), cam);
    let best: { kind: "grid" | "level"; id: string; d: number } | null = null;
    const onRay = new THREE.Vector3(), onSeg = new THREE.Vector3();
    for (const o of datumGroup.children) {
      const kind = o.userData.datumKind, id = o.userData.datumId;
      if (!kind || !id) continue;
      let d = Infinity;
      if ((o as THREE.Line).isLine) {
        const pos = (o as THREE.Line).geometry.getAttribute("position");
        const a = new THREE.Vector3().fromBufferAttribute(pos, 0);
        const b = new THREE.Vector3().fromBufferAttribute(pos, 1);
        const d2 = ray.ray.distanceSqToSegment(a, b, onRay, onSeg);
        const tol = Math.max(0.05, onRay.distanceTo(ray.ray.origin) * 0.012);
        if (d2 <= tol * tol) d = Math.sqrt(d2) / tol;
      } else if ((o as THREE.Sprite).isSprite) {
        const hit = ray.intersectObject(o, false)[0];
        if (hit) d = 0.5;
      }
      if (d < Infinity && (!best || d < best.d)) best = { kind, id, d };
    }
    return best ? { kind: best.kind, id: best.id } : null;
  } catch { return null; }
}

function setDatumSelection(sel: { kind: "grid" | "level"; id: string } | null): void {
  const same = (!sel && !selectedDatum) || (sel && selectedDatum && sel.kind === selectedDatum.kind && sel.id === selectedDatum.id);
  selectedDatum = sel;
  if (!same) rebuildDatums();
  refreshEditor();
}

export function getSelectedDatum() { return selectedDatum ? { ...selectedDatum } : null; }
export function selectDatum(kind: "grid" | "level", id: string): boolean {
  const exists = kind === "grid" ? grids.some((g) => g.id === id) : levels.some((l) => l.id === id);
  if (!exists) return false;
  selectedIds.clear();
  applySelection(); refreshGrips();
  setDatumSelection({ kind, id });
  notifyAuthoringChange();
  return true;
}

/** Delete a grid or level (undoable). Elements on a deleted level are kept but unconstrained. */
export function deleteDatum(kind: "grid" | "level", id: string): boolean {
  if (kind === "grid") {
    const idx = grids.findIndex((g) => g.id === id);
    if (idx < 0) return false;
    const gr = grids[idx];
    history.push({
      label: `Delete grid ${gr.label}`,
      apply: () => { const i = grids.findIndex((g) => g.id === id); if (i >= 0) grids.splice(i, 1); if (selectedDatum?.id === id) selectedDatum = null; rebuildDatums(); refreshEditor(); markDirty(); notifyAuthoringChange(); },
      revert: () => { grids.splice(Math.min(idx, grids.length), 0, gr); rebuildDatums(); markDirty(); notifyAuthoringChange(); },
    });
    const i = grids.findIndex((g) => g.id === id); grids.splice(i, 1);
    if (selectedDatum?.id === id) selectedDatum = null;
    rebuildDatums(); refreshEditor(); markDirty(); notifyAuthoringChange();
    notify("info", `Deleted grid ${gr.label}`);
    return true;
  }
  const idx = levels.findIndex((l) => l.id === id);
  if (idx < 0) return false;
  const lv = levels[idx];
  const wasActive = activeLevelId === id;
  const owned = elements.filter((e) => e.levelId === id);
  const doDelete = () => {
    const i = levels.findIndex((l) => l.id === id); if (i >= 0) levels.splice(i, 1);
    for (const e of owned) delete e.levelId;
    if (activeLevelId === id) activeLevelId = null;
    if (selectedDatum?.id === id) selectedDatum = null;
    rebuildDatums(); refreshEditor(); markDirty(); notifyAuthoringChange();
  };
  history.push({
    label: `Delete level ${lv.name}`,
    apply: doDelete,
    revert: () => {
      levels.splice(Math.min(idx, levels.length), 0, lv);
      for (const e of owned) e.levelId = id;
      if (wasActive) activeLevelId = id;
      rebuildDatums(); markDirty(); notifyAuthoringChange();
    },
  });
  doDelete();
  notify("info", owned.length ? `Deleted ${lv.name} (${owned.length} element(s) no longer constrained to it)` : `Deleted ${lv.name}`);
  return true;
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
    // Resolve which param key changed for geometry sync
    const changedKey = (() => {
      for (const k of Object.keys(after)) {
        if (JSON.stringify((before as any)[k]) !== JSON.stringify((after as any)[k])) return k;
      }
      return "height";
    })();
    history.push(
      {
        label: `Edit ${el.name} · ${getLabel()}`,
        apply: () => {
          el.params = JSON.parse(JSON.stringify(after));
          rebuild();
          markDirty();
        },
        revert: () => {
          el.params = JSON.parse(JSON.stringify(before));
          rebuild();
          markDirty();
        },
      },
      coalesceKey,
    );
    el.params = JSON.parse(JSON.stringify(before));
    applyElementParamChange(el.id, changedKey, (after as any)[changedKey]);
  });
}

function selectInput<T extends string>(
  value: T,
  options: { v: T; label: string }[],
  on: (v: T) => void,
): HTMLSelectElement {
  const s = document.createElement("select");
  s.style.cssText = INP;
  s.innerHTML = options.map((o) => `<option value="${escapeHtml(o.v)}" ${o.v === value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("");
  s.onchange = () => on(s.value as T);
  return s;
}

function refreshDatumEditor(): void {
  const sd = selectedDatum!;
  editor.style.display = "block";
  editor.innerHTML = "";
  const title = document.createElement("div");
  title.style.cssText = "font-weight:700;margin-bottom:8px";
  editor.appendChild(title);
  const del = document.createElement("button");
  del.textContent = "\u{1F5D1} Delete " + sd.kind;
  del.style.cssText = "width:100%;padding:6px;margin-top:4px;background:#3b0d0d;color:#fca5a5;border:1px solid #ef4444;border-radius:5px;cursor:pointer;font-size:11px";
  del.onclick = () => deleteDatum(sd.kind, sd.id);
  if (sd.kind === "grid") {
    const gr = grids.find((g) => g.id === sd.id);
    if (!gr) { editor.style.display = "none"; return; }
    title.textContent = `Grid ${gr.label}`;
    const lab = document.createElement("input"); lab.value = gr.label; lab.style.cssText = INP;
    lab.onchange = () => {
      const before = gr.label, after = lab.value.trim() || before;
      history.push({ label: `Rename grid ${before}`,
        apply: () => { gr.label = after; rebuildDatums(); markDirty(); notifyAuthoringChange(); },
        revert: () => { gr.label = before; rebuildDatums(); markDirty(); notifyAuthoringChange(); } });
      gr.label = after; rebuildDatums(); markDirty(); notifyAuthoringChange(); refreshEditor();
    };
    editor.appendChild(field("Name", lab));
    const info = document.createElement("div");
    const len = Math.hypot(gr.end[0] - gr.start[0], gr.end[1] - gr.start[1]);
    info.style.cssText = "font-size:11px;opacity:.8;margin-bottom:6px;line-height:1.5";
    info.textContent = `Start ${gr.start[0].toFixed(2)}, ${gr.start[1].toFixed(2)}  End ${gr.end[0].toFixed(2)}, ${gr.end[1].toFixed(2)}  Length ${len.toFixed(2)} m`;
    editor.appendChild(info);
  } else {
    const lv = levels.find((l) => l.id === sd.id);
    if (!lv) { editor.style.display = "none"; return; }
    title.textContent = `Level \u2014 ${lv.name}`;
    const nm = document.createElement("input"); nm.value = lv.name; nm.style.cssText = INP;
    nm.onchange = () => {
      const before = lv.name, after = nm.value.trim() || before;
      history.push({ label: `Rename ${before}`,
        apply: () => { lv.name = after; rebuildDatums(); markDirty(); notifyAuthoringChange(); },
        revert: () => { lv.name = before; rebuildDatums(); markDirty(); notifyAuthoringChange(); } });
      lv.name = after; rebuildDatums(); markDirty(); notifyAuthoringChange(); refreshEditor();
    };
    editor.appendChild(field("Name", nm));
    editor.appendChild(field("Elevation (m)", numInput(lv.elevation, 0.05, (v) => {
      if (!Number.isFinite(v)) return;
      const before = lv.elevation;
      history.push({ label: `Set ${lv.name} elevation`,
        apply: () => { lv.elevation = v; if (activeLevelId === lv.id) level = v; rebuildDatums(); markDirty(); notifyAuthoringChange(); },
        revert: () => { lv.elevation = before; if (activeLevelId === lv.id) level = before; rebuildDatums(); markDirty(); notifyAuthoringChange(); } });
      lv.elevation = v; if (activeLevelId === lv.id) level = v; rebuildDatums(); markDirty(); notifyAuthoringChange();
    })));
    const act = document.createElement("button");
    act.textContent = activeLevelId === lv.id ? "Active level" : "Make active level";
    act.disabled = activeLevelId === lv.id;
    act.style.cssText = "width:100%;padding:6px;margin-bottom:4px;background:#12131a;color:#e2e8f0;border:1px solid #3a3a4a;border-radius:5px;cursor:pointer;font-size:11px";
    act.onclick = () => { setActiveLevelById(lv.id); notifyAuthoringChange(); refreshEditor(); };
    editor.appendChild(act);
  }
  editor.appendChild(del);
}

function refreshEditor() {
  if (selectedDatum && selectedIds.size === 0 && activeTool === "select") { refreshDatumEditor(); return; }
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
    case "slab":
    case "terrain": addNum("Thickness (m)", "height", 0.05); break;
    case "fitting":
      addNum("Height (m)", "height", 0.05);
      addNum("Width/diameter (m)", "thickness", 0.05);
      break;
  }

  editor.appendChild(field("Elevation (m)", historyNum("elevation", el, (v) => (el.params.elevation = v), el.params.elevation, 0.1)));

  if (MEP_LINEAR_TYPES.has(el.type) && el.params.start && el.params.end) {
    const horiz = () => Math.hypot(el.params.end![0] - el.params.start![0], el.params.end![1] - el.params.start![1]);
    editor.appendChild(field("Slope (%, + rises to end)", historyNum("slope", el, (v) => {
      el.params.endElevation = Math.abs(v) < 1e-9 ? undefined : endElevationFromSlope(el.params.elevation, horiz(), v);
    }, +slopePercent(el.params.elevation, el.params.endElevation, horiz()).toFixed(3), 0.1)));
    editor.appendChild(field("End elevation (m)", historyNum("end-elevation", el, (v) => {
      el.params.endElevation = Math.abs(v - el.params.elevation) < 1e-9 ? undefined : v;
    }, el.params.endElevation ?? el.params.elevation, 0.1)));
  }

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
      else suffix = " — click direction point";
      break;
    case "offset":
      if (!pendingOp.id) suffix = " — click a wall/line";
      else if (!pendingOp.base) suffix = " — click offset side";
      break;
  }
  activeToolLabel.textContent = `Active Tool: ${activeTool ? cap(activeTool) : "None"}${activeTool && TOOL_HINTS[activeTool] ? ` · ${TOOL_HINTS[activeTool]}${suffix}` : ""}`;
}

export function isDrawingActive() { return activeTool !== null && activeTool !== "select"; }

/** True when a placement/draw tool is active (panel auto-open signal). */
export function isDrawToolActive(): boolean {
  return activeTool !== null && DRAW_TOOLS.has(activeTool);
}

/**
 * Re-run the placement preview with the last known pointer position so a
 * parameter change in the modeling panel updates the ghost immediately
 * (MASTER PROMPT §2.3 "update the modeling preview immediately").
 */
export function refreshPreview(): void {
  if (!activeTool || activeTool === "select") return;
  try { updatePreview(lastHoverEvent); } catch { /* */ }
}

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
  if (activeTool !== "select") { selectedIds.clear(); if (selectedDatum) setDatumSelection(null); }
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
  // BIM-style: if a named level exists at this elevation, adopt it.
  const hit = levels.find((l) => Math.abs(l.elevation - v) <= 0.001);
  if (hit) activeLevelId = hit.id;
}
export function getLevel() { return level; }

/** BIM-style active level id. Null when no named level is selected. */
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
/** BIM-style active family id. Null when no family is selected. */
export function getActiveFamilyId(): string | null { return activeFamilyId; }

/** BIM-style active family type id. Null when no type is selected. */
export function getActiveFamilyTypeId(): string | null { return activeFamilyTypeId; }

/** BIM-style: the family/type the NEXT placed element will adopt. */
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
  return elementTypeFromIfcEntity(entity);
}


/** Capture reference dimensions once so later param edits can scale/regenerate. */
function ensureNativeBaseDimensions(el: AuthoredElement): void {
  const props = (el.properties ??= {}) as Record<string, unknown>;
  if (props.nativeBaseHeight == null && Number.isFinite(el.params.height) && (el.params.height as number) > 0) {
    props.nativeBaseHeight = el.params.height;
  }
  if (props.nativeBaseThickness == null && Number.isFinite(el.params.thickness) && (el.params.thickness as number) > 0) {
    props.nativeBaseThickness = el.params.thickness;
  }
  if (props.nativeBaseWidth == null) {
    const w = (el.params.width ?? el.params.depth) as number | undefined;
    if (Number.isFinite(w) && (w as number) > 0) props.nativeBaseWidth = w;
  }
  if (props.nativeBaseLength == null && el.params.start && el.params.end) {
    const len = Math.hypot(
      (el.params.end[0] as number) - (el.params.start[0] as number),
      (el.params.end[1] as number) - (el.params.start[1] as number),
    );
    if (Number.isFinite(len) && len > 1e-6) props.nativeBaseLength = len;
  }
  // Derive from geometry if still missing
  if (props.nativeBaseHeight == null && el.nativeGeometry?.positions?.length) {
    const pos = el.nativeGeometry.positions;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      const y = pos[i];
      if (Number.isFinite(y)) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    if (Number.isFinite(minY) && maxY > minY) props.nativeBaseHeight = maxY - minY;
  }
}

/**
 * Authoritative parametric property update used by the Properties panel and
 * inline editors. Updates params, regenerates geometry via rebuild, and
 * keeps Native Twin gizmo clones in sync when present.
 */
export function applyElementParamChange(
  elementId: string,
  key: string,
  value: number | string | boolean,
): { ok: boolean; reason?: string } {
  const el = elements.find((e) => e.id === elementId);
  if (!el) return { ok: false, reason: "element_not_found" };
  ensureNativeBaseDimensions(el);
  const before = JSON.parse(JSON.stringify(el.params));
  const candidateParams = JSON.parse(JSON.stringify(el.params));
  (candidateParams as any)[key] = value;
  const candidate: AuthoredElement = { ...el, params: candidateParams };
  const diagnostics = validateNativeModel({
    elements: elements.map((item) => (item.id === el.id ? candidate : item)),
    levels,
    grids,
  }).filter((d) => d.elementId === el.id && d.severity === "error");
  if (diagnostics.length) {
    return { ok: false, reason: diagnostics.map((d) => d.code + ": " + d.message).join("; ") };
  }
  el.params = candidateParams;
  // Snapshot frozen mesh provenance; createMesh prefers parametric solids when capable.
  const mode = String((el.properties as any)?.editMode ?? "");
  const geomKeys = new Set(["height", "thickness", "width", "depth", "elevation", "sillHeight", "offsetAlongHost", "frameThickness"]);
  if (el.nativeGeometry && geomKeys.has(key)) {
    (el.properties as any).nativeGeometrySnapshot = el.nativeGeometry;
    // Parametric modes keep nativeGeometry for provenance but rebuild via builders / scaled mesh.
  }
  // Preserve Layer 2 archive; mark dimension fields as native-modified only.
  try {
    markNativeDimensionModified(el.sourceArchive, key);
  } catch { /* */ }
  try {
    rebuild();
  } catch (err) {
    // Atomic edit: geometry regeneration failed -> restore the previous valid parameters.
    el.params = before;
    try { rebuild(); } catch { /* keep going; previous state restored in the model */ }
    return { ok: false, reason: "geometry_regeneration_failed: " + (err instanceof Error ? err.message : String(err)) };
  }
  markDirty();
  notifyAuthoringChange();
  try {
    const fe: any = (ctx.features as any)?.fragEdit;
    const twins = fe?.list?.() as any[] | undefined;
    if (twins?.length) {
      for (const t of twins) {
        if (t.nativeElementId === el.id && Array.isArray(t.position)) {
          // Keep the gizmo twin on the authored mesh's real placement. (Do NOT derive it from
          // elevation + height/2: that assumes the mesh origin is its vertical centre.)
          if (key === "height") {
            const obj = group.children.find((c: any) => c.userData?.elementId === el.id && c.userData?.nativeTwin) as THREE.Object3D | undefined;
            if (obj) t.position = [obj.position.x, obj.position.y, obj.position.z];
          }
        }
      }
    }
  } catch { /* optional */ }
  console.info(
    `[authoring] param ${key}=${String(value)} applied to ${el.id} (${el.type}); geometry rebuilt`,
  );
  return { ok: true };
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
  /** Full source item record from getItemsData (Layer 2 archive). */
  sourceRawItem?: unknown;
  sourceArchive?: SourceArchive;
  geometryProvenance?: {
    extractionPath?: string;
    triangleCount?: number;
    meshCount?: number;
    vertexCount?: number;
    bounds?: { min: [number, number, number]; max: [number, number, number]; center: [number, number, number] };
    modelMatrixWorld?: number[];
  };
}): AuthoredElement {
  const id = uid();
  const type = nativeElementTypeFromIfc(input.entity);
  const pos = input.position;
  // Reject non-finite geometry — prevents WebGL corruption / black viewport.
  const positions = input.positions ?? [];
  if (positions.length < 9) {
    throw new Error("Native twin geometry has insufficient positions");
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      throw new Error(`Native twin geometry has non-finite coordinate at index ${i}`);
    }
  }
  for (const n of [...input.position, ...input.quaternion, ...input.scale]) {
    if (!Number.isFinite(n)) {
      throw new Error("Native twin transform contains non-finite values");
    }
  }

  // Recover parametric definition from exact source geometry (all disciplines).
  const derived = deriveLinearParamsFromPositions(
    positions,
    input.position,
    input.quaternion,
    input.scale,
  );
  const planPoly = derivePlanAabbPolygon(positions, input.position, input.scale);
  const height = derived?.height ?? input.dimensions?.height ?? 0;
  const thickness = derived?.thickness ?? input.dimensions?.depth ?? input.dimensions?.width ?? 0.2;
  const elevation = derived?.elevation ?? input.position[1] - (height || 0) / 2;
  const width = input.dimensions?.width ?? thickness;
  const depth = input.dimensions?.depth ?? thickness;
  // Plan point = centre of the placed footprint, NOT the mesh origin (IFC origins are often a corner/base).
  const fpc = footprintCenterXZ(positions, input.position, input.quaternion, input.scale);
  const point: [number, number] = fpc ?? [pos[0], pos[2]];
  const useLinear = LINEAR_ELEMENT_TYPES.has(type) && !!(derived && derived.reliable);
  const useVertical = !useLinear && (
    type === "column" || type === "footing" || type === "equipment" || type === "fitting"
  );
  const useSlab = !useLinear && !useVertical && !!planPoly && (
    type === "slab" || type === "roof" || type === "ceiling" || type === "terrain" || type === "room" || type === "area"
  );

  const caps = classifyTwinCapabilities({
    type,
    hasPositions: positions.length >= 9,
    hasLinearBaseline: useLinear,
    linearReliable: !!(derived && derived.reliable),
    hasPoint: useVertical || !!point,
    hasPolygon: !!planPoly && (useSlab || type === "slab"),
    vertexCount: Math.floor(positions.length / 3),
  });
  // Prefer category-specific parametric modes when recovery succeeded.
  // Visual mode is always source-mesh for Digital Twins. Parametric capability is
  // recorded separately so Properties can edit dimensions without replacing geometry
  // with an approximate box (which caused wall rotation/shape loss).
  let editMode = "boundary-mesh";
  let parametricCapability: string = caps.editMode;
  if (useLinear) parametricCapability = "parametric-linear";
  else if (useVertical) parametricCapability = "parametric-vertical";
  else if (useSlab) parametricCapability = "parametric-slab";

  const el: AuthoredElement = {
    id, type,
    name: input.name || `${type} native twin`,
    color: input.color,
    params: {
      point,
      height,
      thickness,
      elevation,
      width,
      depth,
      ...(useLinear && derived ? { start: derived.start, end: derived.end } : {}),
      ...(useSlab && planPoly ? { polygon: planPoly } : {}),
    },
    properties: {
      nativeTwin: true,
      nativeBaseHeight: height,
      nativeBaseThickness: thickness,
      nativeBaseWidth: width,
      nativeBaseLength: useLinear && derived ? Math.hypot(derived.end[0] - derived.start[0], derived.end[1] - derived.start[1]) : undefined,
      editMode,
      parametricCapability,
      forceParametricSolid: false,
      preserveSourceGeometry: true,
      twinCapabilities: caps.notes,
      sourceModelId: input.sourceModelId,
      sourceLocalId: input.sourceLocalId,
      sourceGlobalId: input.sourceGlobalId || input.globalId,
      sourceModelName: input.sourceModelName,
      editable: editMode !== "read-only",
      pinned: false,
    },
    nativeGeometry: { positions: [...positions] },
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
    sourceArchive: input.sourceArchive ?? buildSourceArchive({
      rawItem: input.sourceRawItem ?? {
        propertySets: input.propertySets,
        quantities: input.quantities,
        GlobalId: input.globalId,
        Name: input.name,
        Description: input.description,
        Tag: input.tag,
        PredefinedType: input.predefinedType,
        Entity: input.entity,
      },
      identity: {
        sourceModelId: input.sourceModelId,
        sourceLocalId: input.sourceLocalId,
        sourceModelName: input.sourceModelName,
        globalId: input.globalId || input.sourceGlobalId,
        entityType: input.entity,
        predefinedType: input.predefinedType,
        name: input.name,
        tag: input.tag,
        description: input.description,
      },
      geometry: {
        ...(input.geometryProvenance ?? {}),
        tessellationPositionsCount: positions.length,
        notes: [
          "Tessellated positions are the editable/render representation; original source topology remains in rawItem when provided by the loader.",
        ],
      },
      sourceDimensions: {
        height: input.dimensions?.height ?? null,
        width: input.dimensions?.width ?? null,
        depth: input.dimensions?.depth ?? null,
      },
    }),
  };
  elements.push(el);
  // Incremental add — avoid full authored-scene dispose/rebuild which can
  // flash the viewport black and drop unrelated meshes under load.
  try {
    const mesh = createMesh(el);
    if (mesh) group.add(mesh);
    applySelection();
  } catch (err) {
    const idx = elements.findIndex((e) => e.id === id);
    if (idx >= 0) elements.splice(idx, 1);
    throw err;
  }
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

/**
 * Delete one authored element (undoable via history / Ctrl+Z).
 * Delegates to deleteElements so host-cascade and the undo stack stay consistent.
 */
export function removeElementById(id: string): boolean {
  const idx = elements.findIndex((el) => el.id === id);
  if (idx < 0) return false;
  deleteElements([id]);
  return true;
}

export function setElementVisibility(id: string, visible: boolean): void {
  const group = getAuthoredGroup();
  group.traverse((obj: any) => {
    if (obj.userData.elementId === id) {
      obj.visible = visible;
    }
  });
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

export function deleteSelectedElement() {
  if (selectedDatum && selectedIds.size === 0) { deleteDatum(selectedDatum.kind, selectedDatum.id); return; }
  deleteElements([...selectedIds]);
}

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
  if (selectedDatum?.kind === "grid" && !grids.some((g) => g.id === selectedDatum!.id)) selectedDatum = null;
  rebuildDatums();
}
export function getLevels() { return levels; }
export function setLevels(list: LevelDatum[] | undefined | null) {
  levels = Array.isArray(list) ? list : [];
  levelIdx = levels.length;
  if (selectedDatum?.kind === "level" && !levels.some((l) => l.id === selectedDatum!.id)) selectedDatum = null;
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

/** When on, moving an MEP part also moves everything connected to it (default on). */
let moveConnectedMep = (() => { try { return localStorage.getItem("obs.moveConnectedMep") !== "0"; } catch { return true; } })();
try { (window as any).__obsMoveConnected = moveConnectedMep; } catch { /* */ }
export function isMoveConnectedMep(): boolean { return moveConnectedMep; }
export function setMoveConnectedMep(on: boolean): void {
  moveConnectedMep = on;
  try { localStorage.setItem("obs.moveConnectedMep", on ? "1" : "0"); } catch { /* */ }
}
/** Ids to move together with `ids`: the connected MEP network when the option is on. */
export function expandConnectedIds(ids: Iterable<string>): string[] {
  const list = [...ids];
  if (!moveConnectedMep) return list;
  const mepStart = list.filter((id) => { const e = elements.find((x) => x.id === id); return e && isMepElement(e); });
  if (!mepStart.length) return list;
  const extra = expandConnected(mepStart, elements as any);
  return [...new Set([...list, ...extra])];
}

/** Replace an element's boundary polygon (Edit Boundary), with undo/redo. Returns false if rejected. */
export function setElementPolygon(id: string, polygon: Vec2[], label = "Edit boundary"): boolean {
  const el = elements.find((e) => e.id === id);
  if (!el || !el.params.polygon || el.properties?.pinned) return false;
  if (!isValidBoundary(polygon as Array<[number, number]>)) return false;
  const before = JSON.parse(JSON.stringify(el.params.polygon)) as Vec2[];
  const after = polygon.map((p) => [p[0], p[1]] as Vec2);
  if (JSON.stringify(before) === JSON.stringify(after)) return true;
  history.push({
    label: `${label} · ${el.name}`,
    apply: () => { el.params.polygon = after.map((p) => [p[0], p[1]] as Vec2); rebuild(); markDirty(); notifyAuthoringChange(); },
    revert: () => { el.params.polygon = before.map((p) => [p[0], p[1]] as Vec2); rebuild(); markDirty(); notifyAuthoringChange(); },
  });
  el.params.polygon = after.map((p) => [p[0], p[1]] as Vec2);
  rebuild(); markDirty(); notifyAuthoringChange();
  return true;
}

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
          // Revit-style elbow: centreline radius 1.5 x width, shrunk only when the
          // adjoining runs are too short. Runs end at the true tangent points
          // (tangent length = r * tan(turn / 2), not r, for non-90 degree bends).
          const bendX = lastPlanLinear.end[0];
          const bendZ = lastPlanLinear.end[1];
          const turn = turnAngle(lastPlanLinear.dir, dir);
          const bendRadius = clampBendRadius(defaultBendRadius(Math.max(thick, height)), turn, prevLen, nextLen);
          const eg = elbowGeometry([bendX, bendZ], lastPlanLinear.dir, dir, bendRadius);
          const inX = eg ? eg.T1[0] : bendX;
          const inZ = eg ? eg.T1[1] : bendZ;
          const outX = eg ? eg.T2[0] : bendX;
          const outZ = eg ? eg.T2[1] : bendZ;

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
        ...slopedElevations(type, sx, sz, ex, ez),
      }, props);
    });
  } else {
    el = await createElement(type as any, {
      start: [sx, sz],
      end: [ex, ez],
      height,
      thickness: thick,
      ...slopedElevations(type, sx, sz, ex, ez),
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
    endElevation: el.params.endElevation,
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
   width (BIM default) and re-trims the two ducts that feed the
   fitting so their ends meet the new tangent points. Idempotent —
   safe to call repeatedly. Returns the number of fittings changed. */
/* ── MEP fitting migration + connector enforcement ─────────────────────
   mep-connector-v2

   Two responsibilities, both idempotent:

   1. Radius normalisation — every elbow's bendRadius is bumped to at
      least one duct width (BIM default). Fittings already at or above
      the floor are left alone.

   2. Connector enforcement — for every elbow, any same-type duct whose
      endpoint sits near the corner OR near either tangent point is
      snapped exactly onto the elbow's connection plane. This is what
      BIM calls a connector: the duct terminates at the fitting, not at
      the corner, so the two never overlap.

   The duct snap uses a generous tolerance (max of 1.5× radius,
   2.5× duct width, 0.5 m) so it also repairs ducts drawn before the
   current elbow geometry existed. Ducts deliberately detached from the
   elbow (endpoint further away) are never touched.

   Returns the total number of mutations (fittings + duct endpoints). */
export function migrateMepFittingRadii(onlyId?: string, forceRadius?: number): number {
  const mepTypes = new Set(["duct", "pipe", "cable-tray", "conduit"]);
  const fittings = elements.filter(
    (e) => e.type === "fitting" &&
           String((e.params as any).fittingKind || "elbow") === "elbow" &&
           mepTypes.has(String((e.params as any).parentType ?? "duct")) &&
           (!onlyId || e.id === onlyId),
  );

  let changedFittings = 0;
  let changedDuctEnds = 0;

  for (const f of fittings) {
    const t = f.params.thickness ?? 0.3;
    const ductWidth = Math.max(t, 0.05);
    const stored = Number((f.params as any).bendRadius);
    const legacy = !(Number.isFinite(stored) && stored > 0);
    const oldR = legacy ? ductWidth / 2 : stored;
    // Only legacy fittings (no stored radius) get the Revit default; an explicit radius is never overridden.
    const newR = forceRadius != null && forceRadius > 0 ? forceRadius : legacy ? defaultBendRadius(ductWidth) : oldR;

    const cx = (f.params as any).point?.[0];
    const cz = (f.params as any).point?.[1];
    if (cx == null || cz == null) continue;
    const aIn  = Number((f.params as any).angleIn  ?? 0);
    const aOut = Number((f.params as any).angleOut ?? Math.PI / 2);

    const oldG = elbowGeometry([cx, cz], aIn, aOut, oldR);
    const newG = elbowGeometry([cx, cz], aIn, aOut, newR);
    if (!oldG || !newG) continue;
    const oldT1: [number, number] = oldG.T1;
    const oldT2: [number, number] = oldG.T2;
    const newT1: [number, number] = newG.T1;
    const newT2: [number, number] = newG.T2;

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
/**
 * Set an elbow's centreline bend radius (Properties > Bend Radius) and re-trim the
 * connected runs onto the new tangent points. Refuses (returns false) if a run would
 * become shorter than 5 cm. Undo-able as one step.
 */
export function setElbowBendRadius(fittingId: string, radius: number): boolean {
  const f = elements.find((e) => e.id === fittingId && e.type === "fitting");
  if (!f || !(radius > 0)) return false;
  const mepTypes = ["duct", "pipe", "cable-tray", "conduit"];
  const parentType = String((f.params as any).parentType ?? "duct");
  const runs = elements.filter((e) => mepTypes.includes(e.type) && e.type === parentType && e.params.start && e.params.end);
  const snap = runs.map((e) => ({ e, s: [...e.params.start!] as [number, number], en: [...e.params.end!] as [number, number] }));
  const oldR = Number((f.params as any).bendRadius);
  migrateMepFittingRadii(fittingId, radius);
  const bad = snap.some(({ e }) => Math.hypot(e.params.end![0] - e.params.start![0], e.params.end![1] - e.params.start![1]) < 0.05);
  if (bad) {
    for (const x of snap) { x.e.params.start = x.s; x.e.params.end = x.en; }
    (f.params as any).bendRadius = Number.isFinite(oldR) && oldR > 0 ? oldR : undefined;
    rebuild(); markDirty();
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Bend radius too large for the connected runs.", kind: "warn" } }));
    return false;
  }
  (f.params as any).bendRadius = radius;
  rebuild(); markDirty(); notifyAuthoringChange();
  history.push({
    label: "Change bend radius",
    apply: () => { migrateMepFittingRadii(fittingId, radius); (f.params as any).bendRadius = radius; rebuild(); markDirty(); },
    revert: () => { for (const x of snap) { x.e.params.start = x.s; x.e.params.end = x.en; } (f.params as any).bendRadius = Number.isFinite(oldR) && oldR > 0 ? oldR : undefined; rebuild(); markDirty(); },
  });
  return true;
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
  let gizmoMoving = new Set<string>();

  gizmo.setCallbacks({
    onStart: () => {
      gizmoBaseline = {};
      gizmoMoving = new Set(expandConnectedIds(selectedIds));
      for (const el of elements) {
        if (gizmoMoving.has(el.id) && !el.properties?.pinned) {
          gizmoBaseline[el.id] = JSON.parse(JSON.stringify(el.params));
        }
      }
    },
    onUpdate: (delta) => {
      if (!gizmoBaseline) return;
      for (const el of elements) {
        if (!gizmoMoving.has(el.id) || !!el.properties?.pinned) continue;
        const base = gizmoBaseline[el.id];
        if (!base) continue;
        const p = JSON.parse(JSON.stringify(base)) as AuthoredElement["params"];
        if (p.start) p.start = [p.start[0] + delta.x, p.start[1] + delta.z] as Vec2;
        if (p.end) p.end = [p.end[0] + delta.x, p.end[1] + delta.z] as Vec2;
        if (p.point) p.point = [p.point[0] + delta.x, p.point[1] + delta.z] as Vec2;
        if (p.polygon) p.polygon = p.polygon.map(([x, z]) => [x + delta.x, z + delta.z] as Vec2);
        p.elevation += delta.y;
        if (p.endElevation != null) p.endElevation += delta.y;
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
        if (gizmoMoving.has(el.id) && before[el.id]) after[el.id] = JSON.parse(JSON.stringify(el.params));
      }
      // MASTER PROMPT §6 — drag-move also updates bound dependents.
      const depPatches = collectDependentPatches(Object.keys(after), delta.x, delta.z);
      for (const el of elements) {
        if (before[el.id]) el.params = JSON.parse(JSON.stringify(before[el.id]));
      }
      rebuild();
      history.push({
        label: `Transform ${Object.keys(after).length} element(s)`,
        apply: () => {
          for (const el of elements) if (after[el.id]) el.params = JSON.parse(JSON.stringify(after[el.id]));
          for (const p of depPatches) p.el.params = JSON.parse(JSON.stringify(p.after));
          rebuild(); markDirty();
        },
        revert: () => {
          for (const el of elements) if (before[el.id]) el.params = JSON.parse(JSON.stringify(before[el.id]));
          for (const p of depPatches) p.el.params = JSON.parse(JSON.stringify(p.before));
          rebuild(); markDirty();
        },
      });
      for (const el of elements) if (after[el.id]) el.params = JSON.parse(JSON.stringify(after[el.id]));
      for (const p of depPatches) p.el.params = JSON.parse(JSON.stringify(p.after));
      refreshDependentRefs(depPatches);
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
    const datumHit = hitId ? null : datumAt(e);
    if (datumHit) {
      selectedIds.clear();
      try { const sel: any = (ctx.features as any).selection; sel?.replace?.({}); void sel?.applyToHighlighter?.(); } catch { /* */ }
      if (activeTool && activeTool !== "select") { activeTool = "select"; activePreset = null; }
      setDatumSelection(datumHit);
      applySelection(); refreshGrips(); updateLabel();
      paletteTarget = null;
      notifyAuthoringChange();
      return true;
    }
    if (selectedDatum) setDatumSelection(null);
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
    lastHoverEvent = e;

    // Feed the snap engine the draw context (chain base) so magnetic
    // perpendicular/parallel snaps can be computed (MASTER PROMPT §5).
    try { snapping.setDrawContext(chainStart); } catch { /* */ }

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

    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && activeTool && activeTool !== "select") {
      const step = e.shiftKey ? 0.1 : 0.5;
      const delta = e.key === "ArrowUp" ? step : -step;
      setLevel(level + delta);
      notify("info", `Elevation: ${level.toFixed(1)} m`);
      try { updateLabel(); } catch { /* */ }
      e.preventDefault();
      return;
    }

    // MASTER PROMPT §4.3 — Tab cycles overlapping snap candidates in the
    // 3D viewport (Shift+Tab cycles backwards). Pointer movement resets.
    if (e.key === "Tab" && activeTool && activeTool !== "select") {
      const cycled = snapping.cycleNext(e.shiftKey ? -1 : 1);
      if (cycled) {
        e.preventDefault();
        e.stopPropagation();
        notify("info", `Snap: ${cycled}`);
      }
      return;
    }

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
    setElementVisibility,
    pickAuthoredElementAt,
    deleteSelectedElement, clearAllElements, clearDatums,
    getSelectedDatum, selectDatum, deleteDatum,
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

    // MASTER PROMPT §2/§3 — modeling panel + justification state
    isDrawToolActive,
    refreshPreview,
    resetTypeDefaults,
    getBeamJustification, setBeamJustification: (v: any) => setBeamJustification(v as any),
    getBeamZJustification, setBeamZJustification: (v: any) => setBeamZJustification(v as any),
    getMepJustification, setMepJustification: (v: any) => setMepJustification(v as any),
    getDrawSlope, setDrawSlope,

    getGrids, setGrids, getLevels, setLevels,
    getActiveLevelId, setActiveLevelById,
    getActiveFamilyId, getActiveFamilyTypeId, setActiveFamily,
    syncFamilyInstances,

    onAuthoringChange,
    migrateMepFittingRadii,
    setElbowBendRadius,

    // Remediation Phase 1.4 — real element creation for plugin/API callers.
    // Delegates to the SAME history-wrapped createElement the draw tools use
    // (type defaults, family overrides, hosting, snap relationships), with a
    // strict whitelist so unknown types are an honest rejection, not a stub.
    createElementByType: async (type: string, params: Record<string, unknown>, hostId?: string) => {
      const t = String(type || "").trim();
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, t)) return null;
      try {
        const el = await createElement(t as ElementType, (params ?? {}) as Partial<AuthoredElement["params"]>, undefined, hostId);
        return el ? el.id : null;
      } catch (err) {
        console.warn("[authoring] createElementByType rejected:", t, err);
        return null;
      }
    },
  };
  ctx.features.authoring = api;
  register("authoring", api);
  try { (window as any).__obsAuthoring = api; } catch { /* */ }
}