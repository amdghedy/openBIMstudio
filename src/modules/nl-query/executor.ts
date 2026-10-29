/**
 * Natural Language BIM Query Executor.
 *
 * Runs parsed queries against the loaded IFC model or authored elements,
 * filtering matching element IDs and dispatching UI selection and highlight actions.
 */

import { parseNLQuery, type ParsedBimQuery } from "./parser";

export interface QueryExecutionResult {
  parsed: ParsedBimQuery;
  matchedCount: number;
  matchedIds: string[];
  durationMs: number;
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
    window.dispatchEvent(
      new CustomEvent("obs-select", {
        detail: { ids: matchedIds },
      })
    );
  } else if (parsed.action === "highlight") {
    window.dispatchEvent(
      new CustomEvent("obs-highlight", {
        detail: { ids: matchedIds, color: "#f59e0b" },
      })
    );
  }

  window.dispatchEvent(
    new CustomEvent("obs-toast", {
      detail: {
        message: `${parsed.interpretedSummary} &rarr; Found ${matchedIds.length} element(s)`,
        kind: "info",
      },
    })
  );

  return {
    parsed,
    matchedCount: matchedIds.length,
    matchedIds,
    durationMs: Math.round(performance.now() - start),
  };
}

function sampleOrGlobalElements(): Array<{ id: string; category: string; properties?: Record<string, any> }> {
  // Try to inspect global ctx if accessible
  const ctx = (window as any).__obsContext || (window as any).ctx;
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
