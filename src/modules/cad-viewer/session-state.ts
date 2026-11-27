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
  /** Grid snap (F9 / SNAP) — a separate master from the OSNAP master above. */
  gridSnapOn?: boolean;
  orthoOn?: boolean;
  polarOn?: boolean;
  polarAngle?: number;
  otrackOn?: boolean;
  dynOn?: boolean;
  lwtOn?: boolean;
  /** Annotation scale factor (2D-30, CANNOSCALE): text, leaders and dimension arrowheads render at this scale. 1 = no scaling. */
  annoScale?: number;
  showGrid?: boolean;
  showText?: boolean;
  showHatch?: boolean;
  showLt?: boolean;
  snapModes?: string[];
  typeFilter?: string[];
  /**
   * FILTER property filter (2D-15 condition tree, raw JSON; validated
   * semantically by cad-selection-a18 at restore). A pre-2D-15 flat
   * criteria array is converted to an AND group at sanitize time.
   */
  propFilter?: SessionFilterNode;
  currentLayer?: string;
  lockedLayers?: string[];
}

/** One FILTER criterion as stored. */
export interface SessionFilterCriterion { property: string; operator: string; value: string; }

/** One node of a FILTER condition tree as stored (2D-15). */
export type SessionFilterNode =
  | { kind: "criterion"; criterion: SessionFilterCriterion }
  | { kind: "group"; operator: "AND" | "OR"; children: SessionFilterNode[] };

const MAX_SESSION_FILTER_DEPTH = 4;
const MAX_SESSION_FILTER_CRITERIA = 20;

const isSessionCriterion = (x: unknown): x is SessionFilterCriterion => {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.property === "string" && o.property.length > 0 && o.property.length <= 200 &&
    typeof o.operator === "string" && o.operator.length > 0 && o.operator.length <= 20 &&
    typeof o.value === "string" && o.value.length > 0 && o.value.length <= 200;
};

/**
 * Structural clean-up of a stored FILTER tree (raw JSON from an older app
 * version, hand-edited, or corrupted): keeps only well-shaped nodes,
 * drops bad leaves, caps depth and leaf count, flattens one-child groups.
 * A legacy flat criteria array becomes an AND group. Returns undefined
 * when nothing usable survives. Semantic validation (does the property
 * exist, does the value parse) happens in cad-selection-a18 at restore.
 */
export function sanitizeSessionFilterTree(raw: unknown, depth = 0, budget: { leaves: number } = { leaves: 0 }): SessionFilterNode | undefined {
  if (depth > MAX_SESSION_FILTER_DEPTH) return undefined;
  if (Array.isArray(raw)) {
    const clean = raw.filter(isSessionCriterion).slice(0, MAX_SESSION_FILTER_CRITERIA)
      .map((x) => ({ property: x.property, operator: x.operator, value: x.value }));
    if (clean.length === 0) return undefined;
    if (clean.length === 1) return { kind: "criterion", criterion: clean[0] };
    return { kind: "group", operator: "AND", children: clean.map((criterion) => ({ kind: "criterion", criterion }) as SessionFilterNode) };
  }
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind === "criterion") {
    if (budget.leaves >= MAX_SESSION_FILTER_CRITERIA) return undefined;
    if (!isSessionCriterion(r.criterion)) return undefined;
    budget.leaves++;
    const c = r.criterion as SessionFilterCriterion;
    return { kind: "criterion", criterion: { property: c.property, operator: c.operator, value: c.value } };
  }
  if (r.kind === "group") {
    if (r.operator !== "AND" && r.operator !== "OR") return undefined;
    if (!Array.isArray(r.children)) return undefined;
    const children: SessionFilterNode[] = [];
    for (const child of r.children) {
      const n = sanitizeSessionFilterTree(child, depth + 1, budget);
      if (n) children.push(n);
    }
    if (children.length === 0) return undefined;
    if (children.length === 1) return children[0];
    return { kind: "group", operator: r.operator, children };
  }
  return undefined;
}

const BOOLS = ["snapOn", "gridSnapOn", "orthoOn", "polarOn", "otrackOn", "dynOn", "lwtOn", "showGrid", "showText", "showHatch", "showLt"] as const;
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
  if (typeof r.annoScale === "number" && Number.isFinite(r.annoScale) && r.annoScale > 0 && r.annoScale <= 10000) out.annoScale = r.annoScale;
  const sm = strArr(r.snapModes, 40); if (sm) out.snapModes = sm.filter((k) => snapKinds.includes(k));
  const tf = strArr(r.typeFilter, 60); if (tf) out.typeFilter = tf;
  if (r.propFilter !== undefined) {
    const tree = sanitizeSessionFilterTree(r.propFilter);
    if (tree) out.propFilter = tree;
  }
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
