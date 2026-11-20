/**
 * Per-entity IFC conversion-fidelity report — issue #106.
 *
 * Extends the inventory-only `interop-report.ts` (entity types + counts +
 * FILE_SCHEMA) with a per-entity fidelity record for every IfcProduct in a
 * file, in both directions:
 *
 *   IMPORT  `buildImportFidelityReport()` — for each product (by IFC type +
 *           GlobalId): did the STEP/semantic layer recover it, with what type
 *           mapping, geometry, placement, property sets and relationships,
 *           and any loss or downgrade with a reason code.
 *   EXPORT  `buildExportFidelityReport()` — for each source element: what IFC
 *           type was emitted, whether it round-trips to the same type,
 *           geometry survival and property-set survival. Writer-agnostic: it
 *           compares a source-element list against exported STEP text, so it
 *           works for the native-twin writer, the authored writer, or any
 *           other writer, before or after the §5 typed-entity fix.
 *   ROUND-TRIP `buildRoundTripReport()` — export report + re-import of the
 *           exported text, joined per GlobalId (type survival).
 *
 * What this IS and what it is NOT — read before quoting a number from it:
 *
 *   The import leg measures what the INDEPENDENT STEP/semantic layer
 *   (`step-reader.ts` + `semantic-model.ts`, no shared code with web-ifc or
 *   any writer) recovers from the file. The application's live import is a
 *   monolithic web-ifc → FRAG conversion that exposes no per-entity
 *   callback, so this report CANNOT claim "web-ifc imported entity X into
 *   the FRAG model". A `preserved` row means: the entity is present in the
 *   file with a valid identity, a known product type, resolvable placement
 *   and representation, and spatial containment — i.e. everything the
 *   semantic layer can verify without the FRAG conversion. The web-ifc leg
 *   is measured separately, in Node, by `scripts/ifc-per-entity-report.mjs`
 *   (per-entity GlobalId + type enumeration through web-ifc 0.0.77) and by
 *   the round-trip test; its numbers live in the corpus summary, not in
 *   this module's rows.
 *
 *   The export leg measures the exported STEP text against the source list
 *   with the same independent reader, so a proxy fallback, a lost pset or a
 *   changed GlobalId is reported, never hidden. It does not open the file
 *   in a desktop BIM/CAD tool — no claim in this module is a desktop-tool
 *   validation (see docs/engineering/PER_ENTITY_IFC_REPORT.md §6).
 *
 * Status vocabulary (hardening plan item 10 / #106):
 *   preserved     — type, identity, geometry, placement and containment all
 *                   verified; nothing downgraded.
 *   transformed   — same entity, different (typed) IFC class: a documented
 *                   normalisation, e.g. IfcWallStandardCase → IfcWall.
 *   approximated  — the entity survives but with loss: proxy fallback,
 *                   missing geometry/placement, uncontained, lost psets, or
 *                   a non-preserved GlobalId (matched by name instead).
 *   unsupported   — the type is unknown to the platform (import) or the
 *                   source carries no representable type (export).
 *   skipped       — present in the source but not imported/exported as its
 *                   own entity: a duplicate GlobalId (identity collision —
 *                   only the first occurrence is kept).
 *   failed        — cannot be used as an entity at all: invalid or missing
 *                   GlobalId, dangling placement/representation reference
 *                   (import), or no emitted entity found (export).
 *
 * Reason codes are stable machine-readable strings; every downgrade carries
 * at least one. The mapping to the semantic validator's finding codes
 * (`validate.ts`) is: INVALID_GLOBALID ↔ IFC-E-BAD-GUID,
 * DUPLICATE_GLOBALID ↔ IFC-W-DUP-GUID, UNCONTAINED ↔ IFC-W-ORPHAN-ELEMENT,
 * PLACEMENT_DANGLING / GEOMETRY_DANGLING ↔ IFC-E-DANGLING-REF.
 *
 * Determinism: reports contain no timestamps, no random values and no
 * wall-clock data. Rows are sorted by express id, aggregates by total
 * descending then type ascending. `fidelityReportToJson()` is the canonical
 * serialisation; the corpus test regenerates the checked-in example and
 * fails on drift.
 */

import { buildSemanticModel, type SemanticModel } from "./semantic-model";
import { parseRef, unquote } from "./step-reader";
import { isValidIfcGuid } from "../bim-gaps/ifc-guid";

export const PER_ENTITY_REPORT_VERSION = 1;
export const PER_ENTITY_REPORT_GENERATOR =
  "src/modules/ifc-semantics/per-entity-report.ts (per-entity-report v1)";

export type FidelityStatus =
  | "preserved"
  | "transformed"
  | "approximated"
  | "unsupported"
  | "skipped"
  | "failed";

export type ImportReasonCode =
  | "INVALID_GLOBALID"
  | "MISSING_GLOBALID"
  | "DUPLICATE_GLOBALID"
  | "UNKNOWN_TYPE"
  | "TYPE_NORMALISED"
  | "GEOMETRY_MISSING"
  | "GEOMETRY_DANGLING"
  | "PLACEMENT_MISSING"
  | "PLACEMENT_DANGLING"
  | "PLACEMENT_BROKEN"
  | "UNCONTAINED";

export type ExportReasonCode =
  | "PROXY_FALLBACK"
  | "TYPE_NORMALISED"
  | "TYPE_CHANGED"
  | "UNKNOWN_SOURCE_TYPE"
  | "NO_SOURCE_TYPE"
  | "GUID_NOT_PRESERVED"
  | "EXPORTED_ENTITY_MISSING"
  | "INVALID_EXPORTED_GLOBALID"
  | "GEOMETRY_LOST"
  | "PSETS_LOST";

export type FidelityReasonCode = ImportReasonCode | ExportReasonCode;

/** Statuses that count as degraded (survived, but changed or lossy). */
export const DEGRADED_STATUSES: FidelityStatus[] = ["transformed", "approximated"];
/** Statuses that count as lost (no faithful entity on the other side). */
export const LOST_STATUSES: FidelityStatus[] = ["unsupported", "skipped", "failed"];

/** Spatial-structure product classes (IfcProject + IfcSpatialStructureElement). */
export const SPATIAL_PRODUCT_TYPES = new Set([
  "IFCPROJECT",
  "IFCSITE",
  "IFCBUILDING",
  "IFCBUILDINGSTOREY",
  "IFCSPACE",
]);

/**
 * Physical product classes the semantic model knows (the product subset of
 * `KNOWN_CLASSES` in semantic-model.ts). Anything product-shaped outside
 * this set is reported as an `unknown-type` row, never dropped.
 */
export const PHYSICAL_PRODUCT_TYPES = new Set([
  "IFCWALL", "IFCWALLSTANDARDCASE", "IFCWALLELEMENTEDCASE",
  "IFCSLAB", "IFCBEAM", "IFCCOLUMN", "IFCMEMBER", "IFCPLATE",
  "IFCFOOTING", "IFCPILE", "IFCSTAIR", "IFCRAILING", "IFCRAMP",
  "IFCROOF", "IFCCEILING", "IFCCURTAINWALL",
  "IFCDOOR", "IFCWINDOW", "IFCOPENINGELEMENT",
  "IFCFURNISHINGELEMENT", "IFCBUILDINGELEMENTPROXY", "IFCCOVERING",
  "IFCFLOWSEGMENT", "IFCFLOWTERMINAL", "IFCFLOWFITTING",
  "IFCFLOWCONTROLLER", "IFCFLOWMOVINGDEVICE", "IFCFLOWSTORAGEDEVICE",
  "IFCDISTRIBUTIONELEMENT",
  "IFCDUCTSEGMENT", "IFCPIPESEGMENT", "IFCCABLECARRIERSEGMENT",
  "IFCCABLESEGMENT", "IFCCONDUITSEGMENT",
  "IFCDUCTFITTING", "IFCPIPEFITTING", "IFCCABLECARRIERFITTING",
  "IFCCONDUITFITTING",
]);

export const PRODUCT_TYPES = new Set([
  ...SPATIAL_PRODUCT_TYPES,
  ...PHYSICAL_PRODUCT_TYPES,
]);

/**
 * Types the platform normalises to a plain class downstream: a tessellated
 * twin / a STEP reader cannot satisfy IfcWallStandardCase (SweptSolid +
 * Axis) or IfcWallElementedCase (subordinate aggregation), so plain IfcWall
 * is the correct target. Reporting this as `transformed`, not `preserved`,
 * keeps the normalisation visible.
 */
export const NORMALISED_TYPE_MAP: Record<string, string> = {
  IFCWALLSTANDARDCASE: "IFCWALL",
  IFCWALLELEMENTEDCASE: "IFCWALL",
};

/** Root classes that carry a GlobalId but are not products (never rows). */
const NON_PRODUCT_ROOT_RE = /^(IFCREL|IFCPROPERTYSET|IFCELEMENTQUANTITY|IFCCLASSIFICATION|IFCMATERIAL)/;

/** Normalise a type label for comparison: case-insensitive, `Ifc` prefix optional. */
export function normaliseIfcType(t: string | null | undefined): string {
  if (!t) return "";
  return t.trim().toUpperCase().replace(/^IFC/, "");
}

export interface TypeFidelityAggregate {
  type: string;
  total: number;
  preserved: number;
  transformed: number;
  approximated: number;
  unsupported: number;
  skipped: number;
  failed: number;
  preservedPct: number;
  degradedPct: number;
  lostPct: number;
}

export interface FidelityTotals {
  preserved: number;
  transformed: number;
  approximated: number;
  unsupported: number;
  skipped: number;
  failed: number;
  preservedPct: number;
  degradedPct: number;
  lostPct: number;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function emptyTotals(): FidelityTotals {
  return {
    preserved: 0, transformed: 0, approximated: 0,
    unsupported: 0, skipped: 0, failed: 0,
    preservedPct: 0, degradedPct: 0, lostPct: 0,
  };
}

function summariseStatuses(statuses: FidelityStatus[]): FidelityTotals {
  const t = emptyTotals();
  for (const s of statuses) t[s]++;
  const total = statuses.length;
  t.preservedPct = pct(t.preserved, total);
  t.degradedPct = pct(t.transformed + t.approximated, total);
  t.lostPct = pct(t.unsupported + t.skipped + t.failed, total);
  return t;
}

function aggregateByType(
  rows: Array<{ ifcType: string; status: FidelityStatus }>,
): TypeFidelityAggregate[] {
  const byType = new Map<string, FidelityStatus[]>();
  for (const r of rows) {
    const arr = byType.get(r.ifcType);
    if (arr) arr.push(r.status);
    else byType.set(r.ifcType, [r.status]);
  }
  return [...byType.entries()]
    .map(([type, statuses]) => {
      const t = summariseStatuses(statuses);
      return { type, total: statuses.length, ...t };
    })
    .sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));
}

// ── Import ────────────────────────────────────────────────────────────────

export interface EntityFidelityRow {
  expressId: number;
  /** The file's stated 22-char GlobalId (valid or not); null when the
   *  first argument is absent or not 22 chars. Validity is in `status` /
   *  `reasonCodes` — an invalid value is kept here so it can be seen. */
  globalId: string | null;
  ifcType: string;
  name: string | null;
  objectType: string | null;
  /** Tag (IfcElement arg 7); null for spatial elements, which have no Tag. */
  tag: string | null;
  status: FidelityStatus;
  reasonCodes: ImportReasonCode[];
  /** typed = known product class; normalised = WallStandard/ElementedCase;
   *  unknown-type = product-shaped but outside the known set. */
  typeMapping: "typed" | "normalised" | "unknown-type";
  geometry: "present" | "absent" | "dangling" | "not-applicable";
  placement: "present" | "absent" | "dangling" | "broken" | "not-applicable";
  propertySets: Array<{ name: string; propertyCount: number }>;
  quantitySets: string[];
  /** Relationship kinds this element participates in. */
  relationships: string[];
  containedIn: { id: number; type: string; name: string | null } | null;
  notes: string[];
}

export interface ImportFidelityReport {
  schemaVersion: number;
  kind: "import";
  generator: string;
  fileName: string;
  schema: string;
  /** Products covered (rows). Non-product roots are counted by the
   *  inventory report (interop-report.ts), not here. */
  totalProducts: number;
  totals: FidelityTotals;
  byType: TypeFidelityAggregate[];
  rows: EntityFidelityRow[];
  /** Semantic-model warnings (capped), e.g. dangling relationships. */
  warnings: string[];
  warningCount: number;
  /** Scope caveat, repeated in every serialisation so a bare JSON file
   *  cannot be mistaken for a web-ifc FRAG-conversion proof. */
  scope: string;
}

export const IMPORT_SCOPE =
  "STEP/semantic-model fidelity: what the independent STEP reader recovers " +
  "from the file. Not a per-entity web-ifc FRAG-conversion claim — the live " +
  "import is monolithic and exposes no per-entity callback.";

function isProductEntity(e: { name: string; args: string[] }): boolean {
  if (PRODUCT_TYPES.has(e.name)) return true;
  if (NON_PRODUCT_ROOT_RE.test(e.name)) return false;
  // Product-shaped unknown: a quoted 22-char first argument (GlobalId) and
  // at least 6 arguments (IfcProduct has 7+; property values have 4).
  const g = unquote(e.args[0]);
  return g !== null && g.length === 22 && e.args.length >= 6;
}

/**
 * Build the per-entity import fidelity report from STEP text.
 * Returns null when the text has no readable product entities.
 */
export function buildImportFidelityReportFromText(
  fileName: string,
  text: string,
): ImportFidelityReport | null {
  let model: SemanticModel;
  try {
    model = buildSemanticModel(text);
  } catch {
    return null;
  }
  const schema = model.schema ?? "UNKNOWN";

  // Relationship participation per express id: kinds + containment.
  const relKinds = new Map<number, Set<string>>();
  const containedIn = new Map<number, { id: number; type: string; name: string | null }>();
  const aggregatedBy = new Map<number, number>();
  for (const r of model.relationships) {
    const mark = (id: number) => {
      const s = relKinds.get(id) ?? new Set<string>();
      s.add(r.kind);
      relKinds.set(id, s);
    };
    for (const id of r.related) mark(id);
    if (r.relating != null) mark(r.relating);
    if (r.kind === "containment" && r.relating != null) {
      const host = model.entities.get(r.relating);
      for (const id of r.related) {
        containedIn.set(id, {
          id: r.relating,
          type: host?.name ?? "UNKNOWN",
          name: host ? unquote(host.args[2]) : null,
        });
      }
    }
    if (r.kind === "aggregates" && r.relating != null) {
      for (const id of r.related) aggregatedBy.set(id, r.relating);
    }
  }

  // Property / quantity sets per host express id.
  const psetsByHost = new Map<number, Array<{ name: string; propertyCount: number }>>();
  const qtosByHost = new Map<number, string[]>();
  for (const ps of model.psets.values()) {
    for (const host of ps.hosts) {
      const arr = psetsByHost.get(host) ?? [];
      arr.push({ name: ps.name, propertyCount: ps.props.length });
      psetsByHost.set(host, arr);
    }
  }
  for (const q of model.qtos.values()) {
    for (const host of q.hosts) {
      const arr = qtosByHost.get(host) ?? [];
      arr.push(q.name);
      qtosByHost.set(host, arr);
    }
  }

  // Duplicate GlobalIds: first occurrence keeps its own verdict; later
  // occurrences are `skipped` (identity collision on import).
  const seenGlobalIds = new Map<string, number>();
  const duplicateIds = new Set<number>();
  for (const e of [...model.entities.values()].sort((a, b) => a.id - b.id)) {
    const g = unquote(e.args[0]);
    if (g && g.length === 22) {
      if (seenGlobalIds.has(g)) duplicateIds.add(e.id);
      else seenGlobalIds.set(g, e.id);
    }
  }

  const rows: EntityFidelityRow[] = [];
  const products = [...model.entities.values()]
    .filter(isProductEntity)
    .sort((a, b) => a.id - b.id);

  for (const e of products) {
    const isSpatial = SPATIAL_PRODUCT_TYPES.has(e.name);
    const isProject = e.name === "IFCPROJECT";
    const isOpening = e.name === "IFCOPENINGELEMENT";
    const rawGuid = unquote(e.args[0]);
    const globalId = rawGuid && rawGuid.length === 22 ? rawGuid : null;
    const guidValid = globalId !== null && isValidIfcGuid(globalId);
    const reasons: ImportReasonCode[] = [];
    const notes: string[] = [];
    let status: FidelityStatus;
    let typeMapping: EntityFidelityRow["typeMapping"] = "typed";
    let geometry: EntityFidelityRow["geometry"] = "not-applicable";
    let placement: EntityFidelityRow["placement"] = "not-applicable";

    // — Identity (terminal failures first) —
    if (rawGuid === null || rawGuid.length !== 22) {
      reasons.push("MISSING_GLOBALID");
      status = "failed";
    } else if (!guidValid) {
      reasons.push("INVALID_GLOBALID");
      status = "failed";
    } else if (duplicateIds.has(e.id)) {
      reasons.push("DUPLICATE_GLOBALID");
      status = "skipped";
      notes.push(`duplicate GlobalId ${globalId} — first occurrence #${seenGlobalIds.get(globalId)} kept`);
    } else if (!PRODUCT_TYPES.has(e.name)) {
      reasons.push("UNKNOWN_TYPE");
      status = "unsupported";
      typeMapping = "unknown-type";
    } else {
      status = "preserved";
    }

    if (NORMALISED_TYPE_MAP[e.name]) {
      typeMapping = "normalised";
      if (status === "preserved") {
        status = "transformed";
        reasons.push("TYPE_NORMALISED");
        notes.push(`${e.name} normalises to ${NORMALISED_TYPE_MAP[e.name]} downstream`);
      }
    }

    // — Placement (IfcProduct arg 5) / representation (arg 6) —
    // IfcProject has neither; spatial elements have placement but usually
    // no representation (a storey with no shape is normal, not a loss).
    if (!isProject && status !== "failed" && status !== "skipped" && status !== "unsupported") {
      const placementArg = e.args[5];
      if (placementArg === undefined || placementArg === "$" || placementArg === "*") {
        placement = "absent";
        reasons.push("PLACEMENT_MISSING");
        if (status === "preserved" || status === "transformed") status = "approximated";
      } else {
        const ref = parseRef(placementArg);
        if (ref === null) {
          placement = "broken";
          reasons.push("PLACEMENT_BROKEN");
          if (status === "preserved" || status === "transformed") status = "approximated";
        } else if (!model.entities.has(ref)) {
          placement = "dangling";
          reasons.push("PLACEMENT_DANGLING");
          status = "failed";
        } else if (!model.placements.has(ref)) {
          placement = "broken";
          reasons.push("PLACEMENT_BROKEN");
          if (status === "preserved" || status === "transformed") status = "approximated";
          notes.push(`placement #${ref} has no world transform in the semantic model`);
        } else {
          placement = "present";
        }
      }

      if (!isSpatial) {
        const reprArg = e.args[6];
        if (reprArg === undefined || reprArg === "$" || reprArg === "*") {
          geometry = "absent";
          reasons.push("GEOMETRY_MISSING");
          if (status === "preserved" || status === "transformed") status = "approximated";
        } else {
          const ref = parseRef(reprArg);
          if (ref === null) {
            geometry = "absent";
            reasons.push("GEOMETRY_MISSING");
            if (status === "preserved" || status === "transformed") status = "approximated";
          } else if (!model.entities.has(ref)) {
            geometry = "dangling";
            reasons.push("GEOMETRY_DANGLING");
            status = "failed";
          } else {
            geometry = "present";
          }
        }
      }

      // — Containment: physical elements (except openings, which hang off
      // their host wall via voids) must be contained in spatial structure.
      if (!isSpatial && !isOpening) {
        const kinds = relKinds.get(e.id);
        if (!containedIn.has(e.id) && !aggregatedBy.has(e.id)) {
          reasons.push("UNCONTAINED");
          if (status === "preserved" || status === "transformed") status = "approximated";
          notes.push("not contained in any spatial structure node" + (kinds ? "" : " and in no relationship"));
        }
      }
    }

    const kinds = relKinds.get(e.id);
    rows.push({
      expressId: e.id,
      globalId,
      ifcType: e.name,
      name: unquote(e.args[2]),
      objectType: unquote(e.args[4]),
      tag: !isSpatial && e.args[7] !== undefined ? unquote(e.args[7]) : null,
      status,
      reasonCodes: reasons,
      typeMapping,
      geometry,
      placement,
      propertySets: psetsByHost.get(e.id) ?? [],
      quantitySets: qtosByHost.get(e.id) ?? [],
      relationships: kinds ? [...kinds].sort() : [],
      containedIn: containedIn.get(e.id) ?? null,
      notes,
    });
  }

  if (rows.length === 0) return null;
  const totals = summariseStatuses(rows.map((r) => r.status));
  const warnings = model.warnings.slice(0, 50);
  return {
    schemaVersion: PER_ENTITY_REPORT_VERSION,
    kind: "import",
    generator: PER_ENTITY_REPORT_GENERATOR,
    fileName,
    schema,
    totalProducts: rows.length,
    totals,
    byType: aggregateByType(rows),
    rows,
    warnings,
    warningCount: model.warnings.length,
    scope: IMPORT_SCOPE,
  };
}

/** Build the per-entity import fidelity report from file bytes (latin1 STEP). */
export function buildImportFidelityReport(
  fileName: string,
  bytes: Uint8Array,
): ImportFidelityReport | null {
  if (!bytes || bytes.length === 0) return null;
  let text: string;
  try {
    text = new TextDecoder("latin1").decode(bytes);
  } catch {
    return null;
  }
  if (!/ISO-10303-21/i.test(text.slice(0, 4096)) && !/#\d+\s*=\s*IFC/i.test(text.slice(0, 65536))) {
    return null;
  }
  return buildImportFidelityReportFromText(fileName, text);
}

// ── Export ────────────────────────────────────────────────────────────────

export interface ExportSourceElement {
  /** Source GlobalId when known; a missing/invalid id is itself reported. */
  globalId?: string | null;
  name?: string;
  /** Source IFC type, e.g. "IfcWall" / "IFCWALL" / "Wall". */
  sourceType: string;
  /** Property-set names the source carries (checked against the export). */
  propertySets?: string[];
  /** True when the source carries geometry; undefined = not recorded. */
  hasGeometry?: boolean;
}

export interface ExportFidelityRow {
  sourceGlobalId: string | null;
  sourceName: string | null;
  sourceType: string;
  emittedType: string | null;
  emittedExpressId: number | null;
  matchedBy: "globalId" | "name" | "none";
  status: FidelityStatus;
  reasonCodes: ExportReasonCode[];
  /** True when a typed source was emitted as IfcBuildingElementProxy. */
  proxyFallback: boolean;
  /** Null when the source did not record whether it has geometry. */
  geometrySurvived: boolean | null;
  propertySetsSurvived: string[];
  propertySetsLost: string[];
  propertySetsChecked: boolean;
  notes: string[];
}

export interface ExportFidelityReport {
  schemaVersion: number;
  kind: "export";
  generator: string;
  sourceCount: number;
  totals: FidelityTotals;
  byType: TypeFidelityAggregate[];
  rows: ExportFidelityRow[];
  scope: string;
}

export const EXPORT_SCOPE =
  "Export fidelity: each source element compared against the exported STEP " +
  "text with the independent STEP reader. A proxy fallback, lost pset or " +
  "changed GlobalId is reported, never hidden. Not a desktop-tool validation.";

function exportedProductInfo(
  model: SemanticModel,
  expressId: number,
): { type: string; geometryPresent: boolean; psetNames: string[] } {
  const e = model.entities.get(expressId)!;
  const reprArg = e.args[6];
  const reprRef = reprArg ? parseRef(reprArg) : null;
  const geometryPresent = reprRef !== null && model.entities.has(reprRef);
  const psetNames: string[] = [];
  for (const ps of model.psets.values()) {
    if (ps.hosts.includes(expressId)) psetNames.push(ps.name);
  }
  for (const q of model.qtos.values()) {
    if (q.hosts.includes(expressId)) psetNames.push(q.name);
  }
  return { type: e.name, geometryPresent, psetNames };
}

/**
 * Build the per-entity export fidelity report: compare `sources` against
 * exported STEP text. Writer-agnostic — it reads only the exported text.
 */
export function buildExportFidelityReport(
  sources: ExportSourceElement[],
  exportedText: string,
): ExportFidelityReport {
  const model = buildSemanticModel(exportedText);
  const byGlobalId = new Map<string, number>();
  for (const [id, g] of model.globalIds) {
    if (!byGlobalId.has(g)) byGlobalId.set(g, id);
  }
  // Name lookup for the GUID_NOT_PRESERVED fallback (name match only when
  // exactly one exported product carries the name).
  const byName = new Map<string, number[]>();
  for (const e of model.entities.values()) {
    if (!isProductEntity(e)) continue;
    const n = unquote(e.args[2]);
    if (n === null) continue;
    const arr = byName.get(n) ?? [];
    arr.push(e.id);
    byName.set(n, arr);
  }

  const rows: ExportFidelityRow[] = [];
  for (const src of sources) {
    const srcNorm = normaliseIfcType(src.sourceType);
    const srcKnown = src.sourceType ? PRODUCT_TYPES.has("IFC" + srcNorm) : false;
    const normalisedTarget = NORMALISED_TYPE_MAP["IFC" + srcNorm];
    const reasons: ExportReasonCode[] = [];
    const notes: string[] = [];
    let status: FidelityStatus;
    let emittedType: string | null = null;
    let emittedExpressId: number | null = null;
    let matchedBy: ExportFidelityRow["matchedBy"] = "none";
    let geometrySurvived: boolean | null = null;
    let psetSurvived: string[] = [];
    let psetLost: string[] = [];
    const psetChecked = Array.isArray(src.propertySets);

    const guid = src.globalId ?? null;
    if (guid && isValidIfcGuid(guid) && byGlobalId.has(guid)) {
      emittedExpressId = byGlobalId.get(guid)!;
      matchedBy = "globalId";
    } else if (src.name && byName.has(src.name) && byName.get(src.name)!.length === 1) {
      emittedExpressId = byName.get(src.name)![0];
      matchedBy = "name";
      reasons.push("GUID_NOT_PRESERVED");
      notes.push(
        guid
          ? `source GlobalId ${guid} not found in export — matched by name '${src.name}'`
          : `source carried no GlobalId — matched by name '${src.name}'`,
      );
    }

    if (emittedExpressId === null) {
      status = "failed";
      reasons.push("EXPORTED_ENTITY_MISSING");
      notes.push("no emitted entity found for this source element");
    } else {
      const info = exportedProductInfo(model, emittedExpressId);
      emittedType = info.type;
      const emittedNorm = normaliseIfcType(emittedType);
      const proxyFallback = emittedNorm === "BUILDINGELEMENTPROXY" && srcNorm !== "" && srcNorm !== "BUILDINGELEMENTPROXY";
      const expectedNorm = normalisedTarget !== undefined
        ? normaliseIfcType(normalisedTarget)
        : srcNorm;

      if (!src.sourceType) {
        reasons.push("NO_SOURCE_TYPE");
        status = emittedNorm === "BUILDINGELEMENTPROXY" ? "unsupported" : "approximated";
      } else if (!srcKnown) {
        reasons.push("UNKNOWN_SOURCE_TYPE");
        status = "unsupported";
      } else if (proxyFallback) {
        reasons.push("PROXY_FALLBACK");
        status = "approximated";
      } else if (emittedNorm !== expectedNorm) {
        reasons.push("TYPE_CHANGED");
        status = "transformed";
        notes.push(`source ${src.sourceType} emitted as ${emittedType}`);
      } else if (normalisedTarget !== undefined) {
        // Source type normalises to the emitted type (WallStandardCase →
        // Wall): same entity, documented class change — transformed, not
        // preserved, so the normalisation stays visible.
        reasons.push("TYPE_NORMALISED");
        status = "transformed";
        notes.push(`source ${src.sourceType} normalises to ${emittedType}`);
      } else {
        status = "preserved";
      }

      if (matchedBy === "name" && status === "preserved") status = "approximated";

      if (src.hasGeometry !== undefined) {
        geometrySurvived = src.hasGeometry ? info.geometryPresent : true;
        if (src.hasGeometry && !info.geometryPresent) {
          reasons.push("GEOMETRY_LOST");
          if (status === "preserved") status = "approximated";
        }
      }
      if (psetChecked) {
        const wanted = src.propertySets!;
        psetSurvived = wanted.filter((n) => info.psetNames.includes(n));
        psetLost = wanted.filter((n) => !info.psetNames.includes(n));
        if (psetLost.length > 0) {
          reasons.push("PSETS_LOST");
          if (status === "preserved") status = "approximated";
          notes.push(`property sets lost in export: ${psetLost.join(", ")}`);
        }
      }
      // Re-check: an invalid exported GlobalId is a failure of identity,
      // even when the row matched by name.
      const emittedGuid = model.globalIds.get(emittedExpressId);
      if (emittedGuid !== undefined && !isValidIfcGuid(emittedGuid)) {
        reasons.push("INVALID_EXPORTED_GLOBALID");
        status = "failed";
      }
    }

    rows.push({
      sourceGlobalId: guid,
      sourceName: src.name ?? null,
      sourceType: src.sourceType,
      emittedType,
      emittedExpressId,
      matchedBy,
      status,
      reasonCodes: reasons,
      proxyFallback: emittedType !== null && normaliseIfcType(emittedType) === "BUILDINGELEMENTPROXY" && srcNorm !== "BUILDINGELEMENTPROXY",
      geometrySurvived,
      propertySetsSurvived: psetSurvived,
      propertySetsLost: psetLost,
      propertySetsChecked: psetChecked,
      notes,
    });
  }

  return {
    schemaVersion: PER_ENTITY_REPORT_VERSION,
    kind: "export",
    generator: PER_ENTITY_REPORT_GENERATOR,
    sourceCount: sources.length,
    totals: summariseStatuses(rows.map((r) => r.status)),
    byType: aggregateByType(rows.map((r) => ({ ifcType: r.sourceType.toUpperCase(), status: r.status }))),
    rows,
    scope: EXPORT_SCOPE,
  };
}

// ── Round-trip ────────────────────────────────────────────────────────────

export interface RoundTripReport {
  schemaVersion: number;
  kind: "round-trip";
  generator: string;
  export: ExportFidelityReport;
  /** Re-import of the exported text (null when it has no products). */
  reimport: ImportFidelityReport | null;
  /** Per source element: did the emitted type survive the re-import? */
  typeSurvival: Array<{
    sourceGlobalId: string | null;
    sourceType: string;
    emittedType: string | null;
    reimportedType: string | null;
    survived: boolean | null;
  }>;
}

/**
 * Import → export → re-import, joined per GlobalId. `survived` is null when
 * the element has no re-imported row to compare against (e.g. it was never
 * emitted, or the re-import produced no report).
 */
export function buildRoundTripReport(
  sources: ExportSourceElement[],
  exportedText: string,
): RoundTripReport {
  const exportReport = buildExportFidelityReport(sources, exportedText);
  const reimport = buildImportFidelityReportFromText("exported.ifc", exportedText);
  const reimportByGuid = new Map<string, string>();
  if (reimport) {
    for (const r of reimport.rows) {
      if (r.globalId) reimportByGuid.set(r.globalId, r.ifcType);
    }
  }
  const typeSurvival = exportReport.rows.map((r) => {
    let reimportedType: string | null = null;
    let survived: boolean | null = null;
    if (r.sourceGlobalId && reimportByGuid.has(r.sourceGlobalId)) {
      reimportedType = reimportByGuid.get(r.sourceGlobalId)!;
      survived =
        r.emittedType !== null &&
        normaliseIfcType(reimportedType) === normaliseIfcType(r.emittedType);
    } else if (r.emittedExpressId !== null && reimport) {
      const row = reimport.rows.find((x) => x.expressId === r.emittedExpressId);
      if (row) {
        reimportedType = row.ifcType;
        survived = r.emittedType !== null && normaliseIfcType(row.ifcType) === normaliseIfcType(r.emittedType);
      }
    }
    return {
      sourceGlobalId: r.sourceGlobalId,
      sourceType: r.sourceType,
      emittedType: r.emittedType,
      reimportedType,
      survived,
    };
  });
  return {
    schemaVersion: PER_ENTITY_REPORT_VERSION,
    kind: "round-trip",
    generator: PER_ENTITY_REPORT_GENERATOR,
    export: exportReport,
    reimport,
    typeSurvival,
  };
}

// ── Serialisation / human summary ─────────────────────────────────────────

export type AnyFidelityReport = ImportFidelityReport | ExportFidelityReport | RoundTripReport;

/**
 * Canonical deterministic JSON: fixed key order (construction order),
 * rows sorted by the builders, no timestamps. Regenerating the same report
 * from the same bytes yields byte-identical output.
 */
export function fidelityReportToJson(report: AnyFidelityReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

function totalsLine(label: string, total: number, t: FidelityTotals): string {
  return (
    `${label}: ${total} entit${total === 1 ? "y" : "ies"} — ` +
    `preserved ${t.preserved} (${t.preservedPct}%), ` +
    `degraded ${t.transformed + t.approximated} (${t.degradedPct}%), ` +
    `lost ${t.unsupported + t.skipped + t.failed} (${t.lostPct}%)`
  );
}

/** Human-readable summary lines (Markdown-ish) for the UI details block and docs. */
export function formatFidelitySummary(report: ImportFidelityReport | ExportFidelityReport): string[] {
  const lines: string[] = [];
  if (report.kind === "import") {
    lines.push(`per-entity fidelity (${report.schema} · ${report.fileName}):`);
    lines.push(`  ${totalsLine("import", report.totalProducts, report.totals)}`);
    for (const a of report.byType) {
      if (a.preserved !== a.total) {
        lines.push(
          `  ${a.type}: ${a.total} — preserved ${a.preserved}, degraded ${a.transformed + a.approximated}, lost ${a.unsupported + a.skipped + a.failed}`,
        );
      }
    }
    const lost = report.rows.filter((r) => LOST_STATUSES.includes(r.status));
    for (const r of lost.slice(0, 10)) {
      lines.push(`  ${r.status}: #${r.expressId} ${r.ifcType} ${r.globalId ?? "(no GlobalId)"} — ${r.reasonCodes.join(", ")}`);
    }
    if (lost.length > 10) lines.push(`  … ${lost.length - 10} more lost entit${lost.length - 10 === 1 ? "y" : "ies"}`);
    lines.push(`  ${report.scope}`);
  } else {
    lines.push(`per-entity export fidelity:`);
    lines.push(`  ${totalsLine("export", report.sourceCount, report.totals)}`);
    const proxied = report.rows.filter((r) => r.proxyFallback).length;
    if (proxied > 0) lines.push(`  proxy fallback (reported, not hidden): ${proxied} of ${report.sourceCount}`);
    for (const a of report.byType) {
      if (a.preserved !== a.total) {
        lines.push(
          `  ${a.type}: ${a.total} — preserved ${a.preserved}, degraded ${a.transformed + a.approximated}, lost ${a.unsupported + a.skipped + a.failed}`,
        );
      }
    }
    lines.push(`  ${report.scope}`);
  }
  return lines;
}
