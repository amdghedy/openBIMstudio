/**
 * Revit 2D audit gap G3 — Tab-cycle through overlapping elements at hover.
 *
 * Pure selection-cycle model: no DOM, no THREE, no app imports, so the node
 * tests can compile this file standalone (see tests/revit-g3-tab-cycle.test.cjs).
 *
 * Revit behaviour ([SEL] / [MEP-2013] in the audit): hovering a crowded spot
 * pre-highlights the top element; Tab cycles the pre-highlight through the
 * overlapping elements under the cursor, in a stable order, wrapping around;
 * the status bar shows which element is pre-highlighted; clicking selects
 * the pre-highlighted element, not the topmost hit; Esc / moving the mouse
 * away resets the cycle.
 *
 * What this module owns:
 *   - the hit-stack order (nearest first, stable tie-break by key),
 *   - the cycle state machine (set stack / advance with wrap / reset),
 *   - the plan-view hit geometry (which authored elements overlap a plan
 *     cursor point — the same distance math as `nearestAuthoredAt` in
 *     plan-view-panel.ts, so the stack matches what a click would pick),
 *   - the shared 3D preselect-cycle instance, driven by bim-experience.ts
 *     (hover stack) and consulted by the 3D click paths (authoring
 *     pickSelect, selection pointerup) so a click selects the cycled
 *     candidate. The plan view keeps its own local instance because its
 *     cursor lives in plan (x, z) space.
 *
 * Honest limits, recorded here so no caller over-claims:
 *   - 3D fragment (linked IFC) elements: the ThatOpen GPU picker
 *     (`FastModelPicker.getFullPick`) returns only the single top hit, so a
 *     3D stack can hold every overlapping *authored* element plus the one
 *     top fragment hit — overlapping fragments behind that top hit cannot
 *     be cycled. The plan stack is authored-only for the same reason plan
 *     click-select is authored-only today.
 */
export interface CycleCandidate {
  /** Stable identity: an authored element id, or `frag:<modelId>:<localId>`. */
  key: string;
  /** Human-readable readout, e.g. "Wall · Wall 1". */
  label: string;
  kind: "authored" | "fragment";
  /** Authored element id (kind === "authored"). */
  authoredId?: string;
  /** Fragment model id (kind === "fragment"). */
  modelId?: string;
  /** Fragment local id (kind === "fragment"). */
  localId?: number;
  /** Ray / pick distance; smaller = nearer the viewer (3D) or the cursor (plan). */
  distance: number;
}

/** Nearest first; ties break by key so the order is stable run to run. */
export function compareCandidates(a: CycleCandidate, b: CycleCandidate): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Dedupe a raw hit list by key (keeping the nearest hit per key) and sort
 * it into stack order. The first entry is the topmost hit.
 */
export function sortHitStack(candidates: CycleCandidate[]): CycleCandidate[] {
  const best = new Map<string, CycleCandidate>();
  for (const c of candidates) {
    const prev = best.get(c.key);
    if (!prev || compareCandidates(c, prev) < 0) best.set(c.key, c);
  }
  return [...best.values()].sort(compareCandidates);
}

/** "Wall · Wall 1 (2/3)" — the readout shown while cycling. */
export function formatCycleLabel(candidate: CycleCandidate, index: number, count: number): string {
  return `${candidate.label} (${index + 1}/${count})`;
}

/** Full status-bar / footer readout for the current candidate. */
export function formatCycleStatus(candidate: CycleCandidate, index: number, count: number): string {
  return `Tab ${index + 1}/${count}: ${candidate.label} — click to select, Esc to cancel`;
}

/**
 * Cycle state machine over one hover hit-stack.
 *
 * `index` is the pre-highlighted position; it starts at 0 (the top hit,
 * which hover already pre-highlights). `advance()` moves to the next
 * candidate, wrapping around, and returns it — or null when there is
 * nothing to cycle through (fewer than two candidates). `cycled` records
 * whether Tab has moved the pre-highlight off the top hit: only then does
 * a click need to override the topmost pick.
 */
export class SelectionCycle {
  private stack: CycleCandidate[] = [];
  private index = 0;
  private cycledFlag = false;
  /** Key of the top hit when the stack was set — the hover anchor. */
  private anchorKey: string | null = null;

  /** Replace the stack for the current hover spot; resets the position to the top. */
  setStack(candidates: CycleCandidate[]): void {
    this.stack = sortHitStack(candidates);
    this.index = 0;
    this.cycledFlag = false;
    this.anchorKey = this.stack.length ? this.stack[0].key : null;
  }

  get count(): number {
    return this.stack.length;
  }

  get currentIndex(): number {
    return this.index;
  }

  /** True once Tab has moved the pre-highlight off the top hit. */
  get cycled(): boolean {
    return this.cycledFlag && this.stack.length > 1;
  }

  /** The pre-highlighted candidate, or null when the stack is empty. */
  current(): CycleCandidate | null {
    return this.stack[this.index] ?? null;
  }

  /** All candidates in stack order (a copy). */
  candidates(): CycleCandidate[] {
    return [...this.stack];
  }

  /** Top-hit key the cycle is anchored to, or null when there is no stack. */
  get anchor(): string | null {
    return this.anchorKey;
  }

  /**
   * Step the pre-highlight. `dir` is +1 (Tab) or -1 (Shift+Tab). Wraps
   * around. Returns the new current candidate, or null when the stack has
   * fewer than two candidates (a lone element cannot be cycled).
   */
  advance(dir: 1 | -1 = 1): CycleCandidate | null {
    if (this.stack.length < 2) return null;
    const n = this.stack.length;
    this.index = ((this.index + dir) % n + n) % n;
    this.cycledFlag = true;
    return this.stack[this.index];
  }

  /**
   * True when the hover anchor moved: the top hit under the cursor is no
   * longer the one this cycle was built for, so the cycle is stale. The
   * caller resets (and, for a fresh hover spot, rebuilds) the stack.
   */
  anchorChanged(topKey: string | null): boolean {
    if (!this.stack.length) return topKey !== null;
    return this.anchorKey !== topKey;
  }

  /** Clear the stack (Esc, mouse leaves, click consumes the cycle). */
  reset(): void {
    this.stack = [];
    this.index = 0;
    this.cycledFlag = false;
    this.anchorKey = null;
  }
}

export function createSelectionCycle(): SelectionCycle {
  return new SelectionCycle();
}

/**
 * Tell the status bar (src/shell/status-bar.ts listens for this window
 * event) to show — or clear, with null — the Tab-cycle readout. No-op
 * outside a browser, so the node tests can import this module as-is.
 */
export function emitTabCycleStatus(message: string | null): void {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("obs:tab-cycle-status", { detail: { message } }));
    }
  } catch { /* the readout is best-effort */ }
}

/**
 * Shared 3D preselect cycle, driven by bim-experience.ts (which owns the
 * 3D hover stack) and consulted by the 3D click paths in authoring.ts and
 * selection.ts. One instance because the 3D viewport has one cursor.
 */
export const hoverPreselectCycle = new SelectionCycle();

/* ── Plan-view hit geometry ─────────────────────────────────────────── */

/** Minimal authored-element shape the plan hit test needs. */
export interface PlanElementLike {
  id: string;
  type?: string;
  name?: string;
  params?: {
    start?: [number, number] | number[];
    end?: [number, number] | number[];
    point?: [number, number] | number[];
    polygon?: Array<[number, number] | number[]>;
    thickness?: number;
    width?: number;
    depth?: number;
  };
}

export interface PlanHit {
  element: PlanElementLike;
  /** Cursor distance minus half-thickness; <= 0 means the cursor is inside the element. */
  distance: number;
}

/**
 * Distance from a plan cursor point to one authored element, using the same
 * geometry as `nearestAuthoredAt` in plan-view-panel.ts (linear centreline
 * distance, point distance, polygon bounding-box test), each minus the
 * element's half-thickness. Returns null when the element has no usable
 * plan geometry.
 */
export function distanceToAuthoredElement(
  el: PlanElementLike,
  point: { x: number; z: number },
): number | null {
  const p = el?.params ?? {};
  const half = Math.max(0.04, Number((p as any).thickness ?? (p as any).width ?? 0.2) * 0.55);
  if ((p as any).start && (p as any).end) {
    const ax = (p as any).start[0], az = (p as any).start[1];
    const bx = (p as any).end[0], bz = (p as any).end[1];
    const dx = bx - ax, dz = bz - az;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((point.x - ax) * dx + (point.z - az) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, pz = az + t * dz;
    return Math.hypot(point.x - px, point.z - pz) - half;
  }
  if ((p as any).point) {
    return Math.hypot(point.x - (p as any).point[0], point.z - (p as any).point[1]) - half;
  }
  if (Array.isArray((p as any).polygon) && (p as any).polygon.length) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const v of (p as any).polygon as number[][]) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minZ) minZ = v[1];
      if (v[1] > maxZ) maxZ = v[1];
    }
    if (point.x >= minX - half && point.x <= maxX + half && point.z >= minZ - half && point.z <= maxZ + half) {
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      return Math.hypot(point.x - cx, point.z - cz);
    }
    return null;
  }
  return null;
}

/**
 * Every authored element overlapping a plan cursor point, nearest first.
 * `maxDistance` is the same 0.85 m acceptance threshold `nearestAuthoredAt`
 * uses, so the stack holds exactly the elements a click at that point could
 * pick; `allowed` applies the shared category filter (pass
 * `selection.matchesAuthoredCategoryFilter`). Ties break by element id, so
 * the order is stable.
 */
export function authoredElementsAt(
  elements: PlanElementLike[],
  point: { x: number; z: number },
  opts: { maxDistance?: number; allowed?: (el: PlanElementLike) => boolean } = {},
): PlanHit[] {
  const maxDistance = opts.maxDistance ?? 0.85;
  const hits: PlanHit[] = [];
  for (const el of elements) {
    if (!el) continue;
    if (opts.allowed && !opts.allowed(el)) continue;
    const d = distanceToAuthoredElement(el, point);
    if (d === null || d > maxDistance) continue;
    hits.push({ element: el, distance: d });
  }
  hits.sort((a, b) =>
    a.distance !== b.distance
      ? a.distance - b.distance
      : a.element.id < b.element.id
        ? -1
        : a.element.id > b.element.id
          ? 1
          : 0,
  );
  return hits;
}

/** "Wall · Wall 1" label for a plan element. */
export function planElementLabel(el: PlanElementLike): string {
  const type = el.type ?? "element";
  return el.name ? `${type} · ${el.name}` : type;
}

/** Convert plan hits into cycle candidates (keyed by element id). */
export function planHitsToCandidates(hits: PlanHit[]): CycleCandidate[] {
  return hits.map((h) => ({
    key: String(h.element.id),
    label: planElementLabel(h.element),
    kind: "authored" as const,
    authoredId: String(h.element.id),
    distance: h.distance,
  }));
}
