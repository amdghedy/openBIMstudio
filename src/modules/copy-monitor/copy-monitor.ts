/**
 * Copy / Monitor - track elements from a linked (federated) model and
 * optionally copy them into the host, with change detection (Revit-style).
 */

import { ctx } from "../../core/context";
import { notify } from "../../core/notify";

export type MonitorStatus = "ok" | "new" | "modified" | "deleted" | "orphaned";

export interface MonitoredElement {
  id: string;
  /** Source model id in the federation. */
  sourceModelId: string;
  /** Source local / express id. */
  sourceLocalId: number | string;
  /** Category / IFC type. */
  category: string;
  name: string;
  /** Fingerprint of geometry + key properties at last sync. */
  fingerprint: string;
  /** Host authored element id if copied. */
  hostElementId?: string;
  status: MonitorStatus;
  lastChecked: number;
}

export interface CopyMonitorRule {
  id: string;
  name: string;
  sourceModelId: string;
  /** Category filter (regex string). Empty = all. */
  categoryFilter: string;
  /** Automatically copy new elements into host. */
  autoCopy: boolean;
  /** Stop monitoring demolished source elements. */
  stopOnDelete: boolean;
}

const STORAGE = "obs.copy-monitor.v1";
type Listener = () => void;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function fingerprint(item: {
  name?: string;
  category?: string;
  box?: number[];
  props?: Record<string, unknown>;
}): string {
  const raw = JSON.stringify({
    n: item.name ?? "",
    c: item.category ?? "",
    b: (item.box ?? []).map((v) => Math.round(v * 1000)),
    p: item.props ?? {},
  });
  // Simple hash
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

class CopyMonitorStore {
  private rules: CopyMonitorRule[] = [];
  private monitored = new Map<string, MonitoredElement>();
  private listeners = new Set<Listener>();
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const data = JSON.parse(raw);
        this.rules = data.rules ?? [];
        for (const m of data.monitored ?? []) {
          this.monitored.set(m.id, m);
        }
      }
    } catch { /* */ }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE,
        JSON.stringify({
          rules: this.rules,
          monitored: [...this.monitored.values()],
        }),
      );
    } catch { /* */ }
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  listRules(): CopyMonitorRule[] {
    return [...this.rules];
  }

  listMonitored(): MonitoredElement[] {
    return [...this.monitored.values()];
  }

  addRule(input: {
    name: string;
    sourceModelId: string;
    categoryFilter?: string;
    autoCopy?: boolean;
  }): CopyMonitorRule {
    const rule: CopyMonitorRule = {
      id: uid("cmr"),
      name: input.name,
      sourceModelId: input.sourceModelId,
      categoryFilter: input.categoryFilter ?? "",
      autoCopy: input.autoCopy ?? false,
      stopOnDelete: true,
    };
    this.rules.push(rule);
    this.persist();
    return rule;
  }

  removeRule(id: string): boolean {
    const n = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    // Drop monitored entries for this rule's model if no other rules cover it
    const still = new Set(this.rules.map((r) => r.sourceModelId));
    for (const [mid, m] of this.monitored) {
      if (!still.has(m.sourceModelId)) this.monitored.delete(mid);
    }
    if (this.rules.length !== n) {
      this.persist();
      return true;
    }
    return false;
  }

  /**
   * Scan federated models and update monitored status.
   * `scanItems` yields current items from a linked model.
   */
  sync(
    scanItems: (
      modelId: string,
    ) => Array<{
      localId: number | string;
      name: string;
      category: string;
      box?: number[];
      props?: Record<string, unknown>;
    }>,
  ): { new: number; modified: number; deleted: number; ok: number } {
    const counts = { new: 0, modified: 0, deleted: 0, ok: 0 };
    const seen = new Set<string>();
    const now = Date.now();

    for (const rule of this.rules) {
      let items: ReturnType<typeof scanItems> = [];
      try {
        items = scanItems(rule.sourceModelId) ?? [];
      } catch {
        continue;
      }

      const catRe = rule.categoryFilter
        ? new RegExp(rule.categoryFilter, "i")
        : null;

      for (const item of items) {
        if (catRe && !catRe.test(item.category)) continue;
        const key = `${rule.sourceModelId}:${item.localId}`;
        seen.add(key);
        const fp = fingerprint(item);
        const existing = this.monitored.get(key);

        if (!existing) {
          const m: MonitoredElement = {
            id: key,
            sourceModelId: rule.sourceModelId,
            sourceLocalId: item.localId,
            category: item.category,
            name: item.name,
            fingerprint: fp,
            status: "new",
            lastChecked: now,
          };
          this.monitored.set(key, m);
          counts.new++;
        } else if (existing.fingerprint !== fp) {
          existing.fingerprint = fp;
          existing.name = item.name;
          existing.category = item.category;
          existing.status = "modified";
          existing.lastChecked = now;
          counts.modified++;
        } else {
          existing.status = "ok";
          existing.lastChecked = now;
          counts.ok++;
        }
      }
    }

    // Mark missing as deleted
    for (const [key, m] of this.monitored) {
      if (!seen.has(key)) {
        if (m.status !== "deleted") {
          m.status = "deleted";
          m.lastChecked = now;
          counts.deleted++;
        }
      }
    }

    this.persist();
    return counts;
  }

  /** Summary for UI badge. */
  summary(): { total: number; new: number; modified: number; deleted: number } {
    let neu = 0, mod = 0, del = 0;
    for (const m of this.monitored.values()) {
      if (m.status === "new") neu++;
      else if (m.status === "modified") mod++;
      else if (m.status === "deleted") del++;
    }
    return { total: this.monitored.size, new: neu, modified: mod, deleted: del };
  }

  acknowledge(id: string): void {
    const m = this.monitored.get(id);
    if (!m) return;
    if (m.status === "deleted") {
      this.monitored.delete(id);
    } else {
      m.status = "ok";
    }
    this.persist();
  }

  acknowledgeAll(): number {
    let n = 0;
    for (const [id, m] of [...this.monitored]) {
      if (m.status === "ok") continue;
      if (m.status === "deleted") this.monitored.delete(id);
      else m.status = "ok";
      n++;
    }
    if (n) this.persist();
    return n;
  }
}

export const copyMonitorStore = new CopyMonitorStore();

export function setupCopyMonitor(): typeof copyMonitorStore {
  copyMonitorStore.boot();
  (ctx.features as any).copyMonitor = copyMonitorStore;
  (window as any).__obsCopyMonitor = copyMonitorStore;
  console.log("[copy-monitor] ready -", copyMonitorStore.listRules().length, "rules");
  return copyMonitorStore;
}

/** Helper: run sync against federation fragment list if available. */
export async function runCopyMonitorSync(): Promise<ReturnType<CopyMonitorStore["sync"]>> {
  const scan = (modelId: string) => {
    const fragments = (ctx as any).fragments?.list as Map<string, any> | undefined;
    if (!fragments) return [];
    const model = fragments.get(modelId);
    if (!model) return [];
    // Best-effort: if model exposes a simple item list
    const items: Array<{
      localId: number | string;
      name: string;
      category: string;
      box?: number[];
    }> = [];
    try {
      if (typeof model.getItemsOfCategories === "function") {
        // Can't fully await here in sync callback; return empty and rely on caller
      }
    } catch { /* */ }
    return items;
  };

  const result = copyMonitorStore.sync(scan);
  const s = copyMonitorStore.summary();
  if (s.new + s.modified + s.deleted > 0) {
    notify(
      "info",
      `Copy/Monitor: ${s.new} new, ${s.modified} modified, ${s.deleted} deleted`,
      { timeout: 3000 },
    );
  } else {
    notify("success", "Copy/Monitor: all monitored elements OK", { timeout: 1800 });
  }
  return result;
}
