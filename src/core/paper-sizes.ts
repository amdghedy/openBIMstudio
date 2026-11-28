/**
 * Paper sizes — the single registry for sheets, CAD layouts, plotting and region defaults.
 *
 * Sizes are exact: ANSI/ARCH sheets are defined in inches (×25.4), ISO in millimetres. `w` is always the long edge, so a
 * landscape page is w × h and a portrait page h × w.
 */
export type PaperFamily = "iso" | "ansi" | "arch";

export interface PaperDef { id: PaperId; label: string; family: PaperFamily; w: number; h: number; aliases?: string[] }

const IN = 25.4;
/** Round to a micron so 36 × 25.4 is 914.4, not 914.4000000000001. */
const mm = (v: number): number => Math.round(v * 1e6) / 1e6;
const defs = <T extends string>(rows: Array<[T, string, PaperFamily, number, number, string[]?]>): Array<PaperDef & { id: T }> =>
  rows.map(([id, label, family, w, h, aliases]) => ({ id, label, family, w: mm(w), h: mm(h), ...(aliases ? { aliases } : {}) } as PaperDef & { id: T }));

export type PaperId =
  | "A0" | "A1" | "A2" | "A3" | "A4"
  | "ANSI-A" | "ANSI-B" | "ANSI-C" | "ANSI-D" | "ANSI-E"
  | "Arch-A" | "Arch-B" | "Arch-C" | "Arch-D" | "Arch-E" | "Arch-E1"
  | "Legal";

export const PAPER_SIZES: readonly PaperDef[] = defs<PaperId>([
  ["A0", "A0 (841 × 1189 mm)", "iso", 1189, 841],
  ["A1", "A1 (594 × 841 mm)", "iso", 841, 594],
  ["A2", "A2 (420 × 594 mm)", "iso", 594, 420],
  ["A3", "A3 (297 × 420 mm)", "iso", 420, 297],
  ["A4", "A4 (210 × 297 mm)", "iso", 297, 210],
  ["ANSI-A", "ANSI A / Letter (8.5 × 11 in)", "ansi", 11 * IN, 8.5 * IN, ["Letter"]],
  ["ANSI-B", "ANSI B / Tabloid (11 × 17 in)", "ansi", 17 * IN, 11 * IN, ["Tabloid", "Ledger"]],
  ["ANSI-C", "ANSI C (17 × 22 in)", "ansi", 22 * IN, 17 * IN],
  ["ANSI-D", "ANSI D (22 × 34 in)", "ansi", 34 * IN, 22 * IN],
  ["ANSI-E", "ANSI E (34 × 44 in)", "ansi", 44 * IN, 34 * IN],
  ["Arch-A", "Arch A (9 × 12 in)", "arch", 12 * IN, 9 * IN],
  ["Arch-B", "Arch B (12 × 18 in)", "arch", 18 * IN, 12 * IN],
  ["Arch-C", "Arch C (18 × 24 in)", "arch", 24 * IN, 18 * IN],
  ["Arch-D", "Arch D (24 × 36 in)", "arch", 36 * IN, 24 * IN],
  ["Arch-E", "Arch E (36 × 48 in)", "arch", 48 * IN, 36 * IN],
  ["Arch-E1", "Arch E1 (30 × 42 in)", "arch", 42 * IN, 30 * IN],
  ["Legal", "Legal (8.5 × 14 in)", "ansi", 14 * IN, 8.5 * IN],
]);

const BY_KEY = new Map<string, PaperDef>();
for (const p of PAPER_SIZES) { BY_KEY.set(p.id.toLowerCase(), p); for (const a of p.aliases ?? []) BY_KEY.set(a.toLowerCase(), p); }
// Region/legacy spellings.
BY_KEY.set("arch-e1", BY_KEY.get("arch-e1")!);

/** Resolve an id, alias (Letter, Tabloid) or legacy spelling (ARCH-E1) — case-insensitive. Undefined when unknown. */
export function paperDef(id: string | undefined | null): PaperDef | undefined {
  return typeof id === "string" ? BY_KEY.get(id.trim().toLowerCase()) : undefined;
}

export const isPaperId = (id: unknown): id is PaperId => typeof id === "string" && PAPER_SIZES.some((p) => p.id === id);

/** Canonical id, falling back to `fallback` for anything unknown. */
export function normalizePaperId(id: string | undefined | null, fallback: PaperId = "A3"): PaperId {
  return paperDef(id)?.id ?? fallback;
}

/** Page size in mm for a paper id and orientation (unknown ids use `fallback`). */
export function paperSizeMm(id: string, orientation: "landscape" | "portrait", fallback: PaperId = "A3"): { w: number; h: number } {
  const p = paperDef(id) ?? paperDef(fallback)!;
  return orientation === "portrait" ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/** Closest standard paper to a width × height in mm (either orientation) within `tolMm`, else null. */
export function paperIdForMm(w: number, h: number, tolMm = 0.6): PaperId | null {
  for (const p of PAPER_SIZES) {
    if ((Math.abs(w - p.w) < tolMm && Math.abs(h - p.h) < tolMm) || (Math.abs(w - p.h) < tolMm && Math.abs(h - p.w) < tolMm)) return p.id;
  }
  return null;
}
