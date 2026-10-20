export * from "./types";

let installed = false;
export function setupKeynotes() {
  if (installed) return;
  installed = true;
  (window as any).__obsKeynotes = {
    loadFile: (text: string) => require("./types").loadKeynoteFile(text),
    get: (code: string) => require("./types").getKeynote(code),
    list: () => require("./types").listKeynotes(),
    search: (q: string) => require("./types").searchKeynotes(q),
    assign: (a: any) => require("./types").assignKeynote(a),
    getAssignments: (viewId: string | null) => require("./types").getAssignments(viewId),
    removeAssignment: (elId: string, vId: string | null) => require("./types").removeAssignment(elId, vId),
    legend: () => require("./types").generateLegend(),
    legendCSV: () => require("./types").legendToCSV(),
  };
  console.log("[keynotes] ready. Load a keynote file via __obsKeynotes.loadFile(text).");
}
export function isReady() { return installed; }
