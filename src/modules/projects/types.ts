import type { Issue } from "../issues/types";
import type { CostData } from "../cost/types";

// ── Geometry / authored element types ─────────────────────────────────────
export type Vec2 = [number, number];

export type ElementType =
  | "wall"
  | "slab"
  | "column"
  | "beam"
  | "brace"
  | "truss"
  | "footing"
  | "strip"
  | "mline"
  | "duct"
  | "pipe"
  | "cable-tray"
  | "conduit"
  | "equipment"
  | "fitting"
  | "door"
  | "window"
  | "roof"
  | "stairs"
  | "railing"
  | "ramp"
  | "room"
  | "area"
  | "ceiling" | "terrain"
  | "curtain-wall"
  | "grid"
  | "level"
  | "generic";

/** Door / window panel variants used by authoring + property palette. */
export type DoorPanelType = "swing" | "double" | "sliding" | "folding" | "pocket";
export type WindowPanelType = "fixed" | "casement" | "sliding" | "awning" | "double";

export interface AuthoredElement {
  id: string;
  type: ElementType;
  name: string;
  color?: string;
  /** For hosted elements (door/window) — the id of the host wall. */
  hostId?: string;
  /** BIM-style: the level this element was placed on. */
  levelId?: string;
  /** BIM-style: the family this element instantiates (optional). */
  familyId?: string;
  /** BIM-style: the family type this element instantiates (optional). */
  familyTypeId?: string;
  params: {
    start?: Vec2;
    end?: Vec2;
    polygon?: Vec2[];
    point?: Vec2;
    width?: number;
    depth?: number;
    height: number;
    thickness: number;
    elevation: number;

    // ── Hosted element (door/window) ──────────────────────────────────
    /** Distance in metres from the host wall's start to the element's centre. */
    offsetAlongHost?: number;
    /** Sill height above the wall's elevation, in metres. */
    sillHeight?: number;
    /** Frame thickness (m). */
    frameThickness?: number;
    /** Door panel type. */
    doorPanel?: "swing" | "double" | "sliding" | "folding" | "pocket";
    /** Window panel type. */
    windowPanel?: "fixed" | "casement" | "sliding" | "awning" | "double";
    /** Whether a window has a horizontal mullion (transom). */
    mullion?: boolean;

    // ── Fitting (auto-generated at chain bends) ───────────────────────
    /** Incoming direction angle in the XZ plane (radians). */
    angleIn?: number;
    /** Outgoing direction angle in the XZ plane (radians). */
    angleOut?: number;
    /** Bend radius for fitting reconstruction (m). */
    bendRadius?: number;

    /** Fitting kind (elbow, tee, cross, ...). */
    fittingKind?: string;

    /** Parent element type that generated this fitting. */
    parentType?: "duct" | "pipe" | "cable-tray" | "conduit";
  };
  properties?: Record<string, unknown>;

  /** Optional exact geometry captured from an imported IFC/FRAG object.
   * Stored as non-indexed triangle positions in the authored project so the
   * reconstructed element becomes a real project object rather than a
   * transient viewport clone.
   */
  nativeGeometry?: { positions: number[] };

  /** IFC semantic identity retained for reconstructed/native elements. */
  ifc?: {
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
  };

  /** World transform of a reconstructed/imported native project object. */
  transform?: {
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: [number, number, number];
  };
}

// ── Datum ─────────────────────────────────────────────────────────────────
export interface GridDatum {
  id: string;
  label: string;
  start: Vec2;
  end: Vec2;
}

export interface LevelDatum {
  id: string;
  name: string;
  elevation: number;
  /** Optional display colour for datum visibility in the plan / 3D. */
  color?: string;
}

// ── Model metadata ────────────────────────────────────────────────────────
export interface ProjectModelMeta {
  id: string;
  name: string;
  bytes: number;
  /** Set when the model's blob was not found during project open. */
  missing?: boolean;

  /**
   * World-space position of the model's root object at save time.
   *
   * Persisting this allows re-opens to reproduce the exact same shared-
   * coordinate placement the user had on screen when they saved.
   *
   * Why: the Fragments autoCoordinator assigns each model a different
   * world position to avoid overlaps. For IFC in shared coordinates that
   * shift is wrong — geometry is authored to sit at the correct relative
   * position. This field + the enforcement guard in projects.ts keep
   * models where the user put them.
   */
  position?: [number, number, number];
}

// ── Positioning (BIM-style linking modes) ───────────────────────────────
export type PositioningMode =
  | "origin-to-origin"
  | "shared-coordinates"
  | "center-to-center"
  | "project-base-to-project-base"
  | "manual";

// ── Element Types / Parameters (BIM-style type system foundation) ───────
export type ParamDataType = "text" | "number" | "integer" | "yesno" | "length" | "area" | "volume" | "angle" | "material";

export interface ParameterDef {
  id: string;
  name: string;
  group: string;
  dataType: ParamDataType;
  unit?: string;
  shared?: boolean;
  defaultValue?: string | number | boolean;
}

export interface ElementTypeDef {
  id: string;
  category: ElementType;
  name: string;
  description?: string;
  /** Type parameters (shared across instances of this type). */
  parameters: Record<string, string | number | boolean>;
  materialId?: string;
  color?: string;
}

// ── Materials ─────────────────────────────────────────────────────────────
export interface MaterialDef {
  id: string;
  name: string;
  category: "concrete" | "steel" | "timber" | "glass" | "insulation" | "finish" | "mep" | "other";
  color: string;
  density?: number; // kg/m³
  thermalConductivity?: number;
  costPerUnit?: number;
  unit?: string;
}

// ── Sheets / Production documentation ─────────────────────────────────────
export interface SheetViewport {
  id: string;
  viewId: string;       // plan view id or saved view id
  viewType: "plan" | "3d" | "elevation" | "section" | "schedule";
  x: number;            // mm on sheet
  y: number;
  width: number;        // mm
  height: number;
  scale: string;        // e.g. "1:100"
  title?: string;
}

export interface SheetDef {
  id: string;
  number: string;       // e.g. "A-101"
  name: string;
  size: "A0" | "A1" | "A2" | "A3" | "A4" | "ANSI-D" | "ANSI-E" | "Arch-D" | "Arch-E";
  orientation: "portrait" | "landscape";
  titleblockId?: string;
  viewports: SheetViewport[];
  annotations?: { id: string; kind: string; text: string; x: number; y: number }[];
  createdAt: number;
  updatedAt: number;
}

export interface TitleblockDef {
  id: string;
  name: string;
  size: SheetDef["size"];
  fields: { key: string; label: string; value: string }[];
}

// ── Automation rules ──────────────────────────────────────────────────────
export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: "on-selection" | "on-save" | "on-clash" | "manual" | "on-import";
  /** Simple condition expression, e.g. category=IfcWall AND height>3 */
  condition?: string;
  actions: { type: string; params: Record<string, unknown> }[];
}

// ── Project document ──────────────────────────────────────────────────────
export type ProjectStatus = "active" | "on-hold" | "complete" | "archived";
export type ProjectTemplate = "blank" | "coordination" | "mep-delivery" | "documentation" | "construction";
export type ProjectUnits = "metric" | "imperial";

export interface ProjectDoc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;

  /** Optional enterprise/project-control metadata. */
  projectNumber?: string;
  client?: string;
  phase?: string;
  description?: string;
  status?: ProjectStatus;
  units?: ProjectUnits;
  template?: ProjectTemplate;
  owner?: string;

  elements: AuthoredElement[];
  models: ProjectModelMeta[];

  issues?: Issue[];
  cost?: CostData;
  grids?: GridDatum[];
  levels?: LevelDatum[];

  /** Element type catalog (families / types). */
  elementTypes?: ElementTypeDef[];
  /** Project + shared parameters. */
  parameters?: ParameterDef[];
  /** Material library. */
  materials?: MaterialDef[];
  /** Production sheets. */
  sheets?: SheetDef[];
  titleblocks?: TitleblockDef[];
  /** Automation rules. */
  automationRules?: AutomationRule[];

  appState?: {
    cam?: [number, number, number];
    target?: [number, number, number];
  };

  /** Persisted positioning mode used when linking IFC / FRAG files. */
  positioningMode?: PositioningMode;

  /** BIM-style: the level that was active when the project was saved. */
  activeLevelId?: string | null;

  /** Persisted FRAG/native twin edits (move / rotate / scale + copied BIM data). */
  fragEdits?: FragEditLite[];
  /** Native openBIM reconstructions created from linked IFC/FRAG objects. */
  nativeTwins?: NativeTwinLite[];

  /** Persisted clash review statuses and comments (keyed by clash pair). */
  clashStates?: Array<{
    key: string;
    status: string;
    comments: Array<{ id?: string; author?: string; text: string; at?: number }>;
    assignee?: string;
    updatedAt?: number;
  }>;

  /** Plan-view dimensions (aligned / linear / chains) drawn in the 2D floor plan. */
  planDimensions?: unknown[];
  /** Plan-view tags and text notes. */
  planAnnotations?: { tags: unknown[]; notes: unknown[] };

  /** Persisted 2D annotations (dimensions, tags, notes) keyed per view. */
  annotations?: {
    dimensions: unknown[];
    tags: unknown[];
    notes: unknown[];
    updatedAt: number;
  };
}


/** A persisted editable twin reconstructed from a linked openBIM element. */
export interface NativeTwinLite extends FragEditLite {
  sourceType: "IFC" | "FRAG" | "openBIM";
  /** New project identity for the editable twin; never reuses the source IFC GlobalId. */
  nativeId?: string;
  nativeEntity?: string;
  sourceGlobalId?: string;
  sourceEntity?: string;
  sourceModelName?: string;
  sourceTag?: string;
  predefinedType?: string;
  description?: string;
  objectPlacement?: number[];
  dimensions: {
    width: number;
    height: number;
    depth: number;
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
  };
  /** Exact non-indexed triangle positions in twin-local coordinates. */
  geometry?: { positions: number[] };
  /** Full IFC/FRAG attributes and psets copied at reconstruction time. */
  sourceData?: Record<string, unknown>;
  propertySets?: Record<string, unknown>;
  quantities?: Record<string, unknown>;
  /** Native overrides edited by the user after reconstruction. */
  overrides?: Record<string, unknown>;
}

/**
 * Lightweight mirror of `features/frag-edit.ts::FragEdit`.
 * Kept here so this file has no imports from the features layer (avoids
 * circular dependencies), while remaining structurally compatible.
 */
export interface FragEditLite {
  id: string;
  modelId: string;
  localId: number;
  name: string;
  category: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  createdAt: number;
  updatedAt: number;
}

// ── Project summary (list views) ──────────────────────────────────────────
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  elementCount: number;
  modelCount: number;
  issueCount: number;
  projectNumber?: string;
  client?: string;
  phase?: string;
  status?: ProjectStatus;
  units?: ProjectUnits;
  template?: ProjectTemplate;
}
