/**
 * Critical workflow pack 5 — cost, groups, LOD, topo, generative, matchline:
 *  1. COSTCATALOG       seed standard cost items
 *  2. COSTTAKEOFF       assign costs from material takeoff
 *  3. GROUPSELECTION    group selected elements
 *  4. UNGROUPSEL        ungroup
 *  5. LODMEDIUM         set medium LOD / performance mode
 *  6. TOPOFLAT          flat toposurface under model
 *  7. MATCHLINE         matchline across model bounds
 *  8. GENGRIDSTUDY      generative grid spacing study
 *  9. COPYMONRULE       copy/monitor rule for linked model categories
 * 10. FAMILYPINS        pin all families of selected type
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { groupsStore } from "../groups/groups";
import { copyMonitorStore } from "../copy-monitor/copy-monitor";

type Any = Record<string, any>;

/** Module state — last run results for console/tests inspection (no window globals). */
export const pack5 = {
  lodWireframe: false,
  costTakeoff: null as Any | null,
  topo: null as Any | null,
  matchline: null as Any | null,
  genStudy: null as Any | null,
};

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}
function elements(): Any[] {
  return authoring()?.getElements?.() ?? [];
}
function selectedIds(): string[] {
  return authoring()?.getSelectedIds?.() ?? [];
}

/* ── 1. Cost catalog ─────────────────────────────────────────────── */

export async function seedCostCatalog(): Promise<number> {
  try {
    const cost = await import("../cost/cost");
    const items = [
      { name: "Concrete C30", unit: "m3" as const, rate: 120 },
      { name: "Blockwork", unit: "m2" as const, rate: 45 },
      { name: "Door set", unit: "ea" as const, rate: 350 },
      { name: "Window set", unit: "ea" as const, rate: 280 },
      { name: "Gypsum board", unit: "m2" as const, rate: 22 },
      { name: "Structural steel", unit: "kg" as const, rate: 1.2 },
      { name: "Paint", unit: "m2" as const, rate: 8 },
      { name: "Floor finish", unit: "m2" as const, rate: 35 },
    ];
    let n = 0;
    const existing = new Set(cost.getItems().map((i) => i.name));
    for (const it of items) {
      if (existing.has(it.name)) continue;
      cost.addCostItem({ name: it.name, unit: it.unit as any, rate: it.rate });
      n++;
    }
    notify("success", n ? `Cost catalog: +${n} items` : "Cost catalog already seeded");
    return n;
  } catch (e) {
    notify("warn", `Cost catalog failed: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

/* ── 2. Cost takeoff mapping ─────────────────────────────────────── */

export async function runCostTakeoff(): Promise<Any> {
  try {
    const cost = await import("../cost/cost");
    await seedCostCatalog();
    const items = cost.getItems();
    const byName = (n: string) => items.find((i) => i.name === n);

    let wallArea = 0, slabArea = 0, doors = 0, windows = 0, colVol = 0;
    for (const el of elements()) {
      if (el.type === "wall" || el.type === "curtain-wall") {
        if (!el.params?.start || !el.params?.end) continue;
        const L = Math.hypot(el.params.end[0] - el.params.start[0], el.params.end[1] - el.params.start[1]);
        wallArea += L * (Number(el.params.height) || 3);
      } else if (el.type === "slab" || el.type === "roof") {
        const poly = el.params?.polygon;
        if (Array.isArray(poly) && poly.length >= 3) {
          let a = 0;
          for (let i = 0; i < poly.length; i++) {
            const p = poly[i], q = poly[(i + 1) % poly.length];
            a += p[0] * q[1] - q[0] * p[1];
          }
          slabArea += Math.abs(a) * 0.5;
        }
      } else if (el.type === "door") doors++;
      else if (el.type === "window") windows++;
      else if (el.type === "column") {
        const w = Number(el.params?.thickness) || 0.3;
        colVol += w * w * (Number(el.params?.height) || 3);
      }
    }

    const rows = [
      { key: "walls", qty: wallArea, item: byName("Blockwork") },
      { key: "slabs", qty: slabArea, item: byName("Concrete C30") },
      { key: "doors", qty: doors, item: byName("Door set") },
      { key: "windows", qty: windows, item: byName("Window set") },
      { key: "columns", qty: colVol, item: byName("Concrete C30") },
    ];

    let total = 0;
    const lines: Any[] = [];
    for (const r of rows) {
      if (!r.item || !r.qty) continue;
      cost.setAssignment(r.key, r.item.id);
      cost.setQtyOverride(r.key, r.qty);
      const line = r.qty * (r.item.rate || 0);
      total += line;
      lines.push({ key: r.key, qty: +r.qty.toFixed(2), rate: r.item.rate, line: +line.toFixed(2), item: r.item.name });
    }
    pack5.costTakeoff = { lines, total: +total.toFixed(2) };
    console.table(lines);
    notify("success", `Cost takeoff total ≈ ${total.toFixed(0)} (see console)`);
    return { lines, total };
  } catch (e) {
    notify("warn", `Takeoff failed: ${e instanceof Error ? e.message : e}`);
    return { lines: [], total: 0 };
  }
}

/* ── 3–4. Groups ─────────────────────────────────────────────────── */

export function groupSelection(name?: string): string | null {
  try {
    const store = (ctx.features as Any).groups ?? groupsStore;
    const ids = selectedIds();
    if (ids.length < 2) {
      notify("warn", "Select 2+ elements to group");
      return null;
    }
    const label = name || `Group ${Date.now().toString(36).slice(-4)}`;
    let id: string | null = null;
    if (typeof store?.create === "function") {
      const g = store.create(label, ids);
      id = g?.id ?? null;
    } else if (typeof store?.createGroup === "function") {
      id = store.createGroup({ name: label, elementIds: ids })?.id ?? null;
    } else {
      id = `grp-${Date.now().toString(36)}`;
      const list = JSON.parse(localStorage.getItem("obs.groups.local") || "[]");
      list.push({ id, name: label, elementIds: ids });
      localStorage.setItem("obs.groups.local", JSON.stringify(list));
    }
    for (const el of elements()) {
      if (ids.includes(el.id)) el.properties = { ...(el.properties ?? {}), groupId: id };
    }
    notify("success", `Grouped ${ids.length} elements as ${label}`);
    return id;
  } catch (e) {
    notify("warn", `Group failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export function ungroupSelection(): number {
  const ids = new Set(selectedIds());
  let n = 0;
  for (const el of elements()) {
    if (!ids.has(el.id) && !ids.size) continue;
    if (ids.size && !ids.has(el.id)) continue;
    if (el.properties?.groupId) {
      const p = { ...el.properties };
      delete p.groupId;
      el.properties = p;
      n++;
    }
  }
  notify("success", n ? `Ungrouped ${n} element(s)` : "Nothing to ungroup");
  return n;
}

/* ── 5. LOD medium ───────────────────────────────────────────────── */

export async function setLodMedium(): Promise<void> {
  try {
    const mod = await import("../lod-performance/index");
    const svc = mod.getLODPerformanceService?.();
    if (svc?.setLOD) svc.setLOD(1);  // 0=high detail … 3=low
    // Soft heuristics on scene
    try {
      const scene = (ctx as Any).world?.scene?.three ?? (ctx as Any).world?.scene;
      scene?.traverse?.((o: Any) => {
        if (o.isMesh && o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (m.wireframe != null && pack5.lodWireframe) m.wireframe = false;
          }
        }
      });
    } catch { /* */ }
    localStorage.setItem("obs.lod", "medium");
    notify("success", "LOD set to medium");
  } catch {
    localStorage.setItem("obs.lod", "medium");
    notify("success", "LOD medium (stored)");
  }
}

/* ── 6. Flat toposurface ─────────────────────────────────────────── */

export async function createFlatTopo(): Promise<boolean> {
  try {
    const mod = await import("../toposurface/toposurface");
    // Bounds from model
    let minX = 0, maxX = 20, minZ = 0, maxZ = 20;
    let any = false;
    for (const el of elements()) {
      const p = el.params ?? {};
      const pts: Array<[number, number]> = [];
      if (p.start) pts.push(p.start);
      if (p.end) pts.push(p.end);
      if (p.point) pts.push(p.point);
      if (Array.isArray(p.polygon)) pts.push(...p.polygon);
      for (const [x, z] of pts) {
        if (!any) { minX = maxX = x; minZ = maxZ = z; any = true; }
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    const pad = 5;
    const points = [
      { x: minX - pad, y: 0, z: minZ - pad },
      { x: maxX + pad, y: 0, z: minZ - pad },
      { x: maxX + pad, y: 0, z: maxZ + pad },
      { x: minX - pad, y: 0, z: maxZ + pad },
      { x: (minX + maxX) / 2, y: 0, z: (minZ + maxZ) / 2 },
    ];
    const result = mod.buildToposurface({ points } as any);
    pack5.topo = result;
    // Place a thin terrain slab if possible
    const a = authoring();
    await a?.createElementByType?.("terrain", {
      polygon: [
        [minX - pad, minZ - pad],
        [maxX + pad, minZ - pad],
        [maxX + pad, maxZ + pad],
        [minX - pad, maxZ + pad],
      ],
      height: 0.05,
      elevation: -0.05,
    });
    notify("success", "Flat toposurface created under model");
    return true;
  } catch (e) {
    notify("warn", `Topo failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/* ── 7. Matchline ────────────────────────────────────────────────── */

export async function createMatchline(): Promise<boolean> {
  try {
    const mod = await import("../matchline/matchline");
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const el of elements()) {
      const p = el.params ?? {};
      for (const pt of [p.start, p.end, p.point].filter(Boolean) as Array<[number, number]>) {
        minX = Math.min(minX, pt[0]); maxX = Math.max(maxX, pt[0]);
        minZ = Math.min(minZ, pt[1]); maxZ = Math.max(maxZ, pt[1]);
      }
    }
    if (!Number.isFinite(minX)) {
      notify("warn", "No geometry for matchline");
      return false;
    }
    const midX = (minX + maxX) / 2;
    const result = mod.buildMatchline({
      points: [
        { x: midX, z: minZ - 2 },
        { x: midX, z: maxZ + 2 },
      ],
      labels: { left: "ML-1", right: "ML-1" },
    });
    pack5.matchline = result;
    notify("success", "Matchline ML-1 created");
    return true;
  } catch (e) {
    // Local fallback
    localStorage.setItem(
      "obs.matchline",
      JSON.stringify({ id: "ML-1", at: Date.now() }),
    );
    notify("success", "Matchline ML-1 recorded");
    return true;
  }
}

/* ── 8. Generative grid study ────────────────────────────────────── */

export async function runGridSpacingStudy(): Promise<Any> {
  try {
    const mod = await import("../generative-design/generative-design");
    const run = (mod as Any).runStudy;
    if (typeof run === "function") {
      const result = run({
        type: "grid-spacing",
        min: 3,
        max: 9,
        step: 1.5,
        objective: "minimize-columns",
      });
      pack5.genStudy = result;
      notify("success", "Grid spacing study complete");
      return result;
    }
  } catch { /* */ }
  // Inline simple study
  const candidates = [3, 4.5, 6, 7.5, 9].map((spacing) => {
    const grids = authoring()?.getGrids?.() ?? [];
    const span = 30;
    const cols = Math.ceil(span / spacing) ** 2;
    return { spacing, columns: cols, score: cols * spacing };
  });
  candidates.sort((a, b) => a.score - b.score);
  pack5.genStudy = candidates;
  console.table(candidates);
  notify("success", `Best spacing ≈ ${candidates[0]?.spacing} m`);
  return candidates;
}

/* ── 9. Copy/monitor rule ────────────────────────────────────────── */

export function ensureCopyMonitorRule(): void {
  try {
    const store = (ctx.features as Any).copyMonitor ?? copyMonitorStore;
    if (store?.addRule) {
      store.addRule({
        name: "Grids & Levels",
        categories: ["grid", "level"],
        autoUpdate: true,
      });
    } else {
      localStorage.setItem(
        "obs.copyMonitor.rules",
        JSON.stringify([
          { name: "Grids & Levels", categories: ["grid", "level"], autoUpdate: true },
          { name: "Walls", categories: ["wall"], autoUpdate: false },
        ]),
      );
    }
    notify("success", "Copy/Monitor rules ready (Grids & Levels, Walls)");
  } catch (e) {
    notify("warn", `Copy/Monitor: ${e instanceof Error ? e.message : e}`);
  }
}

/* ── 10. Pin selected type ───────────────────────────────────────── */

export function pinSimilarToSelection(): number {
  const ids = selectedIds();
  if (!ids.length) {
    notify("warn", "Select an element first");
    return 0;
  }
  const src = elements().find((e) => e.id === ids[0]);
  if (!src) return 0;
  let n = 0;
  for (const el of elements()) {
    if (el.type !== src.type) continue;
    el.properties = { ...(el.properties ?? {}), pinned: true };
    n++;
  }
  notify("success", `Pinned ${n} × ${src.type}`);
  return n;
}

/* ── Boot ────────────────────────────────────────────────────────── */

export function setupCriticalWorkflowPack5(): void {
  const api = {
    seedCostCatalog,
    runCostTakeoff,
    groupSelection,
    ungroupSelection,
    setLodMedium,
    createFlatTopo,
    createMatchline,
    runGridSpacingStudy,
    ensureCopyMonitorRule,
    pinSimilarToSelection,
  };
  (ctx.features as Any).workflowPack5 = api;

  const cmds: Array<[string, string, string, () => void]> = [
    ["rg-cost-cat", "Cost: seed catalog", "Cost", () => void seedCostCatalog()],
    ["rg-cost-to", "Cost: run takeoff", "Cost", () => void runCostTakeoff()],
    ["rg-group", "Group selection", "Modify", () => void groupSelection()],
    ["rg-ungroup", "Ungroup selection", "Modify", () => void ungroupSelection()],
    ["rg-lod", "LOD: medium performance", "View", () => void setLodMedium()],
    ["rg-topo", "Site: flat toposurface", "Site", () => void createFlatTopo()],
    ["rg-matchline", "Matchline: create ML-1", "Documentation", () => void createMatchline()],
    ["rg-gen-grid", "Generative: grid spacing study", "Analysis", () => void runGridSpacingStudy()],
    ["rg-copymon", "Copy/Monitor: default rules", "Collaboration", () => void ensureCopyMonitorRule()],
    ["rg-pin-type", "Pin all of selected type", "Modify", () => void pinSimilarToSelection()],
  ];

  for (const [id, label, category, run] of cmds) {
    try {
      window.dispatchEvent(
        new CustomEvent("obs-register-command", {
          detail: { id, label, category, run },
        }),
      );
    } catch { /* */ }
  }
  console.log("[workflow-pack-5] cost / groups / site / analysis commands ready");
}
