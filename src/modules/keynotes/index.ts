export * from "./types";

// NOTE: the setup bag below used require("./types") — dead on arrival in a
// Vite ESM browser bundle (same bug parametric-constraints had). The bag now
// goes through proper static ESM imports, so the legend/CSV/assign flows it
// exposes actually run.
import {
  loadKeynoteFile,
  getKeynote,
  listKeynotes,
  searchKeynotes,
  assignKeynote,
  getAssignments,
  removeAssignment,
  generateLegend,
  legendToCSV,
} from "./types";

let installed = false;
export function setupKeynotes() {
  if (installed) return;
  installed = true;
  (window as any).__obsKeynotes = {
    loadFile: (text: string) => loadKeynoteFile(text),
    get: (code: string) => getKeynote(code),
    list: () => listKeynotes(),
    search: (q: string) => searchKeynotes(q),
    assign: (a: any) => assignKeynote(a),
    getAssignments: (viewId: string | null) => getAssignments(viewId),
    removeAssignment: (elId: string, vId: string | null) => removeAssignment(elId, vId),
    legend: () => generateLegend(),
    legendCSV: () => legendToCSV(),
  };
  console.log("[keynotes] ready. Load a keynote file via __obsKeynotes.loadFile(text).");
}
export function isReady() { return installed; }
