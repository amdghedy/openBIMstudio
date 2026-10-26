/**
 * Selection engine — MODIFY GROUP 1 spec §2 (docs/MODIFY_GROUP1_SPEC_V71.md).
 *
 * Implements the uploaded Modify master prompt §4.1: hit-testing with
 * deterministic overlap priority, window/crossing selection, category /
 * type / parameter / id selection, inversion, hosted / connected /
 * dependent / related expansion, and the hidden / pinned / read-only /
 * linked-model behavioral rules.
 *
 * Discipline: selection is authoritative-input bookkeeping only — it
 * NEVER mutates element data. Pinned and read-only elements ARE
 * selectable (so the user can select then unpin); edit commands reject
 * them at CanExecute.
 *
 * Diagnostic codes: MOD-SEL-nnn (spec §2.6).
 * Pure module: no DOM — safe to unit-test in Node.
 */

import type { RelationshipRegistry } from "../relationships";

// ── Data model (spec §2.1) ───────────────────────────────────────────────

export interface SelectableElement {
  id: string;
  categoryId: string;
  typeId?: string;
  pinned: boolean;
  hidden: boolean;
  editable: boolean;
  linkedModel?: boolean;
  groupId?: string;
  hostedOnId?: string | null;
  /** Plan-view axis-aligned bounds (metres). */
  aabb?: { min: [number, number]; max: [number, number] };
  /** Plan curve (world coordinates). */
  curve?: { start: [number, number]; end: [number, number] };
  /** Point element (e.g. equipment origin, adaptive placement point). */
  point?: [number, number];
  params?: Record<string, number | string | boolean>;
}

export type SubHitKind = "vertex" | "edge" | "connector" | "datum" | "body";

/** Base priorities — spec §2.2 table (E-M1-01): vertex > edge > connector > datum > body. */
export const HIT_PRIORITY: Record<SubHitKind, number> = {
  vertex: 100,
  edge: 90,
  connector: 70,
  datum: 60,
  body: 40,
};

/** Category ids treated as datum elements for hit-testing. */
export const DATUM_CATEGORIES: ReadonlySet<string> = new Set([
  "levels", "grids", "reference-planes",
]);

export interface SelectionFilter {
  categories?: string[];
  typeIds?: string[];
  includePinned?: boolean;      // default true — pinned selectable, not editable
  includeHidden?: boolean;      // default false
  includeLinkedModels?: boolean; // default false
  selectWholeGroups?: boolean;  // default true
}

export const DEFAULT_SELECTION_FILTER: Required<SelectionFilter> = {
  categories: [],
  typeIds: [],
  includePinned: true,
  includeHidden: false,
  includeLinkedModels: false,
  selectWholeGroups: true,
};

export interface RankedHit {
  elementId: string;
  subKind: SubHitKind;
  priority: number;
  /** Hit distance in metres (0 for containment hits). */
  distance: number;
  /** Which feature was hit (curve endpoint index etc.), for tools that care. */
  featureIndex?: number;
}

export interface SelectionDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  elementIds: string[];
}

// ── Geometry helpers ─────────────────────────────────────────────────────

function dist2(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/** Squared distance from p to segment ab, plus nearest-point parameter. */
function dist2ToSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): { d2: number; t: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-18) return { d2: dist2(p, a), t: 0 };
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a[0] + t * abx;
  const qy = a[1] + t * aby;
  return { d2: dist2(p, [qx, qy]), t };
}

function pointInAabb(
  p: [number, number],
  aabb: { min: [number, number]; max: [number, number] },
): boolean {
  return (
    p[0] >= aabb.min[0] && p[0] <= aabb.max[0] &&
    p[1] >= aabb.min[1] && p[1] <= aabb.max[1]
  );
}

function aabbOverlapsRect(
  aabb: { min: [number, number]; max: [number, number] },
  a: [number, number],
  b: [number, number],
): boolean {
  const minx = Math.min(a[0], b[0]);
  const maxx = Math.max(a[0], b[0]);
  const miny = Math.min(a[1], b[1]);
  const maxy = Math.max(a[1], b[1]);
  return !(aabb.max[0] < minx || aabb.min[0] > maxx ||
           aabb.max[1] < miny || aabb.min[1] > maxy);
}

function aabbInsideRect(
  aabb: { min: [number, number]; max: [number, number] },
  a: [number, number],
  b: [number, number],
): boolean {
  const minx = Math.min(a[0], b[0]);
  const maxx = Math.max(a[0], b[0]);
  const miny = Math.min(a[1], b[1]);
  const maxy = Math.max(a[1], b[1]);
  return (
    aabb.min[0] >= minx && aabb.max[0] <= maxx &&
    aabb.min[1] >= miny && aabb.max[1] <= maxy
  );
}

function insideRect(p: [number, number], a: [number, number], b: [number, number]): boolean {
  const minx = Math.min(a[0], b[0]);
  const maxx = Math.max(a[0], b[0]);
  const miny = Math.min(a[1], b[1]);
  const maxy = Math.max(a[1], b[1]);
  return p[0] >= minx && p[0] <= maxx && p[1] >= miny && p[1] <= maxy;
}

function curveAabb(c: { start: [number, number]; end: [number, number] }): { min: [number, number]; max: [number, number] } {
  return {
    min: [Math.min(c.start[0], c.end[0]), Math.min(c.start[1], c.end[1])],
    max: [Math.max(c.start[0], c.end[0]), Math.max(c.start[1], c.end[1])],
  };
}

// ── Selection engine ─────────────────────────────────────────────────────

export interface SelectionEngineDeps {
  /** Live element source (re-evaluated on every call — store-agnostic). */
  elements: () => SelectableElement[];
  /** Optional relationship registry for hosted/connected expansion. */
  relationships?: RelationshipRegistry;
  /** Optional connector position provider (id → plan positions). */
  connectorPositions?: (elementId: string) => [number, number][];
}

export class SelectionEngine {
  private filter: Required<SelectionFilter> = { ...DEFAULT_SELECTION_FILTER };
  private selection: string[] = [];
  private diagnostics: SelectionDiagnostic[] = [];
  private lastHit: RankedHit | null = null;

  constructor(private deps: SelectionEngineDeps) {}

  // ── filter ──

  SetFilter(f: SelectionFilter): void {
    this.filter = { ...this.filter, ...f };
  }

  GetFilter(): Required<SelectionFilter> {
    return { ...this.filter };
  }

  // ── diagnostics ──

  GetDiagnostics(): SelectionDiagnostic[] {
    return [...this.diagnostics];
  }

  private diag(severity: SelectionDiagnostic["severity"], code: string, message: string, elementIds: string[] = []): void {
    this.diagnostics.push({ severity, code, message, elementIds });
  }

  // ── visibility / eligibility (spec §2.4) ──

  private isSelectable(el: SelectableElement): boolean {
    if (this.filter.categories.length && !this.filter.categories.includes(el.categoryId)) return false;
    if (this.filter.typeIds.length && (!el.typeId || !this.filter.typeIds.includes(el.typeId))) return false;
    if (el.hidden && !this.filter.includeHidden) return false;
    if (el.linkedModel && !this.filter.includeLinkedModels) return false;
    if (el.pinned && !this.filter.includePinned) return false;
    return true;
  }

  // ── hit-testing (spec §2.2) ──

  HitTest(p: [number, number], pickRadius = 0.05): RankedHit | null {
    if (!(pickRadius > 0)) {
      this.diag("error", "MOD-SEL-006", `degenerate pick radius ${pickRadius}`);
      return null;
    }
    const r2 = pickRadius * pickRadius;
    const hits: RankedHit[] = [];
    for (const el of this.deps.elements()) {
      if (!this.isSelectable(el)) continue;
      const isDatum = DATUM_CATEGORIES.has(el.categoryId);
      // vertex + edge hits: curve endpoints and segment
      if (el.curve) {
        const eps: Array<[number, number]> = [el.curve.start, el.curve.end];
        for (let i = 0; i < 2; i++) {
          const d2 = dist2(p, eps[i]);
          if (d2 <= r2) {
            hits.push({ elementId: el.id, subKind: "vertex", priority: HIT_PRIORITY.vertex, distance: Math.sqrt(d2), featureIndex: i });
          }
        }
        const seg = dist2ToSegment(p, el.curve.start, el.curve.end);
        if (seg.d2 <= r2) {
          hits.push({ elementId: el.id, subKind: "edge", priority: HIT_PRIORITY.edge, distance: Math.sqrt(seg.d2) });
        }
      }
      if (el.point) {
        const d2 = dist2(p, el.point);
        if (d2 <= r2) {
          hits.push({ elementId: el.id, subKind: isDatum ? "datum" : "vertex", priority: isDatum ? HIT_PRIORITY.datum : HIT_PRIORITY.vertex, distance: Math.sqrt(d2) });
        }
      }
      if (this.deps.connectorPositions) {
        for (const cp of this.deps.connectorPositions(el.id) ?? []) {
          const d2 = dist2(p, cp);
          if (d2 <= r2) {
            hits.push({ elementId: el.id, subKind: "connector", priority: HIT_PRIORITY.connector, distance: Math.sqrt(d2) });
          }
        }
      }
      // body: containment in aabb
      if (el.aabb && pointInAabb(p, el.aabb)) {
        hits.push({ elementId: el.id, subKind: "body", priority: HIT_PRIORITY.body, distance: 0 });
      }
    }
    if (!hits.length) {
      this.diag("info", "MOD-SEL-001", `no element at pick point (${p[0]}, ${p[1]})`);
      return null;
    }
    hits.sort((x, y) =>
      (y.priority - x.priority) ||
      (x.distance - y.distance) ||
      (x.elementId < y.elementId ? -1 : x.elementId > y.elementId ? 1 : 0),
    );
    return hits[0];
  }

  SelectSingle(p: [number, number], pickRadius = 0.05): RankedHit | null {
    const hit = this.HitTest(p, pickRadius);
    if (!hit) {
      this.selection = [];
      return null;
    }
    this.applySelectionRules([hit.elementId]);
    this.lastHit = hit;
    return hit;
  }

  GetLastHit(): RankedHit | null {
    return this.lastHit ? { ...this.lastHit } : null;
  }

  // ── window / crossing (spec §2.3) ──

  SelectWindow(a: [number, number], b: [number, number], mode: "inside" | "crossing"): string[] {
    const picked: string[] = [];
    for (const el of this.deps.elements()) {
      if (!this.isSelectable(el)) continue;
      let hit: boolean;
      if (el.aabb) {
        hit = mode === "inside" ? aabbInsideRect(el.aabb, a, b) : aabbOverlapsRect(el.aabb, a, b);
      } else if (el.curve) {
        hit = mode === "inside"
          ? insideRect(el.curve.start, a, b) && insideRect(el.curve.end, a, b)
          : aabbOverlapsRect(curveAabb(el.curve), a, b);
      } else if (el.point) {
        hit = insideRect(el.point, a, b);
      } else {
        hit = false;
      }
      if (hit) picked.push(el.id);
    }
    this.applySelectionRules(picked);
    return [...this.selection];
  }

  // ── filtered scans (spec §2.3) ──

  SelectByCategory(categories: string[]): string[] {
    const picked = this.deps.elements()
      .filter((el) => this.isSelectable(el) && categories.includes(el.categoryId))
      .map((el) => el.id);
    this.applySelectionRules(picked);
    return [...this.selection];
  }

  SelectByType(typeId: string): string[] {
    const picked = this.deps.elements()
      .filter((el) => this.isSelectable(el) && el.typeId === typeId)
      .map((el) => el.id);
    this.applySelectionRules(picked);
    return [...this.selection];
  }

  SelectByParameter(pred: (params: Record<string, number | string | boolean>) => boolean): string[] {
    const picked = this.deps.elements()
      .filter((el) => this.isSelectable(el) && el.params && pred(el.params))
      .map((el) => el.id);
    this.applySelectionRules(picked);
    return [...this.selection];
  }

  SelectByIds(ids: string[]): string[] {
    const known = new Set(this.deps.elements().map((el) => el.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) {
      this.diag("info", "MOD-SEL-004", `select-by-id: unknown ids ignored: ${missing.join(", ")}`, missing);
    }
    this.applySelectionRules(ids.filter((id) => known.has(id)));
    return [...this.selection];
  }

  Invert(): string[] {
    const visible = this.deps.elements()
      .filter((el) => this.isSelectable(el))
      .map((el) => el.id);
    const current = new Set(this.selection);
    this.applySelectionRules(visible.filter((id) => !current.has(id)));
    return [...this.selection];
  }

  // ── multi-selection bookkeeping (spec §2.3) ──

  AddToSelection(id: string): void {
    if (!this.selection.includes(id)) this.selection.push(id);
  }

  RemoveFromSelection(id: string): void {
    this.selection = this.selection.filter((x) => x !== id);
  }

  ToggleSelection(id: string): void {
    if (this.selection.includes(id)) this.RemoveFromSelection(id);
    else this.AddToSelection(id);
  }

  Clear(): void {
    this.selection = [];
    this.diagnostics = [];
    this.lastHit = null;
  }

  GetSelection(): string[] {
    return [...this.selection];
  }

  // ── relationship-driven expansion (spec §2.4) ──

  ExpandHosted(id: string): string[] {
    const out: string[] = [];
    // direct hostedOnId links
    for (const el of this.deps.elements()) {
      if (el.hostedOnId === id) out.push(el.id);
    }
    // registry records (host / attachment kinds)
    const reg = this.deps.relationships;
    if (reg) {
      for (const rec of reg.queryRelationships({ elementId: id })) {
        const other = rec.source.elementId === id ? rec.target.elementId : rec.source.elementId;
        const hostKind = rec.type === "host" || rec.type === "face-attachment" || rec.type === "rigid-attachment";
        if (hostKind && other !== id && !out.includes(other)) {
          out.push(other);
        }
      }
    }
    for (const x of out) this.AddToSelection(x);
    return out;
  }

  ExpandConnected(id: string): string[] {
    const reg = this.deps.relationships;
    const out: string[] = [];
    if (reg) {
      for (const rec of reg.queryRelationships({ elementId: id })) {
        const other = rec.source.elementId === id ? rec.target.elementId : rec.source.elementId;
        if (other !== id && !out.includes(other)) out.push(other);
      }
    }
    for (const x of out) this.AddToSelection(x);
    return out;
  }

  ExpandDependents(id: string): string[] {
    return this.ExpandHosted(id);
  }

  ExpandRelated(id: string): string[] {
    return this.ExpandConnected(id);
  }

  // ── internal ──

  /**
   * Selection rules: group expansion (selectWholeGroups), pinned /
   * read-only / hidden-force warnings (spec §2.4).
   */
  private applySelectionRules(ids: string[]): void {
    const byId = new Map(this.deps.elements().map((el) => [el.id, el]));
    const final: string[] = [];
    const seen = new Set<string>();
    const push = (id: string): void => {
      if (seen.has(id)) return;
      const el = byId.get(id);
      if (!el) return;
      // visibility/eligibility filter applies to EVERY selection path
      // (hit-test, window, scan, by-id) — spec §2.4
      if (!this.isSelectable(el)) return;
      seen.add(id);
      final.push(id);
      if (el.pinned) {
        this.diag("warning", "MOD-SEL-002", `element '${id}' is pinned (edits will be rejected)`, [id]);
      }
      if (!el.editable || el.linkedModel) {
        this.diag("warning", "MOD-SEL-003", `element '${id}' is read-only${el.linkedModel ? " (linked model)" : ""}`, [id]);
      }
      if (el.hidden) {
        this.diag("warning", "MOD-SEL-005", `element '${id}' is hidden (force-selected via filter override)`, [id]);
      }
    };
    for (const id of ids) push(id);
    if (this.filter.selectWholeGroups) {
      const groupIds = new Set<string>();
      for (const id of ids) {
        const el = byId.get(id);
        if (el?.groupId) {
          for (const other of this.deps.elements()) {
            if (other.groupId === el.groupId && this.isSelectable(other)) groupIds.add(other.id);
          }
        }
      }
      for (const id of groupIds) push(id);
    }
    this.selection = final;
  }
}
