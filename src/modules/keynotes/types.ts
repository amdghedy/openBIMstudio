/**
 * Keynotes — types + lookup system.
 *
 * Keynotes tag elements with standardized codes from a keynote file
 * (BIM's Keynote Legend feature). Each keynote has a code (e.g.
 * "05 10 00.A"), a title, and is organized hierarchically by
 * division → section → topic.
 *
 * The keynote system supports:
 *   - Loading a keynote file (tab-delimited: code \t title)
 *   - Assigning keynotes to elements by element ID
 *   - Rendering keynote tags in views (similar to text tags but
 *     showing the keynote code instead of element name)
 *   - Exporting a keynote legend (sorted list of all used keynotes)
 */

/** A single keynote entry. */
export interface Keynote {
  /** Keynote code (e.g. "05 10 00.A" or "10 20 00.B1"). */
  code: string;
  /** Human-readable title. */
  title: string;
  /** Division number (e.g. "05" for Structural). */
  division: string;
  /** Section number (e.g. "10"). */
  section: string;
}

/** A keynote assignment on an element. */
export interface KeynoteAssignment {
  /** Element ID the keynote is attached to. */
  elementId: string;
  /** View ID (null = applies in all views). */
  viewId: string | null;
  /** Keynote code. */
  code: string;
  /** Position offset [dx, dz] in mm from the element. */
  offsetMm: [number, number];
  /** Whether to show a leader. */
  leader: boolean;
}

/** Keynote store (loaded keynote file). */
const keynoteMap = new Map<string, Keynote>();
const assignments: KeynoteAssignment[] = [];

/** Parse a keynote file (tab-delimited: code \t title). */
export function loadKeynoteFile(text: string): number {
  keynoteMap.clear();
  const lines = text.split(/\r?\n/);
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    const code = parts[0].trim();
    const title = parts[1].trim();
    if (!code) continue;
    const divSec = code.split(".");
    const div = divSec[0]?.split(" ")[0] ?? "";
    const sec = divSec[0]?.split(" ")[1] ?? "";
    keynoteMap.set(code, { code, title, division: div, section: sec });
    count++;
  }
  console.log(`[keynotes] loaded ${count} keynote(s) from file`);
  return count;
}

/** Look up a keynote by code. */
export function getKeynote(code: string): Keynote | null {
  return keynoteMap.get(code) ?? null;
}

/** List all loaded keynotes. */
export function listKeynotes(): Keynote[] {
  return [...keynoteMap.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/** Search keynotes by title or code. */
export function searchKeynotes(query: string): Keynote[] {
  const q = query.toLowerCase();
  return listKeynotes().filter(
    (k) => k.code.toLowerCase().includes(q) || k.title.toLowerCase().includes(q),
  );
}

/** Assign a keynote to an element. */
export function assignKeynote(assignment: KeynoteAssignment): void {
  assignments.push(assignment);
}

/** Get all keynote assignments for a view (or all views). */
export function getAssignments(viewId: string | null): KeynoteAssignment[] {
  if (viewId === null) return assignments;
  return assignments.filter((a) => a.viewId === null || a.viewId === viewId);
}

/** Remove a keynote assignment. */
export function removeAssignment(elementId: string, viewId: string | null): void {
  const idx = assignments.findIndex(
    (a) => a.elementId === elementId && (viewId === null || a.viewId === viewId),
  );
  if (idx >= 0) assignments.splice(idx, 1);
}

/** Generate a keynote legend: sorted list of all used keynotes. */
export function generateLegend(): Array<{ code: string; title: string; count: number }> {
  const used = new Map<string, number>();
  for (const a of assignments) {
    used.set(a.code, (used.get(a.code) ?? 0) + 1);
  }
  return [...used.entries()]
    .map(([code, count]) => ({
      code,
      title: keynoteMap.get(code)?.title ?? "Unknown",
      count,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Export keynote legend as CSV. */
export function legendToCSV(): string {
  const legend = generateLegend();
  const header = "Code,Title,Count";
  const rows = legend.map((l) => `"${l.code}","${l.title}",${l.count}`);
  return [header, ...rows].join("\r\n");
}
