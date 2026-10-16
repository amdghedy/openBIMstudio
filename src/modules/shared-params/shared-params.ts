/**
 * Shared / Project Parameters - Revit Shared Parameter analogue.
 *
 * Shared parameters are defined once (GUID + name + type) and can be
 * bound onto any family or project element. Project parameters are
 * project-scoped bindings of shared (or local) parameters onto categories.
 */

import { ctx } from "../../core/context";
import type { ParameterType } from "../families/types";

export interface SharedParameter {
  guid: string;
  name: string;
  type: ParameterType;
  group: string;
  description?: string;
  /** true = instance, false = type */
  instance: boolean;
}

export interface ProjectParameter {
  id: string;
  /** Shared parameter GUID, or local name if not shared. */
  sharedGuid: string | null;
  name: string;
  type: ParameterType;
  group: string;
  instance: boolean;
  /** Categories this parameter applies to (empty = all). */
  categories: string[];
  defaultValue?: unknown;
}

const STORAGE_SHARED = "obs.shared-params.v1";
const STORAGE_PROJECT = "obs.project-params.v1";
type Listener = () => void;

function guid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

class SharedParamsStore {
  private shared = new Map<string, SharedParameter>();
  private project = new Map<string, ProjectParameter>();
  private listeners = new Set<Listener>();
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    try {
      const s = localStorage.getItem(STORAGE_SHARED);
      if (s) {
        for (const p of JSON.parse(s) as SharedParameter[]) {
          this.shared.set(p.guid, p);
        }
      }
      const pr = localStorage.getItem(STORAGE_PROJECT);
      if (pr) {
        for (const p of JSON.parse(pr) as ProjectParameter[]) {
          this.project.set(p.id, p);
        }
      }
    } catch { /* */ }

    // Seed a few common shared parameters
    if (!this.shared.size) {
      this.addShared({
        name: "FireRating",
        type: "text",
        group: "Identity Data",
        instance: false,
        description: "Fire resistance rating",
      });
      this.addShared({
        name: "Mark",
        type: "text",
        group: "Identity Data",
        instance: true,
        description: "Element mark",
      });
      this.addShared({
        name: "Comments",
        type: "text",
        group: "Identity Data",
        instance: true,
      });
      this.addShared({
        name: "OmniClassNumber",
        type: "text",
        group: "Identity Data",
        instance: false,
      });
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_SHARED, JSON.stringify([...this.shared.values()]));
      localStorage.setItem(STORAGE_PROJECT, JSON.stringify([...this.project.values()]));
    } catch { /* */ }
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  listShared(): SharedParameter[] {
    return [...this.shared.values()];
  }

  getShared(guid: string): SharedParameter | null {
    return this.shared.get(guid) ?? null;
  }

  addShared(input: {
    name: string;
    type: ParameterType;
    group: string;
    instance: boolean;
    description?: string;
  }): SharedParameter {
    const p: SharedParameter = {
      guid: guid(),
      name: input.name,
      type: input.type,
      group: input.group,
      instance: input.instance,
      description: input.description,
    };
    this.shared.set(p.guid, p);
    this.persist();
    return p;
  }

  removeShared(g: string): boolean {
    const ok = this.shared.delete(g);
    // Also drop project bindings that reference it
    for (const [id, pp] of this.project) {
      if (pp.sharedGuid === g) this.project.delete(id);
    }
    if (ok) this.persist();
    return ok;
  }

  listProject(): ProjectParameter[] {
    return [...this.project.values()];
  }

  bindToProject(input: {
    sharedGuid?: string | null;
    name: string;
    type: ParameterType;
    group: string;
    instance: boolean;
    categories?: string[];
    defaultValue?: unknown;
  }): ProjectParameter {
    const p: ProjectParameter = {
      id: guid(),
      sharedGuid: input.sharedGuid ?? null,
      name: input.name,
      type: input.type,
      group: input.group,
      instance: input.instance,
      categories: input.categories ?? [],
      defaultValue: input.defaultValue,
    };
    this.project.set(p.id, p);
    this.persist();
    return p;
  }

  unbindProject(id: string): boolean {
    const ok = this.project.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** Parameters applicable to a given element category. */
  forCategory(category: string): ProjectParameter[] {
    return this.listProject().filter(
      (p) => !p.categories.length || p.categories.includes(category),
    );
  }

  /**
   * Build a values map for schedule/export by merging element properties
   * with project parameter defaults.
   */
  resolveValues(
    category: string,
    elementProps: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(elementProps ?? {}) };
    for (const p of this.forCategory(category)) {
      if (!(p.name in out) && p.defaultValue !== undefined) {
        out[p.name] = p.defaultValue;
      }
    }
    return out;
  }

  /** Export shared parameter definitions as a Revit-like text table. */
  exportSharedTxt(): string {
    const lines = [
      "# Open BIM Studio Shared Parameters",
      "# GUID\tName\tType\tGroup\tInstance",
    ];
    for (const p of this.listShared()) {
      lines.push(
        `${p.guid}\t${p.name}\t${p.type}\t${p.group}\t${p.instance ? "1" : "0"}`,
      );
    }
    return lines.join("\n");
  }

  /** Import from tab-separated shared parameter text. */
  importSharedTxt(text: string): number {
    let n = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const [g, name, type, group, inst] = line.split("\t");
      if (!name || !type) continue;
      const p: SharedParameter = {
        guid: g || guid(),
        name,
        type: type as ParameterType,
        group: group || "Other",
        instance: inst === "1" || inst === "true",
      };
      this.shared.set(p.guid, p);
      n++;
    }
    if (n) this.persist();
    return n;
  }
}

export const sharedParamsStore = new SharedParamsStore();

export function setupSharedParams(): typeof sharedParamsStore {
  sharedParamsStore.boot();
  (ctx.features as any).sharedParams = sharedParamsStore;
  (window as any).__obsSharedParams = sharedParamsStore;
  console.log(
    "[shared-params] ready -",
    sharedParamsStore.listShared().length,
    "shared,",
    sharedParamsStore.listProject().length,
    "project",
  );
  return sharedParamsStore;
}
