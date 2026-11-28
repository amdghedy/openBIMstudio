/**
 * US National CAD Standard (NCS) layer-name check — structural, not a full UDS layer list.
 *
 * Format checked:  <Discipline[+level-2 letter]> - <MAJOR 4> [- <MINOR 4> [- <MINOR 4>]] [- <STATUS 1>]
 * e.g. A-WALL, A-WALL-FULL, A-DOOR-IDEN-N, S-BEAM, E-POWR.
 * Discipline designators (NCS): A G B C D E F H I L M O P Q R S T X Z.
 *
 * What this does NOT do: it does not know whether a given major/minor group exists in the published UDS
 * (A-WALL-XXXX passes). It checks shape and the discipline letter only. Pure, import-free.
 */
export const NCS_DISCIPLINES: Record<string, string> = {
  A: "Architectural", B: "Geotechnical", C: "Civil", D: "Process", E: "Electrical", F: "Fire Protection", G: "General",
  H: "Hazardous Materials", I: "Interiors", L: "Landscape", M: "Mechanical", O: "Operations", P: "Plumbing", Q: "Equipment",
  R: "Resource", S: "Structural", T: "Telecommunications", X: "Other Disciplines", Z: "Contractor / Shop Drawings",
};

export interface NcsLayerCheck {
  ok: boolean;
  /** Layers like "0", "Defpoints" and xref-dependent names are system/foreign and not judged. */
  exempt?: boolean;
  discipline?: string;
  major?: string;
  issues: string[];
}

const SYSTEM = new Set(["0", "DEFPOINTS"]);
const NCS_RE = /^([A-Z])([A-Z])?-([A-Z0-9]{4})(?:-([A-Z0-9]{4}))?(?:-([A-Z0-9]{4}))?(?:-([A-Z]))?$/;

export function checkNcsLayerName(raw: string): NcsLayerCheck {
  const full = String(raw ?? "");
  // XREF-dependent layers are "xrefname|layer": judge the host drawing's own layer part.
  const name = (full.includes("|") ? full.slice(full.lastIndexOf("|") + 1) : full).trim();
  if (!name) return { ok: false, issues: ["Layer name is empty."] };
  if (SYSTEM.has(name.toUpperCase())) return { ok: true, exempt: true, issues: [] };
  const issues: string[] = [];
  const up = name.toUpperCase();
  if (name !== up) issues.push("NCS layer names are upper-case.");
  const m = NCS_RE.exec(up);
  if (!m) {
    if (!/^[A-Z]{1,2}-/.test(up)) issues.push("Must start with a discipline designator and a hyphen (e.g. A-, S-, M-).");
    else issues.push("Does not match <discipline>-<4-char major group>[-<4-char minor>…][-<status>].");
    if (/[^A-Z0-9-]/.test(up)) issues.push("Only letters, digits and hyphens are allowed.");
    return { ok: false, issues };
  }
  if (!NCS_DISCIPLINES[m[1]]) issues.push(`"${m[1]}" is not an NCS discipline designator.`);
  return { ok: issues.length === 0, discipline: m[1], major: m[3], issues };
}

export interface NcsAudit {
  total: number;
  conforming: number;
  exempt: number;
  offenders: Array<{ layer: string; issues: string[] }>;
}

export function auditNcsLayers(names: readonly string[]): NcsAudit {
  const seen = new Set<string>();
  const a: NcsAudit = { total: 0, conforming: 0, exempt: 0, offenders: [] };
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    a.total++;
    const r = checkNcsLayerName(n);
    if (r.exempt) a.exempt++;
    else if (r.ok) a.conforming++;
    else a.offenders.push({ layer: n, issues: r.issues });
  }
  return a;
}
