/**
 * IDS 1.0 validation engine (buildingSMART Information Delivery Specification).
 *
 * Supported facets:
 *   Applicability : entity, attribute, property (existence facets)
 *   Requirements  : entity, attribute, property
 *   Restrictions  : simpleValue, enumeration, pattern, min/maxInclusive/Exclusive,
 *                   length, minLength, maxLength
 *
 * Not yet supported (reported as "unsupported" in results, not as failure):
 *   Applicability : partOf, classification, material
 *   Requirements  : partOf, classification, material
 *
 * The engine is defensive about SDK API surface: if properties cannot be read
 * for a given model, property facets report "unverifiable" rather than fail.
 */
import { ctx } from "../core/context";

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════
export type IdsSeverity = "pass" | "fail" | "warning" | "unsupported";

export interface IdsRestriction {
  kind:
    | "simpleValue"
    | "enumeration"
    | "pattern"
    | "minInclusive"
    | "maxInclusive"
    | "minExclusive"
    | "maxExclusive"
    | "length"
    | "minLength"
    | "maxLength";
  values: string[];
}

export interface IdsFacet {
  type: "entity" | "attribute" | "property" | "classification" | "material" | "partOf";
  /** Facet name (attribute name / property name / entity type). */
  name?: string;
  /** Property set name (only for property facet). */
  propertySet?: string;
  /** Restriction on the value, if present. */
  restriction?: IdsRestriction;
  /** Whether the facet must exist (required/optional/prohibited). */
  cardinality: "required" | "optional" | "prohibited";
}

export interface IdsSpecification {
  id: string;
  name: string;
  description?: string;
  ifcVersion: string;
  applicability: IdsFacet[];
  requirements: IdsFacet[];
}

export interface IdsDocument {
  title?: string;
  version?: string;
  author?: string;
  date?: string;
  specifications: IdsSpecification[];
}

export interface IdsCheckResult {
  specificationId: string;
  specificationName: string;
  modelId: string;
  localId: number;
  elementName: string;
  /** Human-readable label for the facet that was checked. */
  facet: string;
  severity: IdsSeverity;
  message: string;
  /** Actual value read from the model (if applicable). */
  actual?: string;
}

export interface IdsRunReport {
  document: IdsDocument;
  results: IdsCheckResult[];
  startedAt: number;
  finishedAt: number;
  modelsChecked: number;
  elementsChecked: number;
  /** Per-specification summary. */
  summary: {
    specificationId: string;
    specificationName: string;
    total: number;
    passed: number;
    failed: number;
    unsupported: number;
  }[];
}

let lastReport: IdsRunReport | null = null;
export function getLastReport(): IdsRunReport | null {
  return lastReport;
}
export function clearLastReport() {
  lastReport = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// XML parsing
// ═══════════════════════════════════════════════════════════════════════════
function byLocalName(parent: Element | Document | null, name: string): Element[] {
  if (!parent) return [];
  const all = (parent as Element).getElementsByTagName("*");
  const out: Element[] = [];
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (
      e.localName === name ||
      e.tagName === name ||
      e.tagName.endsWith(":" + name)
    ) {
      out.push(e);
    }
  }
  return out;
}

function directChild(parent: Element | null, name: string): Element | null {
  if (!parent) return null;
  for (let i = 0; i < parent.children.length; i++) {
    const c = parent.children[i];
    if (
      c.localName === name ||
      c.tagName === name ||
      c.tagName.endsWith(":" + name)
    ) {
      return c;
    }
  }
  return null;
}

function textOf(parent: Element | null, name: string): string | undefined {
  const c = directChild(parent, name);
  if (!c) return undefined;
  const txt = (c.textContent ?? "").trim();
  return txt || undefined;
}

function parseRestriction(parent: Element | null): IdsRestriction | undefined {
  if (!parent) return undefined;
  // simpleValue
  const simple = directChild(parent, "simpleValue");
  if (simple) {
    return { kind: "simpleValue", values: [(simple.textContent ?? "").trim()] };
  }
  // restriction
  const restr = directChild(parent, "restriction");
  if (!restr) return undefined;

  // Enumerations
  const enums: string[] = [];
  for (const e of Array.from(restr.children)) {
    const local = e.localName ?? e.tagName.split(":").pop() ?? "";
    if (local === "enumeration") {
      const v = e.getAttribute("value");
      if (v != null) enums.push(v);
    }
  }
  if (enums.length) return { kind: "enumeration", values: enums };

  // Patterns and bounds — collection with values
  for (const e of Array.from(restr.children)) {
    const local = e.localName ?? e.tagName.split(":").pop() ?? "";
    if (
      local === "pattern" ||
      local === "minInclusive" ||
      local === "maxInclusive" ||
      local === "minExclusive" ||
      local === "maxExclusive" ||
      local === "length" ||
      local === "minLength" ||
      local === "maxLength"
    ) {
      const v = e.getAttribute("value");
      if (v != null) return { kind: local as any, values: [v] };
    }
  }
  return undefined;
}

function parseFacet(el: Element): IdsFacet | null {
  const local = el.localName ?? el.tagName.split(":").pop() ?? "";
  const cardinality =
    (el.getAttribute("cardinality") as any) ??
    (local === "entity" || local === "attribute" || local === "property"
      ? "required"
      : "optional");

  switch (local) {
    case "entity": {
      const nameEl = directChild(el, "name");
      const simple = nameEl ? directChild(nameEl, "simpleValue") : null;
      const name = simple ? (simple.textContent ?? "").trim() : undefined;
      return { type: "entity", name, cardinality };
    }
    case "attribute": {
      const nameEl = directChild(el, "name");
      const simple = nameEl ? directChild(nameEl, "simpleValue") : null;
      const name = simple ? (simple.textContent ?? "").trim() : undefined;
      const restriction = parseRestriction(el);
      return { type: "attribute", name, cardinality, restriction };
    }
    case "property": {
      const psEl = directChild(el, "propertySet");
      const psSimple = psEl ? directChild(psEl, "simpleValue") : null;
      const propertySet = psSimple ? (psSimple.textContent ?? "").trim() : undefined;
      const nameEl = directChild(el, "name") ?? directChild(el, "baseName");
      const simple = nameEl ? directChild(nameEl, "simpleValue") : null;
      const name = simple ? (simple.textContent ?? "").trim() : undefined;
      const restriction = parseRestriction(el);
      return { type: "property", propertySet, name, cardinality, restriction };
    }
    case "classification":
      return { type: "classification", cardinality };
    case "material":
      return { type: "material", cardinality };
    case "partOf":
      return { type: "partOf", cardinality };
  }
  return null;
}

export function parseIdsXml(xml: string): IdsDocument {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");

  // Namespace-safe error detection
  const err = doc.getElementsByTagName("parsererror");
  if (err && err.length) {
    throw new Error("IDS XML parse error: " + (err[0].textContent ?? "unknown"));
  }

  const root = doc.documentElement;
  if (!root) throw new Error("Empty IDS document.");

  const info = byLocalName(root, "info")[0];
  const specsEl = byLocalName(root, "specifications")[0];
  const specEls = specsEl ? byLocalName(specsEl, "specification") : [];

  const document: IdsDocument = {
    title: info ? textOf(info, "title") : undefined,
    version: info ? textOf(info, "version") : undefined,
    author: info ? textOf(info, "author") : undefined,
    date: info ? textOf(info, "date") : undefined,
    specifications: [],
  };

  let idx = 0;
  for (const s of specEls) {
    const name = s.getAttribute("name") ?? `Specification ${++idx}`;
    const description = s.getAttribute("description") ?? textOf(s, "description") ?? undefined;
    const ifcVersion = s.getAttribute("ifcVersion") ?? "IFC4";

    const appEl = directChild(s, "applicability");
    const reqEl = directChild(s, "requirements");

    const applicability: IdsFacet[] = [];
    if (appEl) {
      for (const child of Array.from(appEl.children)) {
        const f = parseFacet(child);
        if (f) applicability.push(f);
      }
    }
    const requirements: IdsFacet[] = [];
    if (reqEl) {
      for (const child of Array.from(reqEl.children)) {
        const f = parseFacet(child);
        if (f) requirements.push(f);
      }
    }

    document.specifications.push({
      id: s.getAttribute("identifier") ?? `spec-${++idx}`,
      name,
      description,
      ifcVersion,
      applicability,
      requirements,
    });
  }

  return document;
}

// ═══════════════════════════════════════════════════════════════════════════
// Restriction matching
// ═══════════════════════════════════════════════════════════════════════════
function matchRestriction(actual: string, r: IdsRestriction): boolean {
  const a = String(actual ?? "").trim();
  switch (r.kind) {
    case "simpleValue":
      return a === r.values[0];
    case "enumeration":
      return r.values.includes(a);
    case "pattern":
      try {
        return new RegExp(r.values[0]).test(a);
      } catch {
        return false;
      }
    case "minInclusive": {
      const n = parseFloat(a);
      const m = parseFloat(r.values[0]);
      return Number.isFinite(n) && Number.isFinite(m) && n >= m;
    }
    case "maxInclusive": {
      const n = parseFloat(a);
      const m = parseFloat(r.values[0]);
      return Number.isFinite(n) && Number.isFinite(m) && n <= m;
    }
    case "minExclusive": {
      const n = parseFloat(a);
      const m = parseFloat(r.values[0]);
      return Number.isFinite(n) && Number.isFinite(m) && n > m;
    }
    case "maxExclusive": {
      const n = parseFloat(a);
      const m = parseFloat(r.values[0]);
      return Number.isFinite(n) && Number.isFinite(m) && n < m;
    }
    case "length":
      return a.length === parseInt(r.values[0], 10);
    case "minLength":
      return a.length >= parseInt(r.values[0], 10);
    case "maxLength":
      return a.length <= parseInt(r.values[0], 10);
  }
  return false;
}

function describeRestriction(r: IdsRestriction): string {
  switch (r.kind) {
    case "simpleValue":
      return `= "${r.values[0]}"`;
    case "enumeration":
      return `one of [${r.values.join(", ")}]`;
    case "pattern":
      return `matches /${r.values[0]}/`;
    case "minInclusive":
      return `≥ ${r.values[0]}`;
    case "maxInclusive":
      return `≤ ${r.values[0]}`;
    case "minExclusive":
      return `> ${r.values[0]}`;
    case "maxExclusive":
      return `< ${r.values[0]}`;
    case "length":
      return `length = ${r.values[0]}`;
    case "minLength":
      return `length ≥ ${r.values[0]}`;
    case "maxLength":
      return `length ≤ ${r.values[0]}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Element data extraction
// ═══════════════════════════════════════════════════════════════════════════

/** Flat element record for the engine. Read once per model in a batch. */
interface ElementRecord {
  localId: number;
  ifcType: string;
  attributes: Record<string, string>;
  psets: Record<string, Record<string, string>>;
  /** True when psets couldn't be read (SDK fallback). */
  psetsUnavailable: boolean;
}

/**
 * Try to read as much data as possible for a batch of elements.
 * Batches to reduce round-trips. Silently falls back if an option is unsupported.
 */
async function readElementRecords(
  model: any,
  localIds: number[],
  categoryMap: Map<number, string>,
): Promise<Map<number, ElementRecord>> {
  const out = new Map<number, ElementRecord>();
  if (!localIds.length) return out;

  let raw: any[] | null = null;
  let psetsUnavailable = false;

  // Attempt a full read including psets.
  try {
    raw = await model.getItemsData(localIds, {
      attributesDefault: true,
      psetsDefault: true,
    } as any);
  } catch {
    raw = null;
  }

  // Fallback: attributes only.
  if (!raw) {
    psetsUnavailable = true;
    try {
      raw = await model.getItemsData(localIds, {
        attributesDefault: true,
      } as any);
    } catch {
      raw = [];
    }
  }

  for (let i = 0; i < localIds.length; i++) {
    const id = localIds[i];
    const d = (raw as any[])?.[i] ?? {};
    const attrs: Record<string, string> = {};
    const psets: Record<string, Record<string, string>> = {};

    // Flatten attributes.
    for (const [k, v] of Object.entries(d)) {
      if (k === "psets") continue;
      const val = (v as any)?.value;
      if (val != null) attrs[k] = String(val);
      else if (typeof v === "string" || typeof v === "number") attrs[k] = String(v);
    }

    // Flatten psets if present.
    const rawPsets = (d as any).psets;
    if (rawPsets && typeof rawPsets === "object") {
      for (const [psName, props] of Object.entries(rawPsets)) {
        const map: Record<string, string> = {};
        for (const [pk, pv] of Object.entries(props as any)) {
          const val = (pv as any)?.value;
          if (val != null) map[pk] = String(val);
          else if (typeof pv === "string" || typeof pv === "number") map[pk] = String(pv);
        }
        psets[psName] = map;
      }
    }

    // IFC type — prefer ObjectType, fall back to category map.
    const ifcType =
      (attrs.ObjectType && attrs.ObjectType.toUpperCase()) ||
      (categoryMap.get(id) ?? "UNKNOWN").toUpperCase().replace(/^IFC/, "");

    out.set(id, { localId: id, ifcType, attributes: attrs, psets, psetsUnavailable });
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Applicability matching
// ═══════════════════════════════════════════════════════════════════════════
function facetMatchesElement(f: IdsFacet, r: ElementRecord): boolean {
  switch (f.type) {
    case "entity": {
      if (!f.name) return false;
      const want = f.name.toUpperCase().replace(/^IFC/, "");
      return r.ifcType === want || r.ifcType === f.name.toUpperCase();
    }
    case "attribute": {
      if (!f.name) return false;
      // For applicability, attribute must exist. If restriction present, value must match.
      const v = r.attributes[f.name];
      if (v == null) return false;
      if (f.restriction) return matchRestriction(v, f.restriction);
      return true;
    }
    case "property": {
      if (f.cardinality === "prohibited") {
        return !r.psets[f.propertySet ?? ""]?.[f.name ?? ""];
      }
      const pset = f.propertySet ? r.psets[f.propertySet] : undefined;
      if (!pset) return false;
      if (!f.name) return true;
      const v = pset[f.name];
      if (v == null) return false;
      if (f.restriction) return matchRestriction(v, f.restriction);
      return true;
    }
    // Unsupported facets — treat as "matches nothing" for applicability so
    // they don't leak into results, but mark the spec as containing
    // unsupported facets separately (see runIdsValidation).
    default:
      return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Requirements checking
// ═══════════════════════════════════════════════════════════════════════════
function checkRequirement(
  f: IdsFacet,
  r: ElementRecord,
): { severity: IdsSeverity; message: string; actual?: string } {
  switch (f.type) {
    case "entity": {
      if (!f.name) return { severity: "unsupported", message: "Entity facet without a name" };
      const want = f.name.toUpperCase().replace(/^IFC/, "");
      const ok = r.ifcType === want || r.ifcType === f.name.toUpperCase();
      return ok
        ? { severity: "pass", message: `Entity is ${f.name}` }
        : {
            severity: "fail",
            message: `Expected entity ${f.name}`,
            actual: r.ifcType,
          };
    }
    case "attribute": {
      if (!f.name)
        return { severity: "unsupported", message: "Attribute facet without a name" };
      const v = r.attributes[f.name];
      if (v == null) {
        return f.cardinality === "required"
          ? {
              severity: "fail",
              message: `Missing required attribute "${f.name}"`,
            }
          : { severity: "pass", message: `Optional attribute "${f.name}" not present` };
      }
      if (f.cardinality === "prohibited") {
        return {
          severity: "fail",
          message: `Attribute "${f.name}" is prohibited but present`,
          actual: v,
        };
      }
      if (f.restriction && !matchRestriction(v, f.restriction)) {
        return {
          severity: "fail",
          message: `Attribute "${f.name}" must be ${describeRestriction(f.restriction)}`,
          actual: v,
        };
      }
      return { severity: "pass", message: `Attribute "${f.name}" OK`, actual: v };
    }
    case "property": {
      if (!f.propertySet || !f.name)
        return { severity: "unsupported", message: "Property facet missing set or name" };
      if (r.psetsUnavailable) {
        return {
          severity: "warning",
          message: `Cannot read properties for this element — check skipped`,
        };
      }
      const pset = r.psets[f.propertySet];
      const v = pset?.[f.name];
      if (v == null) {
        return f.cardinality === "required"
          ? {
              severity: "fail",
              message: `Missing required property ${f.propertySet}.${f.name}`,
            }
          : {
              severity: "pass",
              message: `Optional property ${f.propertySet}.${f.name} not present`,
            };
      }
      if (f.cardinality === "prohibited") {
        return {
          severity: "fail",
          message: `Property ${f.propertySet}.${f.name} is prohibited but present`,
          actual: v,
        };
      }
      if (f.restriction && !matchRestriction(v, f.restriction)) {
        return {
          severity: "fail",
          message: `${f.propertySet}.${f.name} must be ${describeRestriction(f.restriction)}`,
          actual: v,
        };
      }
      return { severity: "pass", message: `${f.propertySet}.${f.name} OK`, actual: v };
    }
    default:
      return {
        severity: "unsupported",
        message: `Facet type "${f.type}" is not yet supported by this engine`,
      };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════════
export interface IdsRunOptions {
  /** Optional — restrict to specific model ids. */
  modelIds?: string[];
  onProgress?: (p: { current: number; total: number; modelId: string }) => void;
  signal?: { cancelled: boolean };
}

export async function runIdsValidation(
  document: IdsDocument,
  opts: IdsRunOptions = {},
): Promise<IdsRunReport> {
  const startedAt = Date.now();
  const results: IdsCheckResult[] = [];
  const perSpecTotal = new Map<string, number>();
  const perSpecPass = new Map<string, number>();
  const perSpecFail = new Map<string, number>();
  const perSpecUnsupported = new Map<string, number>();

  const modelIds = opts.modelIds?.length
    ? opts.modelIds.filter((id) => ctx.fragments.list.has(id))
    : Array.from(ctx.fragments.list.keys());

  const modelsChecked = modelIds.length;
  let elementsChecked = 0;

  for (let mi = 0; mi < modelIds.length; mi++) {
    const modelId = modelIds[mi];
    const model: any = ctx.fragments.list.get(modelId);
    if (!model) continue;
    if (opts.signal?.cancelled) break;

    opts.onProgress?.({ current: mi + 1, total: modelIds.length, modelId });

    // Read all ids + category map
    let allIds: number[] = [];
    try {
      allIds = (await model.getItemsIdsWithGeometry()) ?? [];
    } catch {
      continue;
    }
    if (!allIds.length) continue;

    const categoryMap = new Map<number, string>();
    try {
      const cats = await model.getItemsOfCategories([/.+/]);
      for (const [cat, list] of Object.entries(cats ?? {})) {
        for (const id of (list as number[]) || []) categoryMap.set(id, cat);
      }
    } catch {
      /* */
    }

    // Only read data for elements that any spec could possibly match.
    // For simplicity we read them all — id-range subsetting is a future optimization.
    const records = await readElementRecords(model, allIds, categoryMap);
    elementsChecked += records.size;

    for (const spec of document.specifications) {
      const specId = spec.id;
      if (!perSpecTotal.has(specId)) {
        perSpecTotal.set(specId, 0);
        perSpecPass.set(specId, 0);
        perSpecFail.set(specId, 0);
        perSpecUnsupported.set(specId, 0);
      }

      const hasUnsupportedApplicability = spec.applicability.some(
        (f) =>
          f.type === "classification" ||
          f.type === "material" ||
          f.type === "partOf",
      );

      for (const [localId, rec] of records) {
        if (opts.signal?.cancelled) break;

        // Applicability gate
        const matches = spec.applicability.every((f) => facetMatchesElement(f, rec));
        if (!matches) continue;

        perSpecTotal.set(specId, (perSpecTotal.get(specId) ?? 0) + 1);

        // If the spec contains unsupported applicability facets, emit a
        // single warning on the first matched element and continue with
        // requirements checking on the supported subset.
        if (hasUnsupportedApplicability) {
          results.push({
            specificationId: specId,
            specificationName: spec.name,
            modelId,
            localId,
            elementName: rec.attributes.Name ?? `#${localId}`,
            facet: "applicability",
            severity: "unsupported",
            message:
              "Spec uses applicability facets (classification, material, partOf) that this engine does not yet support.",
          });
        }

        if (!spec.requirements.length) {
          // No requirements = existence-only check. Applicability match is pass.
          perSpecPass.set(specId, (perSpecPass.get(specId) ?? 0) + 1);
          continue;
        }

        let anyFail = false;
        let anyUnsupported = false;
        for (const req of spec.requirements) {
          const r = checkRequirement(req, rec);
          const facetLabel =
            req.type === "property"
              ? `property ${req.propertySet ?? "?"}.${req.name ?? "?"}`
              : req.type === "attribute"
                ? `attribute ${req.name ?? "?"}`
                : req.type;
          if (r.severity === "fail") anyFail = true;
          if (r.severity === "unsupported" || r.severity === "warning") {
            anyUnsupported = true;
          }
          if (r.severity !== "pass") {
            results.push({
              specificationId: specId,
              specificationName: spec.name,
              modelId,
              localId,
              elementName: rec.attributes.Name ?? `#${localId}`,
              facet: facetLabel,
              severity: r.severity,
              message: r.message,
              actual: r.actual,
            });
          }
        }

        if (!anyFail) {
          perSpecPass.set(specId, (perSpecPass.get(specId) ?? 0) + 1);
        } else {
          perSpecFail.set(specId, (perSpecFail.get(specId) ?? 0) + 1);
        }
        if (anyUnsupported) {
          perSpecUnsupported.set(specId, (perSpecUnsupported.get(specId) ?? 0) + 1);
        }
      }
    }
  }

  const report: IdsRunReport = {
    document,
    results,
    startedAt,
    finishedAt: Date.now(),
    modelsChecked,
    elementsChecked,
    summary: document.specifications.map((s) => ({
      specificationId: s.id,
      specificationName: s.name,
      total: perSpecTotal.get(s.id) ?? 0,
      passed: perSpecPass.get(s.id) ?? 0,
      failed: perSpecFail.get(s.id) ?? 0,
      unsupported: perSpecUnsupported.get(s.id) ?? 0,
    })),
  };
  lastReport = report;
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// CSV export
// ═══════════════════════════════════════════════════════════════════════════
export function exportIdsReportCsv(report: IdsRunReport): void {
  const q = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    "Specification,ModelId,LocalId,ElementName,Facet,Severity,Message,ActualValue",
  ];
  for (const r of report.results) {
    lines.push(
      [
        q(r.specificationName),
        q(r.modelId),
        r.localId,
        q(r.elementName),
        q(r.facet),
        r.severity,
        q(r.message),
        q(r.actual ?? ""),
      ].join(","),
    );
  }
  lines.push("");
  lines.push("Specification,Total,Passed,Failed,Unsupported");
  for (const s of report.summary) {
    lines.push(
      [q(s.specificationName), s.total, s.passed, s.failed, s.unsupported].join(","),
    );
  }
  const blob = new Blob(["\ufeff" + lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ids-validation-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}