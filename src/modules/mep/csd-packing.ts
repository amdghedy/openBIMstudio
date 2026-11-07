/**
 * Knowledge-Based BIM deterministic CSD cross-section packing foundation.
 * Pure TypeScript domain engine. All dimensions are metres.
 * This is bounded deterministic search, not a global-optimality claim.
 */

export interface CsdPoint2 { x: number; y: number }
export interface CsdSectionBoundary { width: number; height: number }

export interface CsdServiceItem {
  id: string;
  system: string;
  width: number;
  height: number;
  clearance?: number;
  /** Per-peer minimum clearances in metres, keyed by the other service item ID. */
  pairClearances?: Record<string, number>;
  edgeClearance?: number;
  preferred?: CsdPoint2;
  fixed?: CsdPoint2;
  rotatable?: boolean;
  priority?: number;
}

export type CsdRelationship =
  | { kind: "left-of" | "right-of" | "above" | "below"; fromId: string; toId: string; gap?: number }
  | { kind: "same-center-x" | "same-center-y"; fromId: string; toId: string; tolerance?: number };

export interface CsdObjectiveWeights {
  preference: number;
  compactness: number;
  verticalPreference: number;
}
export interface CsdPackingOptions {
  gridSize?: number;
  maxNodes?: number;
  maxCandidatesPerItem?: number;
  maxSolutions?: number;
  allowRotation?: boolean;
  verticalPreference?: "top" | "bottom" | "none";
  objectiveWeights?: Partial<CsdObjectiveWeights>;
}
export interface CsdPlacement {
  id: string; system: string; x: number; y: number;
  width: number; height: number; rotated: boolean;
}
export interface CsdPackingMetrics {
  occupiedArea: number; envelopeArea: number; utilization: number;
  preferenceDistance: number; normalizedPreferenceDistance: number;
  compactness: number; verticalPenalty: number; score: number;
}
export interface CsdPackingCandidate {
  id: string; placements: CsdPlacement[]; metrics: CsdPackingMetrics; compliant: true;
}
export type CsdPackingStatus = "solved" | "partial" | "infeasible" | "invalid-input";
export interface CsdPackingResult {
  status: CsdPackingStatus;
  candidates: CsdPackingCandidate[];
  exploredNodes: number;
  searchComplete: boolean;
  diagnostics: string[];
}

export interface CsdPackingRequest {
  boundary: CsdSectionBoundary;
  items: CsdServiceItem[];
  relationships?: CsdRelationship[];
  options?: CsdPackingOptions;
}

const EPS = 1e-9;
const DEFAULT_WEIGHTS: CsdObjectiveWeights = { preference: 1, compactness: 1, verticalPreference: 0.05 };
const positive = (v: number) => Number.isFinite(v) && v > 0;
const keyNumber = (v: number) => (Math.round(v * 1e8) / 1e8).toFixed(8);
function solutionKey(ps: CsdPlacement[]): string {
  return ps.slice().sort((a, b) => a.id.localeCompare(b.id))
    .map(p => p.id + ":" + keyNumber(p.x) + ":" + keyNumber(p.y) + ":" + (p.rotated ? "1" : "0")).join("|");
}
function withinBoundary(p: CsdPlacement, item: CsdServiceItem, boundary: CsdSectionBoundary): boolean {
  const edge = Math.max(0, item.edgeClearance ?? 0);
  return p.x >= edge - EPS && p.y >= edge - EPS &&
    p.x + p.width <= boundary.width - edge + EPS &&
    p.y + p.height <= boundary.height - edge + EPS;
}
function pairClearance(a: CsdServiceItem, b: CsdServiceItem): number {
  return Math.max(0, a.clearance ?? 0, b.clearance ?? 0,
    a.pairClearances?.[b.id] ?? 0, b.pairClearances?.[a.id] ?? 0);
}
function respectsPairClearance(a: CsdPlacement, ia: CsdServiceItem, b: CsdPlacement, ib: CsdServiceItem): boolean {
  const gap = pairClearance(ia, ib);
  return a.x + a.width + gap <= b.x + EPS ||
    b.x + b.width + gap <= a.x + EPS ||
    a.y + a.height + gap <= b.y + EPS ||
    b.y + b.height + gap <= a.y + EPS;
}
function relationshipSatisfied(r: CsdRelationship, placed: Map<string, CsdPlacement>): boolean {
  const a = placed.get(r.fromId), b = placed.get(r.toId);
  if (!a || !b) return true;
  switch (r.kind) {
    case "left-of": return a.x + a.width + Math.max(0, r.gap ?? 0) <= b.x + EPS;
    case "right-of": return b.x + b.width + Math.max(0, r.gap ?? 0) <= a.x + EPS;
    case "above": return b.y + b.height + Math.max(0, r.gap ?? 0) <= a.y + EPS;
    case "below": return a.y + a.height + Math.max(0, r.gap ?? 0) <= b.y + EPS;
    case "same-center-x": return Math.abs(a.x + a.width / 2 - b.x - b.width / 2) <= Math.max(0, r.tolerance ?? 0.001) + EPS;
    case "same-center-y": return Math.abs(a.y + a.height / 2 - b.y - b.height / 2) <= Math.max(0, r.tolerance ?? 0.001) + EPS;
  }
}
function axisPositions(min: number, max: number, grid: number, contacts: number[], fixed?: number): number[] {
  if (fixed !== undefined) return [fixed];
  const values = new Set<number>([min, max]);
  for (let v = min + grid; v < max - EPS; v += grid) values.add(v);
  for (const v of contacts) if (v >= min - EPS && v <= max + EPS) values.add(Math.min(max, Math.max(min, v)));
  return [...values].sort((a, b) => a - b);
}
function calculateMetrics(
  placements: CsdPlacement[], items: CsdServiceItem[], boundary: CsdSectionBoundary,
  weights: CsdObjectiveWeights, verticalPreference: "top" | "bottom" | "none",
): CsdPackingMetrics {
  const itemById = new Map(items.map(i => [i.id, i]));
  const occupiedArea = placements.reduce((s, p) => s + p.width * p.height, 0);
  const minX = Math.min(...placements.map(p => p.x));
  const minY = Math.min(...placements.map(p => p.y));
  const maxX = Math.max(...placements.map(p => p.x + p.width));
  const maxY = Math.max(...placements.map(p => p.y + p.height));
  const envelopeArea = Math.max(0, (maxX - minX) * (maxY - minY));
  const preferenceDistance = placements.reduce((s, p) => {
    const pref = itemById.get(p.id)?.preferred;
    return s + (pref ? Math.hypot(p.x - pref.x, p.y - pref.y) : 0);
  }, 0);
  const diagonal = Math.hypot(boundary.width, boundary.height) || 1;
  const normalizedPreferenceDistance = preferenceDistance / (Math.max(1, placements.length) * diagonal);
  const compactness = envelopeArea / (boundary.width * boundary.height);
  const verticalPenalty = verticalPreference === "none" ? 0 : placements.reduce((s, p) => {
    const d = verticalPreference === "top" ? boundary.height - p.y - p.height : p.y;
    return s + d / (Math.max(1, placements.length) * boundary.height);
  }, 0);
  const score = weights.preference * normalizedPreferenceDistance +
    weights.compactness * compactness + weights.verticalPreference * verticalPenalty;
  return { occupiedArea, envelopeArea, utilization: envelopeArea > EPS ? occupiedArea / envelopeArea : 1,
    preferenceDistance, normalizedPreferenceDistance, compactness, verticalPenalty, score };
}

/**
 * Generate ranked 2D cross-section arrangements.
 * Returned candidates satisfy every supplied hard geometric relationship.
 * searchComplete=false means a configured search/candidate bound was reached.
 */
export function optimizeCsdPacking(request: CsdPackingRequest): CsdPackingResult {
  const invalid = (message: string): CsdPackingResult => ({
    status: "invalid-input", candidates: [], exploredNodes: 0, searchComplete: true, diagnostics: [message],
  });
  const boundary = request?.boundary;
  const items = request?.items;
  const relationships = request?.relationships ?? [];
  const options = request?.options ?? {};
  if (!boundary || !positive(boundary.width) || !positive(boundary.height))
    return invalid("Section boundary width and height must be finite positive metre values.");
  if (!Array.isArray(items)) return invalid("Items must be an array.");
  const ids = new Set<string>();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim()) return invalid("Every service item requires a non-empty ID.");
    if (ids.has(item.id)) return invalid("Duplicate service item ID: " + item.id);
    ids.add(item.id);
    if (!positive(item.width) || !positive(item.height)) return invalid("Item " + item.id + " must have finite positive dimensions in metres.");
    if (!Number.isFinite(item.clearance ?? 0) || (item.clearance ?? 0) < 0 ||
        !Number.isFinite(item.edgeClearance ?? 0) || (item.edgeClearance ?? 0) < 0)
      return invalid("Item " + item.id + " has an invalid clearance.");
    if (item.pairClearances && Object.entries(item.pairClearances).some(([peerId, value]) =>
        !peerId || peerId === item.id || !Number.isFinite(value) || value < 0))
      return invalid("Item " + item.id + " has an invalid peer-specific clearance.");
    if (item.fixed && (!Number.isFinite(item.fixed.x) || !Number.isFinite(item.fixed.y))) return invalid("Item " + item.id + " has an invalid fixed position.");
    if (item.preferred && (!Number.isFinite(item.preferred.x) || !Number.isFinite(item.preferred.y))) return invalid("Item " + item.id + " has an invalid preferred position.");
  }
  for (const r of relationships) {
    if (!ids.has(r.fromId) || !ids.has(r.toId) || r.fromId === r.toId)
      return invalid("Relationship " + r.kind + " references a missing or identical item ID.");
    if (("gap" in r && (r.gap ?? 0) < 0) || ("tolerance" in r && (r.tolerance ?? 0) < 0))
      return invalid("Relationship gap and tolerance values cannot be negative.");
  }
  if (items.length === 0) return {
    status: "solved",
    candidates: [{ id: "csd-0001", placements: [], compliant: true,
      metrics: { occupiedArea: 0, envelopeArea: 0, utilization: 1, preferenceDistance: 0,
        normalizedPreferenceDistance: 0, compactness: 0, verticalPenalty: 0, score: 0 } }],
    exploredNodes: 1, searchComplete: true, diagnostics: ["No MEP items supplied; returned an empty valid arrangement."],
  };

  const grid = options.gridSize ?? 0.1;
  const maxNodes = Math.floor(options.maxNodes ?? 30000);
  const maxCandidates = Math.floor(options.maxCandidatesPerItem ?? 1200);
  const maxSolutions = Math.floor(options.maxSolutions ?? 20);
  if (!positive(grid) || !Number.isFinite(maxNodes) || maxNodes < 1 ||
      !Number.isFinite(maxCandidates) || maxCandidates < 1 ||
      !Number.isFinite(maxSolutions) || maxSolutions < 1)
    return invalid("Grid size and search limits must be finite positive values.");
  const weights: CsdObjectiveWeights = {
    preference: options.objectiveWeights?.preference ?? DEFAULT_WEIGHTS.preference,
    compactness: options.objectiveWeights?.compactness ?? DEFAULT_WEIGHTS.compactness,
    verticalPreference: options.objectiveWeights?.verticalPreference ?? DEFAULT_WEIGHTS.verticalPreference,
  };
  if (Object.values(weights).some(v => !Number.isFinite(v) || v < 0))
    return invalid("Objective weights must be finite non-negative numbers.");

  const ordered = items.slice().sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) ||
    b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
  const itemById = new Map(items.map(i => [i.id, i]));
  const placed = new Map<string, CsdPlacement>();
  const solutions: CsdPackingCandidate[] = [];
  const seen = new Set<string>();
  let exploredNodes = 0, limitReached = false, candidatesPruned = false;

  const record = () => {
    const placements = [...placed.values()].sort((a, b) => a.id.localeCompare(b.id));
    const key = solutionKey(placements);
    if (seen.has(key)) return;
    seen.add(key);
    solutions.push({ id: "pending", placements, compliant: true,
      metrics: calculateMetrics(placements, items, boundary, weights, options.verticalPreference ?? "none") });
    solutions.sort((a, b) => a.metrics.score - b.metrics.score ||
      solutionKey(a.placements).localeCompare(solutionKey(b.placements)));
    if (solutions.length > maxSolutions) solutions.length = maxSolutions;
  };
  const rulesPass = () => relationships.every(r => relationshipSatisfied(r, placed));

  const visit = (index: number): void => {
    if (exploredNodes >= maxNodes) { limitReached = true; return; }
    if (index >= ordered.length) { exploredNodes++; record(); return; }
    const item = ordered[index];
    const shapes = item.rotatable && options.allowRotation !== false && !item.fixed
      ? [{ width: item.width, height: item.height, rotated: false }, { width: item.height, height: item.width, rotated: true }]
      : [{ width: item.width, height: item.height, rotated: false }];
    for (const shape of shapes) {
      const edge = Math.max(0, item.edgeClearance ?? 0);
      const maxX = boundary.width - shape.width - edge;
      const maxY = boundary.height - shape.height - edge;
      if (maxX < -EPS || maxY < -EPS) continue;
      const xContacts: number[] = [], yContacts: number[] = [];
      for (const other of placed.values()) {
        const otherItem = itemById.get(other.id)!;
        const gap = pairClearance(item, otherItem);
        xContacts.push(other.x + other.width + gap, other.x - shape.width - gap);
        yContacts.push(other.y + other.height + gap, other.y - shape.height - gap);
      }
      const xs = axisPositions(edge, maxX, grid, xContacts, item.fixed?.x);
      const ys = axisPositions(edge, maxY, grid, yContacts, item.fixed?.y);
      const positions: CsdPoint2[] = [];
      for (const y of ys) for (const x of xs) positions.push({ x, y });
      positions.sort((a, b) => {
        const pref = item.preferred;
        const da = pref ? Math.hypot(a.x - pref.x, a.y - pref.y) : 0;
        const db = pref ? Math.hypot(b.x - pref.x, b.y - pref.y) : 0;
        if (da !== db) return da - db;
        if (options.verticalPreference === "top" && a.y !== b.y) return b.y - a.y;
        if (options.verticalPreference === "bottom" && a.y !== b.y) return a.y - b.y;
        return a.y - b.y || a.x - b.x;
      });
      if (positions.length > maxCandidates) { positions.length = maxCandidates; candidatesPruned = true; }
      for (const point of positions) {
        if (exploredNodes >= maxNodes) { limitReached = true; return; }
        exploredNodes++;
        const p: CsdPlacement = { id: item.id, system: item.system, x: point.x, y: point.y,
          width: shape.width, height: shape.height, rotated: shape.rotated };
        if (!withinBoundary(p, item, boundary)) continue;
        let valid = true;
        for (const other of placed.values()) {
          if (!respectsPairClearance(p, item, other, itemById.get(other.id)!)) { valid = false; break; }
        }
        if (!valid) continue;
        placed.set(item.id, p);
        if (rulesPass()) visit(index + 1);
        placed.delete(item.id);
        if (limitReached) return;
      }
    }
  };

  visit(0);
  solutions.forEach((s, i) => { s.id = "csd-" + String(i + 1).padStart(4, "0"); });
  const searchComplete = !limitReached && !candidatesPruned;
  const diagnostics: string[] = [];
  if (limitReached) diagnostics.push("Search stopped at node limit " + maxNodes + "; returned candidates are best-found, not a global-optimality proof.");
  if (candidatesPruned) diagnostics.push("Candidate positions were capped at " + maxCandidates + " per item; search completeness is not guaranteed.");
  if (!solutions.length && searchComplete) diagnostics.push("No arrangement satisfies the supplied boundary, clearances and hard relationships.");
  if (solutions.length && !searchComplete) diagnostics.push("Compliant arrangements were found, but bounded search did not prove all alternatives were explored.");
  return { status: solutions.length ? (searchComplete ? "solved" : "partial") : (searchComplete ? "infeasible" : "partial"),
    candidates: solutions, exploredNodes, searchComplete, diagnostics };
}
