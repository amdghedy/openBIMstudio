/**
 * Visibility bridge.
 *
 * Problem this fixes: `visibilityFilter` (temporary hide / isolate, category
 * overrides, phase filter, design options) only *computed* answers and emitted
 * change events that nothing listened to, so none of it changed the viewport.
 * Also `ctx.features.selection.getSelectedIds()` did not exist, so the Hide /
 * Isolate / Group buttons always received an empty list.
 *
 * What this module does
 *   1. Re-applies the filter to the AUTHORED meshes (mesh.visible + phase /
 *      halftone opacity) on every filter / phase / design-option / authoring
 *      change, including after every authoring rebuild.
 *   2. Applies it to FRAGMENTS models through OBC.Hider (set / isolate on a
 *      model-id map; category overrides via model.getItemsOfCategories).
 *   3. Adds getSelectedIds() to the selection manager: authored ids plus
 *      "frag:<modelId>::<localId>" keys for fragment items.
 *   4. Adds "assign phase / design option to selection" (nothing in the app
 *      wrote phaseCreated / designOptionId before, so those filters had no
 *      data to act on).
 *
 * Phase / design-option tags live in element.properties.{phaseCreated,
 * phaseDemolished, designOptionId}. Fragment (linked IFC) items are not tagged,
 * so phase / option filters never hide them; hide, isolate and category
 * overrides do.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { visibilityFilter } from "../visibility/visibility-filter";
import { phasesStore } from "../phases/phases";
import { designOptionsStore } from "../design-options/design-options";

type Any = Record<string, any>;
const FRAG_PREFIX = "frag:";

export const fragKey = (modelId: string, localId: number): string => `${FRAG_PREFIX}${modelId}::${localId}`;
export function parseFragKey(k: string): { modelId: string; localId: number } | null {
  if (!k.startsWith(FRAG_PREFIX)) return null;
  const rest = k.slice(FRAG_PREFIX.length);
  const i = rest.lastIndexOf("::");
  if (i < 0) return null;
  const localId = Number(rest.slice(i + 2));
  return Number.isFinite(localId) ? { modelId: rest.slice(0, i), localId } : null;
}

const authoring = (): Any | null => ((ctx.features as Any).authoring ?? (window as Any).__obsAuthoring ?? null);

/** Authored element ids + fragment keys currently selected. */
export function getSelectedKeys(): string[] {
  const out: string[] = [];
  try { for (const id of authoring()?.getSelectedIds?.() ?? []) out.push(String(id)); } catch { /* */ }
  try {
    const snap: Record<string, Iterable<number>> | undefined = (ctx.features as Any).selection?.snapshot?.();
    if (snap) for (const [modelId, ids] of Object.entries(snap)) for (const lid of ids) out.push(fragKey(modelId, lid));
  } catch { /* */ }
  return out;
}

/* ------------------------------------------------------------ authored side */

const ORIG = "__obsVisOrig";
let applyScheduled = false;
let lastActive = false;

function elementTags(el: Any): { phaseCreated: string | null; phaseDemolished: string | null; designOptionId: string | null } {
  const pr = el.properties ?? {};
  return {
    phaseCreated: (el.phaseCreated ?? pr.phaseCreated ?? null) as string | null,
    phaseDemolished: (el.phaseDemolished ?? pr.phaseDemolished ?? null) as string | null,
    designOptionId: (el.designOptionId ?? pr.designOptionId ?? null) as string | null,
  };
}

function filterInternals(): { hidden: Set<string>; isolated: Set<string> | null; categories: Map<string, { visible: boolean; halftone: boolean; transparent: boolean }> } {
  const f = visibilityFilter as unknown as Any;
  return {
    hidden: (f.tempHidden as Set<string>) ?? new Set(),
    isolated: (f.tempIsolated as Set<string> | null) ?? null,
    categories: (f.categoryOverrides as Map<string, any>) ?? new Map(),
  };
}

function anyOverride(elements: Any[]): boolean {
  const { hidden, isolated, categories } = filterInternals();
  if (hidden.size || isolated) return true;
  for (const c of categories.values()) if (!c.visible || c.halftone || c.transparent) return true;
  try {
    if (phasesStore.getFilter() !== ("show-all" as any)) { for (const e of elements) { const t = elementTags(e); if (t.phaseCreated || t.phaseDemolished) return true; } }
  } catch { /* */ }
  for (const e of elements) if (elementTags(e).designOptionId) return true;
  return false;
}

function setOpacity(mesh: THREE.Mesh | Any, opacity: number): void {
  const mats: Any[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    if (!m) continue;
    if (!m.userData) m.userData = {};
    if (!m.userData[ORIG]) m.userData[ORIG] = { transparent: !!m.transparent, opacity: typeof m.opacity === "number" ? m.opacity : 1 };
    if (opacity < 0.999) { m.transparent = true; m.opacity = opacity; }
    else { m.transparent = m.userData[ORIG].transparent; m.opacity = m.userData[ORIG].opacity; }
    m.needsUpdate = true;
  }
}

/** Apply the filter to every authored mesh. Returns the number of hidden meshes. */
export function applyAuthored(force = false): number {
  const a = authoring();
  const group: THREE.Object3D | undefined = a?.getAuthoredGroup?.();
  if (!a || !group) return 0;
  const elements: Any[] = a.getElements?.() ?? [];
  const active = anyOverride(elements);
  if (!active && !lastActive && !force) return 0;
  const byId = new Map<string, Any>();
  for (const e of elements) byId.set(e.id, e);
  let hiddenCount = 0;
  group.traverse((o: any) => {
    if (!o.isMesh) return;
    const id = o.userData?.elementId as string | undefined;
    if (!id) return;
    const el = byId.get(id);
    if (!el) return;
    const tags = elementTags(el);
    const ve = { id, category: String(el.type), ...tags };
    const vis = visibilityFilter.isVisible(ve);
    o.visible = vis;
    if (!vis) hiddenCount++;
    const gs = visibilityFilter.graphicStyle(ve);
    setOpacity(o, vis ? gs.opacity : 1);
  });
  lastActive = active;
  return hiddenCount;
}

/* ----------------------------------------------------------- fragments side */

/** Authored category (element type) -> IFC class patterns for linked models. */
const CATEGORY_TO_IFC: Record<string, RegExp[]> = {
  wall: [/^IFCWALL/i, /^IFCCURTAINWALL/i], slab: [/^IFCSLAB/i], roof: [/^IFCROOF/i], ceiling: [/^IFCCOVERING/i],
  column: [/^IFCCOLUMN/i], beam: [/^IFCBEAM/i], brace: [/^IFCMEMBER/i], footing: [/^IFCFOOTING/i, /^IFCPILE/i],
  door: [/^IFCDOOR/i], window: [/^IFCWINDOW/i], stairs: [/^IFCSTAIR/i], railing: [/^IFCRAILING/i], ramp: [/^IFCRAMP/i],
  duct: [/^IFCDUCT/i], pipe: [/^IFCPIPE/i], "cable-tray": [/^IFCCABLECARRIER/i], conduit: [/^IFCCABLECARRIER/i],
  equipment: [/^IFCFLOWTERMINAL/i, /^IFCFLOWCONTROLLER/i, /^IFCDISTRIBUTIONELEMENT/i, /^IFCFURNISHING/i],
  room: [/^IFCSPACE/i], area: [/^IFCSPACE/i],
};

function categoryPatterns(cat: string): RegExp[] {
  if (/^ifc/i.test(cat)) return [new RegExp("^" + cat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i")];
  return CATEGORY_TO_IFC[cat] ?? [];
}

type IdMap = Record<string, Set<number>>;
let fragTouched = false;
let fragQueue: Promise<void> = Promise.resolve();

async function applyFragmentsNow(): Promise<void> {
  const hider: Any | null = (ctx as Any).hider;
  const frags: Any | null = (ctx as Any).fragments;
  if (!hider || !frags?.list) return;
  const { hidden, isolated, categories } = filterInternals();

  const toMap = (keys: Iterable<string>): IdMap => {
    const m: IdMap = {};
    for (const k of keys) { const p = parseFragKey(k); if (p) (m[p.modelId] ??= new Set()).add(p.localId); }
    return m;
  };
  const hasItems = (m: IdMap) => Object.values(m).some((s) => s.size > 0);

  const hiddenMap = toMap(hidden);
  // category overrides -> item ids per model
  const hiddenCats = [...categories.entries()].filter(([, c]) => !c.visible).map(([k]) => k);
  if (hiddenCats.length) {
    const pats = hiddenCats.flatMap(categoryPatterns);
    if (pats.length) {
      for (const [modelId, model] of frags.list as Map<string, Any>) {
        try {
          const found = (await model.getItemsOfCategories(pats)) as Record<string, number[]>;
          const ids = Object.values(found).flat();
          if (ids.length) { const s = (hiddenMap[modelId] ??= new Set()); for (const i of ids) s.add(i); }
        } catch (e) { console.warn("[visibility-bridge] getItemsOfCategories failed for", modelId, e); }
      }
    }
  }

  const callSet = async (visible: boolean, map?: IdMap) => {
    if (typeof hider.set === "function") { await (map ? hider.set(visible, map) : hider.set(visible)); return true; }
    if (!visible && typeof hider.hide === "function") { await hider.hide(map); return true; }
    if (visible && typeof hider.show === "function") { await hider.show(map); return true; }
    return false;
  };

  if (isolated) {
    const isoMap = toMap(isolated);
    if (hasItems(isoMap)) {
      if (typeof hider.isolate === "function") await hider.isolate(isoMap);
      else { await callSet(false); await callSet(true, isoMap); }
    } else {
      await callSet(false); // isolating authored-only items hides every linked model item
    }
    fragTouched = true;
  } else if (hasItems(hiddenMap)) {
    await callSet(true);
    await callSet(false, hiddenMap);
    fragTouched = true;
  } else if (fragTouched) {
    await callSet(true);
    fragTouched = false;
  } else {
    return; // nothing to do: leave the context-menu's own hide/isolate alone
  }
  try { frags.core?.update?.(true); } catch { /* */ }
}

function applyFragments(): Promise<void> {
  fragQueue = fragQueue.then(applyFragmentsNow).catch((e) => console.warn("[visibility-bridge] fragments apply failed", e));
  return fragQueue;
}

/* ---------------------------------------------------------------- plumbing */

function scheduleApply(): void {
  if (applyScheduled) return;
  applyScheduled = true;
  queueMicrotask(() => {
    applyScheduled = false;
    try { applyAuthored(); } catch (e) { console.warn("[visibility-bridge] authored apply failed", e); }
  });
}

function applyAll(): void {
  try { applyAuthored(true); } catch (e) { console.warn("[visibility-bridge] authored apply failed", e); }
  void applyFragments();
}

let installed = false;
export function setupVisibilityBridge(): { ok: boolean; detail: string } {
  if (installed) return { ok: true, detail: "already installed" };
  installed = true;

  visibilityFilter.onChange(applyAll);
  try { phasesStore.onChange(applyAll); } catch { /* */ }
  try { designOptionsStore.onChange(applyAll); } catch { /* */ }

  // Re-apply after every authoring rebuild: rebuild() re-creates meshes with group.add().
  const hookGroup = () => {
    const g: THREE.Object3D | undefined = authoring()?.getAuthoredGroup?.();
    if (!g) return false;
    if ((g as Any).__obsVisHooked) return true;
    const origAdd = g.add.bind(g);
    (g as Any).add = (...objs: THREE.Object3D[]) => { const r = origAdd(...objs); scheduleApply(); return r; };
    (g as Any).__obsVisHooked = true;
    return true;
  };
  const a = authoring();
  if (a?.onAuthoringChange) a.onAuthoringChange(scheduleApply);
  if (!hookGroup()) {
    const t = setInterval(() => { if (hookGroup()) clearInterval(t); }, 500);
    setTimeout(() => clearInterval(t), 60_000);
  }

  // The selection manager has no getSelectedIds(); several buttons call it.
  const installSel = () => {
    const sel: Any | undefined = (ctx.features as Any).selection;
    if (!sel) return false;
    if (typeof sel.getSelectedIds !== "function") sel.getSelectedIds = getSelectedKeys;
    return true;
  };
  if (!installSel()) {
    const t = setInterval(() => { if (installSel()) clearInterval(t); }, 500);
    setTimeout(() => clearInterval(t), 60_000);
  }
  return { ok: true, detail: "authored + fragments visibility wired" };
}

/* ------------------------------------------------- public helper operations */

export function hideSelection(): number {
  const keys = getSelectedKeys();
  if (!keys.length) { notify("info", "Select elements first"); return 0; }
  visibilityFilter.hideElements(keys);
  return keys.length;
}
export function isolateSelection(): number {
  const keys = getSelectedKeys();
  if (!keys.length) { notify("info", "Select elements first"); return 0; }
  visibilityFilter.isolateElements(keys);
  return keys.length;
}
export function resetTemporaryVisibility(): void { visibilityFilter.resetTemporary(); }

async function markProjectDirty(): Promise<void> {
  try { (await import("../projects/projects")).markDirty(); } catch { /* */ }
}

/** Write phase / design-option tags onto the selected authored elements. */
export async function tagSelection(patch: { phaseCreated?: string | null; phaseDemolished?: string | null; designOptionId?: string | null }): Promise<number> {
  const a = authoring();
  if (!a) return 0;
  const ids: string[] = a.getSelectedIds?.() ?? [];
  let n = 0;
  for (const id of ids) {
    const el: Any | undefined = a.getElementById?.(id);
    if (!el) continue;
    el.properties = { ...(el.properties ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete el.properties[k]; else el.properties[k] = v;
    }
    n++;
  }
  if (n) { await markProjectDirty(); applyAll(); }
  return n;
}

function pick<T extends { id: string; name: string }>(title: string, items: T[], allowNone = true): string | null | undefined {
  if (!items.length) { notify("warn", `${title}: none defined yet`); return undefined; }
  const lines = items.map((it, i) => `${i + 1}. ${it.name}`).join("\n");
  const ans = window.prompt(`${title}\n${lines}${allowNone ? "\n0. (none)" : ""}`, "1");
  if (ans === null) return undefined;
  const i = Number(ans.trim());
  if (allowNone && i === 0) return null;
  return Number.isInteger(i) && i >= 1 && i <= items.length ? items[i - 1].id : undefined;
}

export async function promptAssignPhase(kind: "created" | "demolished"): Promise<void> {
  const id = pick(`Phase ${kind} for selection`, phasesStore.list() as Array<{ id: string; name: string }>);
  if (id === undefined) return;
  const n = await tagSelection(kind === "created" ? { phaseCreated: id } : { phaseDemolished: id });
  notify(n ? "success" : "info", n ? `Phase ${kind} set on ${n} element(s)` : "Select authored elements first");
}

export async function promptAssignDesignOption(): Promise<void> {
  const opts: Array<{ id: string; name: string }> = [];
  for (const s of designOptionsStore.listSets()) for (const o of s.options) opts.push({ id: o.id, name: `${s.name} / ${o.name}` });
  const id = pick("Design option for selection", opts);
  if (id === undefined) return;
  const n = await tagSelection({ designOptionId: id });
  notify(n ? "success" : "info", n ? `Design option set on ${n} element(s)` : "Select authored elements first");
}
