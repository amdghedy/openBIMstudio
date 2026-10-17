/**
 * Central selection manager.
 *
 * Multi-select across models (Ctrl add, Shift toggle, Alt remove).
 * Two-way bridge to the OBC highlighter (source of truth for rendering).
 * Named selection sets, persisted in localStorage.
 * Click-to-select for fragments wired via setupClickToSelect().
 */
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { ctx } from "../core/context";
import { register, tryUse, type SelectionService } from "../core/services";

export interface SelectionSnapshot {
  [modelId: string]: Set<number>;
}

export interface SelectionSet {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  snapshot: Record<string, number[]>;
}

const SETS_KEY = "obs.selection-sets.v1";

class SelectionManager {
  private map: SelectionSnapshot = {};
  private listeners = new Set<() => void>();
  private filter: Set<string> | null = null;
  private highlightStyle = "select";

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  // ── Read ──
  snapshot(): SelectionSnapshot {
    const out: SelectionSnapshot = {};
    for (const [m, s] of Object.entries(this.map)) {
      if (s.size) out[m] = new Set(s);
    }
    return out;
  }
  isEmpty(): boolean {
    for (const s of Object.values(this.map)) if (s.size) return false;
    return true;
  }
  size(): number {
    let n = 0;
    for (const s of Object.values(this.map)) n += s.size;
    return n;
  }
  has(modelId: string, localId: number): boolean {
    return !!this.map[modelId]?.has(localId);
  }
  modelCount(): number {
    return Object.keys(this.map).filter((m) => (this.map[m]?.size ?? 0) > 0).length;
  }

  // ── Mutate ──
  add(modelId: string, localId: number): void {
    if (!this.map[modelId]) this.map[modelId] = new Set();
    this.map[modelId].add(localId);
    this.emit();
  }
  addMany(modelId: string, ids: Iterable<number>): void {
    if (!this.map[modelId]) this.map[modelId] = new Set();
    for (const id of ids) this.map[modelId].add(id);
    this.emit();
  }
  remove(modelId: string, localId: number): void {
    this.map[modelId]?.delete(localId);
    if (this.map[modelId]?.size === 0) delete this.map[modelId];
    this.emit();
  }
  removeMany(modelId: string, ids: Iterable<number>): void {
    const s = this.map[modelId];
    if (!s) return;
    for (const id of ids) s.delete(id);
    if (s.size === 0) delete this.map[modelId];
    this.emit();
  }
  toggle(modelId: string, localId: number): void {
    if (this.has(modelId, localId)) this.remove(modelId, localId);
    else this.add(modelId, localId);
  }
  replace(snap: SelectionSnapshot): void {
    this.map = {};
    for (const [m, s] of Object.entries(snap)) {
      if (s.size) this.map[m] = new Set(s);
    }
    this.emit();
  }
  clear(): void {
    this.map = {};
    this.emit();
  }

  applyClick(
    modelId: string,
    localId: number,
    mods: { ctrl?: boolean; shift?: boolean; alt?: boolean },
  ): void {
    // BIM-style selection modifiers:
    //   plain click  = replace
    //   Ctrl/Cmd     = add
    //   Shift        = remove
    //   Alt          = remove (kept as a useful accessibility/legacy alias)
    if (mods.alt || mods.shift) {
      this.remove(modelId, localId);
    } else if (mods.ctrl) {
      this.add(modelId, localId);
    } else {
      this.replace({ [modelId]: new Set([localId]) });
    }
  }

  // ── Filter ──
  setFilter(categories: string[] | null): void {
    this.filter = categories && categories.length ? new Set(categories) : null;
    this.emit();
  }
  getFilter(): string[] | null {
    return this.filter ? [...this.filter] : null;
  }
  hasFilter(): boolean {
    return this.filter != null && this.filter.size > 0;
  }

  // ── Bulk operations ──
  async selectAll(): Promise<void> {
    this.map = {};
    for (const [modelId, model] of ctx.fragments.list) {
      try {
        const ids = (await (model as any).getItemsIdsWithGeometry()) as number[];
        if (!ids?.length) continue;
        if (this.filter) {
          const cats = await (model as any).getItemsOfCategories([/.+/]);
          const keep = new Set<number>();
          for (const [cat, list] of Object.entries(cats ?? {})) {
            if (this.filter.has(cat)) for (const id of (list as number[]) || []) keep.add(id);
          }
          if (keep.size) this.map[modelId] = keep;
        } else {
          this.map[modelId] = new Set(ids);
        }
      } catch { /* */ }
    }
    this.emit();
    await this.applyToHighlighter();
  }

  async selectSimilar(modelId: string, localId: number): Promise<void> {
    const model = ctx.fragments.list.get(modelId);
    if (!model) return;
    try {
      const cats = await (model as any).getItemsOfCategories([/.+/]);
      let cat: string | null = null;
      for (const [c, list] of Object.entries(cats ?? {})) {
        if (((list as number[]) || []).includes(localId)) { cat = c; break; }
      }
      if (!cat) return;
      const ids = ((cats as any)[cat] as number[]) || [];
      const merged: SelectionSnapshot = this.snapshot();
      if (!merged[modelId]) merged[modelId] = new Set();
      for (const id of ids) merged[modelId].add(id);
      this.replace(merged);
      await this.applyToHighlighter();
    } catch (e) {
      console.warn("[selection] selectSimilar failed", e);
    }
  }

  async invert(): Promise<void> {
    for (const [modelId, model] of ctx.fragments.list) {
      try {
        const all = (await (model as any).getItemsIdsWithGeometry()) as number[];
        if (!all?.length) continue;
        const cur = this.map[modelId] ?? new Set<number>();
        const inv = new Set<number>();
        for (const id of all) if (!cur.has(id)) inv.add(id);
        if (inv.size) this.map[modelId] = inv;
        else delete this.map[modelId];
      } catch { /* */ }
    }
    this.emit();
    await this.applyToHighlighter();
  }

  // ── Rendering bridge ──
  async applyToHighlighter(style = this.highlightStyle): Promise<void> {
    try { await (ctx.highlighter as any).clear(style); } catch { /* */ }
    if (this.isEmpty()) return;
    const map: OBC.ModelIdMap = {};
    for (const [m, s] of Object.entries(this.map)) {
      if (s.size) map[m] = new Set(s);
    }
    try {
      await (ctx.highlighter as any).highlightByID(style, map, true);
    } catch (e) {
      console.warn("[selection] highlighter", e);
    }
  }

  adoptFromHighlighter(): void {
    const hl = ctx.highlighter as any;
    const candidates: any[] = [hl?.selection, hl?.styles, hl];
    const snap: SelectionSnapshot = {};
    const isNumericSet = (v: any): v is Set<number> => {
      if (!(v instanceof Set) || !v.size) return false;
      for (const x of v) if (typeof x !== "number") return false;
      return true;
    };
    const scan = (node: any, depth: number) => {
      if (!node || depth > 4) return;
      if (node instanceof Map) {
        for (const [k, v] of node) {
          if (isNumericSet(v)) {
            if (!snap[String(k)]) snap[String(k)] = new Set();
            for (const id of v) snap[String(k)]!.add(id);
          } else scan(v, depth + 1);
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const v of node) scan(v, depth + 1);
        return;
      }
      if (typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (isNumericSet(v)) {
          if (!snap[k]) snap[k] = new Set();
          for (const id of v) snap[k]!.add(id);
        } else if (v && typeof v === "object") {
          scan(v, depth + 1);
        }
      }
    };
    for (const c of candidates) scan(c, 0);
    if (Object.keys(snap).length) this.replace(snap);
  }

  // ── Selection sets ──
  listSets(): SelectionSet[] {
    try {
      const raw = localStorage.getItem(SETS_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  private persistSets(list: SelectionSet[]) {
    try { localStorage.setItem(SETS_KEY, JSON.stringify(list)); } catch (e) {
      console.warn("[selection] set save failed", e);
    }
  }
  saveSet(name: string): SelectionSet {
    const snap: Record<string, number[]> = {};
    for (const [m, s] of Object.entries(this.map)) snap[m] = [...s];
    const set: SelectionSet = {
      id: (crypto as any).randomUUID?.() ?? `ss-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: name.trim() || "Set",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      snapshot: snap,
    };
    const list = this.listSets();
    list.unshift(set);
    this.persistSets(list);
    this.emit();
    return set;
  }
  async loadSet(id: string): Promise<void> {
    const set = this.listSets().find((s) => s.id === id);
    if (!set) return;
    const snap: SelectionSnapshot = {};
    for (const [m, arr] of Object.entries(set.snapshot)) snap[m] = new Set(arr);
    this.replace(snap);
    await this.applyToHighlighter();
  }
  deleteSet(id: string): void {
    this.persistSets(this.listSets().filter((s) => s.id !== id));
    this.emit();
  }

  async focus(): Promise<void> {
    if (this.isEmpty()) return;
    try {
      const mod = await import("./camera-tools");
      const map: any = {};
      for (const [m, s] of Object.entries(this.map)) map[m] = s;
      await mod.fitToMap(map);
    } catch { /* */ }
  }

  async boundingBox(): Promise<THREE.Box3 | null> {
    const box = new THREE.Box3();
    let any = false;
    for (const [modelId, ids] of Object.entries(this.map)) {
      const model: any = ctx.fragments.list.get(modelId);
      if (!model || !ids.size) continue;
      try {
        const boxes: THREE.Box3[] = await model.getBoxes([...ids]);
        const mw = model.object.matrixWorld?.clone?.() ?? new THREE.Matrix4();
        for (const b of boxes ?? []) {
          if (!b || b.isEmpty()) continue;
          const w = b.clone().applyMatrix4(mw);
          box.union(w);
          any = true;
        }
      } catch { /* */ }
    }
    return any ? box : null;
  }
}


export const selection = new SelectionManager();

/** Typed service registration (Week 3). */
{
  const svc: SelectionService = {
    snapshot: () => selection.snapshot(),
    size: () => selection.size(),
    modelCount: () => selection.modelCount(),
    isEmpty: () => selection.isEmpty(),
    replace: (m) => selection.replace(m),
    clear: () => selection.clear(),
    addMany: (m, ids) => selection.addMany(m, ids),
    removeMany: (m, ids) => selection.removeMany(m, ids),
    selectAll: () => selection.selectAll(),
    invert: () => selection.invert(),
    selectSimilar: (m, id) => selection.selectSimilar(m, id),
    applyClick: (m, id, mods) => selection.applyClick(m, id, mods),
    adoptFromHighlighter: () => selection.adoptFromHighlighter(),
    applyToHighlighter: () => selection.applyToHighlighter(),
    focus: () => selection.focus(),
    boundingBox: () => selection.boundingBox(),
    saveSet: (n) => selection.saveSet(n),
    listSets: () => selection.listSets(),
    loadSet: (id) => selection.loadSet(id),
    onChange: (cb) => selection.onChange(cb),
  };
  register("selection", svc);
}


/* ═════════════════════════════════════════════════════════════════════════
   Click-to-select wiring for fragments
   ═════════════════════════════════════════════════════════════════════════ */
let clickToSelectInstalled = false;
let highlighterSyncInstalled = false;
let hoverPending = false;
let hoveredMap: Record<string, Set<number>> = {};

function anyBlockingToolActive(): boolean {
  try {
    if ((tryUse("authoring") as any)?.isActive?.()) return true;
    if ((ctx.features as any).drawing?.isActive?.()) return true;
    if ((ctx.features as any).measure?.isEnabled?.()) return true;
    if ((ctx.features as any).section?.isEnabled?.()) return true;
    if ((ctx.features as any).walkMode?.isEnabled?.()) return true;
    return false;
  } catch { return false; }
}

function normalizeRaycastResult(r: any): { modelId: string; localId: number } | null {
  if (!r) return null;
  const localCandidate = r.localId ?? r.localIds?.[0] ?? r.fragments?.localId ?? r.fragments?.localIds?.[0] ?? r.itemId;
  const localId = typeof localCandidate === "number" ? localCandidate : Number(localCandidate);
  const model = r.model ?? r.fragment?.model ?? r.fragments?.model ?? r.fragments?.[0]?.model;
  let modelId: string | null =
    typeof r.modelId === "string" ? r.modelId :
    typeof r.fragments?.modelId === "string" ? r.fragments.modelId :
    typeof r.fragments?.[0]?.modelId === "string" ? r.fragments[0].modelId :
    typeof model?.modelId === "string" ? model.modelId :
    typeof model?.id === "string" ? model.id : null;
  if (modelId == null && model) {
    for (const [id, m] of ctx.fragments.list as any) {
      if (m === model || (m as any)?.object === model || (model as any)?.model === m) { modelId = id; break; }
    }
  }
  if (!Number.isFinite(localId) || modelId == null || !ctx.fragments.list.has(modelId)) return null;
  return { modelId, localId };
}

function clearAuthoredSelection(): void {
  try {
    const authoring: any = tryUse("authoring") as any;
    authoring?.setSelectedAuthored?.([], "replace");
  } catch { /* optional authoring bridge */ }
}

function clearFragmentSelection(): void {
  try {
    selection.replace({});
    void selection.applyToHighlighter();
  } catch { /* */ }
}

export async function pickFragmentAtPointer(): Promise<{ modelId: string; localId: number } | null> {
  try {
    const caster: any = ctx.components.get(OBC.Raycasters).get(ctx.world);
    return normalizeRaycastResult(await caster.castRay());
  } catch (err) {
    console.warn("[selection] fragment raycast failed", err);
    return null;
  }
}

async function clearHover(): Promise<void> {
  if (!ctx.highlighter) return;
  try { await (ctx.highlighter as any).clear("preselect"); } catch { /* */ }
  hoveredMap = {};
}

async function updateHover(canvas: HTMLCanvasElement): Promise<void> {
  if (hoverPending) return;
  hoverPending = true;
  try {
    const caster: any = ctx.components.get(OBC.Raycasters).get(ctx.world);
    const r: any = await caster.castRay();
    const localId = r?.localId ?? r?.localIds?.[0] ?? r?.itemId ?? r?.id;
    const modelId = r?.modelId ?? r?.fragments?.modelId ?? r?.fragments?.[0]?.modelId ?? r?.model?.modelId ?? r?.model?.id;
    if (typeof localId !== "number" || typeof modelId !== "string" || !ctx.fragments.list.has(modelId)) {
      await clearHover();
      return;
    }
    const next = { [modelId]: new Set([localId]) };
    const same = Object.keys(hoveredMap).length === 1 && hoveredMap[modelId]?.size === 1 && hoveredMap[modelId].has(localId);
    if (same) return;
    await clearHover();
    hoveredMap = next;
    await (ctx.highlighter as any).highlightByID("preselect", next, true, false);
    void canvas;
  } catch {
    await clearHover();
  } finally {
    hoverPending = false;
  }
}

export function setupClickToSelect(): void {
  if (clickToSelectInstalled) return;
  clickToSelectInstalled = true;

  if (!highlighterSyncInstalled) {
    highlighterSyncInstalled = true;
    try {
      const selectEvents = (ctx.highlighter as any)?.events?.select;
      selectEvents?.onHighlight?.add((map: any) => {
        const snap: SelectionSnapshot = {};
        for (const [modelId, ids] of Object.entries(map ?? {})) {
          const set = ids instanceof Set ? ids : new Set<number>(Array.isArray(ids) ? ids : []);
          if (set.size) snap[modelId] = new Set(set);
        }
        if (Object.keys(snap).length) (selection as any).replace(snap);
      });
      selectEvents?.onClear?.add((map: any) => {
        if (map && Object.keys(map).length) {
          const snap = selection.snapshot();
          for (const [modelId, ids] of Object.entries(map)) {
            const current = snap[modelId];
            if (!current) continue;
            for (const id of ids as Set<number>) current.delete(id);
            if (!current.size) delete snap[modelId];
          }
          (selection as any).replace(snap);
        }
      });
    } catch { /* event bridge is optional */ }
  }

  const canvasForHover = (ctx.world.renderer.three as THREE.WebGLRenderer)?.domElement as HTMLCanvasElement | null;
  if (canvasForHover) {
    canvasForHover.addEventListener("pointermove", () => { void updateHover(canvasForHover); }, { passive: true });
    canvasForHover.addEventListener("pointerleave", () => { void clearHover(); }, { passive: true });
  }

  let downPos: { x: number; y: number; target: EventTarget | null } | null = null;

  ctx.rightHost.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      downPos = { x: e.clientX, y: e.clientY, target: e.target };
    },
    true,
  );

  ctx.rightHost.addEventListener(
    "pointerup",
    async (e) => {
      const d = downPos;
      downPos = null;
      if (e.button !== 0 || !d) return;

      // Ctrl+LeftClick is multi-selection in both 3D and Floor Plan.
      // box-selection.ts only commits when the pointer actually drags, so a
      // stationary Ctrl click reaches this handler and adds the element.

      // The click must have started on the raw canvas, not on a floating panel.
      const canvas = (ctx.world.renderer.three as THREE.WebGLRenderer)?.domElement;
      if (!canvas || d.target !== canvas) return;

      // Reject drags and gizmo drags.
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved > 4) return;
      if ((ctx.features as any).gizmo?.isDragging?.()) return;
      if (anyBlockingToolActive()) return;

      const hit = await pickFragmentAtPointer();

      // If the authored-element handler already owns this click, do not let
      // the fragment selector clear that selection.
      if (!hit) {
        try {
          const authoring: any = tryUse("authoring") as any;
          const authoredHit = authoring?.pickAuthoredElementAt?.(e as MouseEvent);
          if (authoredHit) return;
        } catch { /* optional authoring bridge */ }

        // Empty click — clear unless a modifier is held.
        await clearHover();
        if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
          selection.replace({});
          await selection.applyToHighlighter();
          clearAuthoredSelection();
        }
        return;
      }

      await clearHover();
      // A 3D viewport has one selection set: selecting a linked/fragment
      // element clears any authored selection, just like BIM.
      clearAuthoredSelection();
      selection.applyClick(hit.modelId, hit.localId, {
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      });
      await selection.applyToHighlighter();
    },
    true,
  );

  console.log("[selection] click-to-select installed");
}

/** Programmatic pick — returns the element under the last cursor position. */
export async function pickUnderCursor(): Promise<{ modelId: string; localId: number } | null> {
  return pickFragmentAtPointer();
}