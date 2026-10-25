/**
 * Metadata-driven property schemas (MASTER PROMPT MODULE 2D.1, 2D.4, 2D.5).
 *
 * Every property definition carries the 21 metadata fields the spec
 * mandates (parameter id, names, description, data type, unit, defaults,
 * current/effective value slots, editability + read-only reason, range,
 * allowed values, formula association, scope, shared-parameter id,
 * validation rule, dependencies, precision, group, visibility condition,
 * change-propagation policy).
 *
 * Category schemas are the spec's minimum baseline: walls, columns,
 * beams/framing, floors/slabs, doors/windows, generic families/equipment,
 * pipes/ducts, conduits/cable-trays, MEP fittings/connectors, levels/
 * grids, stairs/railings, curtain walls, reinforcement.
 *
 * Editable inputs are distinguished from calculated outputs and explicit
 * overrides (spec 2D.3) via the `kind` field.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

export type PropertyDataType =
  | "length" | "area" | "volume" | "angle" | "number" | "integer"
  | "text" | "boolean" | "enum" | "element-reference" | "material";

export type PropertyScope = "instance" | "type";

export type PropertyKind2 =
  | "editable-input" | "calculated-output" | "read-only" | "formula-driven" | "explicit-override";

export type ChangePropagation =
  | "none" | "geometry-regeneration" | "hosted-elements" | "quantity-update" | "schedule-update";

export interface PropertyDefinition {
  /** Parameter id (stable). */
  id: string;
  /** Display name. */
  name: string;
  /** Internal/symbol name used in formulas. */
  symbol: string;
  description: string;
  dataType: PropertyDataType;
  /** Internal unit (SI); display unit may differ. */
  unit?: string;
  displayUnit?: string;
  defaultValue?: string | number | boolean | null;
  /** Editable state + reason when not editable (spec 2D.1). */
  editable: boolean;
  readOnlyReason?: string;
  kind: PropertyKind2;
  /** Inclusive numeric range. */
  min?: number;
  max?: number;
  /** Allowed enum values. */
  allowedValues?: string[];
  /** Formula expression when formula-driven. */
  formula?: string;
  scope: PropertyScope;
  /** Shared parameter GUID when applicable (spec 2D.1). */
  sharedParameterId?: string;
  /** Validation rule id (lifecycle.ts implements the rules). */
  validationRule?: string;
  /** Parameter ids this one depends on. */
  dependsOn: string[];
  /** Display digits. */
  precision: number;
  /** Group header in the panel. */
  group: string;
  /** Visibility condition: property shows only when true. */
  visibleWhen?: (ctx: PropertyVisibilityContext) => boolean;
  /** What a change propagates to (spec 2D.1). */
  propagation: ChangePropagation;
}

export interface PropertyVisibilityContext {
  values: Record<string, unknown>;
  categoryId: string;
}

// ── Builders ─────────────────────────────────────────────────────────────

interface Opt {
  name: string;
  symbol?: string;
  description?: string;
  unit?: string;
  displayUnit?: string;
  defaultValue?: string | number | boolean | null;
  readOnlyReason?: string;
  kind?: PropertyKind2;
  min?: number;
  max?: number;
  allowedValues?: string[];
  formula?: string;
  scope?: PropertyScope;
  sharedParameterId?: string;
  validationRule?: string;
  dependsOn?: string[];
  precision?: number;
  group?: string;
  visibleWhen?: PropertyDefinition["visibleWhen"];
  propagation?: ChangePropagation;
}

function len(id: string, o: Opt): PropertyDefinition {
  return {
    id, name: o.name, symbol: o.symbol ?? id, description: o.description ?? "",
    dataType: "length", unit: o.unit ?? "m", displayUnit: o.displayUnit ?? o.unit ?? "m",
    defaultValue: o.defaultValue ?? 0, editable: !o.readOnlyReason, readOnlyReason: o.readOnlyReason,
    kind: o.kind ?? "editable-input", min: o.min, max: o.max, allowedValues: o.allowedValues,
    formula: o.formula, scope: o.scope ?? "instance", sharedParameterId: o.sharedParameterId,
    validationRule: o.validationRule, dependsOn: o.dependsOn ?? [], precision: o.precision ?? 3,
    group: o.group ?? "Dimensions", visibleWhen: o.visibleWhen,
    propagation: o.propagation ?? "geometry-regeneration",
  };
}

function num(id: string, o: Opt): PropertyDefinition {
  return {
    ...len(id, o), dataType: "number", unit: o.unit, displayUnit: undefined, group: o.group ?? "Dimensions",
  };
}
function txt(id: string, o: Opt): PropertyDefinition {
  return {
    id, name: o.name, symbol: o.symbol ?? id, description: o.description ?? "",
    dataType: "text", defaultValue: o.defaultValue ?? "", editable: !o.readOnlyReason,
    readOnlyReason: o.readOnlyReason, kind: o.kind ?? "editable-input",
    scope: o.scope ?? "instance", dependsOn: o.dependsOn ?? [], precision: 0,
    group: o.group ?? "Identity", allowedValues: o.allowedValues,
    validationRule: o.validationRule, formula: o.formula, sharedParameterId: o.sharedParameterId,
    visibleWhen: o.visibleWhen, propagation: o.propagation ?? "none",
    displayUnit: undefined, min: o.min, max: o.max,
  };
}

function bool(id: string, o: Opt): PropertyDefinition {
  return {
    ...txt(id, o), dataType: "boolean", defaultValue: o.defaultValue ?? false,
    group: o.group ?? "Constraints",
  };
}

function enm(id: string, o: Opt): PropertyDefinition {
  return {
    ...txt(id, o), dataType: "enum", allowedValues: o.allowedValues ?? [],
    group: o.group ?? "Identity", defaultValue: o.defaultValue ?? (o.allowedValues?.[0] ?? null),
  };
}

function calc(id: string, o: Opt): PropertyDefinition {
  return {
    ...len(id, o), kind: "calculated-output", editable: false,
    readOnlyReason: o.readOnlyReason ?? "calculated from geometry (spec 2D.3: computed quantity)",
    propagation: "none",
  };
}

// ── Category schemas (spec 2D.4 baseline) ────────────────────────────────

const IDENTITY: PropertyDefinition[] = [
  txt("mark", { name: "Mark", group: "Identity", validationRule: "unique-per-category" }),
  txt("comments", { name: "Comments", group: "Identity" }),
  txt("phase-created", { name: "Phase Created", group: "Phasing", readOnlyReason: "managed by the phasing system" }),
];

export const WALL_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  enm("base-constraint", { name: "Base Constraint", group: "Constraints", allowedValues: ["level-1", "level-2", "level-3"] }),
  num("base-offset", { name: "Base Offset", unit: "m" }),
  enm("top-constraint", { name: "Top Constraint", group: "Constraints", allowedValues: ["level-1", "level-2", "level-3", "unconnected"] }),
  num("unconnected-height", { name: "Unconnected Height", unit: "m", min: 0,
    visibleWhen: (c) => c.values["top-constraint"] === "unconnected" }),
  num("top-offset", { name: "Top Offset", unit: "m" }),
  calc("length", { name: "Length", description: "Location-line length (computed)" }),
  num("width", { name: "Width", scope: "type" }),
  enm("location-line", { name: "Location Line", group: "Constraints",
    allowedValues: ["core-centerline", "finish-face-exterior", "finish-face-interior", "core-face-exterior", "core-face-interior"] }),
  bool("structural", { name: "Structural", group: "Structure" }),
  bool("room-bounding", { name: "Room Bounding", group: "Architecture" }),
  bool("pinned", { name: "Pinned", group: "Constraints", readOnlyReason: "pinned state is a command, not an editable value (spec 2C.9)" }),
  calc("volume", { name: "Volume", description: "Net volume after openings" }),
  calc("area", { name: "Area", description: "Elevation area of the bounding side" }),
];

export const COLUMN_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  enm("base-level", { name: "Base Level", group: "Constraints", allowedValues: ["level-1", "level-2", "level-3"] }),
  num("base-offset", { name: "Base Offset", unit: "m" }),
  enm("top-level", { name: "Top Level", group: "Constraints", allowedValues: ["level-1", "level-2", "level-3", "unconnected"] }),
  num("top-offset", { name: "Top Offset", unit: "m" }),
  calc("height", { name: "Height", description: "Computed from base/top constraints" }),
  num("rotation", { name: "Rotation", unit: "rad", displayUnit: "deg" }),
  num("width", { name: "Width (b)", scope: "type" }),
  num("depth", { name: "Depth (h)", scope: "type" }),
  enm("structural-role", { name: "Structural Role", group: "Structure", allowedValues: ["column", "pilaster"] }),
  calc("volume", { name: "Volume" }),
];

export const BEAM_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  txt("start-ref", { name: "Start Reference", group: "Constraints", readOnlyReason: "set by picking; reference identity is not typed (spec 2D.3)" }),
  txt("end-ref", { name: "End Reference", group: "Constraints", readOnlyReason: "set by picking" }),
  num("start-level-offset", { name: "Start Level Offset", unit: "m" }),
  num("end-level-offset", { name: "End Level Offset", unit: "m" }),
  calc("length", { name: "Length" }),
  enm("justification", { name: "Justification", group: "Constraints", allowedValues: ["start", "center", "end"] }),
  num("rotation", { name: "Rotation", unit: "rad", displayUnit: "deg" }),
  num("depth", { name: "Depth (d)", scope: "type" }),
  num("width", { name: "Width (bf)", scope: "type" }),
  enm("structural-role", { name: "Structural Role", group: "Structure", allowedValues: ["beam", "brace", "joist"] }),
];

export const FLOOR_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  enm("level", { name: "Level", group: "Constraints", allowedValues: ["level-1", "level-2", "level-3"] }),
  num("offset-from-level", { name: "Offset From Level", unit: "m" }),
  num("thickness", { name: "Thickness", scope: "type", min: 0.001 }),
  num("slope", { name: "Slope", unit: "rad", displayUnit: "deg" }),
  calc("area", { name: "Area", description: "Profile area minus openings" }),
  calc("volume", { name: "Volume" }),
  calc("perimeter", { name: "Perimeter" }),
];

export const DOOR_WINDOW_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  txt("host", { name: "Host", group: "Constraints", readOnlyReason: "host identity is a relationship (spec 2B.5)" }),
  num("width", { name: "Width", scope: "type", min: 0.1 }),
  num("height", { name: "Height", scope: "type", min: 0.1 }),
  num("sill-height", { name: "Sill Height", unit: "m",
    visibleWhen: (c) => c.categoryId === "windows" }),
  num("head-height", { name: "Head Height", readOnlyReason: "derived: sill + height", kind: "formula-driven", formula: "sill-height + height" }),
  num("offset", { name: "Offset", unit: "m" }),
  bool("flip-hand", { name: "Flip Hand" }),
  bool("flip-facing", { name: "Flip Facing" }),
  calc("position-along-host", { name: "Position Along Host", description: "Curve parameter on the host" }),
];

export const GENERIC_FAMILY_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  enm("placement-mode", { name: "Placement Mode", group: "Constraints",
    allowedValues: ["free", "level-based", "work-plane-based", "face-based", "wall-hosted"] }),
  txt("work-plane", { name: "Work Plane", group: "Constraints" }),
  num("offset", { name: "Offset", unit: "m" }),
  num("rotation", { name: "Rotation", unit: "rad", displayUnit: "deg" }),
  txt("host", { name: "Host", group: "Constraints", readOnlyReason: "host identity is a relationship" }),
];

export const PIPE_DUCT_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  enm("system", { name: "System", group: "Mechanical", allowedValues: ["supply-air", "return-air", "domestic-cold", "domestic-hot", "sanitary"] }),
  num("diameter", { name: "Diameter", unit: "m", scope: "type", min: 0.005,
    visibleWhen: (c) => c.values["shape"] === "round" }),
  num("width", { name: "Width", unit: "m", scope: "type",
    visibleWhen: (c) => c.values["shape"] === "rectangular" }),
  num("height", { name: "Height", unit: "m", scope: "type",
    visibleWhen: (c) => c.values["shape"] === "rectangular" }),
  calc("length", { name: "Length" }),
  num("slope", { name: "Slope", unit: "rad", displayUnit: "deg" }),
  num("start-elevation", { name: "Start Elevation", unit: "m", readOnlyReason: "computed from connector elevations" }),
  num("end-elevation", { name: "End Elevation", unit: "m", readOnlyReason: "computed from connector elevations" }),
  num("flow", { name: "Flow", unit: "m3/s", group: "Mechanical" }),
  num("insulation-thickness", { name: "Insulation Thickness", unit: "m", scope: "type" }),
  calc("pressure-loss", { name: "Pressure Loss", unit: "Pa/m", description: "Darcy-Weisbach friction (mep/pressure)" }),
];

export const CONDUIT_CABLETRAY_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  num("width", { name: "Width", unit: "m", scope: "type" }),
  num("height", { name: "Height", unit: "m", scope: "type" }),
  calc("length", { name: "Length" }),
  num("offset", { name: "Offset", unit: "m" }),
  num("bend-radius", { name: "Bend Radius", unit: "m", scope: "type" }),
  enm("system", { name: "System", group: "Electrical", allowedValues: ["power", "lighting", "data", "fire-alarm"] }),
];

export const FITTING_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  num("connector-count", { name: "Connector Count", readOnlyReason: "fixed by the family definition" }),
  enm("part-type", { name: "Part Type", group: "Mechanical",
    allowedValues: ["elbow", "tee", "cross", "reducer", "transition", "union", "wye", "cap"] }),
  calc("loss-coefficient", { name: "Loss Coefficient (C)", description: "Fitting C coefficient (mep/pressure)" }),
];

export const LEVEL_GRID_SCHEMA: PropertyDefinition[] = [
  txt("name", { name: "Name", group: "Identity" }),
  num("elevation", { name: "Elevation", unit: "m", group: "Constraints" }),
  bool("bubble-visible", { name: "Bubble Visible", group: "Annotation" }),
  bool("grid-head-at-end", { name: "Head At End", group: "Annotation" }),
  txt("scope-box", { name: "Scope Box", group: "Extents" }),
];

export const STAIR_RAILING_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  enm("base-level", { name: "Base Level", group: "Constraints", allowedValues: ["level-1", "level-2", "level-3"] }),
  enm("top-level", { name: "Top Level", group: "Constraints", allowedValues: ["level-1", "level-2", "level-3"] }),
  calc("total-rise", { name: "Total Rise", description: "top elevation − base elevation" }),
  num("desired-riser-height", { name: "Desired Riser Height", unit: "m", min: 0.05, max: 0.25 }),
  num("desired-tread-depth", { name: "Desired Tread Depth", unit: "m", min: 0.2, max: 0.35 }),
  calc("riser-count", { name: "Riser Count", description: "ceil(total rise / desired riser height)" }),
  calc("tread-count", { name: "Tread Count", description: "riser count − 1" }),
  calc("actual-riser-height", { name: "Actual Riser Height", readOnlyReason: "total rise / riser count" }),
  num("width", { name: "Width", unit: "m", scope: "type" }),
  num("slope", { name: "Slope", readOnlyReason: "atan(riser / tread)", kind: "calculated-output" }),
];

export const CURTAIN_WALL_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  num("grid-spacing-u", { name: "Grid 1 Spacing", unit: "m", scope: "type", min: 0.1 }),
  num("grid-spacing-v", { name: "Grid 2 Spacing", unit: "m", scope: "type", min: 0.1 }),
  enm("panel-type", { name: "Panel Type", scope: "type", allowedValues: ["glazed", "solid", "ventilated"] }),
  enm("mullion-type", { name: "Mullion Type", scope: "type", allowedValues: ["rectangular", "circular", "custom"] }),
  calc("panel-count-u", { name: "Panel Count (U)", description: "ceil(length / spacing)" }),
  calc("panel-count-v", { name: "Panel Count (V)" }),
  calc("glazed-area", { name: "Glazed Area" }),
];

export const REINFORCEMENT_SCHEMA: PropertyDefinition[] = [
  ...IDENTITY,
  enm("bar-type", { name: "Bar Type", scope: "type", allowedValues: ["straight", "stirrup-tie", "hooked"] }),
  num("diameter", { name: "Bar Diameter", unit: "m", scope: "type", min: 0.006 }),
  num("number", { name: "Quantity", min: 1 }),
  num("spacing", { name: "Spacing", unit: "m", min: 0.02,
    visibleWhen: (c) => c.values["layout"] === "spacing" }),
  enm("layout", { name: "Layout Rule", allowedValues: ["spacing", "fixed-number"] }),
  num("cover", { name: "Cover", unit: "m", min: 0 }),
  calc("total-length", { name: "Total Length", description: "number × bar length" }),
];

/** Category schema registry (spec 2D.4 "track coverage explicitly"). */
export const CATEGORY_SCHEMAS: Record<string, PropertyDefinition[]> = {
  walls: WALL_SCHEMA,
  columns: COLUMN_SCHEMA,
  beams: BEAM_SCHEMA,
  floors: FLOOR_SCHEMA,
  doors: DOOR_WINDOW_SCHEMA,
  windows: DOOR_WINDOW_SCHEMA,
  "generic-families": GENERIC_FAMILY_SCHEMA,
  "mep-equipment": GENERIC_FAMILY_SCHEMA,
  pipes: PIPE_DUCT_SCHEMA,
  ducts: PIPE_DUCT_SCHEMA,
  conduits: CONDUIT_CABLETRAY_SCHEMA,
  "cable-trays": CONDUIT_CABLETRAY_SCHEMA,
  "mep-fittings": FITTING_SCHEMA,
  levels: LEVEL_GRID_SCHEMA,
  grids: LEVEL_GRID_SCHEMA,
  stairs: STAIR_RAILING_SCHEMA,
  railings: STAIR_RAILING_SCHEMA,
  "curtain-walls": CURTAIN_WALL_SCHEMA,
  reinforcement: REINFORCEMENT_SCHEMA,
};

/** GetPropertyDefinitions for a category (spec 2D.2). */
export function getPropertyDefinitions(categoryId: string): PropertyDefinition[] {
  return CATEGORY_SCHEMAS[categoryId] ?? GENERIC_FAMILY_SCHEMA;
}

/** All covered categories (coverage tracking, spec 2D.4). */
export function coveredCategories(): string[] {
  return Object.keys(CATEGORY_SCHEMAS);
}
