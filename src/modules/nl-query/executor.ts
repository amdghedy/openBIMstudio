/**
 * Natural Language BIM Query Executor.
 *
 * Runs parsed queries against the loaded IFC model or authored elements,
 * filtering matching element IDs and dispatching UI selection and highlight actions.
 */

import { parseNLQuery, type ParsedBimQuery } from "./parser";

// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsContext: any;

export interface QueryExecutionResult {
  parsed: ParsedBimQuery;
  matchedCount: number;
  matchedIds: string[];
  durationMs: number;
}

/**
 * UI side effect of a query (selection / toast). Guarded so the query
 * engine itself runs outside a DOM — node tests, workers — where there
 * is no window to dispatch to; in the browser this changes nothing.
 */
function dispatchUiEvent(name: string, detail: unknown): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export interface QueryableElement {
  id: string;
  category: string;
  properties?: Record<string, any>;
}

/**
 * Map one authored element to the shape the query executor matches on.
 *
 * Before this, callers passed `properties` only — and authored elements
 * carry their geometry in `params`, not `properties` — so a criterion
 * such as "taller than 3 m" found no `Height` property and was silently
 * skipped, matching every wall regardless of height. The live geometry
 * now feeds the criteria the parser emits: Height ← params.height,
 * Width ← params.thickness (walls) or params.width, Length ← the
 * start/end span for linear elements, Elevation ← params.elevation.
 * IFC-style properties, when present, are kept underneath; the live
 * params win for the geometric keys because they are the current model.
 */
export function authoredToQueryElement(el: {
  id: unknown;
  type?: unknown;
  category?: unknown;
  params?: Record<string, any>;
  properties?: Record<string, any>;
}): QueryableElement {
  const params = (el.params ?? {}) as Record<string, any>;
  const properties: Record<string, any> = { ...(el.properties ?? {}) };
  if (typeof params.height === "number") properties.Height = params.height;
  if (typeof params.thickness === "number") properties.Width = params.thickness;
  else if (typeof params.width === "number") properties.Width = params.width;
  if (Array.isArray(params.start) && Array.isArray(params.end)) {
    const length = Math.hypot(params.end[0] - params.start[0], params.end[1] - params.start[1]);
    if (Number.isFinite(length)) properties.Length = Math.round(length * 1000) / 1000;
  }
  if (typeof params.elevation === "number") properties.Elevation = params.elevation;
  return {
    id: String(el.id),
    category: String(el.category ?? el.type ?? "").toUpperCase(),
    properties,
  };
}

export function executeNLQuery(
  rawQuery: string,
  modelElements?: Array<{ id: string; category: string; properties?: Record<string, any> }>
): QueryExecutionResult {
  const start = performance.now();
  const parsed = parseNLQuery(rawQuery);

  // If no elements passed directly, fallback to querying window/service state
  const elements = modelElements || sampleOrGlobalElements();
  const matchedIds: string[] = [];

  for (const el of elements) {
    const elCat = (el.category || "").toUpperCase();

    // Check category match
    const categoryMatches =
      parsed.targetCategories.includes("ALL") ||
      parsed.targetCategories.some((tc) => elCat.includes(tc) || tc.includes(elCat));

    if (!categoryMatches) continue;

    // Check property criteria
    let criteriaPass = true;
    for (const crit of parsed.criteria) {
      const propVal = el.properties ? el.properties[crit.property] : undefined;
      if (propVal === undefined) {
        // Soft match if property not strictly declared
        continue;
      }

      if (crit.operator === "gte" && typeof propVal === "number" && typeof crit.value === "number") {
        if (propVal < crit.value) criteriaPass = false;
      } else if (crit.operator === "eq") {
        if (propVal !== crit.value) criteriaPass = false;
      } else if (crit.operator === "contains" && typeof propVal === "string" && typeof crit.value === "string") {
        if (!propVal.toLowerCase().includes(crit.value.toLowerCase())) criteriaPass = false;
      }
    }

    if (criteriaPass) {
      matchedIds.push(el.id);
    }
  }

  // Dispatch appropriate action
  if (parsed.action === "select" || parsed.action === "isolate") {
    dispatchUiEvent("obs-select", { ids: matchedIds });
  } else if (parsed.action === "highlight") {
    dispatchUiEvent("obs-highlight", { ids: matchedIds, color: "#f59e0b" });
  }

  dispatchUiEvent("obs-toast", {
    message: `${parsed.interpretedSummary} &rarr; Found ${matchedIds.length} element(s)`,
    kind: "info",
  });

  return {
    parsed,
    matchedCount: matchedIds.length,
    matchedIds,
    durationMs: Math.round(performance.now() - start),
  };
}

function sampleOrGlobalElements(): Array<{ id: string; category: string; properties?: Record<string, any> }> {
  // Try to inspect global ctx if accessible
  const ctx = obsContext || (window as any).ctx;
  if (ctx?.sceneElements) {
    return ctx.sceneElements;
  }

  // Synthesize sample matching items for UI demonstration if nothing loaded
  return [
    { id: "wall-101", category: "IFCWALL", properties: { Width: 0.25, Height: 3.0, LoadBearing: true } },
    { id: "wall-102", category: "IFCWALL", properties: { Width: 0.15, Height: 3.0, LoadBearing: false } },
    { id: "door-201", category: "IFCDOOR", properties: { FireRating: "EI30" } },
    { id: "col-301", category: "IFCCOLUMN", properties: { Material: "concrete", Height: 3.5 } },
    { id: "pipe-401", category: "IFCPIPESEGMENT", properties: { Diameter: 0.05 } },
  ];
}
