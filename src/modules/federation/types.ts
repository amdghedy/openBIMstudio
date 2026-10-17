/**
 * Federation types.
 *
 * A Federation is an ordered list of loaded models with:
 *   • a discipline tag (ARC, STR, MEP-M, MEP-E, …)
 *   • a display colour
 *   • a transform override (to fix shared-coordinate drift)
 *   • a priority (affects render order / greying)
 *
 * The federation is persisted with the project; reloading a project restores
 * the federation tree, colours, and transforms.
 */

export type Discipline =
  | "ARC"
  | "STR"
  | "MEP-M"    // mechanical
  | "MEP-E"    // electrical
  | "MEP-P"    // plumbing
  | "MEP-F"    // fire
  | "ELV"      // low voltage / ICT
  | "FAB"      // fabrication
  | "LAND"     // landscape
  | "SITE"
  | "CIVIL"
  | "OTHER";

export const DISCIPLINES: Discipline[] = [
  "ARC", "STR", "MEP-M", "MEP-E", "MEP-P", "MEP-F", "ELV",
  "FAB", "LAND", "SITE", "CIVIL", "OTHER",
];

export const DISCIPLINE_COLORS: Record<Discipline, string> = {
  ARC:      "#cbd5e1",
  STR:      "#8ea3b8",
  "MEP-M":  "#38bdf8",
  "MEP-E":  "#f59e0b",
  "MEP-P":  "#22c55e",
  "MEP-F":  "#ef4444",
  ELV:      "#a855f7",
  FAB:      "#c084fc",
  LAND:     "#84cc16",
  SITE:     "#94a3b8",
  CIVIL:    "#f97316",
  OTHER:    "#6b7280",
};

export const DISCIPLINE_LABELS: Record<Discipline, string> = {
  ARC:      "Architecture",
  STR:      "Structure",
  "MEP-M":  "MEP · Mechanical",
  "MEP-E":  "MEP · Electrical",
  "MEP-P":  "MEP · Plumbing",
  "MEP-F":  "MEP · Fire",
  ELV:      "ELV / ICT",
  FAB:      "Fabrication",
  LAND:     "Landscape",
  SITE:     "Site",
  CIVIL:    "Civil",
  OTHER:    "Other",
};

export interface FederationEntry {
  modelId: string;
  /** Original file name. */
  name: string;
  discipline: Discipline;
  /** Colour override. Falls back to DISCIPLINE_COLORS[discipline]. */
  color?: string;
  /** 4×4 column-major transform. null → identity. */
  transform: number[] | null;
  /** Render priority; higher = drawn last / on top. */
  priority: number;
  /** Layer visibility toggle. */
  visible: boolean;
  /** Transparency: 0 = opaque, 1 = fully transparent. */
  opacity: number;
  /** Optional description shown in the tree. */
  description?: string;
  /** Added timestamp for stable ordering. */
  addedAt: number;
}

export interface FederationState {
  entries: FederationEntry[];
  /** Currently active isolate-set (model IDs). Empty = show all. */
  isolated: string[];
  /** Colour strategy. */
  strategy: "discipline" | "model" | "neutral";
  updatedAt: number;
}

export interface FederationDraft {
  modelId: string;
  name: string;
  discipline?: Discipline;
}