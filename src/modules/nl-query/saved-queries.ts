/**
 * Saved & Quick Predefined BIM Queries.
 *
 * Provides ready-to-click quick queries for common BIM coordination workflows.
 */

export interface QuickQueryPreset {
  id: string;
  label: string;
  query: string;
  category: "Architectural" | "Structural" | "MEP" | "Life Safety";
}

export const QUICK_QUERIES: QuickQueryPreset[] = [
  { id: "q1", label: "All load-bearing walls", query: "select load-bearing walls", category: "Structural" },
  { id: "q2", label: "Walls thicker than 200mm", query: "show walls thicker than 200mm", category: "Architectural" },
  { id: "q3", label: "Fire-rated doors", query: "select all fire rated doors", category: "Life Safety" },
  { id: "q4", label: "Concrete columns", query: "select concrete columns", category: "Structural" },
  { id: "q5", label: "MEP Pipes", query: "highlight all pipes", category: "MEP" },
  { id: "q6", label: "HVAC Ducts", query: "show all ducts", category: "MEP" },
  { id: "q7", label: "Exterior windows", query: "select exterior windows", category: "Architectural" },
  { id: "q8", label: "Steel beams", query: "highlight steel beams", category: "Structural" },
];

const STORAGE_SAVED = "obs.saved_nl_queries.v1";

export function getSavedQueries(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_SAVED) || "[]");
  } catch {
    return [];
  }
}

export function saveQuery(q: string): void {
  const list = getSavedQueries();
  if (!list.includes(q)) {
    list.push(q);
    try {
      localStorage.setItem(STORAGE_SAVED, JSON.stringify(list));
    } catch {
      /* quota */
    }
  }
}
