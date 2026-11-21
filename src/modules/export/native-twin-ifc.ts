// openbim-fix:v3:applied
/**
 * Minimal IFC4 SPF writer for Native Twins.
 *
 * - One twin → standalone IFC
 * - Many twins → one federated IFC4 (single Project/Site/Building/Storey)
 *
 * Entity selection (GAP-05, fix/native-ifc-entities): the writer used to call
 * safeEntityName() and discard the result, emitting IFCBUILDINGELEMENTPROXY
 * for every element. It now emits the real IFC4 entity for each genuinely
 * supported type (see NATIVE_IFC_ENTITY_MAP), with the correct per-type
 * attribute list from the IFC4 schema, a validated PredefinedType, the
 * source Tag, and — for doors/windows — OverallHeight/OverallWidth derived
 * from the twin's recorded dimensions or its local geometry bounding box.
 * Types with no typed writer fall back to IfcBuildingElementProxy explicitly
 * and are listed as proxied in the conversion report
 * (writeFederatedNativeTwinIfcWithReport) — never silently.
 *
 * What this writer does NOT do (documented limits, see
 * docs/engineering/NATIVE_IFC_ENTITY_EXPORT.md):
 * - It does not emit IfcWallStandardCase: that entity requires a SweptSolid
 *   + Axis representation, while twins carry tessellated geometry, so plain
 *   IfcWall is the correct entity for a tessellated wall.
 * - It does not create IfcOpeningElement / IfcRelFillsElement relationships
 *   for doors/windows: twins carry no host-wall information, so doors and
 *   windows are exported as standalone products with placement, tessellated
 *   Body representation and storey containment, not as filled openings.
 * - It performs no axis conversion: positions/quaternions/geometry are
 *   written in the twin's own (three.js, Y-up) frame, as before.
 * - OverallHeight/OverallWidth are bounding-box approximations, not
 *   parametric source values, unless supplied via overrides.
 */

import { newIfcGuid, stableIfcGuid, isValidIfcGuid } from "../bim-gaps/ifc-guid";

/** Minimal twin shape needed for IFC export (avoids cycle with frag-edit). */
export interface TwinIfcSource {
  name?: string;
  description?: string;
  nativeEntity?: string;
  sourceEntity?: string;
  sourceGlobalId?: string;
  nativeId?: string;
  /** Source PredefinedType (FragEdit.predefinedType); validated per-type, never trusted raw. */
  predefinedType?: string;
  /** Source Tag (FragEdit.sourceTag; `tag` is the same value under the writer's own name). */
  tag?: string;
  sourceTag?: string;
  /** Bounding-box dimensions in the twin's local frame (FragEdit.dimensions): Y-up, so height is the Y extent. */
  dimensions?: { width?: number; height?: number; depth?: number };
  modelId: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  propertySets?: Record<string, Record<string, unknown>>;
  overrides?: Record<string, unknown>;
  geometry?: { positions?: number[] | Float32Array };
}

/**
 * Encode text as an ISO 10303-21 string body (without the surrounding quotes).
 * STEP rules: an apostrophe is doubled (`''`), a backslash is doubled (`\\`), and any character outside printable ASCII
 * (including control characters and newlines) is written as `\X2\<UTF-16 hex>\X0\`. The former `\'` form ended the
 * string early in every conforming reader, so a name such as "Owner's room" produced a corrupt file.
 * (Kept from main #251 — the native-ifc branch predates that fix.)
 */
function esc(s: string): string {
  const str = String(s ?? "");
  let out = "";
  let wide = "";
  const flush = () => { if (wide) { out += `\\X2\\${wide}\\X0\\`; wide = ""; } };
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i); // UTF-16 code unit: surrogate pairs stay as two units, as \X2\ requires
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      const ch = str[i];
      out += ch === "'" ? "''" : ch === "\\" ? "\\\\" : ch;
    } else {
      wide += code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  flush();
  return out;
}

/**
 * Fresh valid IFC GlobalId (22-char buildingSMART base64).
 *
 * openbim-fix: the previous implementation truncated a random UUID hex to 22
 * chars, which is NOT the compressed-GUID encoding — consumers and validators
 * rejected such files. All relationship/pset/opening instances now use the
 * real codec from modules/bim-gaps/ifc-guid.
 */
function guid(): string {
  return newIfcGuid();
}

/** Valid GlobalId for an element: keep a real source GUID, else derive one. */
function elementGuid(edit: TwinIfcSource): string {
  const candidate = edit.sourceGlobalId || edit.nativeId || "";
  if (isValidIfcGuid(candidate)) return candidate;
  return stableIfcGuid(`native-twin|${edit.modelId}|${edit.nativeId || edit.name || guid()}`);
}

/**
 * Format a number as a STEP REAL literal. Always carries a decimal point:
 * bare integers ("0", "1") in IfcDirection ratios / IfcCartesianPoint
 * coordinates parse as INTEGERs, and IfcOpenShell's geometry kernel fails
 * to build a shape from a placement whose direction ratios are integers
 * ("Unexpected topology") even though the file parses. Emitting "0." /
 * "1." matches IfcOpenShell's own writer style and is valid for every
 * REAL-valued attribute this writer emits.
 */
function num(n: number): string {
  if (!Number.isFinite(n)) return "0.";
  const s = n.toFixed(6);
  const t = s.replace(/\.?0+$/, "") || "0";
  return t.includes(".") ? t : `${t}.`;
}

/* ---------------------------------------------------------- entity mapping */

/**
 * Explicit supported-type mapping, verified against the IFC4 schema with
 * IfcOpenShell 0.9.0 (`ifcopenshell.schema_by_name("IFC4")` — attribute
 * order, arity and enumeration values). `predefinedTypeEnum` is the full
 * IFC4 enumeration for the entity's PredefinedType attribute; `commonPset`
 * is the standard IFC4 common property set for the entity, or null when
 * the IFC4 pset templates define none for it. `overallSize` marks the
 * entities that additionally carry OverallHeight/OverallWidth.
 *
 * Attribute arity (IFC4, IfcRoot 4 + ObjectType 1 + Product 2 + Tag 1):
 * - 8 attributes: entities with no PredefinedType (IfcFurnishingElement,
 *   IfcFlowSegment, IfcFlowTerminal, IfcFlowFitting, IfcDistributionElement)
 * - 9 attributes: + PredefinedType (wall/slab/beam/column/member/plate/
 *   footing/railing/stair/ramp/proxy)
 * - 10 attributes: IfcPile (+ ConstructionType)
 * - 13 attributes: IfcDoor / IfcWindow (+ OverallHeight, OverallWidth,
 *   PredefinedType, OperationType/PartitioningType, UserDefined…Type)
 */
export interface NativeIfcEntitySpec {
  /** Canonical IFC4 entity name, as emitted. */
  entity: string;
  /** Full IFC4 PredefinedType enumeration, or null when the entity has none. */
  predefinedTypeEnum: readonly string[] | null;
  /** Standard IFC4 common property set, or null when none is defined. */
  commonPset: string | null;
  /** True when the entity carries OverallHeight/OverallWidth. */
  overallSize?: boolean;
}

export const NATIVE_IFC_ENTITY_MAP: Record<string, NativeIfcEntitySpec> = {
  IfcWall: {
    entity: "IfcWall",
    predefinedTypeEnum: ["MOVABLE", "PARAPET", "PARTITIONING", "PLUMBINGWALL", "SHEAR", "SOLIDWALL", "STANDARD", "POLYGONAL", "ELEMENTEDWALL", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_WallCommon",
  },
  IfcSlab: {
    entity: "IfcSlab",
    predefinedTypeEnum: ["FLOOR", "ROOF", "LANDING", "BASESLAB", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_SlabCommon",
  },
  IfcBeam: {
    entity: "IfcBeam",
    predefinedTypeEnum: ["BEAM", "JOIST", "HOLLOWCORE", "LINTEL", "SPANDREL", "T_BEAM", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_BeamCommon",
  },
  IfcColumn: {
    entity: "IfcColumn",
    predefinedTypeEnum: ["COLUMN", "PILASTER", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_ColumnCommon",
  },
  IfcDoor: {
    entity: "IfcDoor",
    predefinedTypeEnum: ["DOOR", "GATE", "TRAPDOOR", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_DoorCommon",
    overallSize: true,
  },
  IfcWindow: {
    entity: "IfcWindow",
    predefinedTypeEnum: ["WINDOW", "SKYLIGHT", "LIGHTDOME", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_WindowCommon",
    overallSize: true,
  },
  IfcMember: {
    entity: "IfcMember",
    predefinedTypeEnum: ["BRACE", "CHORD", "COLLAR", "MEMBER", "MULLION", "PLATE", "POST", "PURLIN", "RAFTER", "STRINGER", "STRUT", "STUD", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_MemberCommon",
  },
  IfcPlate: {
    entity: "IfcPlate",
    predefinedTypeEnum: ["CURTAIN_PANEL", "SHEET", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_PlateCommon",
  },
  IfcFooting: {
    entity: "IfcFooting",
    predefinedTypeEnum: ["CAISSON_FOUNDATION", "FOOTING_BEAM", "PAD_FOOTING", "PILE_CAP", "STRIP_FOOTING", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_FootingCommon",
  },
  IfcPile: {
    entity: "IfcPile",
    predefinedTypeEnum: ["BORED", "DRIVEN", "JETGROUTING", "COHESION", "FRICTION", "SUPPORT", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_PileCommon",
  },
  IfcRailing: {
    entity: "IfcRailing",
    predefinedTypeEnum: ["HANDRAIL", "GUARDRAIL", "BALUSTRADE", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_RailingCommon",
  },
  IfcStair: {
    entity: "IfcStair",
    predefinedTypeEnum: ["STRAIGHT_RUN_STAIR", "TWO_STRAIGHT_RUN_STAIR", "QUARTER_WINDING_STAIR", "QUARTER_TURN_STAIR", "HALF_WINDING_STAIR", "HALF_TURN_STAIR", "TWO_QUARTER_WINDING_STAIR", "TWO_QUARTER_TURN_STAIR", "THREE_QUARTER_WINDING_STAIR", "THREE_QUARTER_TURN_STAIR", "SPIRAL_STAIR", "DOUBLE_RETURN_STAIR", "CURVED_RUN_STAIR", "TWO_CURVED_RUN_STAIR", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_StairCommon",
  },
  IfcRamp: {
    entity: "IfcRamp",
    predefinedTypeEnum: ["STRAIGHT_RUN_RAMP", "TWO_STRAIGHT_RUN_RAMP", "QUARTER_TURN_RAMP", "TWO_QUARTER_TURN_RAMP", "HALF_TURN_RAMP", "SPIRAL_RAMP", "USERDEFINED", "NOTDEFINED"],
    commonPset: "Pset_RampCommon",
  },
  IfcFurnishingElement: {
    entity: "IfcFurnishingElement",
    predefinedTypeEnum: null,
    commonPset: null,
  },
  IfcFlowSegment: {
    entity: "IfcFlowSegment",
    predefinedTypeEnum: null,
    commonPset: "Pset_DistributionFlowElementCommon",
  },
  IfcFlowTerminal: {
    entity: "IfcFlowTerminal",
    predefinedTypeEnum: null,
    commonPset: "Pset_DistributionFlowElementCommon",
  },
  IfcFlowFitting: {
    entity: "IfcFlowFitting",
    predefinedTypeEnum: null,
    commonPset: "Pset_DistributionFlowElementCommon",
  },
  IfcDistributionElement: {
    entity: "IfcDistributionElement",
    predefinedTypeEnum: null,
    commonPset: null,
  },
};

/** IFC4 IfcPileConstructionEnum — IfcPile carries a second enum attribute. Twins carry no construction-type source, so .NOTDEFINED. is always emitted. */
const PILE_CONSTRUCTION_TYPE = "NOTDEFINED";

/**
 * Normalise a raw entity label to a canonical entity name, case-insensitively.
 * Accepts "IfcWall", "IFCWALL", "Wall", "ifcwall". IfcWallStandardCase and
 * IfcWallElementedCase map to IfcWall: StandardCase requires a SweptSolid +
 * Axis representation which tessellated twins cannot provide, and
 * ElementedCase requires subordinate aggregated elements which twins do
 * not carry — plain IfcWall is the correct entity for a tessellated wall.
 * Returns null when the label names no supported entity.
 */
function canonicalEntity(raw: string): { spec: NativeIfcEntitySpec; note?: string } | null {
  const stem = raw.trim().replace(/^ifc/i, "").toLowerCase();
  if (!stem) return null;
  if (stem === "wallstandardcase" || stem === "wallelementedcase") {
    return {
      spec: NATIVE_IFC_ENTITY_MAP.IfcWall,
      note: `source entity '${raw.trim()}' mapped to IfcWall: tessellated twins cannot satisfy ${raw.trim()}'s representation/decomposition requirements`,
    };
  }
  for (const spec of Object.values(NATIVE_IFC_ENTITY_MAP)) {
    if (spec.entity.toLowerCase() === `ifc${stem}`.toLowerCase()) return { spec };
  }
  return null;
}

export type NativeIfcResolutionStatus = "typed" | "proxied";

export interface NativeIfcResolution {
  /** Entity actually emitted. */
  entity: string;
  status: NativeIfcResolutionStatus;
  /** Emitted PredefinedType literal, or null when the entity has no such attribute. */
  predefinedType: string | null;
  /** Why the element was proxied; null for typed elements. */
  fallbackReason: string | null;
  /** Non-fatal mapping notes (case normalisation, enum fallback, case mapping). */
  notes: string[];
}

/**
 * Resolve the IFC entity for one twin. Pure function — no I/O, no STEP
 * output — so the mapping is unit-testable on its own. A supported type
 * always resolves typed; anything else resolves to IfcBuildingElementProxy
 * with an explicit reason (never silently).
 */
export function resolveNativeIfcEntity(edit: TwinIfcSource): NativeIfcResolution {
  const notes: string[] = [];
  const raw = (edit.nativeEntity || edit.sourceEntity || "").trim();
  if (!raw) {
    return {
      entity: "IfcBuildingElementProxy",
      status: "proxied",
      predefinedType: "NOTDEFINED",
      fallbackReason: "no entity information on the twin (nativeEntity/sourceEntity both empty)",
      notes,
    };
  }
  if (raw.replace(/^ifc/i, "").toLowerCase() === "buildingelementproxy") {
    return {
      entity: "IfcBuildingElementProxy",
      status: "proxied",
      predefinedType: "NOTDEFINED",
      fallbackReason: "source type is already IfcBuildingElementProxy — no more specific entity exists",
      notes,
    };
  }
  const found = canonicalEntity(raw);
  if (!found) {
    return {
      entity: "IfcBuildingElementProxy",
      status: "proxied",
      predefinedType: "NOTDEFINED",
      fallbackReason: `unsupported type '${raw}' — no typed writer for this entity`,
      notes,
    };
  }
  if (found.note) notes.push(found.note);
  const spec = found.spec;
  let predefinedType: string | null = null;
  if (spec.predefinedTypeEnum) {
    const supplied = (edit.predefinedType || "").trim().toUpperCase();
    if (!supplied) {
      predefinedType = "NOTDEFINED";
    } else if (supplied === "USERDEFINED") {
      // IFC4 where-rule CorrectPredefinedType: USERDEFINED requires
      // ObjectType, which twins do not carry — downgrade, do not emit an
      // invalid instance.
      predefinedType = "NOTDEFINED";
      notes.push("PredefinedType USERDEFINED dropped (no ObjectType label to satisfy the CorrectPredefinedType where-rule) — emitted .NOTDEFINED.");
    } else if (spec.predefinedTypeEnum.includes(supplied)) {
      predefinedType = supplied;
    } else {
      predefinedType = "NOTDEFINED";
      notes.push(`PredefinedType '${edit.predefinedType}' is not a valid ${spec.entity} PredefinedType — emitted .NOTDEFINED.`);
    }
  }
  return { entity: spec.entity, status: "typed", predefinedType, fallbackReason: null, notes };
}

/** Backwards-compatible name for the old helper: now returns the resolved entity. */
export function safeEntityName(edit: TwinIfcSource): string {
  return resolveNativeIfcEntity(edit).entity;
}

/**
 * Documented alias labels (deprecated IFC2x3/IFC4 subtypes that are
 * geometrically a plain parent) — the same set main's #246 shipped, so
 * decideTwinEntity keeps its "alias" mapping for them.
 */
const DECIDE_ALIASES: Record<string, string> = {
  IFCWALLSTANDARDCASE: "IfcWall", IFCWALLELEMENTEDCASE: "IfcWall",
  IFCSLABSTANDARDCASE: "IfcSlab", IFCBEAMSTANDARDCASE: "IfcBeam",
  IFCCOLUMNSTANDARDCASE: "IfcColumn", IFCMEMBERSTANDARDCASE: "IfcMember",
  IFCPLATESTANDARDCASE: "IfcPlate", IFCDOORSTANDARDCASE: "IfcDoor",
  IFCWINDOWSTANDARDCASE: "IfcWindow", IFCSTAIRFLIGHT: "IfcStair",
};

export interface TwinEntityDecision {
  /** Entity the source asked for (nativeEntity || sourceEntity), as given. */
  requested: string;
  /** IFC4 entity that will be written. */
  entity: string;
  /** "exact" | "alias" (documented parent) | "fallback" (IfcBuildingElementProxy, semantic information is lost). */
  mapping: "exact" | "alias" | "fallback";
}

/**
 * Decide which IFC4 entity a twin is written as. Pure. Kept from main
 * (#246) as the thin mapping API; the richer resolution (PredefinedType,
 * fallback reason, notes) lives in resolveNativeIfcEntity.
 */
export function decideTwinEntity(edit: TwinIfcSource): TwinEntityDecision {
  const requested = String(edit.nativeEntity || edit.sourceEntity || "");
  const up = requested.toUpperCase();
  if (up === "IFCBUILDINGELEMENTPROXY" || up === "BUILDINGELEMENTPROXY") {
    return { requested, entity: "IfcBuildingElementProxy", mapping: "exact" };
  }
  const alias = DECIDE_ALIASES[up];
  if (alias) return { requested, entity: alias, mapping: "alias" };
  const resolution = resolveNativeIfcEntity(edit);
  if (resolution.status === "typed") return { requested, entity: resolution.entity, mapping: "exact" };
  return { requested, entity: "IfcBuildingElementProxy", mapping: "fallback" };
}

/** Entity-level conversion report: what was requested vs what was written. */
export function twinConversionReport(edits: TwinIfcSource[]): {
  total: number; exact: number; alias: number; fallback: number;
  byRequested: Record<string, { entity: string; mapping: TwinEntityDecision["mapping"]; count: number }>;
} {
  const byRequested: Record<string, { entity: string; mapping: TwinEntityDecision["mapping"]; count: number }> = {};
  let exact = 0, alias = 0, fallback = 0;
  for (const e of edits) {
    const d = decideTwinEntity(e);
    const k = d.requested || "(none)";
    (byRequested[k] ??= { entity: d.entity, mapping: d.mapping, count: 0 }).count++;
    if (d.mapping === "exact") exact++; else if (d.mapping === "alias") alias++; else fallback++;
  }
  return { total: edits.length, exact, alias, fallback, byRequested };
}

/** One element's entry in the conversion report. */
export interface NativeIfcElementReport {
  name: string;
  /** Raw entity label the twin carried (nativeEntity ?? sourceEntity), or null. */
  sourceEntity: string | null;
  /** IFC4 entity actually emitted. */
  emittedEntity: string;
  status: NativeIfcResolutionStatus;
  globalId: string;
  predefinedType: string | null;
  tag: string | null;
  overallHeight: number | null;
  overallWidth: number | null;
  /** False when the placement had to be repaired (non-finite / degenerate). */
  placementValid: boolean;
  geometry: { vertices: number; triangles: number; representation: "tessellation" | "none" };
  /** Property-set names attached via IfcRelDefinesByProperties (incl. lineage). */
  propertySets: string[];
  fallbackReason: string | null;
  notes: string[];
}

/** Conversion report for one export — entity inventory, semantic conversion, geometry conversion, round-trip fidelity inputs. */
export interface NativeIfcExportReport {
  schema: "IFC4";
  projectName: string;
  generatedAt: string;
  elements: NativeIfcElementReport[];
  counts: { total: number; typed: number; proxied: number };
}

type Ctx = {
  lines: string[];
  next: () => number;
  owner: number;
  localOrigin: number;
};

/** Positive finite number, or null. */
function positiveFinite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * OverallHeight/OverallWidth for doors/windows, in the twin's local frame.
 * Priority: explicit overrides (user-supplied) → recorded dimensions
 * (FragEdit.dimensions: width = X extent, height = Y extent, Y-up) →
 * local geometry bounding box (X extent = width, Y extent = height).
 * All three are bounding-box approximations, not parametric source values;
 * null means "omit" ($ in STEP) rather than inventing a number.
 */
function overallSize(
  edit: TwinIfcSource,
  positions: ArrayLike<number> | undefined,
): { height: number | null; width: number | null; notes: string[] } {
  const notes: string[] = [];
  const fromOverrides = {
    height: positiveFinite(edit.overrides?.OverallHeight),
    width: positiveFinite(edit.overrides?.OverallWidth),
  };
  if (fromOverrides.height != null || fromOverrides.width != null) {
    return { height: fromOverrides.height, width: fromOverrides.width, notes };
  }
  const fromDimensions = {
    height: positiveFinite(edit.dimensions?.height),
    width: positiveFinite(edit.dimensions?.width),
  };
  if (fromDimensions.height != null || fromDimensions.width != null) {
    return { height: fromDimensions.height, width: fromDimensions.width, notes };
  }
  if (positions && positions.length >= 9) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let finite = true;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(positions[i + 2])) { finite = false; break; }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (finite) {
      notes.push("OverallHeight/OverallWidth derived from the local geometry bounding box (Y extent = height, X extent = width) — bounding-box approximations, not source parameters.");
      return { height: maxY - minY > 0 ? maxY - minY : null, width: maxX - minX > 0 ? maxX - minX : null, notes };
    }
  }
  return { height: null, width: null, notes };
}

/** Validate + normalise a placement. Repairs are reported, never silent. */
function sanePlacement(edit: TwinIfcSource): {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  valid: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  let valid = true;
  let position: [number, number, number] = [0, 0, 0];
  if (edit.position?.length === 3 && edit.position.every((v) => Number.isFinite(v))) {
    position = [edit.position[0], edit.position[1], edit.position[2]];
  } else {
    valid = false;
    notes.push("non-finite position — placement reset to the storey origin (0,0,0)");
  }
  let quaternion: [number, number, number, number] = [0, 0, 0, 1];
  const q = edit.quaternion;
  if (q?.length === 4 && q.every((v) => Number.isFinite(v))) {
    const len = Math.hypot(q[0], q[1], q[2], q[3]);
    if (len > 1e-12) {
      quaternion = [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
    } else {
      valid = false;
      notes.push("degenerate (zero-norm) quaternion — identity rotation used");
    }
  } else {
    valid = false;
    notes.push("non-finite quaternion — identity rotation used");
  }
  return { position, quaternion, valid, notes };
}

/** Append one element (placement + tessellation + psets) under a storey. Returns the element's report entry. */
function appendTwinElement(ctx: Ctx, edit: TwinIfcSource, storey: number): NativeIfcElementReport {
  const { lines, next, owner, localOrigin } = ctx;
  const name = esc(edit.name || "NativeTwin");
  const globalId = esc(elementGuid(edit));
  const description = esc(edit.description || `Native twin of ${edit.sourceEntity || edit.nativeEntity || "element"}`);
  const resolution = resolveNativeIfcEntity(edit);
  const notes = [...resolution.notes];
  const rawTag = (edit.tag ?? edit.sourceTag ?? "").trim();
  const tag = rawTag ? rawTag : null;
  const tagArg = tag ? `'${esc(tag)}'` : "$";

  const placement = sanePlacement(edit);
  notes.push(...placement.notes);
  const [px, py, pz] = placement.position;
  const [qx, qy, qz, qw] = placement.quaternion;
  const xx = qx * qx,
    yy = qy * qy,
    zz = qz * qz;
  const xy = qx * qy,
    xz = qx * qz,
    yz = qy * qz;
  const wx = qw * qx,
    wy = qw * qy,
    wz = qw * qz;
  const r00 = 1 - 2 * (yy + zz);
  const r01 = 2 * (xy - wz);
  const r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz);
  const r11 = 1 - 2 * (xx + zz);
  const r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy);
  const r21 = 2 * (yz + wx);
  const r22 = 1 - 2 * (xx + yy);

  const elPt = next();
  const elDirZ = next();
  const elDirX = next();
  const elAxis = next();
  const elPlace = next();
  lines.push(`#${elPt}=IFCCARTESIANPOINT((${num(px)},${num(py)},${num(pz)}));`);
  lines.push(`#${elDirZ}=IFCDIRECTION((${num(r02)},${num(r12)},${num(r22)}));`);
  lines.push(`#${elDirX}=IFCDIRECTION((${num(r00)},${num(r10)},${num(r20)}));`);
  lines.push(`#${elAxis}=IFCAXIS2PLACEMENT3D(#${elPt},#${elDirZ},#${elDirX});`);
  lines.push(`#${elPlace}=IFCLOCALPLACEMENT(#${localOrigin},#${elAxis});`);

  const positions = edit.geometry?.positions ?? [];
  const geometryFinite =
    positions.length >= 9 && Array.from(positions as ArrayLike<number>).every((v) => Number.isFinite(v));
  if (positions.length >= 9 && !geometryFinite) {
    notes.push("non-finite geometry coordinates — representation omitted (no tessellation emitted)");
  }
  let shapeRepRef = 0;
  let vertices = 0;
  let triangles = 0;
  if (geometryFinite) {
    const coordList: string[] = [];
    const faceList: string[] = [];
    const nVerts = Math.floor(positions.length / 3);
    vertices = nVerts;
    for (let i = 0; i < nVerts; i++) {
      coordList.push(
        `(${num(positions[i * 3])},${num(positions[i * 3 + 1])},${num(positions[i * 3 + 2])})`,
      );
    }
    const nTris = Math.floor(nVerts / 3);
    triangles = nTris;
    for (let t = 0; t < nTris; t++) {
      // IfcTriangulatedFaceSet.CoordIndex = LIST OF LIST[3] OF index: one triple per triangle (an extra pair of brackets made web-ifc abort with 'stoll: no conversion').
      faceList.push(`(${t * 3 + 1},${t * 3 + 2},${t * 3 + 3})`);
    }
    const coords = next();
    lines.push(`#${coords}=IFCCARTESIANPOINTLIST3D((${coordList.join(",")}));`);
    const faces = next();
    lines.push(`#${faces}=IFCTRIANGULATEDFACESET(#${coords},$,.F.,(${faceList.join(",")}),$);`);
    const bodyStyle = next();
    const bodyRep = next();
    lines.push(`#${bodyStyle}=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#${faces}));`);
    lines.push(`#${bodyRep}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${bodyStyle}));`);
    shapeRepRef = bodyRep;
  }

  // Per-type trailing attributes, in IFC4 attribute order (see the mapping
  // table above for arity). Common prefix for every entity:
  // GlobalId, OwnerHistory, Name, Description, ObjectType ($),
  // ObjectPlacement, Representation, Tag.
  const el = next();
  const shapeArg = shapeRepRef ? `#${shapeRepRef}` : "$";
  const commonArgs = `'${globalId}',#${owner},'${name}','${description}',$` + `,#${elPlace},${shapeArg},${tagArg}`;
  const predef = resolution.predefinedType ? `.${resolution.predefinedType}.` : null;
  let tail: string;
  let overallHeight: number | null = null;
  let overallWidth: number | null = null;
  if (resolution.entity === "IfcPile") {
    tail = `${predef},.${PILE_CONSTRUCTION_TYPE}.`;
  } else if (resolution.entity === "IfcDoor" || resolution.entity === "IfcWindow") {
    const size = overallSize(edit, positions);
    overallHeight = size.height;
    overallWidth = size.width;
    notes.push(...size.notes);
    const h = overallHeight != null ? num(overallHeight) : "$";
    const w = overallWidth != null ? num(overallWidth) : "$";
    // OverallHeight, OverallWidth, PredefinedType, OperationType/PartitioningType ($ = unknown), UserDefined…Type ($).
    tail = `${h},${w},${predef},$,$`;
  } else if (predef) {
    tail = `${predef}`;
  } else {
    tail = "";
  }
  const entityArgs = tail ? `${commonArgs},${tail}` : commonArgs;
  lines.push(`#${el}=${resolution.entity.toUpperCase()}(${entityArgs});`);

  const relCont = next();
  lines.push(
    `#${relCont}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',#${owner},$,$,(#${el}),#${storey});`,
  );

  const psets = {
    ...(edit.propertySets ?? {}),
    ...(edit.overrides ? { NativeOverrides: edit.overrides } : {}),
  };
  const attachedPsets: string[] = [];
  for (const [psetName, props] of Object.entries(psets)) {
    if (!props || typeof props !== "object") continue;
    const propIds: number[] = [];
    for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
      if (v == null) continue;
      const pid = next();
      propIds.push(pid);
      if (typeof v === "number") {
        lines.push(`#${pid}=IFCPROPERTYSINGLEVALUE('${esc(k)}',$,IFCREAL(${num(v)}),$);`);
      } else if (typeof v === "boolean") {
        lines.push(`#${pid}=IFCPROPERTYSINGLEVALUE('${esc(k)}',$,IFCBOOLEAN(.${v ? "T" : "F"}.),$);`);
      } else {
        lines.push(`#${pid}=IFCPROPERTYSINGLEVALUE('${esc(k)}',$,IFCLABEL('${esc(String(v))}'),$);`);
      }
    }
    if (!propIds.length) continue;
    attachedPsets.push(psetName);
    const psid = next();
    lines.push(
      `#${psid}=IFCPROPERTYSET('${guid()}',#${owner},'${esc(psetName)}',$,(${propIds.map((x) => `#${x}`).join(",")}));`,
    );
    const rel = next();
    lines.push(`#${rel}=IFCRELDEFINESBYPROPERTIES('${guid()}',#${owner},$,$,(#${el}),#${psid});`);
  }

  const linPid = next();
  lines.push(
    `#${linPid}=IFCPROPERTYSINGLEVALUE('SourceGlobalId',$,IFCLABEL('${esc(edit.sourceGlobalId || "")}'),$);`,
  );
  const linPid2 = next();
  lines.push(
    `#${linPid2}=IFCPROPERTYSINGLEVALUE('SourceEntity',$,IFCLABEL('${esc(edit.sourceEntity || edit.nativeEntity || "")}'),$);`,
  );
  const linPid3 = next();
  lines.push(
    `#${linPid3}=IFCPROPERTYSINGLEVALUE('SourceModelId',$,IFCLABEL('${esc(edit.modelId)}'),$);`,
  );
  const linPs = next();
  lines.push(
    `#${linPs}=IFCPROPERTYSET('${guid()}',#${owner},'Pset_NativeTwinLineage',$,(#${linPid},#${linPid2},#${linPid3}));`,
  );
  const linRel = next();
  lines.push(`#${linRel}=IFCRELDEFINESBYPROPERTIES('${guid()}',#${owner},$,$,(#${el}),#${linPs});`);
  attachedPsets.push("Pset_NativeTwinLineage");
  if (resolution.status === "proxied") {
    notes.push(`emitted as IfcBuildingElementProxy: ${resolution.fallbackReason}`);
  }

  return {
    name: edit.name || "NativeTwin",
    sourceEntity: (edit.nativeEntity || edit.sourceEntity || "").trim() || null,
    emittedEntity: resolution.entity,
    status: resolution.status,
    globalId: elementGuid(edit),
    predefinedType: resolution.predefinedType,
    tag,
    overallHeight,
    overallWidth,
    placementValid: placement.valid,
    geometry: { vertices, triangles, representation: shapeRepRef ? "tessellation" : "none" },
    propertySets: attachedPsets,
    fallbackReason: resolution.fallbackReason,
    notes,
  };
}

function writeHeader(projectName: string): string[] {
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    `FILE_NAME('${esc(projectName)}.ifc','${new Date().toISOString()}',('Open BIM Studio'),('Open BIM Studio'),'Open BIM Studio','Open BIM Studio','');`,
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
  ];
}

function writeSpatialSkeleton(
  lines: string[],
  next: () => number,
  projectName: string,
): { owner: number; localOrigin: number; storey: number } {
  const person = next();
  lines.push(`#${person}=IFCPERSON($,$,'OBS',$,$,$,$,$);`);
  const org = next();
  lines.push(`#${org}=IFCORGANIZATION($,'Open BIM Studio',$,$,$);`);
  const personOrg = next();
  lines.push(`#${personOrg}=IFCPERSONANDORGANIZATION(#${person},#${org},$);`);
  const app = next();
  lines.push(`#${app}=IFCAPPLICATION(#${personOrg},'Open BIM Studio','Open BIM Studio','OBS');`);
  const owner = next();
  lines.push(
    `#${owner}=IFCOWNERHISTORY(#${personOrg},#${app},$,.ADDED.,$,$,$,${Math.floor(Date.now() / 1000)});`,
  );

  const lengthUnit = next();
  const areaUnit = next();
  const volumeUnit = next();
  const angleUnit = next();
  const unitAssign = next();
  const project = next();
  const site = next();
  const building = next();
  const storey = next();
  const localOrigin = next();
  const axis2 = next();
  const cartPt = next();
  const dirZ = next();
  const dirX = next();

  lines.push(`#${cartPt}=IFCCARTESIANPOINT((0.,0.,0.));`);
  lines.push(`#${dirZ}=IFCDIRECTION((0.,0.,1.));`);
  lines.push(`#${dirX}=IFCDIRECTION((1.,0.,0.));`);
  lines.push(`#${axis2}=IFCAXIS2PLACEMENT3D(#${cartPt},#${dirZ},#${dirX});`);
  lines.push(`#${localOrigin}=IFCLOCALPLACEMENT($,#${axis2});`);
  lines.push(`#${lengthUnit}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  lines.push(`#${areaUnit}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
  lines.push(`#${volumeUnit}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
  lines.push(`#${angleUnit}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`);
  lines.push(
    `#${unitAssign}=IFCUNITASSIGNMENT((#${lengthUnit},#${areaUnit},#${volumeUnit},#${angleUnit}));`,
  );
  lines.push(
    `#${project}=IFCPROJECT('${guid()}',#${owner},'${esc(projectName)}',$,$,$,$,(#${unitAssign}),$);`,
  );
  lines.push(
    `#${site}=IFCSITE('${guid()}',#${owner},'Site',$,$,#${localOrigin},$,$,.ELEMENT.,$,$,$,$,$);`,
  );
  lines.push(
    `#${building}=IFCBUILDING('${guid()}',#${owner},'Building',$,$,#${localOrigin},$,$,.ELEMENT.,$,$,$);`,
  );
  lines.push(
    `#${storey}=IFCBUILDINGSTOREY('${guid()}',#${owner},'Level 0',$,$,#${localOrigin},$,$,.ELEMENT.,0.);`,
  );
  const relAgg1 = next();
  const relAgg2 = next();
  const relAgg3 = next();
  lines.push(`#${relAgg1}=IFCRELAGGREGATES('${guid()}',#${owner},$,$,#${project},(#${site}));`);
  lines.push(`#${relAgg2}=IFCRELAGGREGATES('${guid()}',#${owner},$,$,#${site},(#${building}));`);
  lines.push(`#${relAgg3}=IFCRELAGGREGATES('${guid()}',#${owner},$,$,#${building},(#${storey}));`);

  return { owner, localOrigin, storey };
}

function beginFederated(projectName: string): {
  lines: string[];
  next: () => number;
  ctx: Ctx;
  storey: number;
} {
  const lines = writeHeader(projectName.replace(/[^a-z0-9._-]+/gi, "_") || "native-ifc");
  let id = 1;
  const next = () => id++;
  const { owner, localOrigin, storey } = writeSpatialSkeleton(lines, next, projectName);
  return { lines, next, ctx: { lines, next, owner, localOrigin }, storey };
}

function endFederated(lines: string[]): string {
  lines.push("ENDSEC;");
  lines.push("END-ISO-10303-21;");
  return lines.join("\n");
}

/** One twin → one IFC4 file. */
export function writeNativeTwinIfc(edit: TwinIfcSource): string {
  return writeFederatedNativeTwinIfc([edit], edit.name || "Native Twin Export");
}

/**
 * Many Native Twins → one federated IFC4 SPF (shared project tree).
 * This is the primary write-back path for “edit IFC natively, export one model”.
 */
export function writeFederatedNativeTwinIfc(
  edits: TwinIfcSource[],
  projectName = "OpenBIMStudio Native IFC",
): string {
  return writeFederatedNativeTwinIfcWithReport(edits, projectName).ifc;
}

/** Assemble the conversion report from the per-element entries of one export. Shared by the sync and async writers. */
function toExportReport(projectName: string, elements: NativeIfcElementReport[]): NativeIfcExportReport {
  return {
    schema: "IFC4",
    projectName,
    generatedAt: new Date().toISOString(),
    elements,
    counts: {
      total: elements.length,
      typed: elements.filter((e) => e.status === "typed").length,
      proxied: elements.filter((e) => e.status === "proxied").length,
    },
  };
}

/**
 * Federated export plus the per-element conversion report: which entity
 * was actually emitted for each twin, why any element fell back to a
 * proxy, and the placement/geometry/pset evidence for it. The report is
 * the machine-readable form of the entity-level conversion report
 * (GAP-05 / #106 area): entity inventory, semantic conversion, geometry
 * conversion — round-trip fidelity itself is proven by the independent
 * validation (scripts/validate_native_ifc_export.py), not by this report.
 */
export function writeFederatedNativeTwinIfcWithReport(
  edits: TwinIfcSource[],
  projectName = "OpenBIMStudio Native IFC",
): { ifc: string; report: NativeIfcExportReport } {
  if (!edits.length) throw new Error("No Native Twins to export.");
  const { lines, ctx, storey } = beginFederated(projectName);
  const elements: NativeIfcElementReport[] = [];
  for (const edit of edits) {
    elements.push(appendTwinElement(ctx, edit, storey));
  }
  const ifc = endFederated(lines);
  return { ifc, report: toExportReport(projectName, elements) };
}

export function downloadNativeTwinIfc(
  edit: TwinIfcSource,
  filename?: string,
  opts?: { onReport?: (report: NativeIfcExportReport) => void },
): NativeIfcExportReport {
  const { ifc: text, report } = writeFederatedNativeTwinIfcWithReport([edit], edit.name || "Native Twin Export");
  opts?.onReport?.(report);
  const blob = new Blob([text], { type: "application/x-step" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `${(edit.name || "native-twin").replace(/[^a-z0-9._-]+/gi, "_")}.ifc`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return report;
}

/** Download one federated IFC4 for all given twins. Returns the conversion report for the download. */
export function downloadFederatedNativeTwinIfc(
  edits: TwinIfcSource[],
  filename = "openbimstudio-native.ifc",
  opts?: { onReport?: (report: NativeIfcExportReport) => void },
): NativeIfcExportReport {
  const { ifc: text, report } = writeFederatedNativeTwinIfcWithReport(edits);
  opts?.onReport?.(report);
  const blob = new Blob([text], { type: "application/x-step" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
  return report;
}

/** Async federated write — yields every `yieldEvery` elements so large exports do not freeze the tab. */
export async function writeFederatedNativeTwinIfcAsync(
  edits: TwinIfcSource[],
  projectName = "OpenBIMStudio Native IFC",
  opts?: { yieldEvery?: number; onProgress?: (i: number, total: number) => void },
): Promise<string> {
  return (await writeFederatedNativeTwinIfcAsyncWithReport(edits, projectName, opts)).ifc;
}

/**
 * Async federated write plus the per-element conversion report. The report
 * is built from the same appendTwinElement calls that write the file, so
 * it always describes exactly what was emitted — including every proxy
 * fallback and its reason.
 */
export async function writeFederatedNativeTwinIfcAsyncWithReport(
  edits: TwinIfcSource[],
  projectName = "OpenBIMStudio Native IFC",
  opts?: { yieldEvery?: number; onProgress?: (i: number, total: number) => void },
): Promise<{ ifc: string; report: NativeIfcExportReport }> {
  if (!edits.length) throw new Error("No Native Twins to export.");
  const yieldEvery = Math.max(1, opts?.onProgress ? (opts.yieldEvery ?? 40) : (opts?.yieldEvery ?? 80));
  const { lines, ctx, storey } = beginFederated(projectName);
  const elements: NativeIfcElementReport[] = [];
  const total = edits.length;
  for (let i = 0; i < total; i++) {
    elements.push(appendTwinElement(ctx, edits[i], storey));
    opts?.onProgress?.(i + 1, total);
    if ((i + 1) % yieldEvery === 0) {
      await new Promise<void>((r) => {
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => r());
        else setTimeout(r, 0);
      });
    }
  }
  const ifc = endFederated(lines);
  return { ifc, report: toExportReport(projectName, elements) };
}

export async function downloadFederatedNativeTwinIfcAsync(
  edits: TwinIfcSource[],
  filename = "openbimstudio-native.ifc",
  opts?: { onProgress?: (i: number, total: number) => void; onReport?: (report: NativeIfcExportReport) => void },
): Promise<NativeIfcExportReport> {
  const { ifc: text, report } = await writeFederatedNativeTwinIfcAsyncWithReport(edits, "OpenBIMStudio Native IFC", {
    onProgress: opts?.onProgress,
  });
  opts?.onReport?.(report);
  const blob = new Blob([text], { type: "application/x-step" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
  return report;
}
