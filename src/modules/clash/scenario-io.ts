/**
 * Clash scenario (named test) serialization + clash matrix.
 *
 * DOM-free on purpose: the Node suite compiles and requires this file
 * directly, so the exact serialization the browser ships is what the tests
 * pin. No THREE, no window, no document in here.
 *
 * A scenario is the Clash-Detective-style named test: A/B selection keys,
 * method, tolerances, scope, crop margin, and the per-clash review state
 * snapshot it was saved with. Scenarios used to live only in localStorage,
 * so a project opened on another machine (or with a cleared profile) lost
 * every saved test. They are now serialized into the project document;
 * localStorage stays as the live working copy.
 */

/** Mirrors the ClashScenario shape in src/features/clash.ts, without DOM deps. */
export interface ScenarioComment {
  id: string;
  author: string;
  date: number;
  text: string;
}

export interface ScenarioStateSnapshot {
  status: string;
  comments: ScenarioComment[];
  assignee?: string;
  updatedAt: number;
}

export interface ScenarioRunSummary {
  total: number;
  intersect: number;
  touching: number;
  clearance: number;
  duplicate: number;
  at: number;
}

export interface ScenarioRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  testName: string;
  tolerance: number;
  clearance: number;
  cropMargin: number;
  scope?: string;
  method?: string;
  selectionA: string[];
  selectionB: string[];
  clashStates?: Record<string, ScenarioStateSnapshot>;
  lastRun?: ScenarioRunSummary;
}

const KNOWN_STATUSES = new Set([
  "new",
  "active",
  "reviewed",
  "approved",
  "resolved",
]);
const KNOWN_KINDS = new Set([
  "intersect",
  "touching",
  "clearance",
  "duplicate",
]);

const MAX_SCENARIOS = 200;
const MAX_SELECTION_KEYS = 500;
const MAX_STATES = 5000;
const MAX_COMMENTS = 200;
const MAX_TEXT = 2000;
const MAX_ID = 80;
const MAX_NAME = 120;

/* ── scalar coercion helpers ─────────────────────────────────────────── */

function toId(v: unknown, fallback: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return fallback;
  return s.slice(0, MAX_ID);
}

function toText(v: unknown, cap: number): string {
  return typeof v === "string" ? v.slice(0, cap) : "";
}

function toCount(v: unknown, fallback: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  if (n < 0) return 0;
  return n > max ? max : n;
}

function toEpoch(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  return n;
}

function toSelection(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const k = raw.slice(0, MAX_ID * 4);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_SELECTION_KEYS) break;
  }
  return out;
}

function toStateSnapshot(v: unknown): ScenarioStateSnapshot | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const status =
    typeof o.status === "string" && KNOWN_STATUSES.has(o.status)
      ? o.status
      : "new";
  const comments: ScenarioComment[] = [];
  if (Array.isArray(o.comments)) {
    for (const raw of o.comments) {
      if (typeof raw !== "object" || raw === null) continue;
      const c = raw as Record<string, unknown>;
      const text = toText(c.text, MAX_TEXT);
      if (!text) continue;
      comments.push({
        id: toId(c.id, `c-${comments.length + 1}`),
        author: toText(c.author, MAX_NAME),
        date: toEpoch(c.date),
        text,
      });
      if (comments.length >= MAX_COMMENTS) break;
    }
  }
  const snap: ScenarioStateSnapshot = {
    status,
    comments,
    updatedAt: toEpoch(o.updatedAt),
  };
  const assignee = toText(o.assignee, MAX_NAME);
  if (assignee) snap.assignee = assignee;
  return snap;
}

function toStatesMap(v: unknown): Record<string, ScenarioStateSnapshot> | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const out: Record<string, ScenarioStateSnapshot> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(o)) {
    const snap = toStateSnapshot(raw);
    if (!snap) continue;
    out[key.slice(0, 200)] = snap;
    if (++kept >= MAX_STATES) break;
  }
  return kept ? out : undefined;
}

function toRunSummary(v: unknown): ScenarioRunSummary | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const total = toCount(o.total, 0, 1_000_000);
  const intersect = toCount(o.intersect, 0, total);
  const touching = toCount(o.touching, 0, total);
  const clearance = toCount(o.clearance, 0, total);
  const duplicate = toCount(o.duplicate, 0, total);
  const at = toEpoch(o.at);
  if (!total && !intersect && !touching && !clearance && !duplicate && !at) {
    return undefined;
  }
  return { total, intersect, touching, clearance, duplicate, at };
}

function toScope(v: unknown): string | undefined {
  const s = typeof v === "string" ? v : "";
  return ["all", "viewport", "aOnly", "bOnly", "both"].includes(s) ? s : undefined;
}

/* ── public: normalize + cap a scenario list ─────────────────────────── */

/**
 * Normalize an unknown payload (the project document's `clashScenarios`
 * array, or anything else a hand-edited JSON might contain) into a clean
 * ScenarioRecord list. Malformed rows are dropped, individual fields are
 * coerced and capped; never throws.
 */
export function parseScenarios(raw: unknown): ScenarioRecord[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const inner = (raw as Record<string, unknown>).clashScenarios;
    if (Array.isArray(inner)) list = inner;
  }
  const out: ScenarioRecord[] = [];
  const ids = new Set<string>();
  for (const row of list) {
    if (typeof row !== "object" || row === null) continue;
    const o = row as Record<string, unknown>;
    const id = toId(o.id, "");
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const rec: ScenarioRecord = {
      id,
      name: toText(o.name, MAX_NAME) || "Scenario",
      createdAt: toEpoch(o.createdAt),
      updatedAt: toEpoch(o.updatedAt),
      testName: toText(o.testName, MAX_NAME) || "Test 1",
      tolerance: toCount(o.tolerance, 0, 1e6),
      clearance: toCount(o.clearance, 0, 1e6),
      cropMargin: toCount(o.cropMargin, 0.3, 10),
      selectionA: toSelection(o.selectionA),
      selectionB: toSelection(o.selectionB),
    };
    const scope = toScope(o.scope);
    if (scope) rec.scope = scope;
    const method =
      typeof o.method === "string" && o.method.length <= 32 ? o.method : undefined;
    if (method) rec.method = method;
    const states = toStatesMap(o.clashStates);
    if (states) rec.clashStates = states;
    const lastRun = toRunSummary(o.lastRun);
    if (lastRun) rec.lastRun = lastRun;
    out.push(rec);
    if (out.length >= MAX_SCENARIOS) break;
  }
  return out;
}

/**
 * Validate + cap a scenario list before it is written into the project
 * payload. Same coercion as parseScenarios — the writer and the reader
 * share one dialect, so what we save is exactly what we restore.
 */
export function serializeScenarios(raw: unknown): ScenarioRecord[] {
  return parseScenarios(raw);
}

/* ── public: run summary over minimal clash-like rows ────────────────── */

export interface ClashLikeRow {
  kind: string;
}

/** Total + per-kind counts over clash rows; unknown kinds keep their own bucket. */
export function summarizeRun(
  rows: readonly ClashLikeRow[],
): { total: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    if (!r || typeof r.kind !== "string") continue;
    const k = KNOWN_KINDS.has(r.kind) ? r.kind : r.kind.slice(0, 32) || "other";
    byKind[k] = (byKind[k] ?? 0) + 1;
    total++;
  }
  return { total, byKind };
}

/* ── public: clash matrix (category × category counts) ───────────────── */

export interface ClashMatrixRow {
  a: string;
  b: string;
  count: number;
}

export interface ClashMatrix {
  /** Sorted unique categories actually involved in clashes. */
  categories: string[];
  /** Upper-triangle pairs (a ≤ b lexicographically) with counts, sorted. */
  cells: ClashMatrixRow[];
  /** Number of clash rows the matrix was built from. */
  total: number;
}

/**
 * Category × category clash counts, order-normalized: a duct hitting a wall
 * contributes to the same {Wall, Duct} cell as a wall hitting a duct.
 * Same-category pairs (a wall on a wall) land on the diagonal as one cell.
 */
export function buildClashMatrix(
  rows: readonly { a: { category?: string }; b: { category?: string } }[],
): ClashMatrix {
  const cats = new Set<string>();
  const pairCount = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const a = typeof r.a?.category === "string" && r.a.category ? r.a.category : "Uncategorized";
    const b = typeof r.b?.category === "string" && r.b.category ? r.b.category : "Uncategorized";
    cats.add(a);
    cats.add(b);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const key = `${lo}\u0000${hi}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    total++;
  }
  const categories = [...cats].sort((x, y) => x.localeCompare(y));
  const cells = [...pairCount.entries()]
    .map(([k, count]) => {
      const [a, b] = k.split("\u0000");
      return { a, b, count };
    })
    .sort((x, y) => (x.a === y.a ? x.b.localeCompare(y.b) : x.a.localeCompare(y.a)));
  return { categories, cells, total };
}
