/**
 * Lossless source-information archive for Native / Digital Twins.
 *
 * Dual-layer model:
 *   Layer 1 — editable native params + generated geometry (authoring)
 *   Layer 2 — this archive: complete accessible source payload + field map
 *
 * Native parametric edits must never erase Layer 2.
 */

export const SOURCE_ARCHIVE_VERSION = 1 as const;

export type FieldSyncStatus =
  | "synchronized"
  | "native-modified"
  | "source-changed"
  | "conflict"
  | "source-unavailable"
  | "preserved-unmapped"
  | "mapping-failed";

export interface FieldMapping {
  sourcePath: string;
  sourceType?: string;
  unit?: string;
  nativePath?: string;
  lossless: boolean;
  status: FieldSyncStatus;
  note?: string;
}

export interface SourceIdentity {
  sourceModelId?: string;
  sourceLocalId?: number | string;
  sourceModelName?: string;
  sourceFormat?: string;
  globalId?: string;
  expressId?: number | string;
  entityType?: string;
  predefinedType?: string;
  name?: string;
  tag?: string;
  description?: string;
  objectType?: string;
}

export interface SourceGeometryProvenance {
  /** How geometry was extracted for the twin. */
  extractionPath?: string;
  triangleCount?: number;
  meshCount?: number;
  vertexCount?: number;
  /** World AABB at conversion time. */
  bounds?: {
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
  };
  /** Model matrixWorld elements when available. */
  modelMatrixWorld?: number[];
  /** Local (centered) triangle positions used for editable mesh — not a replacement for source topology. */
  tessellationPositionsCount?: number;
  notes?: string[];
}

export interface SourceArchive {
  version: typeof SOURCE_ARCHIVE_VERSION;
  convertedAt: string;
  converter: string;
  identity: SourceIdentity;
  /** Full JSON-safe snapshot of getItemsData / source item record. */
  rawItem: Record<string, unknown>;
  /** Normalized property sets (IfcPropertySet-like). */
  propertySets: Record<string, unknown>;
  /** Normalized quantity sets. */
  quantities: Record<string, unknown>;
  /** Flattened discovery of all key paths under rawItem (unknown attrs stay here). */
  discoveredPaths: string[];
  /** Explicit source→native field mappings. */
  fieldMap: FieldMapping[];
  geometry: SourceGeometryProvenance;
  /** Original source dimensional values (never overwritten by native edits). */
  sourceDimensions?: Record<string, number | string | null>;
  /** Materials / styles if present in raw data. */
  materials?: unknown;
  /** Classification references if present. */
  classifications?: unknown;
  /** Relationship stubs (ids only) when available. */
  relationships?: Record<string, unknown>;
  warnings: string[];
}

const CONVERTER = "openbimstudio-native-twin/source-archive@1";

/** Depth-limited path discovery for audit (not full tree clone). */
export function discoverPaths(value: unknown, prefix = "", depth = 0, out: string[] = [], maxDepth = 6, maxPaths = 2000): string[] {
  if (out.length >= maxPaths || depth > maxDepth) return out;
  if (value == null) {
    out.push(prefix || "(root)");
    return out;
  }
  if (typeof value !== "object") {
    out.push(prefix);
    return out;
  }
  if (Array.isArray(value)) {
    out.push(prefix + "[]");
    if (value.length && depth < maxDepth) {
      discoverPaths(value[0], prefix + "[0]", depth + 1, out, maxDepth, maxPaths);
    }
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "function") continue;
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(path);
    if (v && typeof v === "object") {
      discoverPaths(v, path, depth + 1, out, maxDepth, maxPaths);
    }
    if (out.length >= maxPaths) break;
  }
  return out;
}

function pickScalar(data: any, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = data?.[key];
    const value = v?.value ?? v;
    if (value != null && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      return String(value);
    }
  }
  return undefined;
}

function extractPsets(raw: Record<string, unknown>): Record<string, unknown> {
  const candidates = [raw.psets, raw.Psets, raw.propertySets, raw.PropertySets, (raw as any).HasPropertySets];
  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c)) return c as Record<string, unknown>;
  }
  return {};
}

function extractQtos(raw: Record<string, unknown>): Record<string, unknown> {
  const candidates = [raw.qtos, raw.Qtos, raw.quantities, raw.Quantities, raw.ElementQuantities];
  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c)) return c as Record<string, unknown>;
  }
  return {};
}

function extractMaterials(raw: Record<string, unknown>): unknown {
  return raw.materials ?? raw.Materials ?? raw.HasAssociations ?? raw.material ?? undefined;
}

function extractClassifications(raw: Record<string, unknown>): unknown {
  return raw.classifications ?? raw.Classifications ?? raw.HasAssociations ?? undefined;
}

function extractRelationships(raw: Record<string, unknown>): Record<string, unknown> {
  const rel: Record<string, unknown> = {};
  for (const key of [
    "ContainedInStructure",
    "Decomposes",
    "IsDecomposedBy",
    "FillsVoids",
    "HasOpenings",
    "ConnectedTo",
    "ConnectedFrom",
    "ReferencedBy",
    "HasAssignments",
    "systems",
    "type",
    "Type",
  ]) {
    if ((raw as any)[key] != null) rel[key] = (raw as any)[key];
  }
  return rel;
}

function buildFieldMap(
  identity: SourceIdentity,
  psets: Record<string, unknown>,
  qtos: Record<string, unknown>,
  dims?: Record<string, number | string | null>,
): FieldMapping[] {
  const map: FieldMapping[] = [];
  const add = (m: FieldMapping) => map.push(m);

  if (identity.globalId) {
    add({ sourcePath: "GlobalId", nativePath: "ifc.globalId", lossless: true, status: "synchronized" });
  }
  if (identity.entityType) {
    add({ sourcePath: "Entity/Type", nativePath: "ifc.entity", lossless: true, status: "synchronized" });
  }
  if (identity.name) {
    add({ sourcePath: "Name", nativePath: "name", lossless: true, status: "synchronized" });
  }
  for (const key of Object.keys(psets)) {
    add({
      sourcePath: `psets.${key}`,
      nativePath: `ifc.propertySets.${key}`,
      lossless: true,
      status: "synchronized",
      note: "Property set preserved on native ifc layer and archive",
    });
  }
  for (const key of Object.keys(qtos)) {
    add({
      sourcePath: `qtos.${key}`,
      nativePath: `ifc.quantities.${key}`,
      lossless: true,
      status: "synchronized",
      note: "Quantity set preserved; distinct from regenerated geometry metrics",
    });
  }
  if (dims) {
    for (const [k, v] of Object.entries(dims)) {
      if (v == null) continue;
      add({
        sourcePath: `sourceDimensions.${k}`,
        nativePath: `params.${k}`,
        lossless: false,
        status: "synchronized",
        note: "Source dimension retained in archive; native params may diverge after edit",
      });
    }
  }
  return map;
}

export interface BuildArchiveInput {
  rawItem?: unknown;
  identity: SourceIdentity;
  geometry?: SourceGeometryProvenance;
  sourceDimensions?: Record<string, number | string | null>;
  warnings?: string[];
}

/**
 * Build a versioned lossless archive from accessible source item data.
 */
export function buildSourceArchive(input: BuildArchiveInput): SourceArchive {
  const rawItem =
    input.rawItem && typeof input.rawItem === "object"
      ? (JSON.parse(JSON.stringify(input.rawItem)) as Record<string, unknown>)
      : {};
  const propertySets = extractPsets(rawItem);
  const quantities = extractQtos(rawItem);
  const identity: SourceIdentity = {
    ...input.identity,
    globalId: input.identity.globalId ?? pickScalar(rawItem, "GlobalId", "globalId"),
    entityType: input.identity.entityType ?? pickScalar(rawItem, "Entity", "Type", "ObjectType"),
    name: input.identity.name ?? pickScalar(rawItem, "Name", "name"),
    tag: input.identity.tag ?? pickScalar(rawItem, "Tag"),
    predefinedType: input.identity.predefinedType ?? pickScalar(rawItem, "PredefinedType"),
    description: input.identity.description ?? pickScalar(rawItem, "Description"),
    objectType: pickScalar(rawItem, "ObjectType"),
  };
  const discoveredPaths = discoverPaths(rawItem);
  const fieldMap = buildFieldMap(identity, propertySets, quantities, input.sourceDimensions);
  // Unmapped top-level keys → preserved-unmapped
  for (const path of discoveredPaths) {
    if (path.includes(".") || path.includes("[")) continue;
    if (fieldMap.some((f) => f.sourcePath === path || f.sourcePath.startsWith(path))) continue;
    fieldMap.push({
      sourcePath: path,
      lossless: true,
      status: "preserved-unmapped",
      note: "Retained in rawItem; no native parametric binding",
    });
  }

  return {
    version: SOURCE_ARCHIVE_VERSION,
    convertedAt: new Date().toISOString(),
    converter: CONVERTER,
    identity,
    rawItem,
    propertySets,
    quantities,
    discoveredPaths,
    fieldMap,
    geometry: input.geometry ?? {},
    sourceDimensions: input.sourceDimensions,
    materials: extractMaterials(rawItem),
    classifications: extractClassifications(rawItem),
    relationships: extractRelationships(rawItem),
    warnings: input.warnings ?? [],
  };
}

/**
 * Mark native dimension fields as modified without dropping source values.
 */
export function markNativeDimensionModified(archive: SourceArchive | undefined, paramKey: string): void {
  if (!archive?.fieldMap) return;
  for (const f of archive.fieldMap) {
    if (f.nativePath === `params.${paramKey}` || f.sourcePath === `sourceDimensions.${paramKey}`) {
      f.status = "native-modified";
      f.note = (f.note ? f.note + "; " : "") + `Native ${paramKey} edited; source value retained in sourceDimensions`;
    }
  }
}

export interface CompletenessAudit {
  fieldCount: number;
  mappedNative: number;
  preservedUnmapped: number;
  nativeModified: number;
  warnings: string[];
  hasRawItem: boolean;
  hasPropertySets: boolean;
  hasQuantities: boolean;
  completeness: "full-accessible" | "partial" | "minimal";
}

export function auditSourceArchive(archive: SourceArchive | null | undefined): CompletenessAudit {
  if (!archive) {
    return {
      fieldCount: 0,
      mappedNative: 0,
      preservedUnmapped: 0,
      nativeModified: 0,
      warnings: ["no archive"],
      hasRawItem: false,
      hasPropertySets: false,
      hasQuantities: false,
      completeness: "minimal",
    };
  }
  const mappedNative = archive.fieldMap.filter((f) => f.nativePath && f.status !== "mapping-failed").length;
  const preservedUnmapped = archive.fieldMap.filter((f) => f.status === "preserved-unmapped").length;
  const nativeModified = archive.fieldMap.filter((f) => f.status === "native-modified").length;
  const hasRawItem = !!archive.rawItem && Object.keys(archive.rawItem).length > 0;
  const hasPropertySets = Object.keys(archive.propertySets || {}).length > 0;
  const hasQuantities = Object.keys(archive.quantities || {}).length > 0;
  let completeness: CompletenessAudit["completeness"] = "minimal";
  if (hasRawItem && (hasPropertySets || archive.discoveredPaths.length > 5)) completeness = "full-accessible";
  else if (hasRawItem || hasPropertySets || hasQuantities) completeness = "partial";

  return {
    fieldCount: archive.fieldMap.length,
    mappedNative,
    preservedUnmapped,
    nativeModified,
    warnings: [...archive.warnings],
    hasRawItem,
    hasPropertySets,
    hasQuantities,
    completeness,
  };
}
