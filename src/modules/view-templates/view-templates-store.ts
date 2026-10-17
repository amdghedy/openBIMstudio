/**
 * View Templates store – persistent in-memory + localStorage.
 * Exposes window.__obsViewTemplates for console / other modules.
 */

import {
  type ViewTemplate,
  type ViewDefRef,
  type VisibilityGraphicsState,
  type ViewKind,
  type CategoryGraphicOverride,
  createDefaultVg,
  defaultCategoryOverride,
} from "./types";

type Listener = () => void;

const STORAGE_KEY = "obs.viewTemplates.v1";
const VIEW_BINDINGS_KEY = "obs.viewTemplateBindings.v1";

function uid(prefix = "vt"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function mergeVg(
  base: VisibilityGraphicsState,
  local: VisibilityGraphicsState | null | undefined
): VisibilityGraphicsState {
  if (!local) return deepClone(base);
  const out = deepClone(base);
  out.showAnnotations = local.showAnnotations ?? out.showAnnotations;
  out.showModel = local.showModel ?? out.showModel;
  out.detailLevel = local.detailLevel ?? out.detailLevel;
  out.modelDisplay = local.modelDisplay ?? out.modelDisplay;
  if (local.underlay) out.underlay = { ...out.underlay!, ...local.underlay };
  out.filters = local.filters?.length ? deepClone(local.filters) : out.filters;
  for (const [cat, ov] of Object.entries(local.categoryOverrides || {})) {
    out.categoryOverrides[cat] = {
      ...(out.categoryOverrides[cat] ?? defaultCategoryOverride()),
      ...ov,
    };
  }
  return out;
}

class ViewTemplatesStore {
  private templates = new Map<string, ViewTemplate>();
  /** viewId → { templateId, localVg } */
  private bindings = new Map<
    string,
    { templateId: string | null; localVg: VisibilityGraphicsState | null }
  >();
  private listeners = new Set<Listener>();
  private seeded = false;

  constructor() {
    this.load();
    this.ensureSeedTemplates();
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* swallow listener errors */
      }
    }
  }

  private persist(): void {
    try {
      const t = Array.from(this.templates.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
      const b: Record<string, unknown> = {};
      for (const [k, v] of this.bindings) b[k] = v;
      localStorage.setItem(VIEW_BINDINGS_KEY, JSON.stringify(b));
    } catch (e) {
      console.warn("[view-templates] persist failed", e);
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as ViewTemplate[];
        for (const t of arr) this.templates.set(t.id, t);
      }
      const bRaw = localStorage.getItem(VIEW_BINDINGS_KEY);
      if (bRaw) {
        const obj = JSON.parse(bRaw) as Record<
          string,
          { templateId: string | null; localVg: VisibilityGraphicsState | null }
        >;
        for (const [k, v] of Object.entries(obj)) this.bindings.set(k, v);
      }
    } catch (e) {
      console.warn("[view-templates] load failed", e);
    }
  }

  private ensureSeedTemplates(): void {
    if (this.seeded || this.templates.size > 0) {
      this.seeded = true;
      return;
    }
    this.seeded = true;

    const architectural = this.createTemplate({
      name: "Architectural Plan",
      description: "Default architectural floor plan – walls, doors, windows, rooms, dimensions.",
      appliesTo: ["plan", "ceiling"],
      locked: false,
    });
    const vgA = architectural.vg;
    for (const cat of ["StructuralFraming", "Foundations", "Ducts", "Pipes", "CableTrays", "Conduits"]) {
      vgA.categoryOverrides[cat] = { ...defaultCategoryOverride(), visible: false };
    }
    vgA.detailLevel = "medium";
    this.updateTemplate(architectural.id, { vg: vgA });

    const structural = this.createTemplate({
      name: "Structural Plan",
      description: "Structural framing, columns, foundations; architecture lightly shown.",
      appliesTo: ["plan", "section", "elevation"],
      locked: false,
    });
    const vgS = structural.vg;
    for (const cat of ["Ducts", "Pipes", "CableTrays", "Conduits", "MechanicalEquipment", "PlumbingFixtures"]) {
      vgS.categoryOverrides[cat] = { ...defaultCategoryOverride(), visible: false };
    }
    for (const cat of ["Walls", "Doors", "Windows", "Rooms"]) {
      vgS.categoryOverrides[cat] = { ...defaultCategoryOverride(), visible: true, halftone: true };
    }
    this.updateTemplate(structural.id, { vg: vgS });

    const coordination = this.createTemplate({
      name: "Coordination",
      description: "All disciplines visible for clash / coordination views.",
      appliesTo: ["plan", "section", "elevation", "3d"],
      locked: false,
    });
    // leave defaults – everything visible

    const presentation = this.createTemplate({
      name: "Presentation 3D",
      description: "Shaded realistic 3D with annotations off.",
      appliesTo: ["3d"],
      locked: false,
    });
    const vgP = presentation.vg;
    vgP.showAnnotations = false;
    vgP.modelDisplay = "realistic";
    vgP.detailLevel = "fine";
    this.updateTemplate(presentation.id, { vg: vgP });

    void coordination; // used via create
  }

  // ---------- Templates CRUD ----------

  listTemplates(): ViewTemplate[] {
    return Array.from(this.templates.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  getTemplate(id: string): ViewTemplate | null {
    return this.templates.get(id) ?? null;
  }

  createTemplate(opts: {
    name: string;
    description?: string;
    appliesTo?: ViewKind[];
    locked?: boolean;
    vg?: VisibilityGraphicsState;
  }): ViewTemplate {
    const id = uid("vt");
    const t: ViewTemplate = {
      id,
      name: opts.name,
      description: opts.description ?? "",
      appliesTo: opts.appliesTo ?? ["plan", "section", "elevation", "3d"],
      vg: opts.vg ? deepClone(opts.vg) : createDefaultVg(),
      locked: opts.locked ?? false,
      includes: {
        modelCategories: true,
        annotationCategories: true,
        filters: true,
        detailLevel: true,
        modelDisplay: true,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.templates.set(id, t);
    this.persist();
    this.emit();
    return t;
  }

  updateTemplate(
    id: string,
    patch: Partial<Omit<ViewTemplate, "id" | "createdAt">>
  ): ViewTemplate | null {
    const cur = this.templates.get(id);
    if (!cur) return null;
    const next: ViewTemplate = {
      ...cur,
      ...patch,
      id: cur.id,
      createdAt: cur.createdAt,
      updatedAt: nowIso(),
      vg: patch.vg ? deepClone(patch.vg) : cur.vg,
      includes: patch.includes ? { ...cur.includes, ...patch.includes } : cur.includes,
    };
    this.templates.set(id, next);
    this.persist();
    this.emit();
    return next;
  }

  deleteTemplate(id: string): boolean {
    if (!this.templates.has(id)) return false;
    this.templates.delete(id);
    // clear bindings that pointed to it
    for (const [viewId, b] of this.bindings) {
      if (b.templateId === id) {
        this.bindings.set(viewId, { templateId: null, localVg: b.localVg });
      }
    }
    this.persist();
    this.emit();
    return true;
  }

  duplicateTemplate(id: string, newName?: string): ViewTemplate | null {
    const src = this.templates.get(id);
    if (!src) return null;
    return this.createTemplate({
      name: newName ?? `${src.name} (Copy)`,
      description: src.description,
      appliesTo: [...src.appliesTo],
      locked: false,
      vg: deepClone(src.vg),
    });
  }

  // ---------- View bindings ----------

  getViewBinding(viewId: string): {
    templateId: string | null;
    localVg: VisibilityGraphicsState | null;
  } {
    return (
      this.bindings.get(viewId) ?? { templateId: null, localVg: null }
    );
  }

  setViewTemplate(viewId: string, templateId: string | null): void {
    const cur = this.getViewBinding(viewId);
    this.bindings.set(viewId, {
      templateId,
      localVg: cur.localVg,
    });
    this.persist();
    this.emit();
  }

  setViewLocalVg(viewId: string, localVg: VisibilityGraphicsState | null): void {
    const cur = this.getViewBinding(viewId);
    this.bindings.set(viewId, {
      templateId: cur.templateId,
      localVg: localVg ? deepClone(localVg) : null,
    });
    this.persist();
    this.emit();
  }

  /** Effective VG for a view (template + local, respecting lock). */
  getEffectiveVg(viewId: string): VisibilityGraphicsState {
    const b = this.getViewBinding(viewId);
    const tmpl = b.templateId ? this.templates.get(b.templateId) : null;
    if (!tmpl) {
      return b.localVg ? deepClone(b.localVg) : createDefaultVg();
    }
    if (tmpl.locked) return deepClone(tmpl.vg);
    return mergeVg(tmpl.vg, b.localVg);
  }

  /**
   * Apply a template to one or more views.
   * When `overwriteLocal` is true, local overrides are cleared.
   */
  applyTemplateToViews(
    templateId: string,
    viewIds: string[],
    overwriteLocal = true
  ): number {
    const tmpl = this.templates.get(templateId);
    if (!tmpl) return 0;
    let n = 0;
    for (const viewId of viewIds) {
      const cur = this.getViewBinding(viewId);
      this.bindings.set(viewId, {
        templateId,
        localVg: overwriteLocal ? null : cur.localVg,
      });
      n++;
    }
    this.persist();
    this.emit();
    return n;
  }

  /** Build a ViewDefRef list for UI (caller supplies current views). */
  mapViews(views: { id: string; name: string; kind: ViewKind }[]): ViewDefRef[] {
    return views.map((v) => {
      const b = this.getViewBinding(v.id);
      return {
        id: v.id,
        name: v.name,
        kind: v.kind,
        templateId: b.templateId,
        localVg: b.localVg,
        hasLocalOverrides: !!b.localVg,
      };
    });
  }

  /** Push effective category overrides into the existing VisibilityFilter if present. */
  syncToVisibilityFilter(viewId: string): void {
    try {
      const vf = (window as any).__obsVisibility;
      if (!vf || typeof vf.setCategoryOverride !== "function") return;
      const vg = this.getEffectiveVg(viewId);
      for (const [cat, ov] of Object.entries(vg.categoryOverrides)) {
        vf.setCategoryOverride(cat, {
          visible: ov.visible,
          halftone: ov.halftone,
          transparent: ov.transparent,
        });
      }
      // Also respect showAnnotations / showModel at a high level
      if (!vg.showAnnotations) {
        for (const cat of ["Dimensions", "Tags", "TextNotes", "DetailItems", "Grids"]) {
          vf.setCategoryOverride?.(cat, { visible: false });
        }
      }
      if (!vg.showModel) {
        // leave individual categories; caller can decide
      }
    } catch (e) {
      console.warn("[view-templates] syncToVisibilityFilter failed", e);
    }
  }
}

export const viewTemplatesStore = new ViewTemplatesStore();

/** Global for console / other modules. */
export function exposeViewTemplatesGlobal(): void {
  (window as any).__obsViewTemplates = viewTemplatesStore;
}
