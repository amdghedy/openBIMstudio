/**
 * Property schema per authored element type.
 *
 * Each element declares its editable fields. The palette renders from this
 * — no UI code per element type, no duplicated field lists. Add a field
 * here and it appears in the panel automatically.
 *
 * Field targets:
 *   "params"     → element.params[key]        (dimensions, constraints)
 *   "properties" → element.properties[key]    (user metadata: fire rating, type mark)
 *   "root"       → element[key]               (name, color — top-level fields)
 */
import type { ElementType } from "../modules/projects/types";

export type FieldType = "number" | "text" | "select" | "color" | "boolean";
export type FieldTarget = "params" | "properties" | "root";

export interface PropertyField {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  target: FieldTarget;
  default?: string | number | boolean;
  helpText?: string;
  readOnly?: boolean;
  compute?: (el: any) => string | number | boolean;
}

export interface ElementSchema {
  type: ElementType;
  label: string;
  icon: string;
  groups: string[];
  fields: PropertyField[];
}

const DIMENSIONS = "Dimensions";
const CONSTRAINTS = "Constraints";
const IDENTITY = "Identity Data";
const MATERIALS = "Materials";
const STRUCTURAL = "Structural";
const PHASING = "Phasing";
const CONSTRUCTION = "Construction";

const num = (
  key: string,
  label: string,
  group: string,
  step = 0.05,
  min?: number,
  max?: number,
): PropertyField => ({
  key,
  label,
  group,
  type: "number",
  unit: "m",
  step,
  min,
  max,
  target: "params",
});

const elev = (): PropertyField => num("elevation", "Base elevation", CONSTRAINTS, 0.1);

const nameField = (): PropertyField => ({
  key: "name",
  label: "Name",
  group: IDENTITY,
  type: "text",
  target: "root",
});

const typeMarkField = (): PropertyField => ({
  key: "typeMark",
  label: "Type mark",
  group: IDENTITY,
  type: "text",
  target: "properties",
  helpText: "e.g. W-01, D-02",
});

const fireField = (): PropertyField => ({
  key: "fireRating",
  label: "Fire rating",
  group: IDENTITY,
  type: "text",
  target: "properties",
  helpText: "e.g. 60 min, 2 hr",
});

const colorField = (): PropertyField => ({
  key: "color",
  label: "Color",
  group: MATERIALS,
  type: "color",
  target: "root",
});

const commentsField = (): PropertyField => ({
  key: "comments",
  label: "Comments",
  group: IDENTITY,
  type: "text",
  target: "properties",
});

export const SCHEMAS: Partial<Record<ElementType, ElementSchema>> = {
  wall: {
    type: "wall",
    label: "Basic Wall",
    icon: "wall",
    groups: [STRUCTURAL, DIMENSIONS, IDENTITY, PHASING],
    fields: [
      { key: "layers", label: "Layers (name:thick)", group: STRUCTURAL, type: "text", target: "properties",
        helpText: "e.g. Brick:0.1, Insulation:0.05, Gypsum:0.015" },
      { key: "structural", label: "Structural", group: STRUCTURAL, type: "boolean", target: "properties", default: false },
      { key: "enableAnalytical", label: "Enable Analytical Model", group: STRUCTURAL, type: "boolean", target: "properties", default: false },
      { key: "structuralUsage", label: "Structural Usage", group: STRUCTURAL, type: "select", target: "properties",
        options: [
          { value: "bearing", label: "Bearing" },
          { value: "non-bearing", label: "Non-bearing" },
          { value: "shear", label: "Shear" },
          { value: "combined", label: "Combined" },
          { value: "cantilever", label: "Cantilever" },
        ], default: "non-bearing" },
      { key: "rebarCoverExterior", label: "Rebar Cover - Exterior", group: STRUCTURAL, type: "select", target: "properties",
        options: [
          { value: "none", label: "None" },
          { value: "25", label: "Rebar Cover 1 <25 mm>" },
          { value: "40", label: "Rebar Cover 2 <40 mm>" },
          { value: "50", label: "Rebar Cover 3 <50 mm>" },
        ], default: "25" },
      { key: "rebarCoverInterior", label: "Rebar Cover - Interior", group: STRUCTURAL, type: "select", target: "properties",
        options: [
          { value: "none", label: "None" },
          { value: "25", label: "Rebar Cover 1 <25 mm>" },
          { value: "40", label: "Rebar Cover 2 <40 mm>" },
          { value: "50", label: "Rebar Cover 3 <50 mm>" },
        ], default: "25" },
      { key: "rebarCoverOther", label: "Rebar Cover - Other", group: STRUCTURAL, type: "select", target: "properties",
        options: [
          { value: "none", label: "None" },
          { value: "25", label: "Rebar Cover 1 <25 mm>" },
          { value: "40", label: "Rebar Cover 2 <40 mm>" },
          { value: "50", label: "Rebar Cover 3 <50 mm>" },
        ], default: "25" },

      // Editable dimensions
      { key: "thickness", label: "Width", group: DIMENSIONS, type: "number", unit: "m", step: 0.05, min: 0.01, target: "params" },
      { key: "height",    label: "Height", group: DIMENSIONS, type: "number", unit: "m", step: 0.1,  min: 0.01, target: "params" },

      // Read-only computed
      { key: "length", label: "Length", group: DIMENSIONS, type: "number", unit: "m", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]); } },
      { key: "surfaceArea", label: "Surface Area", group: DIMENSIONS, type: "number", unit: "m2", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; const h = el?.params?.height ?? 0; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]) * h; } },
      { key: "volume", label: "Volume", group: DIMENSIONS, type: "number", unit: "m3", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; const h = el?.params?.height ?? 0; const t = el?.params?.thickness ?? 0; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]) * h * t; } },

      // Identity Data
      { key: "image",    label: "Image",    group: IDENTITY, type: "text", target: "properties" },
      { key: "comments", label: "Comments", group: IDENTITY, type: "text", target: "properties" },
      { key: "mark",     label: "Mark",     group: IDENTITY, type: "text", target: "properties" },

      // Phasing
      { key: "phaseCreated", label: "Phase Created", group: PHASING, type: "select", target: "properties",
        options: [
          { value: "new", label: "New Construction" },
          { value: "existing", label: "Existing" },
          { value: "demo", label: "Demolition" },
        ], default: "new" },
      { key: "phaseDemolished", label: "Phase Demolished", group: PHASING, type: "select", target: "properties",
        options: [
          { value: "none", label: "None" },
          { value: "new", label: "New Construction" },
          { value: "existing", label: "Existing" },
        ], default: "none" },
    ],
  },
  slab: {
    type: "slab",
    label: "Slab",
    icon: "slab",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Thickness", DIMENSIONS, 0.05, 0.01),
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  column: {
    type: "column",
    label: "Column",
    icon: "column",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Height", DIMENSIONS, 0.1, 0.01),
      num("thickness", "Width", DIMENSIONS, 0.05, 0.01),
      num("depth", "Depth", DIMENSIONS, 0.05, 0.01),
      elev(),
      nameField(),
      typeMarkField(),
      fireField(),
      commentsField(),
      colorField(),
    ],
  },

  beam: {
    type: "beam",
    label: "Beam",
    icon: "beam",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Section depth", DIMENSIONS, 0.05, 0.01),
      num("thickness", "Section width", DIMENSIONS, 0.05, 0.01),
      elev(),
      nameField(),
      typeMarkField(),
      fireField(),
      commentsField(),
      colorField(),
    ],
  },

  brace: {
    type: "brace",
    label: "Brace",
    icon: "brace",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Rise", DIMENSIONS, 0.1, 0.01),
      num("thickness", "Member size", DIMENSIONS, 0.05, 0.01),
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  truss: {
    type: "truss",
    label: "Truss",
    icon: "truss",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Truss height", DIMENSIONS, 0.1, 0.1),
      num("thickness", "Member size", DIMENSIONS, 0.01, 0.01),
      {
        key: "panels",
        label: "Panels",
        group: DIMENSIONS,
        type: "number",
        step: 1,
        min: 2,
        max: 20,
        target: "properties",
      },
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  footing: {
    type: "footing",
    label: "Isolated footing",
    icon: "footing",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Pad thickness", DIMENSIONS, 0.05, 0.05),
      num("thickness", "Width", DIMENSIONS, 0.05, 0.1),
      num("depth", "Depth", DIMENSIONS, 0.05, 0.1),
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  strip: {
    type: "strip",
    label: "Strip footing",
    icon: "strip",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Thickness", DIMENSIONS, 0.05, 0.05),
      num("thickness", "Width", DIMENSIONS, 0.05, 0.05),
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  mline: {
    type: "mline",
    label: "Model line",
    icon: "detail-line",
    groups: [CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [elev(), nameField(), commentsField(), colorField()],
  },

  duct: {
    type: "duct",
    label: "Duct",
    icon: "duct",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      { key: "systemType", label: "System Type", group: DIMENSIONS, type: "select", target: "properties",
        options: [
          { value: "supply-air", label: "Supply Air" },
          { value: "return-air", label: "Return Air" },
          { value: "exhaust-air", label: "Exhaust Air" },
          { value: "fresh-air", label: "Fresh Air" },
        ], default: "supply-air" },
      { key: "section", label: "Section", group: DIMENSIONS, type: "select", target: "properties",
        options: [
          { value: "rectangular", label: "Rectangular" },
          { value: "round", label: "Round" },
          { value: "oval", label: "Oval" },
        ], default: "rectangular" },
      { key: "thickness", label: "Width", group: DIMENSIONS, type: "number", unit: "m", step: 0.05, min: 0.05, target: "params" },
      { key: "height", label: "Height", group: DIMENSIONS, type: "number", unit: "m", step: 0.05, min: 0.05, target: "params" },
      { key: "length", label: "Length", group: DIMENSIONS, type: "number", unit: "m", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]); } },
      { key: "surfaceArea", label: "Surface Area", group: DIMENSIONS, type: "number", unit: "m2", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; const w = el?.params?.thickness ?? 0; const h = el?.params?.height ?? 0; if (!a || !b) return 0; const L = Math.hypot(b[0]-a[0], b[1]-a[1]); return 2 * (w + h) * L; } },
      { key: "volume", label: "Volume", group: DIMENSIONS, type: "number", unit: "m3", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; const w = el?.params?.thickness ?? 0; const h = el?.params?.height ?? 0; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]) * w * h; } },
      elev(),
      { key: "slope", label: "Slope", group: CONSTRAINTS, type: "number", unit: "deg", step: 0.1, target: "params" },
      { key: "image", label: "Image", group: IDENTITY, type: "text", target: "properties" },
      { key: "comments", label: "Comments", group: IDENTITY, type: "text", target: "properties" },
      { key: "mark", label: "Mark", group: IDENTITY, type: "text", target: "properties" },
      { key: "systemName", label: "System Name", group: IDENTITY, type: "text", target: "properties" },
    ],
  },
  pipe: {
    type: "pipe",
    label: "Pipe",
    icon: "pipe",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("thickness", "Diameter", DIMENSIONS, 0.01, 0.005),
      num("height", "Diameter", DIMENSIONS, 0.01, 0.005),
      elev(),
      nameField(),
      {
        key: "systemType",
        label: "System",
        group: IDENTITY,
        type: "select",
        target: "properties",
        options: [
          { value: "cold-water", label: "Cold water" },
          { value: "hot-water", label: "Hot water" },
          { value: "chilled-water", label: "Chilled water" },
          { value: "heating", label: "Heating" },
          { value: "drainage", label: "Drainage" },
          { value: "gas", label: "Gas" },
        ],
        default: "cold-water",
      },
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  "cable-tray": {
    type: "cable-tray",
    label: "Cable Tray",
    icon: "cable-tray",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      { key: "thickness", label: "Width", group: DIMENSIONS, type: "number", unit: "m", step: 0.05, min: 0.05, target: "params" },
      { key: "height", label: "Height", group: DIMENSIONS, type: "number", unit: "m", step: 0.01, min: 0.01, target: "params" },
      { key: "length", label: "Length", group: DIMENSIONS, type: "number", unit: "m", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]); } },
      { key: "surfaceArea", label: "Surface Area", group: DIMENSIONS, type: "number", unit: "m2", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; const w = el?.params?.thickness ?? 0; const h = el?.params?.height ?? 0; if (!a || !b) return 0; const L = Math.hypot(b[0]-a[0], b[1]-a[1]); return (2 * h + w) * L; } },
      { key: "volume", label: "Volume", group: DIMENSIONS, type: "number", unit: "m3", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; const w = el?.params?.thickness ?? 0; const h = el?.params?.height ?? 0; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]) * w * h; } },
      { key: "trayType", label: "Tray Type", group: DIMENSIONS, type: "select", target: "properties",
        options: [
          { value: "ladder", label: "Ladder" },
          { value: "solid", label: "Solid Bottom" },
          { value: "perforated", label: "Perforated" },
          { value: "wire-mesh", label: "Wire Mesh" },
        ], default: "perforated" },
      elev(),
      { key: "serviceType", label: "Service Type", group: IDENTITY, type: "text", target: "properties" },
      { key: "image", label: "Image", group: IDENTITY, type: "text", target: "properties" },
      { key: "comments", label: "Comments", group: IDENTITY, type: "text", target: "properties" },
      { key: "mark", label: "Mark", group: IDENTITY, type: "text", target: "properties" },
    ],
  },
  conduit: {
    type: "conduit",
    label: "Conduit",
    icon: "conduit",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("thickness", "Diameter", DIMENSIONS, 0.005, 0.005),
      num("height", "Diameter", DIMENSIONS, 0.005, 0.005),
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  equipment: {
    type: "equipment",
    label: "Equipment",
    icon: "equipment",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Height", DIMENSIONS, 0.1, 0.05),
      num("thickness", "Width", DIMENSIONS, 0.05, 0.05),
      num("depth", "Depth", DIMENSIONS, 0.05, 0.05),
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  door: {
    type: "door",
    label: "Door",
    icon: "door",
    groups: [DIMENSIONS, CONSTRUCTION, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("width", "Width", DIMENSIONS, 0.05, 0.3),
      num("height", "Height", DIMENSIONS, 0.05, 0.5),
      num("sillHeight", "Sill height", CONSTRAINTS, 0.05, 0),
      num("offsetAlongHost", "Offset along wall", CONSTRAINTS, 0.05, 0),
      num("frameThickness", "Frame thickness", CONSTRUCTION, 0.005, 0.02),
      {
        key: "doorPanel",
        label: "Panel type",
        group: CONSTRUCTION,
        type: "select",
        target: "params",
        options: [
          { value: "swing", label: "Swing" },
          { value: "double", label: "Double" },
          { value: "sliding", label: "Sliding" },
          { value: "folding", label: "Folding" },
          { value: "pocket", label: "Pocket" },
        ],
        default: "swing",
      },
      nameField(),
      typeMarkField(),
      fireField(),
      commentsField(),
      colorField(),
    ],
  },

  window: {
    type: "window",
    label: "Window",
    icon: "window",
    groups: [DIMENSIONS, CONSTRUCTION, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("width", "Width", DIMENSIONS, 0.05, 0.3),
      num("height", "Height", DIMENSIONS, 0.05, 0.3),
      num("sillHeight", "Sill height", CONSTRAINTS, 0.05, 0),
      num("offsetAlongHost", "Offset along wall", CONSTRAINTS, 0.05, 0),
      num("frameThickness", "Frame thickness", CONSTRUCTION, 0.005, 0.02),
      {
        key: "windowPanel",
        label: "Panel type",
        group: CONSTRUCTION,
        type: "select",
        target: "params",
        options: [
          { value: "fixed", label: "Fixed" },
          { value: "casement", label: "Casement" },
          { value: "sliding", label: "Sliding" },
          { value: "awning", label: "Awning" },
          { value: "double", label: "Double" },
        ],
        default: "casement",
      },
      {
        key: "mullion",
        label: "Horizontal mullion",
        group: CONSTRUCTION,
        type: "boolean",
        target: "params",
        default: false,
      },
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  fitting: {
    type: "fitting",
    label: "Fitting",
    icon: "duct-fitting",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Height", DIMENSIONS, 0.05, 0.01),
      num("thickness", "Width / diameter", DIMENSIONS, 0.05, 0.01),
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
    ],
  },

  grid: {
    type: "grid",
    label: "Grid",
    icon: "grid",
    groups: [IDENTITY],
    fields: [{ key: "label", label: "Label", group: IDENTITY, type: "text", target: "root" }],
  },
  level: {
    type: "level",
    label: "Level",
    icon: "level",
    groups: [DIMENSIONS, IDENTITY],
    fields: [
      num("elevation", "Elevation", DIMENSIONS, 0.1),
      { key: "name", label: "Name", group: IDENTITY, type: "text", target: "root" },
    ],
  },
};


// ── Auto-injected MEP & Structural Fields ─────────────────────────────
if (SCHEMAS.duct) {
  SCHEMAS.duct.fields.push(
    { key: "width", label: "Duct Width", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.05 },
    { key: "height", label: "Duct Height", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.05 }
  );
}
if (SCHEMAS.pipe) {
  SCHEMAS.pipe.fields.push(
    { key: "diameter", label: "Pipe Diameter", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.01 }
  );
}
if (SCHEMAS["cable-tray"]) {
  SCHEMAS["cable-tray"].fields.push(
    { key: "width", label: "Tray Width", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.05 },
    { key: "height", label: "Tray Depth", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.01 }
  );
}
if (SCHEMAS.beam) {
  SCHEMAS.beam.fields.push(
    { key: "height", label: "Beam Depth", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.05 },
    { key: "thickness", label: "Beam Width", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.05 }
  );
}

// ── Auto-injected Curved Wall field ─────────────────────────────────
if (SCHEMAS.wall) {
  SCHEMAS.wall.fields.push(
    { key: "arcHeight", label: "Arc Height (0=straight)", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.1, default: 0 }
  );
}

// ── Terrain Schema ────────────────────────────────────────────────────
if (!SCHEMAS.terrain) {
  SCHEMAS.terrain = {
    type: "terrain" as any,
    label: "Topography",
    icon: "site-component",
    groups: ["Dimensions", "Constraints"],
    fields: [
      { key: "thickness", label: "Thickness", group: "Dimensions", type: "number", target: "params", unit: "m", step: 0.1, default: 1.0 },
      { key: "elevation", label: "Elevation", group: "Constraints", type: "number", target: "params", unit: "m", step: 0.1, default: 0 },
      { key: "slope", label: "Slope", group: "Dimensions", type: "number", target: "properties", unit: "deg", step: 1, default: 0 },
      { key: "slopeDirection", label: "Slope Direction", group: "Dimensions", type: "number", target: "properties", unit: "deg", step: 15, default: 0 }
    ]
  };
}

export function hasSchema(type: ElementType | string | null | undefined): boolean {
  if (!type) return false;
  return !!SCHEMAS[type as ElementType];
}

export function getSchema(type: ElementType | string): ElementSchema | null {
  return SCHEMAS[type as ElementType] ?? null;
}

/* ══════════════════════════════════════════════════════════════════════
   Revit-style full parameter set
   Every element schema gets the standard instance parameters (Constraints /
   Identity Data / Phasing / IFC Parameters / Other), and fittings get the
   mechanical + dimension parameters (angle, bend radius, tangent, arc length).
   Fields already declared by a schema are never duplicated.
   ══════════════════════════════════════════════════════════════════════ */
const IFC_GROUP = "IFC Parameters";
const OTHER_GROUP = "Other";
const MECHANICAL = "Mechanical";

type LevelRow = { id: string; name: string; elevation: number };
let levelsProvider: () => LevelRow[] = () => [];
/** Wired by the palette so computed Level / Offset fields can resolve datums. */
export function setLevelsProvider(fn: () => LevelRow[]) { levelsProvider = fn; }
function levelsList(): LevelRow[] {
  try { return levelsProvider() ?? []; } catch { return []; }
}

function turnDeg(el: any): number {
  const p = el?.params ?? {};
  let d = (Number(p.angleOut ?? Math.PI / 2) - Number(p.angleIn ?? 0));
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
function fittingRadius(el: any): number {
  const p = el?.params ?? {};
  const w = Math.max(Number(p.thickness ?? 0.3), 0.05);
  const r = Number(p.bendRadius);
  return r > 0 ? r : 1.5 * w;
}

const ro = (key: string, label: string, group: string, compute: (el: any) => string | number, unit?: string): PropertyField => ({
  key, label, group, type: unit ? "number" : "text", unit, target: "params", readOnly: true, compute, step: 0.001,
});
const txt = (key: string, label: string, group: string, target: FieldTarget = "properties", helpText?: string): PropertyField => ({
  key, label, group, type: "text", target, helpText,
});

function commonFields(schema: ElementSchema): PropertyField[] {
  const has = (k: string) => schema.fields.some((f) => f.key === k);
  const out: PropertyField[] = [];
  const add = (f: PropertyField) => { if (!has(f.key) && !out.some((o) => o.key === f.key)) out.push(f); };

  // Constraints
  add(ro("levelName", "Level", CONSTRAINTS, (el) => {
    const lv = levelsList();
    const byId = lv.find((l) => l.id === el?.levelId);
    if (byId) return byId.name;
    const e = Number(el?.params?.elevation ?? 0);
    const near = [...lv].filter((l) => l.elevation <= e + 0.01).sort((a, b) => b.elevation - a.elevation)[0];
    return near ? near.name : "—";
  }));
  add(ro("offsetFromLevel", "Offset from Level", CONSTRAINTS, (el) => {
    const lv = levelsList();
    const e = Number(el?.params?.elevation ?? 0);
    const byId = lv.find((l) => l.id === el?.levelId) ??
      [...lv].filter((l) => l.elevation <= e + 0.01).sort((a, b) => b.elevation - a.elevation)[0];
    return +(e - (byId?.elevation ?? 0)).toFixed(4);
  }, "m"));

  // Identity Data
  add(txt("mark", "Mark", IDENTITY));
  add(txt("description", "Description", IDENTITY));
  add(txt("manufacturer", "Manufacturer", IDENTITY));
  add(txt("model", "Model", IDENTITY));
  add(txt("url", "URL", IDENTITY));
  add(txt("keynote", "Keynote", IDENTITY));
  add(txt("assemblyCode", "Assembly Code", IDENTITY));
  add(txt("typeComments", "Type Comments", IDENTITY));
  add(commentsField());
  add(typeMarkField());

  // Phasing
  add(txt("phaseCreated", "Phase Created", PHASING));
  add(txt("phaseDemolished", "Phase Demolished", PHASING));

  // IFC Parameters
  add({ key: "exportToIfc", label: "Export to IFC", group: IFC_GROUP, type: "boolean", target: "properties", default: true });
  add(txt("ifcPredefinedType", "IFC Predefined Type", IFC_GROUP));
  add({ key: "ifcType", label: "IFC Entity", group: IFC_GROUP, type: "text", target: "properties", readOnly: true });
  add({ key: "globalId", label: "IfcGUID", group: IFC_GROUP, type: "text", target: "properties", readOnly: true,
    compute: (el: any) => String(el?.properties?.globalId ?? el?.id ?? "") });

  // Other
  add(txt("workset", "Workset", OTHER_GROUP));
  add(txt("designOption", "Design Option", OTHER_GROUP));
  add({ key: "elementId", label: "Element ID", group: OTHER_GROUP, type: "text", target: "root", readOnly: true,
    compute: (el: any) => String(el?.id ?? "") });
  return out;
}

function ensureGroups(schema: ElementSchema, fields: PropertyField[]) {
  for (const f of fields) if (!schema.groups.includes(f.group)) schema.groups.push(f.group);
}

// Fitting-specific (elbow / tee / cross / transition / cap / union) parameters.
if (SCHEMAS.fitting) {
  const f = SCHEMAS.fitting;
  const fkind = (el: any) => String(el?.params?.fittingKind ?? el?.properties?.fittingKind ?? "elbow");
  const parent = (el: any) => String(el?.params?.parentType ?? "duct");
  const round = (el: any) => parent(el) === "pipe" || parent(el) === "conduit";
  f.groups = [CONSTRAINTS, MECHANICAL, DIMENSIONS, IDENTITY, MATERIALS];
  f.fields.push(
    // Mechanical
    { key: "systemType", label: "System Type", group: MECHANICAL, type: "select", target: "properties", default: "supply-air",
      options: [
        { value: "supply-air", label: "Supply Air" }, { value: "return-air", label: "Return Air" },
        { value: "exhaust-air", label: "Exhaust Air" }, { value: "fresh-air", label: "Fresh Air" },
        { value: "domestic-cold", label: "Domestic Cold Water" }, { value: "domestic-hot", label: "Domestic Hot Water" },
        { value: "sanitary", label: "Sanitary" }, { value: "hydronic-supply", label: "Hydronic Supply" },
        { value: "hydronic-return", label: "Hydronic Return" }, { value: "fire-protection", label: "Fire Protection" },
        { value: "power", label: "Power" }, { value: "data", label: "Data / Communications" },
      ] },
    { key: "systemName", label: "System Name", group: MECHANICAL, type: "text", target: "properties" },
    ro("classification", "Part Type", MECHANICAL, (el) => {
      const k = fkind(el);
      return ({ elbow: "Elbow", tee: "Tee", cross: "Cross", transition: "Transition", cap: "Cap", union: "Union", wye: "Junction" } as any)[k] ?? k;
    }),
    ro("parentSystem", "Fitting Of", MECHANICAL, (el) => ({ duct: "Duct", pipe: "Pipe", "cable-tray": "Cable Tray", conduit: "Conduit" } as any)[parent(el)] ?? parent(el)),
    ro("size", "Size", MECHANICAL, (el) => {
      const w = Number(el?.params?.thickness ?? 0), h = Number(el?.params?.height ?? w);
      return round(el) ? `\u00d8 ${(w * 1000).toFixed(0)} mm` : `${(w * 1000).toFixed(0)} x ${(h * 1000).toFixed(0)} mm`;
    }),
    // Dimensions
    ro("bendAngle", "Angle", DIMENSIONS, (el) => +(Math.abs(turnDeg(el)) * 180 / Math.PI).toFixed(2), "deg"),
    { key: "bendRadius", label: "Bend Radius (centreline)", group: DIMENSIONS, type: "number", unit: "m", step: 0.01, min: 0.02, target: "params",
      compute: (el: any) => +fittingRadius(el).toFixed(4),
      helpText: "Default 1.5 x width. Connected runs are re-trimmed." },
    ro("tangentLength", "Tangent Length", DIMENSIONS, (el) => +(fittingRadius(el) * Math.tan(Math.abs(turnDeg(el)) / 2)).toFixed(4), "m"),
    ro("arcLength", "Arc Length", DIMENSIONS, (el) => +(fittingRadius(el) * Math.abs(turnDeg(el))).toFixed(4), "m"),
    ro("outerRadius", "Outer Radius", DIMENSIONS, (el) => +(fittingRadius(el) + Number(el?.params?.thickness ?? 0) / 2).toFixed(4), "m"),
    ro("innerRadius", "Inner Radius", DIMENSIONS, (el) => +Math.max(0, fittingRadius(el) - Number(el?.params?.thickness ?? 0) / 2).toFixed(4), "m"),
  );
}

for (const key of Object.keys(SCHEMAS)) {
  const schema = (SCHEMAS as any)[key] as ElementSchema | undefined;
  if (!schema || key === "grid" || key === "level") continue;
  const extra = commonFields(schema);
  schema.fields.push(...extra);
  ensureGroups(schema, extra);
}
