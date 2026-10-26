/**
 * Per-tool modeling panel descriptors (MASTER PROMPT §2).
 *
 * Declarative, framework-free registry that says WHICH parameters each
 * modeling tool exposes, how they bind, and how they validate. The
 * properties palette renders from this — no per-tool UI code.
 *
 * Binding kinds:
 *   "type-default" → authoring.setTypeDefault(elementType, target, key, v)
 *                    (the value the NEXT placed element receives)
 *   "authoring"    → a named live state (location line, chain, join,
 *                    slope, justification…) via the palette's resolver.
 *
 * PURE module: no imports at all, so Node tests can compile it alone
 * and the palette can import it safely.
 */

export type ToolPanelFieldKind = "number" | "select" | "boolean" | "info";

export type ToolPanelBind =
  | { kind: "type-default"; target: "params" | "properties"; key: string }
  | { kind: "authoring"; stateKey: AuthoringStateKey };

export type AuthoringStateKey =
  | "wallLocationLine"
  | "wallChain"
  | "wallOffset"
  | "wallJoinStatus"
  | "beamJustification"
  | "beamZJustification"
  | "mepJustification"
  | "drawSlope";

export interface ToolPanelField {
  kind: ToolPanelFieldKind;
  label: string;
  helpText?: string;
  bind?: ToolPanelBind;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** Hide unless the wall data model supports a compound core (§3.1). */
  requiresCoreLayers?: boolean;
  /** Shown as a static hint (kind "info"). */
  text?: string;
}

export interface ToolPanelGroup {
  title: string;
  fields: ToolPanelField[];
}

export interface ToolPanelDescriptor {
  /** Internal draw tool (authoring Tool name). */
  tool: string;
  /** Element type the tool places. */
  elementType: string;
  title: string;
  subtitle: string;
  groups: ToolPanelGroup[];
}

/* ── Shared option sets ──────────────────────────────────────────────── */

const LOCATION_LINE_OPTIONS = [
  { value: "wall-centerline", label: "Wall Centerline" },
  { value: "core-centerline", label: "Core Centerline" },
  { value: "finish-exterior", label: "Finish Face: Exterior" },
  { value: "finish-interior", label: "Finish Face: Interior" },
  { value: "core-exterior", label: "Core Face: Exterior" },
  { value: "core-interior", label: "Core Face: Interior" },
];

const H_JUSTIFICATION_OPTIONS = [
  { value: "center", label: "Center" },
  { value: "outer", label: "Outer Edge" },
  { value: "inner", label: "Inner Edge" },
];

const Z_JUSTIFICATION_OPTIONS = [
  { value: "bottom", label: "Bottom" },
  { value: "center", label: "Center" },
  { value: "top", label: "Top" },
];

const JOIN_OPTIONS = [
  { value: "allow", label: "Allow join" },
  { value: "disallow", label: "Disallow join" },
];

/* ── Group builders ──────────────────────────────────────────────────── */

const dims = (fields: ToolPanelField[]): ToolPanelGroup => ({ title: "Dimensions", fields });
const constraints = (fields: ToolPanelField[]): ToolPanelGroup => ({ title: "Constraints", fields });
const justification = (fields: ToolPanelField[]): ToolPanelGroup => ({ title: "Justification & Location Line", fields });
const behavior = (fields: ToolPanelField[]): ToolPanelGroup => ({ title: "Placement Behavior", fields });

const td = (target: "params" | "properties", key: string): ToolPanelBind => ({ kind: "type-default", target, key });
const st = (stateKey: AuthoringStateKey): ToolPanelBind => ({ kind: "authoring", stateKey });

const numField = (
  label: string,
  key: string,
  opts: Partial<ToolPanelField> = {},
): ToolPanelField => ({
  kind: "number",
  label,
  bind: td("params", key),
  unit: "m",
  step: 0.05,
  min: 0.001,
  ...opts,
});

/* ── Per-tool descriptors (only parameters the engine really uses) ───── */

const WALL_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.01 }),
    numField("Thickness", "thickness", { min: 0.01 }),
  ]),
  constraints([
    numField("Base Elevation", "elevation", { step: 0.1, min: undefined, helpText: "Draw elevation; Arrow Up/Down adjusts it live" }),
  ]),
  justification([
    {
      kind: "select",
      label: "Location Line",
      bind: st("wallLocationLine"),
      options: LOCATION_LINE_OPTIONS,
      helpText: "Which face of the wall sits on the line you draw. Core options need a compound layered wall type.",
    },
    {
      kind: "select",
      label: "Location Line (core)",
      bind: st("wallLocationLine"),
      options: LOCATION_LINE_OPTIONS.filter((o) => o.value.startsWith("core")),
      requiresCoreLayers: true,
      helpText: "Available because the current wall type has a compound core (properties.layers).",
    },
    numField("Offset", "wallOffset", { bind: st("wallOffset"), step: 0.01, min: undefined, helpText: "Extra offset from the location line" }),
  ]),
  behavior([
    { kind: "boolean", label: "Chain", bind: st("wallChain"), helpText: "Keep drawing connected segments" },
    { kind: "select", label: "Join Status", bind: st("wallJoinStatus"), options: JOIN_OPTIONS },
    { kind: "info", label: "", text: "Click points to chain · Enter ends chain · snap to columns/walls to bind relationships" },
  ]),
];

const BEAM_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Depth (d)", "height", { min: 0.01 }),
    numField("Width (bf)", "thickness", { min: 0.01 }),
  ]),
  constraints([
    numField("Start Elevation", "elevation", { step: 0.1, min: undefined }),
  ]),
  justification([
    { kind: "select", label: "Horizontal Justification", bind: st("beamJustification"), options: H_JUSTIFICATION_OPTIONS, helpText: "Which face of the beam sits on the drawn line" },
    { kind: "select", label: "Z Justification", bind: st("beamZJustification"), options: Z_JUSTIFICATION_OPTIONS, helpText: "Top, center, or bottom of the beam at the draw elevation" },
    numField("End Elevation", "endElevation", { step: 0.1, min: undefined, helpText: "Leave empty to keep the beam level" }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Click start → end · snaps to column faces and wall endpoints" },
  ]),
];

const MEP_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.01, helpText: "Rectangular height (pipe: diameter)" }),
    numField("Width", "thickness", { min: 0.01, helpText: "Rectangular width (pipe: diameter)" }),
  ]),
  constraints([
    numField("Elevation", "elevation", { step: 0.1, min: undefined, helpText: "Centerline/insert elevation" }),
  ]),
  justification([
    { kind: "select", label: "Horizontal Justification", bind: st("mepJustification"), options: H_JUSTIFICATION_OPTIONS },
  ]),
  behavior([
    { kind: "number", label: "Slope", bind: st("drawSlope"), unit: "%", step: 0.1, helpText: "Applied along chained runs (ducts/pipes/trays/conduits)" },
    { kind: "info", label: "", text: "Chain bends get auto-fittings · snapping to connectors joins the network" },
  ]),
];

const SLAB_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Thickness", "height", { min: 0.01 }),
  ]),
  constraints([
    numField("Elevation", "elevation", { step: 0.1, min: undefined }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Click polygon points · click the first point again or press Enter to close (min 3 points)" },
  ]),
];

const COLUMN_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Width (b)", "thickness", { min: 0.01 }),
    numField("Depth (h)", "depth", { min: 0.01, helpText: "Falls back to width when empty" }),
    numField("Height", "height", { min: 0.01 }),
  ]),
  constraints([
    numField("Base Elevation", "elevation", { step: 0.1, min: undefined }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Click to place · walls drawn to its face bind to it" },
  ]),
];

const FOOTING_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Width", "thickness", { min: 0.01 }),
    numField("Depth", "depth", { min: 0.01, helpText: "Falls back to width when empty" }),
    numField("Height", "height", { min: 0.01 }),
  ]),
  constraints([
    numField("Top Elevation", "elevation", { step: 0.1, min: undefined, helpText: "Footing extends downward from here" }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Click to place" },
  ]),
];

const STRIP_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.01 }),
    numField("Width", "thickness", { min: 0.01 }),
  ]),
  constraints([
    numField("Base Elevation", "elevation", { step: 0.1, min: undefined }),
  ]),
  justification([
    { kind: "select", label: "Horizontal Justification", bind: st("beamJustification"), options: H_JUSTIFICATION_OPTIONS, helpText: "Which face of the footing sits on the drawn line" },
  ]),
  behavior([
    { kind: "info", label: "", text: "Click start → end" },
  ]),
];

const DOOR_WINDOW_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Width", "width", { min: 0.1 }),
    numField("Height", "height", { min: 0.1 }),
    numField("Sill Height", "sillHeight", { min: 0, helpText: "Window: height of the sill above the floor" }),
    numField("Frame Thickness", "frameThickness", { min: 0.01 }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Hover a wall and click to insert · the opening cuts the host" },
  ]),
];

const GENERIC_LINEAR_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.001 }),
    numField("Thickness", "thickness", { min: 0.001 }),
  ]),
  constraints([
    numField("Base Elevation", "elevation", { step: 0.1, min: undefined }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Click start → end (chain supported)" },
  ]),
];

const TRUSS_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.05 }),
    numField("Thickness", "thickness", { min: 0.01 }),
  ]),
  behavior([
    numField("Panels", "panels", { bind: td("params", "panels"), unit: "", step: 1, min: 2, max: 24 }),
    { kind: "info", label: "", text: "Click start → end" },
  ]),
];

const EQUIPMENT_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.01 }),
    numField("Width", "thickness", { min: 0.01 }),
  ]),
  constraints([
    numField("Elevation", "elevation", { step: 0.1, min: undefined }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Click to place the selected family/preset" },
  ]),
];

const CURTAIN_WALL_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.01 }),
    numField("Thickness", "thickness", { min: 0.01 }),
  ]),
  constraints([
    numField("Base Elevation", "elevation", { step: 0.1, min: undefined }),
  ]),
  justification([
    { kind: "select", label: "Location Line", bind: st("wallLocationLine"), options: LOCATION_LINE_OPTIONS.filter((o) => !o.value.startsWith("core")) },
    numField("Offset", "wallOffset", { bind: st("wallOffset"), step: 0.01, min: undefined }),
  ]),
  behavior([
    { kind: "boolean", label: "Chain", bind: st("wallChain") },
    { kind: "info", label: "", text: "Click points to chain" },
  ]),
];

const GRID_GROUPS: ToolPanelGroup[] = [
  behavior([
    { kind: "info", label: "", text: "Click start → end for each grid line · bubbles are generated automatically" },
  ]),
];

const LEVEL_GROUPS: ToolPanelGroup[] = [
  behavior([
    { kind: "info", label: "", text: "Click anywhere to create a level at the current elevation (Arrow Up/Down changes it)" },
  ]),
];

const MLINE_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.001 }),
    numField("Thickness", "thickness", { min: 0.001 }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Click start → end" },
  ]),
];

const BRACE_GROUPS: ToolPanelGroup[] = [
  dims([
    numField("Height", "height", { min: 0.01 }),
    numField("Thickness", "thickness", { min: 0.01 }),
  ]),
  behavior([
    { kind: "info", label: "", text: "Click start → end" },
  ]),
];

/* ── Registry ────────────────────────────────────────────────────────── */

export const TOOL_PANELS: Record<string, ToolPanelDescriptor> = {
  wall: {
    tool: "wall", elementType: "wall",
    title: "Wall", subtitle: "Parameters apply to the next wall you draw",
    groups: WALL_GROUPS,
  },
  "curtain-wall": {
    tool: "curtain-wall", elementType: "curtain-wall",
    title: "Curtain Wall", subtitle: "Parameters apply to the next curtain wall",
    groups: CURTAIN_WALL_GROUPS,
  },
  beam: {
    tool: "beam", elementType: "beam",
    title: "Beam", subtitle: "Parameters apply to the next beam you draw",
    groups: BEAM_GROUPS,
  },
  strip: {
    tool: "strip", elementType: "strip",
    title: "Strip Footing", subtitle: "Parameters apply to the next strip footing",
    groups: STRIP_GROUPS,
  },
  slab: {
    tool: "slab", elementType: "slab",
    title: "Slab / Floor", subtitle: "Parameters apply to the next slab boundary you close",
    groups: SLAB_GROUPS,
  },
  column: {
    tool: "column", elementType: "column",
    title: "Column", subtitle: "Parameters apply to the next column you place",
    groups: COLUMN_GROUPS,
  },
  footing: {
    tool: "footing", elementType: "footing",
    title: "Isolated Foundation", subtitle: "Parameters apply to the next footing you place",
    groups: FOOTING_GROUPS,
  },
  duct: {
    tool: "duct", elementType: "duct",
    title: "Duct", subtitle: "Parameters apply to the next duct run",
    groups: MEP_GROUPS,
  },
  pipe: {
    tool: "pipe", elementType: "pipe",
    title: "Pipe", subtitle: "Parameters apply to the next pipe run",
    groups: MEP_GROUPS,
  },
  "cable-tray": {
    tool: "cable-tray", elementType: "cable-tray",
    title: "Cable Tray", subtitle: "Parameters apply to the next tray run",
    groups: MEP_GROUPS,
  },
  conduit: {
    tool: "conduit", elementType: "conduit",
    title: "Conduit", subtitle: "Parameters apply to the next conduit run",
    groups: MEP_GROUPS,
  },
  door: {
    tool: "door", elementType: "door",
    title: "Door", subtitle: "Parameters apply to the next door you place in a wall",
    groups: DOOR_WINDOW_GROUPS,
  },
  window: {
    tool: "window", elementType: "window",
    title: "Window", subtitle: "Parameters apply to the next window you place in a wall",
    groups: DOOR_WINDOW_GROUPS,
  },
  truss: {
    tool: "truss", elementType: "truss",
    title: "Truss", subtitle: "Parameters apply to the next truss",
    groups: TRUSS_GROUPS,
  },
  brace: {
    tool: "brace", elementType: "brace",
    title: "Brace", subtitle: "Parameters apply to the next brace",
    groups: BRACE_GROUPS,
  },
  mline: {
    tool: "mline", elementType: "mline",
    title: "Model Line", subtitle: "Parameters apply to the next model line",
    groups: MLINE_GROUPS,
  },
  equipment: {
    tool: "equipment", elementType: "equipment",
    title: "Equipment / Family", subtitle: "Parameters apply to the next placed component",
    groups: EQUIPMENT_GROUPS,
  },
  grid: {
    tool: "grid", elementType: "grid",
    title: "Grid", subtitle: "Draw structural grid lines",
    groups: GRID_GROUPS,
  },
  level: {
    tool: "level", elementType: "level",
    title: "Level", subtitle: "Create a datum level",
    groups: LEVEL_GROUPS,
  },
};

/** Descriptor for an internal tool name, or null when the tool has none. */
export function getToolPanel(tool: string | null | undefined): ToolPanelDescriptor | null {
  if (!tool) return null;
  return TOOL_PANELS[tool] ?? null;
}

/** All tools covered — used by tests and by the ribbon badge. */
export function coveredTools(): string[] {
  return Object.keys(TOOL_PANELS);
}

/**
 * Validation shared by the palette: a numeric panel value must be finite
 * and inside [min, max] when given. Returns an error message or null.
 */
export function validatePanelNumber(
  field: ToolPanelField,
  value: number,
): string | null {
  if (!Number.isFinite(value)) return "Enter a valid number";
  if (field.min != null && value < field.min) {
    return `Minimum is ${field.min}${field.unit ? " " + field.unit : ""}`;
  }
  if (field.max != null && value > field.max) {
    return `Maximum is ${field.max}${field.unit ? " " + field.unit : ""}`;
  }
  return null;
}
