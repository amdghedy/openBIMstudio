/**
 * View Templates & Graphic Overrides (P1) — Revit View Template parity
 */
export interface GraphicOverride {
  category: string;
  visible?: boolean;
  projectionLineWeight?: number;
  cutLineWeight?: number;
  color?: string;
  transparency?: number;
  halftone?: boolean;
}

export interface ViewFilter {
  id: string;
  name: string;
  categories: string[];
  rules: Array<{ parameter: string; op: "equals" | "contains" | "gt" | "lt"; value: string | number }>;
  enabled: boolean;
}

export interface ViewTemplate {
  id: string;
  name: string;
  overrides: GraphicOverride[];
  filters: string[];
  modelDisplay?: "normal" | "wireframe" | "hidden-line" | "shaded";
  detailLevel?: "coarse" | "medium" | "fine";
}

export interface IViewTemplatesService {
  createTemplate(name: string): ViewTemplate;
  getTemplate(id: string): ViewTemplate | undefined;
  listTemplates(): ViewTemplate[];
  applyToView(viewId: string, templateId: string): boolean;
  addOverride(templateId: string, ov: GraphicOverride): boolean;
  addFilter(filter: ViewFilter): string;
  setApplyHandler(fn: (viewId: string, template: ViewTemplate) => void): void;
}

let _instance: ViewTemplatesService | null = null;

export class ViewTemplatesService implements IViewTemplatesService {
  private templates = new Map<string, ViewTemplate>();
  private filters = new Map<string, ViewFilter>();
  private applyFn: ((viewId: string, template: ViewTemplate) => void) | null = null;

  setApplyHandler(fn: (viewId: string, template: ViewTemplate) => void): void {
    this.applyFn = fn;
  }

  createTemplate(name: string): ViewTemplate {
    const id = `vt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const t: ViewTemplate = {
      id,
      name,
      overrides: [],
      filters: [],
      modelDisplay: "normal",
      detailLevel: "medium",
    };
    this.templates.set(id, t);
    return t;
  }

  getTemplate(id: string): ViewTemplate | undefined {
    return this.templates.get(id);
  }

  listTemplates(): ViewTemplate[] {
    return [...this.templates.values()];
  }

  applyToView(viewId: string, templateId: string): boolean {
    const t = this.templates.get(templateId);
    if (!t) return false;
    this.applyFn?.(viewId, t);
    return true;
  }

  addOverride(templateId: string, ov: GraphicOverride): boolean {
    const t = this.templates.get(templateId);
    if (!t) return false;
    const i = t.overrides.findIndex((o) => o.category === ov.category);
    if (i >= 0) t.overrides[i] = { ...t.overrides[i], ...ov };
    else t.overrides.push(ov);
    return true;
  }

  addFilter(filter: Omit<ViewFilter, "id"> & { id?: string }): string {
    const id = filter.id ?? `vf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const full: ViewFilter = { ...filter, id, enabled: filter.enabled ?? true };
    this.filters.set(id, full);
    return id;
  }
}

export function getViewTemplatesService(): ViewTemplatesService {
  if (!_instance) _instance = new ViewTemplatesService();
  return _instance;
}

export type { IViewTemplatesService, ViewTemplate, GraphicOverride, ViewFilter };
