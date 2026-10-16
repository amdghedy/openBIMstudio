/**
 * Federation manager.
 *
 * Single source of truth for how multiple loaded fragment models are
 * displayed. Applies transforms, colors, opacity and visibility through
 * the Fragments runtime.
 *
 * Reacts to:
 *   • fragments.list.onItemSet / onItemDeleted — auto-registers new models
 *   • project load — restores the persisted federation
 *
 * Emits:
 *   • "obs-federation-changed" on any mutation
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { diagnostics } from "../../core/diagnostics";
import { markDirty } from "../projects/projects";
import {
  DISCIPLINE_COLORS,
  type Discipline,
  type FederationEntry,
  type FederationState,
} from "./types";

const DISCIPLINE_GUESSERS: Array<{ re: RegExp; discipline: Discipline }> = [
  { re: /(^|[_\-\s])(arc|arch|architecture|architectural)/i,     discipline: "ARC" },
  { re: /(^|[_\-\s])(str|struct|structural|structure)/i,          discipline: "STR" },
  { re: /(^|[_\-\s])(mech|mechanical|hvac|supply|return)/i,       discipline: "MEP-M" },
  { re: /(^|[_\-\s])(elec|electrical|lighting|power)/i,           discipline: "MEP-E" },
  { re: /(^|[_\-\s])(plumb|plumbing|sanitary|domestic)/i,         discipline: "MEP-P" },
  { re: /(^|[_\-\s])(fire|sprinkler|suppression)/i,               discipline: "MEP-F" },
  { re: /(^|[_\-\s])(elv|ict|telecom|data|cctv|security|av)/i,    discipline: "ELV" },
  { re: /(^|[_\-\s])(fab|fabrication|steel|ductwork)/i,           discipline: "FAB" },
  { re: /(^|[_\-\s])(land|landscape|planting)/i,                  discipline: "LAND" },
  { re: /(^|[_\-\s])(site|topograph|topography)/i,                discipline: "SITE" },
  { re: /(^|[_\-\s])(civil|infra|infrastructure|road|rail)/i,     discipline: "CIVIL" },
];

export function guessDiscipline(name: string): Discipline {
  for (const g of DISCIPLINE_GUESSERS) {
    if (g.re.test(name)) return g.discipline;
  }
  return "OTHER";
}

class FederationManager {
  private entries = new Map<string, FederationEntry>();
  private isolated = new Set<string>();
  private strategy: FederationState["strategy"] = "discipline";
  private listeners = new Set<() => void>();
  private initialized = false;

  /* ── Lifecycle ─────────────────────────────────────────────────── */

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Auto-register models that arrive after setup.
    try {
      ctx.fragments.list.onItemSet.add(({ key, value }: any) => {
        this.registerModel(String(key), this.nameFor(value) ?? String(key));
      });
      ctx.fragments.list.onItemDeleted.add((evt: any) => {
        const key = typeof evt === "object" && evt !== null && "key" in evt ? evt.key : evt;
        this.entries.delete(String(key));
        this.isolated.delete(String(key));
        this.emit();
      });
    } catch (err) {
      diagnostics.warn("federation.init", "listener attach failed", err);
    }

    // Boot: scan current models.
    try {
      for (const [id, model] of ctx.fragments.list) {
        this.registerModel(String(id), this.nameFor(model) ?? String(id));
      }
    } catch { /* */ }

    console.log(`[federation] ready · ${this.entries.size} model(s)`);
  }

  private nameFor(model: any): string | null {
    return model?.name ?? model?.modelName ?? null;
  }

  /* ── Mutation ──────────────────────────────────────────────────── */

  registerModel(modelId: string, name: string): FederationEntry {
    const existing = this.entries.get(modelId);
    if (existing) return existing;

    const discipline = guessDiscipline(name);
    const entry: FederationEntry = {
      modelId,
      name,
      discipline,
      transform: null,
      priority: this.entries.size,
      visible: true,
      opacity: 1,
      addedAt: Date.now(),
    };
    this.entries.set(modelId, entry);
    this.applyEntry(entry);
    this.emit();
    return entry;
  }

  unregisterModel(modelId: string): void {
    if (this.entries.delete(modelId)) {
      this.isolated.delete(modelId);
      this.emit();
    }
  }

  setDiscipline(modelId: string, discipline: Discipline): void {
    const e = this.entries.get(modelId);
    if (!e) return;
    e.discipline = discipline;
    this.applyEntry(e);
    this.emit();
    markDirty();
  }

  setColor(modelId: string, color: string | null): void {
    const e = this.entries.get(modelId);
    if (!e) return;
    e.color = color ?? undefined;
    this.applyEntry(e);
    this.emit();
    markDirty();
  }

  setVisible(modelId: string, visible: boolean): void {
    const e = this.entries.get(modelId);
    if (!e) return;
    e.visible = visible;
    this.applyEntry(e);
    this.emit();
    markDirty();
  }

  setOpacity(modelId: string, opacity: number): void {
    const e = this.entries.get(modelId);
    if (!e) return;
    e.opacity = Math.max(0, Math.min(1, opacity));
    this.applyEntry(e);
    this.emit();
    markDirty();
  }

  setPriority(modelId: string, priority: number): void {
    const e = this.entries.get(modelId);
    if (!e) return;
    e.priority = priority;
    this.applyOrdering();
    this.emit();
    markDirty();
  }

  setTransform(modelId: string, transform: number[] | null): void {
    const e = this.entries.get(modelId);
    if (!e) return;
    e.transform = transform ? [...transform] : null;
    this.applyEntry(e);
    this.emit();
    markDirty();
  }

  resetTransform(modelId: string): void {
    this.setTransform(modelId, null);
  }

  /** Align two models by their AABB centers. */
  alignToModel(sourceId: string, targetId: string): void {
    const src = ctx.fragments.list.get(sourceId) as any;
    const tgt = ctx.fragments.list.get(targetId) as any;
    if (!src || !tgt) return;
    const b1 = new THREE.Box3().setFromObject(src.object);
    const b2 = new THREE.Box3().setFromObject(tgt.object);
    if (b1.isEmpty() || b2.isEmpty()) return;
    const c1 = b1.getCenter(new THREE.Vector3());
    const c2 = b2.getCenter(new THREE.Vector3());
    const dx = c2.x - c1.x, dy = c2.y - c1.y, dz = c2.z - c1.z;
    const m = new THREE.Matrix4().makeTranslation(dx, dy, dz);
    this.setTransform(sourceId, Array.from(m.elements));
  }

  setStrategy(strategy: FederationState["strategy"]): void {
    this.strategy = strategy;
    for (const e of this.entries.values()) this.applyEntry(e);
    this.emit();
  }

  isolate(modelIds: string[]): void {
    this.isolated = new Set(modelIds);
    for (const e of this.entries.values()) this.applyEntry(e);
    this.emit();
  }

  clearIsolation(): void {
    this.isolated.clear();
    for (const e of this.entries.values()) this.applyEntry(e);
    this.emit();
  }

  /* ── Apply to scene ────────────────────────────────────────────── */

  private applyEntry(e: FederationEntry): void {
    const model = ctx.fragments.list.get(e.modelId) as any;
    if (!model?.object) return;
    const obj = model.object as THREE.Object3D;

    // Visibility
    obj.visible = e.visible &&
      (this.isolated.size === 0 || this.isolated.has(e.modelId));

    // Transform
    if (e.transform) {
      const m = new THREE.Matrix4().fromArray(e.transform);
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(m);
      obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
    } else {
      obj.matrixAutoUpdate = true;
    }

    // Colour strategy
    const targetColor = this.pickColor(e);
    if (this.strategy === "discipline" || this.strategy === "model") {
      applyColorToModel(model, targetColor, e.opacity);
    } else {
      applyColorToModel(model, null, e.opacity);
    }
  }

  private pickColor(e: FederationEntry): string | null {
    if (this.strategy === "neutral") return null;
    if (e.color) return e.color;
    if (this.strategy === "discipline") return DISCIPLINE_COLORS[e.discipline];
    // model strategy — deterministic hash-based
    return hashColor(e.modelId);
  }

  private applyOrdering(): void {
    const sorted = [...this.entries.values()].sort((a, b) => a.priority - b.priority);
    for (const e of sorted) {
      const model = ctx.fragments.list.get(e.modelId) as any;
      if (!model?.object) continue;
      ctx.world.scene.three.remove(model.object);
      ctx.world.scene.three.add(model.object);
    }
  }

  /* ── Serialization ─────────────────────────────────────────────── */

  serialize(): FederationState {
    return {
      entries: [...this.entries.values()].map((e) => ({
        ...e,
        transform: e.transform ? [...e.transform] : null,
      })),
      isolated: [...this.isolated],
      strategy: this.strategy,
      updatedAt: Date.now(),
    };
  }

  deserialize(state: FederationState | null | undefined): void {
    if (!state) return;
    this.entries.clear();
    this.isolated = new Set(state.isolated ?? []);
    this.strategy = state.strategy ?? "discipline";
    for (const e of state.entries ?? []) {
      this.entries.set(e.modelId, { ...e });
    }
    // Reapply to any model currently loaded.
    for (const [id, model] of ctx.fragments.list) {
      if (!this.entries.has(String(id))) {
        this.registerModel(String(id), this.nameFor(model) ?? String(id));
      }
    }
    for (const e of this.entries.values()) this.applyEntry(e);
    this.applyOrdering();
    this.emit();
  }

  /* ── Queries + events ──────────────────────────────────────────── */

  list(): FederationEntry[] {
    return [...this.entries.values()].sort((a, b) => a.priority - b.priority);
  }

  get(modelId: string): FederationEntry | null {
    return this.entries.get(modelId) ?? null;
  }

  getIsolated(): string[] { return [...this.isolated]; }

  getStrategy(): FederationState["strategy"] { return this.strategy; }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
    try {
      window.dispatchEvent(new CustomEvent("obs-federation-changed"));
    } catch { /* */ }
  }
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function hashColor(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  const hue = h % 360;
  return hslToHex(hue, 45, 65);
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

/**
 * Apply a global colour and opacity to every material of a fragment model.
 * The fragments runtime stores a per-material handle; overriding at the
 * object level is safe because fragment materials are shared per model.
 */
function applyColorToModel(model: any, color: string | null, opacity: number): void {
  const obj: THREE.Object3D | undefined = model?.object;
  if (!obj) return;
  const tint = color ? new THREE.Color(color) : null;

  obj.traverse((child: any) => {
    if (!child.isMesh && !child.isPoints && !child.isLine) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m) continue;
      if (!m.userData.__obsFedOrig) {
        m.userData.__obsFedOrig = {
          color: m.color ? m.color.getHex() : null,
          opacity: m.opacity,
          transparent: m.transparent,
        };
      }
      const orig = m.userData.__obsFedOrig;
      if (tint && m.color) m.color.copy(tint);
      else if (!tint && m.color && orig.color != null) m.color.setHex(orig.color);

      if (opacity < 1) {
        m.transparent = true;
        m.opacity = opacity;
      } else {
        m.opacity = orig.opacity;
        m.transparent = orig.transparent;
      }
      m.needsUpdate = true;
    }
  });
}

export const federation = new FederationManager();