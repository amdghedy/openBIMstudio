/**
 * View Templates + Visibility/Graphics – shared types (Revit parity).
 * Compatible with existing VisibilityFilter category overrides.
 */

export type ViewKind =
  | "plan"
  | "ceiling"
  | "elevation"
  | "section"
  | "3d"
  | "detail"
  | "drafting"
  | "schedule"
  | "sheet";

/** Graphic overrides for a single category (Revit VG row). */
export interface CategoryGraphicOverride {
  visible: boolean;
  halftone: boolean;
  transparent: boolean;
  /** Optional projection line colour (CSS / hex). */
  lineColor?: string | null;
  /** Optional surface colour. */
  surfaceColor?: string | null;
  /** Line weight scale 1–16 (Revit-style). */
  lineWeight?: number | null;
  /** Pattern name or null = default. */
  surfacePattern?: string | null;
  cutPattern?: string | null;
}

/** Filter rule applied inside a view or template. */
export interface ViewFilterRule {
  id: string;
  name: string;
  /** Category or "All". */
  category: string;
  parameter: string;
  operator: "equals" | "notEquals" | "contains" | "greater" | "less" | "exists";
  value: string | number | boolean;
  /** If true, elements matching the rule are hidden. */
  hide: boolean;
  /** Optional override applied when rule matches (and hide=false). */
  override?: Partial<CategoryGraphicOverride>;
  enabled: boolean;
}

/** Complete Visibility/Graphics state for one view or template. */
export interface VisibilityGraphicsState {
  categoryOverrides: Record<string, CategoryGraphicOverride>;
  filters: ViewFilterRule[];
  /** Show annotation categories (dimensions, tags, text, grids…). */
  showAnnotations: boolean;
  /** Show analytical / model categories. */
  showModel: boolean;
  /** Detail level: coarse | medium | fine. */
  detailLevel: "coarse" | "medium" | "fine";
  /** Model display: wireframe | hiddenLine | shaded | realistic. */
  modelDisplay: "wireframe" | "hiddenLine" | "shaded" | "realistic";
  /** Underlay / underlay orientation for plans. */
  underlay?: {
    levelId: string | null;
    orientation: "lookDown" | "lookUp" | "none";
  };
}

export interface ViewTemplate {
  id: string;
  name: string;
  description?: string;
  /** Which view kinds this template may be applied to. */
  appliesTo: ViewKind[];
  vg: VisibilityGraphicsState;
  /** When true, applied views cannot locally override VG (Revit “Include” lock). */
  locked: boolean;
  /** Categories of settings included when applying the template. */
  includes: {
    modelCategories: boolean;
    annotationCategories: boolean;
    filters: boolean;
    detailLevel: boolean;
    modelDisplay: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ViewDefRef {
  id: string;
  name: string;
  kind: ViewKind;
  /** Applied template id or null. */
  templateId: string | null;
  /** Local VG overrides (merged on top of template when not locked). */
  localVg: VisibilityGraphicsState | null;
  /** True when the view has local overrides that differ from the template. */
  hasLocalOverrides: boolean;
}

/** Default VG used when nothing is set. */
export function createDefaultVg(): VisibilityGraphicsState {
  return {
    categoryOverrides: {},
    filters: [],
    showAnnotations: true,
    showModel: true,
    detailLevel: "medium",
    modelDisplay: "shaded",
    underlay: { levelId: null, orientation: "none" },
  };
}

/** Standard architectural categories used by the VG dialog. */
export const STANDARD_CATEGORIES: { id: string; label: string; group: string }[] = [
  { id: "Walls", label: "Walls", group: "Architecture" },
  { id: "Floors", label: "Floors", group: "Architecture" },
  { id: "Roofs", label: "Roofs", group: "Architecture" },
  { id: "Ceilings", label: "Ceilings", group: "Architecture" },
  { id: "Doors", label: "Doors", group: "Architecture" },
  { id: "Windows", label: "Windows", group: "Architecture" },
  { id: "Stairs", label: "Stairs", group: "Architecture" },
  { id: "Railings", label: "Railings", group: "Architecture" },
  { id: "CurtainWalls", label: "Curtain Walls", group: "Architecture" },
  { id: "Columns", label: "Columns", group: "Structure" },
  { id: "StructuralFraming", label: "Structural Framing", group: "Structure" },
  { id: "Foundations", label: "Foundations", group: "Structure" },
  { id: "Ducts", label: "Ducts", group: "MEP" },
  { id: "Pipes", label: "Pipes", group: "MEP" },
  { id: "CableTrays", label: "Cable Trays", group: "MEP" },
  { id: "Conduits", label: "Conduits", group: "MEP" },
  { id: "MechanicalEquipment", label: "Mechanical Equipment", group: "MEP" },
  { id: "ElectricalEquipment", label: "Electrical Equipment", group: "MEP" },
  { id: "PlumbingFixtures", label: "Plumbing Fixtures", group: "MEP" },
  { id: "Rooms", label: "Rooms", group: "Spatial" },
  { id: "Areas", label: "Areas", group: "Spatial" },
  { id: "Spaces", label: "Spaces", group: "Spatial" },
  { id: "Grids", label: "Grids", group: "Annotation" },
  { id: "Levels", label: "Levels", group: "Annotation" },
  { id: "Dimensions", label: "Dimensions", group: "Annotation" },
  { id: "Tags", label: "Tags", group: "Annotation" },
  { id: "TextNotes", label: "Text Notes", group: "Annotation" },
  { id: "DetailItems", label: "Detail Items", group: "Annotation" },
  { id: "GenericModels", label: "Generic Models", group: "Model" },
  { id: "Mass", label: "Mass", group: "Model" },
  { id: "Site", label: "Site", group: "Model" },
  { id: "Topography", label: "Topography", group: "Model" },
];

export function defaultCategoryOverride(): CategoryGraphicOverride {
  return {
    visible: true,
    halftone: false,
    transparent: false,
    lineColor: null,
    surfaceColor: null,
    lineWeight: null,
    surfacePattern: null,
    cutPattern: null,
  };
}
