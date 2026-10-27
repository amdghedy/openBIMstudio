/**
 * Universal Digital Twin capability registry.
 * Maps ElementType + recovered geometry to an honest editing mode and
 * the geometric parameters that actually regenerate 3D solids.
 */
import type { ElementType } from "../projects/types";

export type TwinEditMode =
  | "parametric-linear"
  | "parametric-vertical"
  | "parametric-slab"
  | "boundary-mesh"
  | "metadata-only"
  | "read-only";

export type GeometricParam =
  | "height"
  | "thickness"
  | "width"
  | "depth"
  | "elevation"
  | "sillHeight"
  | "offsetAlongHost"
  | "frameThickness";

export interface TwinCapabilities {
  editMode: TwinEditMode;
  geometricParams: GeometricParam[];
  prefersParametricSolid: boolean;
  notes: string;
}

/** Categories that use a plan-line baseline (start/end). */
export const LINEAR_ELEMENT_TYPES: ReadonlySet<ElementType> = new Set([
  "wall",
  "beam",
  "brace",
  "truss",
  "strip",
  "mline",
  "duct",
  "pipe",
  "cable-tray",
  "conduit",
]);

/** Point-based vertical members / equipment. */
export const VERTICAL_ELEMENT_TYPES: ReadonlySet<ElementType> = new Set([
  "column",
  "footing",
  "equipment",
  "fitting",
]);

/** Horizontal area solids. */
export const SLAB_LIKE_TYPES: ReadonlySet<ElementType> = new Set([
  "slab",
  "roof",
  "ceiling",
  "terrain",
  "room",
  "area",
]);

/** Hosted openings. */
export const HOSTED_ELEMENT_TYPES: ReadonlySet<ElementType> = new Set([
  "door",
  "window",
]);

/**
 * Geometric parameters the shared applyElementParamChange path regenerates
 * for a given category when the element is in a parametric mode.
 */
export function geometricParamsForType(type: ElementType): GeometricParam[] {
  if (LINEAR_ELEMENT_TYPES.has(type)) {
    return ["height", "thickness", "width", "depth", "elevation"];
  }
  if (VERTICAL_ELEMENT_TYPES.has(type)) {
    return ["height", "thickness", "width", "depth", "elevation"];
  }
  if (SLAB_LIKE_TYPES.has(type)) {
    return ["height", "thickness", "elevation"];
  }
  if (HOSTED_ELEMENT_TYPES.has(type)) {
    return ["height", "width", "sillHeight", "frameThickness", "offsetAlongHost"];
  }
  if (type === "stairs" || type === "ramp" || type === "railing" || type === "curtain-wall") {
    return ["height", "thickness", "elevation"];
  }
  return ["height", "thickness", "width", "depth", "elevation"];
}

export interface ClassifyInput {
  type: ElementType;
  hasPositions: boolean;
  hasLinearBaseline: boolean;
  linearReliable: boolean;
  hasPoint: boolean;
  hasPolygon: boolean;
  vertexCount: number;
}

/**
 * Classify an element after conversion based on recovered definition data.
 */
export function classifyTwinCapabilities(input: ClassifyInput): TwinCapabilities {
  const { type, hasPositions, hasLinearBaseline, linearReliable, hasPoint, hasPolygon, vertexCount } =
    input;

  if (!hasPositions && !hasLinearBaseline && !hasPoint && !hasPolygon) {
    return {
      editMode: "read-only",
      geometricParams: [],
      prefersParametricSolid: false,
      notes: "No recoverable geometry or parametric definition",
    };
  }

  if (LINEAR_ELEMENT_TYPES.has(type) && hasLinearBaseline && linearReliable) {
    return {
      editMode: "parametric-linear",
      geometricParams: geometricParamsForType(type),
      prefersParametricSolid: true,
      notes: "Plan baseline recovered; solid regenerated from start/end/height/thickness",
    };
  }

  if (VERTICAL_ELEMENT_TYPES.has(type) && hasPoint) {
    return {
      editMode: "parametric-vertical",
      geometricParams: geometricParamsForType(type),
      prefersParametricSolid: true,
      notes: "Point placement recovered; solid regenerated from point/height/section",
    };
  }

  if (SLAB_LIKE_TYPES.has(type) && hasPolygon) {
    return {
      editMode: "parametric-slab",
      geometricParams: geometricParamsForType(type),
      prefersParametricSolid: true,
      notes: "Plan polygon recovered; solid extruded from boundary/thickness",
    };
  }

  if (HOSTED_ELEMENT_TYPES.has(type)) {
    // Hosted elements need a host wall; without it they stay boundary or metadata.
    return {
      editMode: hasPositions ? "boundary-mesh" : "metadata-only",
      geometricParams: hasPositions ? geometricParamsForType(type) : [],
      prefersParametricSolid: false,
      notes: "Door/window requires host wall for parametric opening regeneration",
    };
  }

  if (hasPositions && vertexCount >= 3) {
    return {
      editMode: "boundary-mesh",
      geometricParams: geometricParamsForType(type),
      prefersParametricSolid: false,
      notes: "Boundary mesh editable via base-dimension scale; not full parametric solid",
    };
  }

  return {
    editMode: "metadata-only",
    geometricParams: [],
    prefersParametricSolid: false,
    notes: "Metadata only; geometric edits not supported",
  };
}

/** Whether createMesh should ignore frozen nativeGeometry and use builders. */
export function shouldPreferParametricSolid(
  type: ElementType,
  editMode: string,
  hasLinearBaseline: boolean,
  hasPoint: boolean,
  hasPolygon: boolean,
): boolean {
  if (editMode === "parametric-linear" && hasLinearBaseline) return true;
  if (editMode === "parametric-vertical" && hasPoint) return true;
  if (editMode === "parametric-slab" && hasPolygon) return true;
  // Category defaults when editMode not yet stored on legacy twins
  if (hasLinearBaseline && LINEAR_ELEMENT_TYPES.has(type)) return true;
  if (hasPoint && VERTICAL_ELEMENT_TYPES.has(type)) return true;
  if (hasPolygon && SLAB_LIKE_TYPES.has(type)) return true;
  return false;
}

/** Expanded IFC entity → ElementType mapping for all disciplines. */
export function elementTypeFromIfcEntity(entity: string): ElementType {
  const e = String(entity || "").toLowerCase();

  // Architectural
  if (e.includes("curtain")) return "curtain-wall";
  if (e.includes("wall")) return "wall";
  if (e.includes("slab") || e.includes("plate")) return "slab";
  if (e.includes("roof")) return "roof";
  if (e.includes("ceiling") || e.includes("covering")) return "ceiling";
  if (e.includes("door")) return "door";
  if (e.includes("window")) return "window";
  if (e.includes("stair")) return "stairs";
  if (e.includes("railing")) return "railing";
  if (e.includes("ramp")) return "ramp";
  if (e.includes("space") || e.includes("room")) return "room";
  if (e.includes("furniture") || e.includes("furnishing")) return "equipment";
  if (e.includes("buildingelementproxy") || e.includes("discreteaccessory")) return "generic";

  // Structural
  if (e.includes("column") || e.includes("pillar")) return "column";
  if (e.includes("beam") || e.includes("member")) return "beam";
  if (e.includes("brace") || e.includes("bracing")) return "brace";
  if (e.includes("truss")) return "truss";
  if (e.includes("footing") || e.includes("foundation") || e.includes("pile")) return "footing";
  if (e.includes("reinforcing")) return "generic";

  // Mechanical / HVAC
  if (e.includes("ductfitting") || e.includes("duct segment") || (e.includes("duct") && e.includes("fitting")))
    return "fitting";
  if (e.includes("duct")) return "duct";
  if (e.includes("airterminal") || e.includes("air terminal")) return "equipment";
  if (e.includes("chiller") || e.includes("boiler") || e.includes("fan") || e.includes("ahu"))
    return "equipment";

  // Plumbing / fire / pipe
  if (e.includes("pipefitting") || (e.includes("pipe") && e.includes("fitting"))) return "fitting";
  if (e.includes("pipe") || e.includes("flowsegment")) return "pipe";
  if (e.includes("valve") || e.includes("pump") || e.includes("tank") || e.includes("sanitary"))
    return "equipment";
  if (e.includes("fire") && (e.includes("sprinkler") || e.includes("protection"))) return "equipment";

  // Electrical
  if (e.includes("cabletray") || (e.includes("cable") && e.includes("tray"))) return "cable-tray";
  if (e.includes("conduit")) return "conduit";
  if (e.includes("cablefitting") || e.includes("cable segment")) return "fitting";
  if (
    e.includes("lightfixture") ||
    e.includes("lamp") ||
    e.includes("switchboard") ||
    e.includes("electricdistribution") ||
    e.includes("outlet") ||
    e.includes("junctionbox")
  )
    return "equipment";

  // Site / civil
  if (e.includes("geographic") || e.includes("terrain") || e.includes("site")) return "terrain";
  if (e.includes("grid")) return "grid";

  // Generic equipment / distribution
  if (e.includes("flowcontroller") || e.includes("flowterminal") || e.includes("energyconversion"))
    return "equipment";
  if (e.includes("equipment") || e.includes("engine") || e.includes("unitary")) return "equipment";
  if (e.includes("fitting") || e.includes("elbow") || e.includes("junction") || e.includes("transition"))
    return "fitting";

  return "generic";
}

/** Static capability matrix rows for documentation / audit. */
export function capabilityMatrixRows(): Array<{
  category: ElementType;
  discipline: string;
  conversion: string;
  editModeDefault: TwinEditMode;
  geometricParams: string;
}> {
  const row = (
    category: ElementType,
    discipline: string,
    conversion: string,
    editModeDefault: TwinEditMode,
  ) => ({
    category,
    discipline,
    conversion,
    editModeDefault,
    geometricParams: geometricParamsForType(category).join(", "),
  });

  return [
    row("wall", "Architectural / Structural", "Geometry + baseline", "parametric-linear"),
    row("door", "Architectural", "Geometry; host required for opening", "boundary-mesh"),
    row("window", "Architectural", "Geometry; host required for opening", "boundary-mesh"),
    row("slab", "Architectural / Structural", "Geometry + plan polygon when recoverable", "parametric-slab"),
    row("roof", "Architectural", "Geometry + polygon when recoverable", "parametric-slab"),
    row("ceiling", "Architectural", "Geometry + polygon when recoverable", "parametric-slab"),
    row("column", "Structural", "Geometry + point/section", "parametric-vertical"),
    row("beam", "Structural", "Geometry + baseline", "parametric-linear"),
    row("brace", "Structural", "Geometry + baseline", "parametric-linear"),
    row("footing", "Structural", "Geometry + point", "parametric-vertical"),
    row("truss", "Structural", "Geometry + baseline", "parametric-linear"),
    row("duct", "Mechanical", "Geometry + route baseline", "parametric-linear"),
    row("pipe", "Plumbing / Fire / Mech", "Geometry + route baseline", "parametric-linear"),
    row("cable-tray", "Electrical", "Geometry + route baseline", "parametric-linear"),
    row("conduit", "Electrical", "Geometry + route baseline", "parametric-linear"),
    row("fitting", "MEP", "Geometry + point/section", "parametric-vertical"),
    row("equipment", "MEP / Arch", "Geometry + point/box", "parametric-vertical"),
    row("stairs", "Architectural", "Geometry mesh", "boundary-mesh"),
    row("railing", "Architectural", "Geometry mesh", "boundary-mesh"),
    row("ramp", "Architectural", "Geometry mesh", "boundary-mesh"),
    row("curtain-wall", "Architectural", "Geometry mesh", "boundary-mesh"),
    row("room", "Architectural", "Space boundary when present", "parametric-slab"),
    row("terrain", "Civil / Site", "Surface / polygon", "parametric-slab"),
    row("generic", "Any", "Geometry mesh fallback", "boundary-mesh"),
  ];
}
