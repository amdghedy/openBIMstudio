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
      { key: "length", label: "Length", group: DIMENSIONS, type: "number", unit: "m", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]); } },
      { key: "area", label: "Area", group: DIMENSIONS, type: "number", unit: "m2", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; const h = el?.params?.height ?? 0; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]) * h; } },
      { key: "volume", label: "Volume", group: DIMENSIONS, type: "number", unit: "m3", step: 0.001, target: "params", readOnly: true,
        compute: (el: any) => { const a = el?.params?.start, b = el?.params?.end; const h = el?.params?.height ?? 0; const t = el?.params?.thickness ?? 0; if (!a || !b) return 0; return Math.hypot(b[0]-a[0], b[1]-a[1]) * h * t; } },
      { key: "image", label: "Image", group: IDENTITY, type: "text", target: "properties" },
      { key: "comments", label: "Comments", group: IDENTITY, type: "text", target: "properties" },
      { key: "mark", label: "Mark", group: IDENTITY, type: "text", target: "properties" },
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
      num("height", "Height", DIMENSIONS, 0.05, 0.05),
      num("thickness", "Width", DIMENSIONS, 0.05, 0.05),
      elev(),
      nameField(),
      {
        key: "systemType",
        label: "System",
        group: IDENTITY,
        type: "select",
        target: "properties",
        options: [
          { value: "supply-air", label: "Supply air" },
          { value: "return-air", label: "Return air" },
          { value: "exhaust-air", label: "Exhaust air" },
          { value: "fresh-air", label: "Fresh air" },
        ],
        default: "supply-air",
      },
      typeMarkField(),
      commentsField(),
      colorField(),
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
    label: "Cable tray",
    icon: "cable-tray",
    groups: [DIMENSIONS, CONSTRAINTS, IDENTITY, MATERIALS],
    fields: [
      num("height", "Depth", DIMENSIONS, 0.01, 0.01),
      num("thickness", "Width", DIMENSIONS, 0.05, 0.05),
      elev(),
      nameField(),
      typeMarkField(),
      commentsField(),
      colorField(),
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

export function hasSchema(type: ElementType | string | null | undefined): boolean {
  if (!type) return false;
  return !!SCHEMAS[type as ElementType];
}

export function getSchema(type: ElementType | string): ElementSchema | null {
  return SCHEMAS[type as ElementType] ?? null;
}