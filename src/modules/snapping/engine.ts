/**
 * Magnetic snapping engine (MASTER PROMPT MODULE 2B.2).
 *
 * Implements the spec's snap candidate pipeline:
 *   QuerySnapCandidates → ClassifySnapReference → EvaluateSnapEligibility
 *   → RankSnapCandidates → ResolveSnapAmbiguity → AcquireSnapCandidate
 *   → MaintainSnapLock / ReleaseSnapCandidate → RenderSnapIndicator
 *   → CreateTemporarySnapConstraint / ValidateSnapConstraint
 *   → ConvertSnapToPersistentRelationship
 *
 * Geometry model (level E, matches the observable Revit contract that the
 * platform needs): geometry providers expose candidate points with a
 * semantic reference class; the engine filters by tool compatibility,
 * measures SCREEN-SPACE distance (spec: d_s = |p_s − q_s|), verifies
 * model-space depth, ranks with a deterministic score, applies hysteresis
 * and tie-breaking, and never persists a snap implicitly (temporary snap
 * ≠ persistent constraint — spec §3.4).
 *
 * Tolerances (spec 5.2): the screen-space snap tolerance is separate from
 * geometric tolerances and is NOT reused for boolean work.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */

import type { RelationshipRecord, RelationshipRegistry, GeometricReference } from "../relationships";

// ── Reference model ──────────────────────────────────────────────────────

export type SnapReferenceKind =
  | "endpoint" | "midpoint" | "center" | "intersection" | "nearest"
  | "edge" | "face" | "centerline" | "perpendicular-foot" | "tangent"
  | "grid" | "level" | "reference-plane" | "wall-core-face" | "wall-finish-face"
  | "column-boundary" | "family-reference" | "connector-origin" | "connector-axis"
  | "work-plane";

export interface Pt2 {
  x: number;
  y: number;
}

export interface SnapCandidateRaw {
  /** Model-space position (metres). */
  position: [number, number, number];
  /** Projected screen position (pixels) — produced by the view layer. */
  screen: Pt2;
  kind: SnapReferenceKind;
  /** Owning element (or datum id for grids/levels/planes). */
  elementId: string;
  /** Named reference where applicable (spec 2.10). */
  referenceName?: string;
  /** Depth along the view direction (metres) for depth verification. */
  depth: number;
  /** Direction for line/axis snaps. */
  direction?: [number, number, number];
}

export type SnapIndicatorGlyph =
  | "endpoint-square" | "midpoint-triangle" | "center-circle" | "intersection-x"
  | "nearest-dot" | "edge-line" | "face-box" | "centerline-dash" | "perp-angle"
  | "tangent-circle" | "grid-line" | "level-line" | "plane-cross"
  | "core-face" | "finish-face" | "column-boundary" | "family-ref" | "connector";

export interface SnapIndicator {
  /** Where to draw (screen px). */
  screen: Pt2;
  modelPosition: [number, number, number];
  glyph: SnapIndicatorGlyph;
  /** Legend text, e.g. "Endpoint", "Wall core face". */
  legend: string;
}

export interface SnapSettings {
  /** Screen-space acquisition tolerance (pixels). */
  screenTolerancePx: number;
  /** Model-space depth window (metres) around the work plane/pointer. */
  depthWindow: number;
  /** Hysteresis factor: a new candidate must beat the locked one by this. */
  hysteresis: number;
  /** Enabled kinds (user settings, spec "candidate filtering"). */
  enabled: Set<SnapReferenceKind>;
  /** Priority overrides (higher wins before distance tie-breaks). */
  priority?: Partial<Record<SnapReferenceKind, number>>;
}

export const DEFAULT_SNAP_SETTINGS: SnapSettings = {
  screenTolerancePx: 20,
  depthWindow: 2.0,
  hysteresis: 1.15,
  enabled: new Set<SnapReferenceKind>([
    "endpoint", "midpoint", "center", "intersection", "nearest", "centerline",
    "grid", "level", "reference-plane", "wall-core-face", "wall-finish-face",
    "column-boundary", "family-reference", "connector-origin", "connector-axis",
    "perpendicular-foot", "work-plane", "edge", "face", "tangent",
  ]),
};

/** Baseline priority per kind (bigger = more preferred, spec "priority"). */
export const BASE_PRIORITY: Record<SnapReferenceKind, number> = {
  endpoint: 100, intersection: 95, midpoint: 90, center: 88,
  "connector-origin": 92, "connector-axis": 80, "column-boundary": 85,
  "wall-core-face": 82, "wall-finish-face": 78, centerline: 76,
  "reference-plane": 74, grid: 72, level: 70, "family-reference": 68,
  "work-plane": 60, "perpendicular-foot": 64, tangent: 62,
  edge: 50, face: 45, nearest: 20,
};

const GLYPH: Record<SnapReferenceKind, SnapIndicatorGlyph> = {
  endpoint: "endpoint-square", midpoint: "midpoint-triangle", center: "center-circle",
  intersection: "intersection-x", nearest: "nearest-dot", edge: "edge-line",
  face: "face-box", centerline: "centerline-dash", "perpendicular-foot": "perp-angle",
  tangent: "tangent-circle", grid: "grid-line", level: "level-line",
  "reference-plane": "plane-cross", "wall-core-face": "core-face",
  "wall-finish-face": "finish-face", "column-boundary": "column-boundary",
  "family-reference": "family-ref", "connector-origin": "connector",
  "connector-axis": "connector", "work-plane": "plane-cross",
};

const LEGEND: Record<SnapReferenceKind, string> = {
  endpoint: "Endpoint", midpoint: "Midpoint", center: "Center",
  intersection: "Intersection", nearest: "Nearest", edge: "Edge",
  face: "Face", centerline: "Centerline", "perpendicular-foot": "Perpendicular",
  tangent: "Tangent", grid: "Grid", level: "Level",
  "reference-plane": "Reference plane", "wall-core-face": "Wall core face",
  "wall-finish-face": "Wall finish face", "column-boundary": "Column boundary",
  "family-reference": "Family reference", "connector-origin": "Connector",
  "connector-axis": "Connector axis", "work-plane": "Work plane",
};

export interface RankedCandidate {
  raw: SnapCandidateRaw;
  kind: SnapReferenceKind;
  /** Screen distance in px. */
  screenDistance: number;
  priority: number;
  /** Lower is better; deterministic (spec "ranking + tie-breaking"). */
  score: number;
}

export interface ToolSnapFilter {
  /** Kinds this tool can accept (empty = all enabled kinds). */
  accepts?: Set<SnapReferenceKind>;
  /** Domain compatibility for connector snaps (spec 2B.7). */
  connectorDomain?: string;
  /** Reject candidates owned by these elements (e.g. the dragged element). */
  excludeElements?: Set<string>;
}

// ── Pipeline functions (spec 2B.2) ───────────────────────────────────────

/** QuerySnapCandidates: filter raw candidates by tolerance/depth/kind. */
export function querySnapCandidates(
  raws: SnapCandidateRaw[],
  pointerScreen: Pt2,
  settings: SnapSettings,
  filter: ToolSnapFilter = {},
): SnapCandidateRaw[] {
  const out: SnapCandidateRaw[] = [];
  for (const raw of raws) {
    if (!settings.enabled.has(raw.kind)) continue;
    if (filter.accepts && !filter.accepts.has(raw.kind)) continue;
    if (filter.excludeElements?.has(raw.elementId)) continue;
    const dx = raw.screen.x - pointerScreen.x;
    const dy = raw.screen.y - pointerScreen.y;
    if (Math.hypot(dx, dy) > settings.screenTolerancePx) continue;
    out.push(raw);
  }
  return out;
}

/** ClassifySnapReference: glyph/legend/ranking class for a candidate. */
export function classifySnapReference(raw: SnapCandidateRaw): { glyph: SnapIndicatorGlyph; legend: string; basePriority: number } {
  return {
    glyph: GLYPH[raw.kind],
    legend: raw.referenceName ? `${LEGEND[raw.kind]} · ${raw.referenceName}` : LEGEND[raw.kind],
    basePriority: BASE_PRIORITY[raw.kind],
  };
}

/** EvaluateSnapEligibility: tool + semantic compatibility (spec 2B.2). */
export function evaluateSnapEligibility(
  raw: SnapCandidateRaw,
  filter: ToolSnapFilter,
): { eligible: boolean; reason?: string } {
  if (filter.accepts && !filter.accepts.has(raw.kind)) {
    return { eligible: false, reason: `tool does not accept ${raw.kind}` };
  }
  if (filter.connectorDomain && (raw.kind === "connector-origin" || raw.kind === "connector-axis")) {
    // Connector snaps must match the routed domain (never connect across
    // domains just because two connectors are close — spec 2B.7).
    const domain = raw.referenceName?.split(":")[0];
    if (domain && domain !== filter.connectorDomain) {
      return { eligible: false, reason: `connector domain ${domain} ≠ ${filter.connectorDomain}` };
    }
  }
  return { eligible: true };
}

/** RankSnapCandidates: deterministic scoring (distance, priority, depth). */
export function rankSnapCandidates(
  candidates: SnapCandidateRaw[],
  pointerScreen: Pt2,
  settings: SnapSettings,
  workPlaneDepth?: number,
): RankedCandidate[] {
  const ranked = candidates.map((raw) => {
    const d = Math.hypot(raw.screen.x - pointerScreen.x, raw.screen.y - pointerScreen.y);
    const priority = (settings.priority?.[raw.kind] ?? BASE_PRIORITY[raw.kind]) as number;
    // Normalised distance 0..1 across the tolerance ring.
    const nd = d / settings.screenTolerancePx;
    // Depth penalty grows with distance from the work plane (spec:
    // "verifying model-space depth").
    const depthPenalty = workPlaneDepth !== undefined
      ? Math.min(1, Math.abs(raw.depth - workPlaneDepth) / Math.max(settings.depthWindow, 1e-9)) * 0.35
      : 0;
    const score = nd * 0.65 + (1 - Math.min(priority, 120) / 120) * 0.35 + depthPenalty;
    return { raw, kind: raw.kind, screenDistance: d, priority, score };
  });
  // Deterministic order: score, then kind, then elementId, then position.
  ranked.sort((a, b) =>
    a.score - b.score ||
    a.kind.localeCompare(b.kind) ||
    a.raw.elementId.localeCompare(b.raw.elementId) ||
    a.raw.position[0] - b.raw.position[0] ||
    a.raw.position[1] - b.raw.position[1],
  );
  return ranked;
}

/**
 * ResolveSnapAmbiguity: pick one candidate with hysteresis (spec 2B.2
 * "deterministic tie-breaking, hysteresis"). Returns null when nothing
 * qualifies. `locked` is the currently held candidate (if any).
 */
export function resolveSnapAmbiguity(
  ranked: RankedCandidate[],
  locked: RankedCandidate | null,
  settings: SnapSettings,
): RankedCandidate | null {
  if (ranked.length === 0) return null;
  const best = ranked[0];
  if (locked) {
    const stillThere = ranked.find((r) => r.raw.elementId === locked.raw.elementId && r.kind === locked.kind && r.raw.referenceName === locked.raw.referenceName);
    if (stillThere) {
      // Hysteresis: keep the lock unless the best beats it by the margin.
      if (best.score * settings.hysteresis < stillThere.score) return best;
      return stillThere;
    }
  }
  return best;
}

/** AcquireSnapCandidate → indicator + lock state. */
export function acquireSnapCandidate(
  candidate: RankedCandidate,
): { indicator: SnapIndicator; locked: RankedCandidate } {
  const c = classifySnapReference(candidate.raw);
  return {
    locked: candidate,
    indicator: {
      screen: { x: candidate.raw.screen.x, y: candidate.raw.screen.y },
      modelPosition: candidate.raw.position,
      glyph: c.glyph,
      legend: c.legend,
    },
  };
}

/** MaintainSnapLock: keep a lock alive while the candidate stays in range. */
export function maintainSnapLock(
  locked: RankedCandidate,
  pointerScreen: Pt2,
  settings: SnapSettings,
): { held: boolean; indicator: SnapIndicator | null } {
  const d = Math.hypot(locked.raw.screen.x - pointerScreen.x, locked.raw.screen.y - pointerScreen.y);
  // Release slightly beyond the acquisition tolerance (spec "release
  // behavior": avoid flicker at the boundary).
  if (d > settings.screenTolerancePx * 1.4) return { held: false, indicator: null };
  const c = classifySnapReference(locked.raw);
  return {
    held: true,
    indicator: {
      screen: { x: locked.raw.screen.x, y: locked.raw.screen.y },
      modelPosition: locked.raw.position,
      glyph: c.glyph,
      legend: c.legend,
    },
  };
}

/** ReleaseSnapCandidate. */
export function releaseSnapCandidate(): { locked: null; indicator: null } {
  return { locked: null, indicator: null };
}

/** RenderSnapIndicator data (the view layer draws it; engine produces it). */
export function renderSnapIndicator(indicator: SnapIndicator): SnapIndicator {
  return indicator;
}

// ── Temporary constraints (spec: temp snap ≠ persistent constraint) ──────

export interface TemporarySnapConstraint {
  id: string;
  kind: SnapReferenceKind;
  /** Element the constraint references. */
  elementId: string;
  referenceName?: string;
  /** Snapped model position. */
  position: [number, number, number];
  /** Direction for line/axis locks. */
  direction?: [number, number, number];
  createdAt: number;
}

let tempId = 0;

/** CreateTemporarySnapConstraint (session-scoped, never persisted). */
export function createTemporarySnapConstraint(candidate: RankedCandidate): TemporarySnapConstraint {
  return {
    id: `temp-snap-${++tempId}`,
    kind: candidate.kind,
    elementId: candidate.raw.elementId,
    referenceName: candidate.raw.referenceName,
    position: candidate.raw.position,
    direction: candidate.raw.direction,
    createdAt: Date.now(),
  };
}

/** ValidateSnapConstraint: the referenced position must still be reachable. */
export function validateSnapConstraint(
  c: TemporarySnapConstraint,
  raws: SnapCandidateRaw[],
): { valid: boolean; reason?: string } {
  const hit = raws.find(
    (r) => r.elementId === c.elementId && r.kind === c.kind && r.referenceName === c.referenceName,
  );
  if (!hit) return { valid: false, reason: "reference no longer available" };
  const d = Math.hypot(hit.position[0] - c.position[0], hit.position[1] - c.position[1], hit.position[2] - c.position[2]);
  if (d > 1e-6) return { valid: false, reason: `reference moved by ${d.toFixed(6)} m` };
  return { valid: true };
}

/**
 * ConvertSnapToPersistentRelationship — the ONLY sanctioned path from a
 * temporary snap to a stored relationship (spec 2B.2 "must remain separate
 * concepts"). Requires an explicit target element + type.
 */
export function convertSnapToPersistentRelationship(
  c: TemporarySnapConstraint,
  args: {
    targetElementId: string;
    type: RelationshipRecord["type"];
    registry: RelationshipRegistry;
    offset?: number;
  },
): RelationshipRecord {
  const sourceRef: GeometricReference = {
    elementId: c.elementId,
    kind: snapKindToReferenceKind(c.kind),
    name: c.referenceName,
    position: c.position,
    direction: c.direction,
  };
  const targetRef: GeometricReference = {
    elementId: args.targetElementId,
    kind: "endpoint",
    position: c.position,
  };
  return args.registry.createRelationship({
    type: args.type,
    source: sourceRef,
    target: targetRef,
    offset: args.offset,
    origin: "user-defined",
  });
}

function snapKindToReferenceKind(k: SnapReferenceKind): GeometricReference["kind"] {
  switch (k) {
    case "grid": return "grid";
    case "level": return "level";
    case "reference-plane": case "work-plane": return "reference-plane";
    case "connector-origin": case "connector-axis": return "connector";
    case "wall-core-face": case "wall-finish-face": case "face": return "face";
    case "centerline": return "centerline";
    case "column-boundary": case "edge": return "edge";
    default: return "endpoint";
  }
}
