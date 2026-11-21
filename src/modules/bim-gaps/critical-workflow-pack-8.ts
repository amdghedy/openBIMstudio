/**
 * Critical workflow pack 8 — automation, CDE, navigation, NL, hierarchy, params:
 *  1. AUTOMATIONDEFAULTS   seed automation rules
 *  2. RUNONOPENRULES       fire on-open automation
 *  3. CDEPROVIDERS         list CDE providers
 *  4. FRAMESELECTION       camera frame selected elements
 *  5. NLQUERYDEMO          natural-language element query
 *  5b. NLMODEL             natural-language modelling (words to a room)
 *  6. HIERARCHYREPORT      object hierarchy summary
 *  7. MODELCURVEAXES       model curves along X/Z axes
 *  8. SHAREDPARAMS         seed shared parameters
 *  9. PARAMENGINEPING      parameter engine smoke eval
 * 10. TWINCAPABILITIES     native twin capability matrix
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { registerCommand } from "../../features/command-palette";

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}
function elements(): Any[] {
  return authoring()?.getElements?.() ?? [];
}
function selectedIds(): string[] {
  return authoring()?.getSelectedIds?.() ?? [];
}

/* ── Results live on the module — no window globals (same repair
   packs 3–7 went through) — exposed via getters. ────────────── */
let lastCdeProviders: Any[] = [];
let lastNlQuery: Any | null = null;
let lastNlModel: Any | null = null;
let lastHierarchyReport: Any | null = null;
let lastTwinCaps: Any[] = [];

export function getLastCdeProviders(): Any[] {
  return lastCdeProviders;
}
export function getLastNlQuery(): Any | null {
  return lastNlQuery;
}

export function getLastNlModel(): Any | null {
  return lastNlModel;
}
export function getLastHierarchyReport(): Any | null {
  return lastHierarchyReport;
}
export function getLastTwinCaps(): Any[] {
  return lastTwinCaps;
}

/* ── 1–2. Automation ─────────────────────────────────────────────── */

export async function seedAutomationRules(): Promise<number> {
  try {
    const mod = await import("../automation/rules");
    mod.ensureDefaultRules?.();
    const before = mod.listRules?.()?.length ?? 0;
    // Ensure a few useful rules exist
    const names = new Set((mod.listRules?.() ?? []).map((r: Any) => r.name));
    const extras = [
      { name: "Warn unhosted doors", trigger: "on-save" as const, enabled: true },
      { name: "Tag new walls", trigger: "on-create" as const, enabled: true },
    ];
    let n = 0;
    for (const e of extras) {
      if (names.has(e.name)) continue;
      mod.addRule?.({ name: e.name, trigger: e.trigger, enabled: true } as any);
      n++;
    }
    const total = mod.listRules?.()?.length ?? before + n;
    notify("success", `Automation rules: ${total}`);
    return total;
  } catch (e) {
    notify("warn", `Automation: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

export async function runOnOpenRules(): Promise<number> {
  try {
    const mod = await import("../automation/rules");
    mod.ensureDefaultRules?.();
    const r = mod.runRulesByTrigger?.("on-open" as any);
    const n = Array.isArray(r) ? r.length : Number(r ?? 0);
    notify("success", `Ran on-open rules (${n || "ok"})`);
    return n;
  } catch (e) {
    notify("warn", `Run rules failed: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

/* ── 3. CDE providers ────────────────────────────────────────────── */

export async function listCdeProvidersCmd(): Promise<Any[]> {
  try {
    const reg = await import("../cde/registry");
    try {
      const prov = await import("../cde/providers");
      prov.registerCdeProviders?.();
    } catch { /* */ }
    const list = reg.listCdeProviders?.() ?? [];
    lastCdeProviders = list;
    notify("success", `CDE providers: ${list.length}`);
    return list;
  } catch (e) {
    notify("warn", `CDE: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/* ── 4. Frame selection ──────────────────────────────────────────── */

export async function frameSelection(): Promise<boolean> {
  const ids = new Set(selectedIds());
  const box = new THREE.Box3();
  let any = false;
  const a = authoring();
  for (const el of elements()) {
    if (ids.size && !ids.has(el.id)) continue;
    try {
      const b = a?.getElementWorldBox?.(el);
      if (b && !b.isEmpty()) { box.union(b); any = true; continue; }
    } catch { /* */ }
    const p = el.params ?? {};
    const elev = Number(p.elevation) || 0;
    const h = Number(p.height) || 1;
    const touch = (x: number, y: number, z: number) => {
      any = true;
      box.expandByPoint(new THREE.Vector3(x, y, z));
    };
    if (p.start) touch(p.start[0], elev, p.start[1]);
    if (p.end) touch(p.end[0], elev + h, p.end[1]);
    if (p.point) touch(p.point[0], elev, p.point[1]);
  }
  if (!any) {
    notify("warn", ids.size ? "Selection has no bounds" : "Nothing to frame");
    return false;
  }
  try {
    const mod = await import("../navigation/framing");
    const cam = (ctx as Any).world?.camera?.three ?? (ctx as Any).world?.camera;
    const controls = (ctx as Any).world?.controls ?? (ctx as Any).world?.camera?.controls;
    const result = mod.frameBox(box, { camera: cam, controls, padding: 1.25 } as any);
    if (!result) {
      // manual fallback
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length() || 10;
      if (cam) {
        cam.position.set(c.x + size, c.y + size * 0.6, c.z + size);
        cam.lookAt(c);
        controls?.target?.copy?.(c);
        controls?.update?.();
      }
    }
    notify("success", "Framed selection / model");
    return true;
  } catch (e) {
    notify("warn", `Frame failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/* ── 5. NL query demo ────────────────────────────────────────────── */

export async function runNlQuery(text = "select all walls"): Promise<Any> {
  try {
    // Real API: executeNLQuery(rawQuery: string, elements?: {id, category,
    // properties?}[]) — it parses internally; the parsed object is in the result.
    // Authored elements carry geometry in params, not properties, so the
    // mapping goes through authoredToQueryElement — otherwise a criterion
    // such as "taller than 3 m" finds no Height and is silently skipped.
    const exec = await import("../nl-query/executor");
    const result = exec.executeNLQuery(
      text,
      elements().map((e) =>
        exec.authoredToQueryElement(
          e as {
            id: unknown;
            type?: unknown;
            category?: unknown;
            params?: Record<string, any>;
            properties?: Record<string, any>;
          },
        ),
      ),
    );
    const ids = result.matchedIds;
    if (ids.length) {
      authoring()?.setSelectedAuthored?.(ids);
    }
    try {
      const saved = await import("../nl-query/saved-queries");
      saved.saveQuery?.(text);
    } catch { /* */ }
    lastNlQuery = { text, result, at: Date.now() };
    notify("success", `NL query: ${result.matchedCount} hit(s)`);
    return { text, matchedCount: result.matchedCount, matchedIds: ids, parsed: result.parsed };
  } catch (e) {
    // fallback: select by type keyword
    const m = text.toLowerCase().match(/\b(wall|door|window|column|slab|beam|duct|pipe)s?\b/);
    if (m) {
      const type = m[1];
      const ids = elements().filter((e) => e.type === type || e.type === type + "s").map((e) => e.id);
      authoring()?.setSelectedAuthored?.(ids);
      notify("success", `Selected ${ids.length} × ${type}`);
      return { ids };
    }
    notify("warn", `NL query failed: ${e instanceof Error ? e.message : e}`);
    return { ids: [] };
  }
}

/* ── 5b. NL modelling — words to a real room ─────────────────────── */
/**
 * Models a room from a plain sentence — keyless: the parser, planner and
 * executor use only the local authoring engine, so this works with no API
 * key and no server. The cloud AI chat drives the same path through the
 * `create_room` tool (ai-tools.ts); this is the palette / scriptable entry.
 */
export async function runNlModel(
  text = "draw a 4×6 room with a door and two windows",
): Promise<Any> {
  try {
    const auth = authoring();
    if (!auth?.createElementByType) {
      notify("warn", "NL modelling: the authoring engine is not ready.");
      return { text, ok: false, error: "authoring engine not ready" };
    }
    const mod = await import("../nl-model/index");
    const request = mod.parseRoomCommand(text);
    const plan = mod.planRoom(request);
    // authoring() is the untyped feature bag; the executor only needs the
    // one creation call, so name that shape instead of casting to any.
    const authoringApi = auth as unknown as {
      createElementByType: (
        type: string,
        params: Record<string, unknown>,
        hostId?: string,
      ) => Promise<string | null>;
    };
    const built = await mod.executeRoomPlan(authoringApi, plan);
    const doors = plan.openings.filter((o) => o.type === "door").length;
    const windows = plan.openings.filter((o) => o.type === "window").length;
    lastNlModel = { text, request, plan, ...built, at: Date.now() };
    notify(
      "success",
      `Modelled a ${request.width} × ${request.depth} m room: 4 walls, ${doors} door(s), ${windows} window(s)`,
    );
    return { text, ok: true, request, plan, ...built };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    notify("warn", `NL modelling: ${message}`);
    return { text, ok: false, error: message };
  }
}

/* ── 6. Hierarchy report ─────────────────────────────────────────── */

export function hierarchyReport(): Any {
  const byType: Record<string, number> = {};
  const hosted = { doors: 0, windows: 0, unhosted: 0 };
  for (const el of elements()) {
    byType[el.type] = (byType[el.type] || 0) + 1;
    if (el.type === "door" || el.type === "window") {
      if (el.hostId) hosted[el.type === "door" ? "doors" : "windows"]++;
      else hosted.unhosted++;
    }
  }
  const report = {
    total: elements().length,
    byType,
    hosted,
    levels: authoring()?.getLevels?.()?.length ?? 0,
    grids: authoring()?.getGrids?.()?.length ?? 0,
  };
  lastHierarchyReport = report;
  notify("success", `Hierarchy: ${report.total} elements · ${Object.keys(byType).length} types`);
  return report;
}

/* ── 7. Model curves ─────────────────────────────────────────────── */

export async function placeAxisModelCurves(): Promise<number> {
  try {
    const mod = await import("../model-curves/types");
    const els = elements();
    if (!els.length) {
      notify("warn", "Model curves need a host element — the model is empty.");
      return 0;
    }
    // Real API: addModelCurve(hostElementId, faceIndex, points (UV metres on
    // the face), closed?, color?) — curves are strictly host-bound, so the
    // original "axes at ±50 m with no host" concept cannot exist here.
    const host = els.find((e) => e.type === "slab") ?? els[0];
    const axes: Array<Array<[number, number]>> = [
      [[-0.5, 0], [0.5, 0]], // U leg
      [[0, -0.5], [0, 0.5]], // V leg
    ];
    let n = 0;
    for (const points of axes) {
      try {
        mod.addModelCurve(String(host.id), 0, points, false, "#f59e0b");
        n++;
      } catch { /* per-curve */ }
    }
    if (n) notify("success", `Model curves: ${n} reference axes on host ${String(host.id)}`);
    else notify("warn", "Model curves: host rejected the reference curves");
    return n;
  } catch (e) {
    notify("warn", `Model curves: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

/* ── 8. Shared parameters ────────────────────────────────────────── */

export async function seedSharedParams(): Promise<number> {
  try {
    // Real module + store API: sharedParamsStore.addShared({ name, type,
    // group, instance, description? }) — no dead localStorage channel.
    const mod = await import("../shared-params/shared-params");
    const defs: Array<{ name: string; type: "text" | "number"; group: string }> = [
      { name: "FireRating", type: "text", group: "Identity" },
      { name: "Mark", type: "text", group: "Identity" },
      { name: "Comments", type: "text", group: "Identity" },
      { name: "Cost", type: "number", group: "Data" },
      { name: "Area", type: "number", group: "Dimensions" },
    ];
    const store = (mod as Any).sharedParamsStore;
    if (!store?.addShared) {
      notify("warn", "Shared parameters: store unavailable");
      return 0;
    }
    const existing = new Set((store.listShared?.() ?? []).map((p: Any) => p.name));
    let n = 0;
    for (const d of defs) {
      if (existing.has(d.name)) continue;
      store.addShared({ name: d.name, type: d.type, group: d.group, instance: true });
      n++;
    }
    notify("success", `Shared parameters: ${n} added`);
    return n;
  } catch (e) {
    notify("warn", `Shared parameters: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

/* ── 9. Parameter engine ping ────────────────────────────────────── */

export async function parameterEnginePing(): Promise<boolean> {
  try {
    // Real API: the parameter engine parses/formats values and resolves
    // formula symbols — it has no free-form evaluate(); the ping exercises
    // the real parse → format roundtrip and the symbol resolver.
    const mod = await import("../parameter-engine/index");
    const def: Any = {
      id: "qa.number",
      name: "Number",
      symbol: "num",
      dataType: "number",
      scope: "instance",
      origin: "builtin",
    };
    const parsed = mod.parseParameterValue(def as any, "42.5");
    const okParse = parsed.problem === null && parsed.value === 42.5;
    const back = mod.formatParameterValue(def as any, parsed.value);
    const symbols = mod.referencedSymbols("2 * (3 + 1)", []);
    notify(
      "success",
      `Parameter engine: parse "42.5" → ${back}${symbols.length ? "" : " · no free symbols in closed formula"}`,
    );
    return okParse;
  } catch (e) {
    notify("warn", `Parameter engine: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/* ── 10. Twin capabilities ───────────────────────────────────────── */

export async function twinCapabilityMatrix(): Promise<Any> {
  try {
    const mod = await import("../native-twin/capabilities");
    const rows = mod.capabilityMatrixRows?.() ?? [];
    lastTwinCaps = rows;
    notify("success", `Native twin capabilities: ${rows.length} type(s)`);
    return rows;
  } catch (e) {
    notify("warn", `Twin caps: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/* ── Boot ────────────────────────────────────────────────────────── */

export function setupCriticalWorkflowPack8(): void {
  const api = {
    seedAutomationRules,
    runOnOpenRules,
    listCdeProvidersCmd,
    frameSelection,
    runNlQuery,
    runNlModel,
    hierarchyReport,
    placeAxisModelCurves,
    seedSharedParams,
    parameterEnginePing,
    twinCapabilityMatrix,
    getLastCdeProviders,
    getLastNlQuery,
    getLastNlModel,
    getLastHierarchyReport,
    getLastTwinCaps,
  };
  (ctx.features as Any).workflowPack8 = api;

  const cmds: Array<[string, string, string, () => void]> = [
    ["rg-auto-seed", "Automation: seed default rules", "Automation", () => void seedAutomationRules()],
    ["rg-auto-run", "Automation: run on-open rules", "Automation", () => void runOnOpenRules()],
    ["rg-cde-list", "CDE: list providers", "Collaboration", () => void listCdeProvidersCmd()],
    ["rg-frame-sel", "Navigate: frame selection", "View", () => void frameSelection()],
    ["rg-nl-walls", "NL query: select all walls", "Query", () => void runNlQuery("select all walls")],
    ["rg-nl-room", "Model: draw a 4×6 room with a door and two windows", "Model", () => void runNlModel()],
    ["rg-hierarchy", "Hierarchy: summary report", "Data", () => void hierarchyReport()],
    ["rg-curves", "Model curves: X/Z axes", "Architecture", () => void placeAxisModelCurves()],
    ["rg-shared-p", "Shared parameters: seed", "Data", () => void seedSharedParams()],
    ["rg-param-eng", "Parameter engine: smoke test", "QA", () => void parameterEnginePing()],
    ["rg-twin-caps", "Native twin: capability matrix", "Data", () => void twinCapabilityMatrix()],
  ];

  // Register into the REAL palette — the window CustomEvent channel this
  // pack originally used has no listener anywhere in the repo (the exact
  // dead channel bug class packs 1–7 were repaired from).
  for (const [id, label, category, run] of cmds) {
    try {
      registerCommand({ id, label, category, run });
    } catch { /* */ }
  }
}
