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
let keynotesApi: any = null;
export function setupKeynotes() {
  if (installed) return keynotesApi;
  installed = true;
  keynotesApi = {
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
  console.log("[keynotes] ready. Load a keynote file via the keynotes feature api.");
  return keynotesApi;
}
export function isReady() { return installed; }
