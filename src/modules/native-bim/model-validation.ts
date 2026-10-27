/**
 * Native BIM model validation.
 *
 * This module is deliberately side-effect free: authoring commands, save/export
 * flows, tests and future AI actions can use the same rules without coupling
 * validation to Three.js, the DOM, or the project store.
 *
 * Coordinates and linear parameters are metres; plan coordinates use X/Z.
 */
import type { AuthoredElement, GridDatum, LevelDatum } from "../projects/types";

export type ValidationSeverity = "error" | "warning" | "info";

export interface ModelDiagnostic {
  code: string;
  severity: ValidationSeverity;
  message: string;
  elementId?: string;
  relatedId?: string;
  path?: string;
}

export interface NativeModelSnapshot {
  elements: readonly AuthoredElement[];
  levels?: readonly LevelDatum[];
  grids?: readonly GridDatum[];
}

const LINEAR_TYPES = new Set([
  "wall", "beam", "brace", "truss", "strip", "mline",
  "duct", "pipe", "cable-tray", "conduit",
]);
const HOSTED_TYPES = new Set(["door", "window"]);
const FITTED_TYPES = new Set(["duct", "pipe", "cable-tray", "conduit"]);
const EPS = 1e-8;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}
function distance2(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0));
}
function polygonArea(points: readonly (readonly number[])[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += (a[0] ?? 0) * (b[1] ?? 0) - (b[0] ?? 0) * (a[1] ?? 0);
  }
  return Math.abs(area) / 2;
}

/** Validate authored geometry, relationships, identity and IFC payloads. */
export function validateNativeModel(snapshot: NativeModelSnapshot): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  const add = (
    code: string,
    severity: ValidationSeverity,
    message: string,
    elementId?: string,
    relatedId?: string,
    path?: string,
  ) => diagnostics.push({ code, severity, message, elementId, relatedId, path });

  const elements = snapshot.elements ?? [];
  const byId = new Map<string, AuthoredElement>();
  const globalIds = new Map<string, string>();
  const levelIds = new Set((snapshot.levels ?? []).map((x) => x.id));
  const gridIds = new Set<string>();

  for (const level of snapshot.levels ?? []) {
    if (!level.id?.trim()) add("LEVEL_ID_MISSING", "error", "Level has no stable ID.");
    if (!finite(level.elevation)) add("LEVEL_ELEVATION_INVALID", "error", "Level elevation must be finite.", level.id);
  }
  for (const grid of snapshot.grids ?? []) {
    if (!grid.id?.trim()) add("GRID_ID_MISSING", "error", "Grid has no stable ID.");
    if (gridIds.has(grid.id)) add("GRID_ID_DUPLICATE", "error", `Grid ID "${grid.id}" is duplicated.`, grid.id);
    gridIds.add(grid.id);
    if (![...grid.start, ...grid.end].every(finite)) {
      add("GRID_COORDINATE_INVALID", "error", "Grid coordinates must be finite.", grid.id);
    } else if (distance2(grid.start, grid.end) < EPS) {
      add("GRID_LENGTH_ZERO", "error", "Grid start and end points must differ.", grid.id);
    }
  }

  for (const el of elements) {
    if (!el.id?.trim()) {
      add("ELEMENT_ID_MISSING", "error", "Every authored element must have a stable, non-empty ID.");
      continue;
    }
    if (byId.has(el.id)) {
      add("ELEMENT_ID_DUPLICATE", "error", `Element ID "${el.id}" is duplicated.`, el.id);
      continue;
    }
    byId.set(el.id, el);

    if (!el.type) add("ELEMENT_TYPE_MISSING", "error", "Element category/type is required.", el.id, undefined, "type");
    if (!el.name?.trim()) add("ELEMENT_NAME_MISSING", "warning", "Element name is empty.", el.id, undefined, "name");

    const p = el.params;
    for (const key of ["height", "thickness", "elevation"] as const) {
      if (!finite(p[key])) add("PARAM_NOT_FINITE", "error", `Parameter "${key}" must be finite.`, el.id, undefined, `params.${key}`);
    }
    if (finite(p.height) && p.height <= 0) add("HEIGHT_NOT_POSITIVE", "error", "Height must be greater than zero.", el.id, undefined, "params.height");
    if (finite(p.thickness) && p.thickness <= 0) add("THICKNESS_NOT_POSITIVE", "error", "Thickness must be greater than zero.", el.id, undefined, "params.thickness");
    if (p.width !== undefined && !positive(p.width)) add("WIDTH_NOT_POSITIVE", "error", "Width must be greater than zero.", el.id, undefined, "params.width");
    if (p.depth !== undefined && !positive(p.depth)) add("DEPTH_NOT_POSITIVE", "error", "Depth must be greater than zero.", el.id, undefined, "params.depth");

    if (LINEAR_TYPES.has(el.type)) {
      // Boundary-mesh Native Twins may not have a recovered baseline yet; do not
      // block height/property edits that only update params.height on mesh geometry.
      const isBoundaryTwin =
        !!(el as any).nativeGeometry?.positions?.length &&
        ((el.properties as any)?.editMode === "boundary-mesh" || !p.start || !p.end);
      if (isBoundaryTwin && (!p.start || !p.end)) {
        // Warn only — height scaling of nativeGeometry remains valid.
        add(
          "LINEAR_ENDPOINTS_MISSING",
          "warning",
          "Linear baseline not recovered; element is edited as boundary geometry.",
          el.id,
          undefined,
          "params",
        );
      } else if (!p.start || !p.end) {
        add("LINEAR_ENDPOINTS_MISSING", "error", "Linear element requires start and end coordinates.", el.id, undefined, "params");
      } else if (![...p.start, ...p.end].every(finite)) {
        add("LINEAR_COORDINATE_INVALID", "error", "Linear element coordinates must be finite.", el.id, undefined, "params.start");
      } else if (distance2(p.start, p.end) < EPS) {
        add("LINEAR_LENGTH_ZERO", "error", "Linear element start and end must differ.", el.id, undefined, "params.end");
      }
    }

    if (el.type === "slab" || el.type === "footing" || el.type === "roof" || el.type === "room" || el.type === "area") {
      if (!p.polygon || p.polygon.length < 3) {
        add("POLYGON_TOO_FEW_POINTS", "error", "Area-based element requires at least three polygon points.", el.id, undefined, "params.polygon");
      } else if (!p.polygon.every((pt) => pt.length >= 2 && pt.every(finite))) {
        add("POLYGON_COORDINATE_INVALID", "error", "Polygon points must contain finite X/Z coordinates.", el.id, undefined, "params.polygon");
      } else if (polygonArea(p.polygon) < EPS) {
        add("POLYGON_AREA_ZERO", "error", "Polygon area must be greater than zero.", el.id, undefined, "params.polygon");
      }
    }

    if (HOSTED_TYPES.has(el.type)) {
      if (!el.hostId) add("HOST_MISSING", "error", "Door/window must reference a host wall.", el.id, undefined, "hostId");
      if (el.hostId === el.id) add("HOST_SELF_REFERENCE", "error", "Element cannot host itself.", el.id, el.hostId);
      if (p.offsetAlongHost !== undefined && (!finite(p.offsetAlongHost) || p.offsetAlongHost < 0)) {
        add("HOST_OFFSET_INVALID", "error", "Host offset must be a finite, non-negative distance in metres.", el.id, el.hostId, "params.offsetAlongHost");
      }
      if (p.sillHeight !== undefined && (!finite(p.sillHeight) || p.sillHeight < 0)) {
        add("SILL_HEIGHT_INVALID", "error", "Sill height must be finite and non-negative.", el.id, el.hostId, "params.sillHeight");
      }
    }

    if (el.levelId && levelIds.size > 0 && !levelIds.has(el.levelId)) {
      add("LEVEL_REFERENCE_MISSING", "warning", `Referenced level "${el.levelId}" is not present in the supplied level set.`, el.id, el.levelId, "levelId");
    }

    if (el.nativeGeometry) {
      const positions = el.nativeGeometry.positions;
      if (!Array.isArray(positions) || positions.length === 0 || positions.length % 9 !== 0) {
        add("NATIVE_GEOMETRY_TRIANGLES_INVALID", "error", "Native geometry must contain complete, non-empty triangles (9 coordinates per triangle).", el.id, undefined, "nativeGeometry.positions");
      } else if (!positions.every(finite)) {
        add("NATIVE_GEOMETRY_NON_FINITE", "error", "Native geometry contains non-finite coordinates.", el.id, undefined, "nativeGeometry.positions");
      }
    }

    if (el.transform) {
      const t = el.transform;
      if (t.position.length !== 3 || !t.position.every(finite)) add("TRANSFORM_POSITION_INVALID", "error", "Transform position must contain three finite values.", el.id, undefined, "transform.position");
      if (t.quaternion.length !== 4 || !t.quaternion.every(finite) || Math.hypot(...t.quaternion) < EPS) {
        add("TRANSFORM_QUATERNION_INVALID", "error", "Transform quaternion must contain four finite values and have non-zero magnitude.", el.id, undefined, "transform.quaternion");
      }
      if (t.scale.length !== 3 || !t.scale.every(finite) || t.scale.some((v) => Math.abs(v) < EPS)) {
        add("TRANSFORM_SCALE_INVALID", "error", "Transform scale must contain three finite, non-zero values.", el.id, undefined, "transform.scale");
      }
    }

    const globalId = el.ifc?.globalId;
    if (globalId) {
      const previous = globalIds.get(globalId);
      if (previous && previous !== el.id) {
        add("IFC_GLOBAL_ID_DUPLICATE", "error", `IFC GlobalId "${globalId}" is shared by multiple native elements.`, el.id, previous, "ifc.globalId");
      } else globalIds.set(globalId, el.id);
    }
    if (el.ifc?.sourceGlobalId && el.ifc.globalId && el.ifc.sourceGlobalId !== el.ifc.globalId) {
      add("IFC_IDENTITY_DIVERGENCE", "warning", "Source IFC GlobalId differs from the native element GlobalId; preserve both explicitly during round-trip export.", el.id, undefined, "ifc.sourceGlobalId");
    }

    if (el.type === "fitting") {
      const parentType = p.parentType;
      if (!parentType || !FITTED_TYPES.has(parentType)) {
        add("FITTING_PARENT_TYPE_INVALID", "error", "Fitting must identify a supported parent MEP type.", el.id, undefined, "params.parentType");
      }
      if (p.point && !p.point.every(finite)) add("FITTING_POINT_INVALID", "error", "Fitting insertion point must be finite.", el.id, undefined, "params.point");
      if (p.bendRadius !== undefined && (!finite(p.bendRadius) || p.bendRadius <= 0)) {
        add("FITTING_RADIUS_INVALID", "error", "Fitting bend radius must be positive and finite.", el.id, undefined, "params.bendRadius");
      }
    }
  }

  // Resolve host relationships only after the complete element index exists.
  for (const el of elements) {
    if (!HOSTED_TYPES.has(el.type) || !el.hostId) continue;
    const host = byId.get(el.hostId);
    if (!host) add("HOST_REFERENCE_MISSING", "error", `Host element "${el.hostId}" does not exist in the model.`, el.id, el.hostId, "hostId");
    else if (host.type !== "wall") add("HOST_NOT_WALL", "error", "Door/window host must be a wall.", el.id, host.id, "hostId");
    else {
      const hostLength = host.params.start && host.params.end
        ? distance2(host.params.start, host.params.end)
        : 0;
      const centerOffset = finite(el.params.offsetAlongHost) ? el.params.offsetAlongHost : hostLength / 2;
      const halfWidth = finite(el.params.width) ? el.params.width / 2 : 0;
      if (hostLength > 0 && (centerOffset - halfWidth < -1e-6 || centerOffset + halfWidth > hostLength + 1e-6)) {
        add("HOSTED_ELEMENT_EXCEEDS_HOST_LENGTH", "error", "Door/window width and center offset must fit entirely within the host wall length.", el.id, host.id, "params.offsetAlongHost");
      }
      if (finite(el.params.offsetAlongHost) && finite(host.params.height) && finite(el.params.height) &&
        (el.params.sillHeight ?? 0) + el.params.height > host.params.height + 1e-6) {
        add("HOSTED_ELEMENT_EXCEEDS_HOST_HEIGHT", "warning", "Hosted element extends above the host wall height.", el.id, host.id, "params.height");
      }
    }
  }

  return diagnostics;
}

/** Return true only when a model has no blocking errors. */
export function isNativeModelValid(snapshot: NativeModelSnapshot): boolean {
  return !validateNativeModel(snapshot).some((d) => d.severity === "error");
}

/** Summarize diagnostics for save/export status bars and QA reports. */
export function summarizeDiagnostics(diagnostics: readonly ModelDiagnostic[]) {
  return {
    total: diagnostics.length,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    info: diagnostics.filter((d) => d.severity === "info").length,
  };
}
