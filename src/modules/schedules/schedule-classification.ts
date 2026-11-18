/**
 * Classification → schedules bridge (pure, DOM-free).
 *
 * Schedules could only group by their own free-text column values
 * (level, category, systemType…) — the industry classification codes
 * assigned to elements (UniFormat II / Uniclass 2015 EF / OmniClass
 * Table 21) were invisible to every schedule. This module resolves an
 * element's assigned code and cuts it into hierarchical group prefixes
 * so a schedule can group and subtotal by classification.
 *
 * Every function takes its data as plain input: no browser storage, no
 * document access, no scene graph — compiles and runs in Node.
 *
 * Code systems handled (matching the seeded tables in ../classification):
 *   Uniclass 2015   "EF_25_10_25"      → underscore segments
 *   OmniClass 21    "21-01 10 10 10"   → space segments
 *   UniFormat II    "B2010"            → letter + 3 digits (B → B2 → B2010)
 *   anything else                       → single opaque segment
 */

export interface ScheduleAssignmentLike {
  elementId: string;
  systemId: string;
  code: string;
}

export interface ScheduleSystemLike {
  id: string;
  name: string;
  codes: ReadonlyArray<{ code: string; title: string }>;
}

export interface ResolvedClassification {
  systemId: string;
  systemName: string;
  code: string;
  title: string;
}

/** Group-bucket label for rows whose element carries no classification. */
export const UNCODED_LABEL = "Uncoded";

/* ═════════════════════════════════════════════════════════════════════════
   Code tokenization — cumulative prefixes
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * Cumulative code prefixes, one per hierarchy level.
 *   "EF_25_10_25"    → ["EF", "EF_25", "EF_25_10", "EF_25_10_25"]
 *   "21-01 10 10 10" → ["21-01", "21-01 10", "21-01 10 10", "21-01 10 10 10"]
 *   "B2010"          → ["B", "B2", "B2010"]
 *   ""               → []
 */
export function classificationSegments(code: string): string[] {
  const c = String(code ?? "").trim();
  if (!c) return [];

  if (c.includes("_")) {
    const parts = c.split("_").filter((p) => p.length > 0);
    const out: string[] = [];
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc}_${p}` : p;
      out.push(acc);
    }
    return out;
  }

  if (c.includes(" ")) {
    const parts = c.split(/\s+/).filter((p) => p.length > 0);
    const out: string[] = [];
    let acc = "";
    for (const p of parts) {
      acc = acc ? `${acc} ${p}` : p;
      out.push(acc);
    }
    return out;
  }

  // UniFormat II: letter + exactly 4 digits (B2010, G2030, C1010 …).
  // Levels are prefix cuts: B (group) → B2 (level 2) → B2010 (level 3).
  const uni = c.match(/^([A-Za-z])(\d{4})$/);
  if (uni) return [uni[1], uni[1] + uni[2][0], c];

  return [c];
}

/**
 * The code prefix covering `depth` hierarchy levels (1-based).
 * Unknown depth counts the whole code; depth < 1 is treated as 1.
 * Empty or whitespace-only codes return "" (callers map that to Uncoded).
 */
export function classificationGroup(code: string, depth = 2): string {
  const segs = classificationSegments(code);
  if (!segs.length) return "";
  const d = Math.max(1, Math.floor(depth));
  return segs[Math.min(d, segs.length) - 1] ?? segs[segs.length - 1];
}

/* ═════════════════════════════════════════════════════════════════════════
   Element resolution
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * The element's first classification assignment that survives validation
 * against the system tables. Assignments arrive pre-sorted by
 * (elementId, systemId, code) — the same order the classification module
 * persists — so "first" is deterministic: alphabetically-first system,
 * then alphabetically-first code. Unknown systems and codes are skipped;
 * returns null when the element carries no usable assignment.
 */
export function resolveElementClassification(
  elementId: string,
  assignments: ReadonlyArray<ScheduleAssignmentLike>,
  systems: ReadonlyArray<ScheduleSystemLike>,
): ResolvedClassification | null {
  const eid = String(elementId ?? "");
  if (!eid) return null;

  const sysById = new Map<string, ScheduleSystemLike>();
  for (const s of systems ?? []) {
    if (s && typeof s.id === "string" && s.id) sysById.set(s.id, s);
  }

  for (const a of assignments ?? []) {
    if (!a || typeof a !== "object") continue;
    if (a.elementId !== eid) continue;
    const sys = sysById.get(a.systemId);
    if (!sys) continue;
    const code = String(a.code ?? "").trim();
    if (!code) continue;
    const hit = (sys.codes ?? []).find((c) => c && c.code === code);
    if (!hit) continue;
    return {
      systemId: sys.id,
      systemName: String(sys.name ?? sys.id),
      code,
      title: String(hit.title ?? ""),
    };
  }
  return null;
}

/**
 * The three schedule row values for one element: the assigned code, its
 * published title, and the system display name. Empty strings when the
 * element is uncoded — schedules render those groups as "Uncoded".
 */
export function classificationRowValues(
  elementId: string,
  assignments: ReadonlyArray<ScheduleAssignmentLike>,
  systems: ReadonlyArray<ScheduleSystemLike>,
): { classification: string; classificationTitle: string; classificationSystem: string } {
  const r = resolveElementClassification(elementId, assignments, systems);
  if (!r) return { classification: "", classificationTitle: "", classificationSystem: "" };
  return {
    classification: r.code,
    classificationTitle: r.title,
    classificationSystem: r.systemName,
  };
}
