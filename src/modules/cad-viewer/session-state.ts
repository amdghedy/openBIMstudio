/**
 * Working settings remembered per drawing between sessions (on top of view, layout and layer visibility).
 * Pure and defensive: whatever is in storage (older app version, hand-edited, corrupted) is validated field by field,
 * so a bad value can only be ignored, never break opening a drawing.
 */
export type SessionColorMode = "layer" | "bw" | "invert" | "style";

export interface SessionUi {
  bg?: string;
  cmode?: SessionColorMode;
  snapOn?: boolean;
  orthoOn?: boolean;
  polarOn?: boolean;
  polarAngle?: number;
  otrackOn?: boolean;
  dynOn?: boolean;
  lwtOn?: boolean;
  showGrid?: boolean;
  showText?: boolean;
  showHatch?: boolean;
  showLt?: boolean;
  snapModes?: string[];
  typeFilter?: string[];
  currentLayer?: string;
  lockedLayers?: string[];
}

const BOOLS = ["snapOn", "orthoOn", "polarOn", "otrackOn", "dynOn", "lwtOn", "showGrid", "showText", "showHatch", "showLt"] as const;
const MODES: SessionColorMode[] = ["layer", "bw", "invert", "style"];
const strArr = (v: unknown, max: number, maxLen = 200): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= maxLen).slice(0, max) : undefined;

/**
 * @param bgOptions background names the app offers (anything else is dropped)
 * @param snapKinds snap kinds the app knows (unknown ones are dropped)
 */
export function sanitizeSessionUi(raw: unknown, bgOptions: readonly string[], snapKinds: readonly string[]): SessionUi {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: SessionUi = {};
  if (typeof r.bg === "string" && bgOptions.includes(r.bg)) out.bg = r.bg;
  if (typeof r.cmode === "string" && (MODES as string[]).includes(r.cmode)) out.cmode = r.cmode as SessionColorMode;
  for (const k of BOOLS) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  if (typeof r.polarAngle === "number" && Number.isFinite(r.polarAngle) && r.polarAngle > 0 && r.polarAngle <= 180) out.polarAngle = r.polarAngle;
  const sm = strArr(r.snapModes, 40); if (sm) out.snapModes = sm.filter((k) => snapKinds.includes(k));
  const tf = strArr(r.typeFilter, 60); if (tf) out.typeFilter = tf;
  if (typeof r.currentLayer === "string" && r.currentLayer.length > 0 && r.currentLayer.length <= 200) out.currentLayer = r.currentLayer;
  const ll = strArr(r.lockedLayers, 5000); if (ll) out.lockedLayers = ll;
  return out;
}

/** Cheap change detector for the periodic auto-save (JSON of a small object). */
export function sessionUiSignature(ui: SessionUi): string {
  return JSON.stringify(ui);
}

/** Objects the user hid one by one, remembered by position in the drawing's entity list. `n` is the list length when saved. */
export interface SessionHiddenEntities { n: number; idx: number[] }

export function hiddenEntityIndexes(entities: readonly unknown[], hidden: ReadonlySet<unknown>, max = 20000): SessionHiddenEntities | undefined {
  if (!hidden.size) return undefined;
  const idx: number[] = [];
  for (let i = 0; i < entities.length && idx.length < max; i++) if (hidden.has(entities[i])) idx.push(i);
  return idx.length ? { n: entities.length, idx } : undefined;
}

/** Returns the indexes to hide, or [] when the stored value is malformed or the drawing changed (different entity count). */
export function sanitizeHiddenEntities(raw: unknown, entityCount: number): number[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as { n?: unknown; idx?: unknown };
  if (r.n !== entityCount || !Array.isArray(r.idx)) return [];
  const seen = new Set<number>();
  for (const v of r.idx) if (Number.isInteger(v) && (v as number) >= 0 && (v as number) < entityCount) seen.add(v as number);
  return [...seen];
}
