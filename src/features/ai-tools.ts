/**
 * Tool registry for the AI chat.
 *
 * Every cross-module import is dynamic (via `await import(...)`) so a
 * missing helper file does not break the build. If a tool's dependency
 * is not present at runtime, the tool returns a clear error to the model.
 */
import { ctx } from "../core/context";
import { services } from "../core/services";
import { listCommands, registerCommand } from "./command-palette";

/* ═════════════════════════════════════════════════════════════════════════
   Types (inlined — no cross-module import needed)
   ═════════════════════════════════════════════════════════════════════════ */
export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  extraContent?: Record<string, any>;
}

export interface ToolResult {
  ok: boolean;
  data?: any;
  error?: string;
}

/** Tools that must be approved by the user before running. */
const DESTRUCTIVE_TOOLS = new Set<string>([
  "clear_all_elements",
  "delete_elements",
  "clear_index",
]);

export function isDestructiveTool(name: string): boolean {
  return DESTRUCTIVE_TOOLS.has(name);
}

/* ═════════════════════════════════════════════════════════════════════════
   Tool definitions
   ═════════════════════════════════════════════════════════════════════════ */
export const TOOLS: ToolDef[] = [
  // ── App state & commands ───────────────────────────────────────────
  {
    name: "get_app_state",
    description:
      "Returns the current app state: loaded models, current selection, " +
      "active authoring tool, camera projection, current project name, and " +
      "the current element count. Call this first if you need context.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_commands",
    description:
      "Lists every command registered in the app. Each entry has an id, " +
      "label, category, and optional hint. Use the id with run_command.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "run_command",
    description:
      "Executes a command by id. Call list_commands first to find the " +
      "right id. Returns success or the error the command threw.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The command id from list_commands" },
      },
      required: ["id"],
    },
  },

  // ── Selection & view ───────────────────────────────────────────────
  {
    name: "select_by_category",
    description:
      "Selects every element of an IFC category. Example: 'IFCDOOR' selects " +
      "all doors in every loaded model. Use addToSelection to keep the " +
      "current selection.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string" },
        modelId: { type: "string" },
        addToSelection: { type: "boolean" },
      },
      required: ["category"],
    },
  },
  {
    name: "focus_camera",
    description:
      "Zooms the camera to fit the current selection, or the whole scene " +
      "if nothing is selected.",
    parameters: { type: "object", properties: {} },
  },

  // ── Model inspection ───────────────────────────────────────────────
  {
    name: "get_model_categories",
    description:
      "Returns the count of elements per IFC category for a given model, " +
      "or for all models if modelId is omitted.",
    parameters: {
      type: "object",
      properties: { modelId: { type: "string" } },
    },
  },
  {
    name: "get_element_properties",
    description:
      "Reads all attributes and property sets of one element.",
    parameters: {
      type: "object",
      properties: {
        modelId: { type: "string" },
        localId: { type: "number" },
      },
      required: ["modelId", "localId"],
    },
  },
  {
    name: "query_elements",
    description:
      "Finds elements of a category that match a property filter. " +
      "Operators: eq, neq, gt, gte, lt, lte, contains.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string" },
        modelId: { type: "string" },
        filters: { type: "object" },
        limit: { type: "number" },
      },
      required: ["category"],
    },
  },

  // ── Analysis ───────────────────────────────────────────────────────
  {
    name: "run_clash_test",
    description:
      "Runs a clash detection test between Selection A and Selection B.",
    parameters: {
      type: "object",
      properties: {
        tolerance: { type: "number" },
        clearance: { type: "number" },
      },
    },
  },
  {
    name: "summarize_clashes",
    description: "Groups the last clash test's results by category pair and kind.",
    parameters: { type: "object", properties: {} },
  },

  // ── Issues ─────────────────────────────────────────────────────────
  {
    name: "create_issue",
    description: "Creates a BCF issue from the current viewpoint.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string" },
      },
      required: ["title"],
    },
  },

  // ── Semantic search ────────────────────────────────────────────────
  {
    name: "semantic_search",
    description:
      "Searches element descriptions by meaning. If the index is empty, " +
      "call build_semantic_index first.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "build_semantic_index",
    description:
      "Builds or refreshes the semantic search index. Requires an embedding " +
      "provider (Ollama or OpenAI-compatible).",
    parameters: {
      type: "object",
      properties: {
        modelId: { type: "string" },
        maxPerModel: { type: "number" },
      },
    },
  },

  // ── Scheduling ─────────────────────────────────────────────────────
  {
    name: "list_schedule_templates",
    description:
      "Lists the built-in schedule templates (Door, Window, Wall, Room, " +
      "Material, MEP, Cost, BOQ, 4D, IDS, Model Health, plus international " +
      "BOQ variants for UK/Germany/US/China/Japan/India/Australia).",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "run_schedule",
    description:
      "Runs a schedule by template id and returns totals plus sample rows.",
    parameters: {
      type: "object",
      properties: {
        templateId: { type: "string" },
        maxRows: { type: "number" },
      },
      required: ["templateId"],
    },
  },
  {
    name: "schedule_diff",
    description:
      "Compares the current schedule to its most recent saved snapshot.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_saved_schedules",
    description: "Lists the user-saved schedule definitions.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_schedule_columns",
    description:
      "Lists available column keys and the IFC category catalog. Call " +
      "this before create_schedule.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "create_schedule",
    description:
      "Creates and saves a custom schedule. Columns and grouping must be " +
      "chosen from list_schedule_columns.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        category: { type: "string" },
        columns: { type: "array", items: { type: "string" } },
        grouping: { type: "array", items: { type: "string" } },
        sortBy: { type: "string" },
        useCostData: { type: "boolean" },
        useLiveQuantities: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "run_saved_schedule",
    description: "Runs a saved schedule by its id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        maxRows: { type: "number" },
      },
      required: ["id"],
    },
  },

  // ── Destructive ────────────────────────────────────────────────────
  {
    name: "delete_elements",
    description:
      "Deletes specified authored elements by id. Requires user approval.",
    parameters: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
  },
  {
    name: "clear_all_elements",
    description: "Deletes every authored element. Requires user approval.",
    parameters: { type: "object", properties: {} },
  },
];

/* ═════════════════════════════════════════════════════════════════════════
   Executor
   ═════════════════════════════════════════════════════════════════════════ */
export async function executeTool(call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "get_app_state": return { ok: true, data: await getAppState() };
      case "list_commands": return { ok: true, data: listCommands().map(cmdToBrief) };
      case "run_command": return await runCommandTool(String(call.args.id ?? ""));

      case "select_by_category": return await selectByCategoryTool(call.args);
      case "focus_camera": return await focusCameraTool();

      case "get_model_categories": return await getModelCategoriesTool(call.args);
      case "get_element_properties": return await getElementPropertiesTool(call.args);
      case "query_elements": return await queryElementsTool(call.args);

      case "run_clash_test": return await runClashTestTool(call.args);
      case "summarize_clashes": return await summarizeClashesTool();

      case "create_issue": return await createIssueTool(call.args);

      case "semantic_search": return await semanticSearchTool(call.args);
      case "build_semantic_index": return await buildSemanticIndexTool(call.args);

      case "list_schedule_templates": return await listScheduleTemplatesTool();
      case "run_schedule": return await runScheduleTool(call.args);
      case "schedule_diff": return await scheduleDiffTool();
      case "list_saved_schedules": return await listSavedSchedulesTool();
      case "list_schedule_columns": return await listScheduleColumnsTool();
      case "create_schedule": return await createScheduleTool(call.args);
      case "run_saved_schedule": return await runSavedScheduleTool(call.args);

      case "delete_elements": return await deleteElementsTool(call.args);
      case "clear_all_elements": return await clearAllElementsTool();

      default: return { ok: false, error: `Unknown tool: ${call.name}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   App state & commands
   ═════════════════════════════════════════════════════════════════════════ */
function cmdToBrief(c: any) {
  return {
    id: c.id,
    label: c.label,
    category: c.category,
    hint: c.hint ?? undefined,
    kbd: c.kbd ?? undefined,
  };
}

async function getAppState() {
  const project = services.tryUse("projects")?.getCurrentProject() ?? null;

  const models: { id: string; name: string; elementCount: number | null }[] = [];
  for (const [id, model] of ctx.fragments.list) {
    let count: number | null = null;
    try {
      const ids = await (model as any).getItemsIdsWithGeometry?.();
      if (Array.isArray(ids)) count = ids.length;
    } catch { /* */ }
    models.push({
      id,
      name: (model as any)?.name ?? (model as any)?.modelName ?? id,
      elementCount: count,
    });
  }

  const selection: Record<string, number> = {};
  const snap = services.tryUse("selection")?.snapshot();
  if (snap) {
    for (const [mid, ids] of Object.entries(snap)) {
      selection[mid] = ids.size;
    }
  }

  const auth = services.tryUse("authoring");
  const authoredCount = auth?.getElementCount() ?? 0;
  const activeTool = auth?.getActiveTool() ?? null;

  return {
    project: project ? { id: project.id, name: project.name } : null,
    models,
    selection,
    authoredElementCount: authoredCount,
    activeAuthoringTool: activeTool,
  };
}

async function runCommandTool(id: string): Promise<ToolResult> {
  if (!id) return { ok: false, error: "Missing command id" };
  const cmd = listCommands().find((c) => c.id === id);
  if (!cmd) return { ok: false, error: `No command with id "${id}"` };
  try {
    await cmd.run();
    return { ok: true, data: { ran: id, label: cmd.label } };
  } catch (err) {
    return { ok: false, error: `Command "${id}" failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Selection & view
   ═════════════════════════════════════════════════════════════════════════ */
async function selectByCategoryTool(args: Record<string, any>): Promise<ToolResult> {
  const category = String(args.category ?? "").trim().toUpperCase();
  if (!category) return { ok: false, error: "Missing category" };
  const modelId = args.modelId ? String(args.modelId) : null;
  const add = !!args.addToSelection;

  const selection = services.tryUse("selection");
  if (!selection) return { ok: false, error: "Selection module not loaded" };

  const map: Record<string, Set<number>> = {};
  let total = 0;

  for (const [mid, model] of ctx.fragments.list) {
    if (modelId && mid !== modelId) continue;
    let cats: Record<string, number[]> = {};
    try { cats = await (model as any).getItemsOfCategories([/.+/]); }
    catch { continue; }
    const ids: number[] = [];
    for (const [cat, list] of Object.entries(cats ?? {})) {
      const upper = String(cat).toUpperCase();
      if (upper === category || upper.startsWith(category)) {
        for (const id of (list as number[]) ?? []) ids.push(id);
      }
    }
    if (ids.length) { map[mid] = new Set(ids); total += ids.length; }
  }

  if (!total) {
    return { ok: true, data: { selected: 0, category, note: "No matching elements" } };
  }

  if (add) {
    for (const [mid, ids] of Object.entries(map)) selection.addMany(mid, ids);
  } else {
    selection.replace(map);
  }
  await selection.applyToHighlighter?.();

  return { ok: true, data: { selected: total, category, addToSelection: add } };
}

async function focusCameraTool(): Promise<ToolResult> {
  try {
    const cam = services.tryUse("camera");
    const sel = services.tryUse("selection");
    const isEmpty = !sel || sel.isEmpty?.();
    if (isEmpty || !sel) { cam?.fitAll?.(); return { ok: true, data: { focused: "scene" } }; }
    await sel.focus?.();
    return { ok: true, data: { focused: "selection" } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Model inspection
   ═════════════════════════════════════════════════════════════════════════ */
async function getModelCategoriesTool(args: Record<string, any>): Promise<ToolResult> {
  const modelId = args.modelId ? String(args.modelId) : null;
  const out: Record<string, Record<string, number>> = {};
  for (const [mid, model] of ctx.fragments.list) {
    if (modelId && mid !== modelId) continue;
    try {
      const cats = await (model as any).getItemsOfCategories([/.+/]);
      const bucket: Record<string, number> = {};
      for (const [cat, list] of Object.entries(cats ?? {})) {
        bucket[cat] = ((list as number[]) ?? []).length;
      }
      out[mid] = bucket;
    } catch (err) {
      out[mid] = { error: err instanceof Error ? err.message : String(err) } as any;
    }
  }
  return { ok: true, data: out };
}

function flattenData(d: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!d || typeof d !== "object") return out;
  for (const [k, v] of Object.entries(d)) {
    if (k === "psets") continue;
    const val = (v as any)?.value ?? v;
    if (val == null) continue;
    if (typeof val === "object") continue;
    out[k] = String(val);
  }
  const psets = d.psets;
  if (psets && typeof psets === "object") {
    for (const [psName, props] of Object.entries(psets)) {
      for (const [pk, pv] of Object.entries(props as any)) {
        const val = (pv as any)?.value ?? pv;
        if (val == null) continue;
        if (typeof val === "object") continue;
        out[`${psName}.${pk}`] = String(val);
      }
    }
  }
  return out;
}

async function getElementPropertiesTool(args: Record<string, any>): Promise<ToolResult> {
  const modelId = String(args.modelId ?? "");
  const localId = Number(args.localId);
  if (!modelId || !Number.isFinite(localId)) {
    return { ok: false, error: "modelId and localId are required" };
  }
  const model = ctx.fragments.list.get(modelId);
  if (!model) return { ok: false, error: `Model "${modelId}" not loaded` };
  try {
    const data = await (model as any).getItemsData([localId], {
      attributesDefault: true,
      psetsDefault: true,
    });
    return { ok: true, data: flattenData((data as any[])?.[0] ?? {}) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function getProp(flat: Record<string, string>, name: string): string | undefined {
  if (flat[name] != null) return flat[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(flat)) {
    if (k.toLowerCase() === lower) return v;
    const bare = k.includes(".") ? k.split(".").pop()! : k;
    if (bare.toLowerCase() === lower) return v;
  }
  return undefined;
}

function matchFilter(actual: string | undefined, op: string, expected: any): boolean {
  if (actual == null) return false;
  switch (op) {
    case "eq": return actual.toLowerCase() === String(expected).toLowerCase();
    case "neq": return actual.toLowerCase() !== String(expected).toLowerCase();
    case "contains": return actual.toLowerCase().includes(String(expected).toLowerCase());
    case "gt": return parseFloat(actual) > Number(expected);
    case "gte": return parseFloat(actual) >= Number(expected);
    case "lt": return parseFloat(actual) < Number(expected);
    case "lte": return parseFloat(actual) <= Number(expected);
    default: return false;
  }
}

async function queryElementsTool(args: Record<string, any>): Promise<ToolResult> {
  const category = String(args.category ?? "").trim().toUpperCase();
  if (!category) return { ok: false, error: "Missing category" };
  const modelId = args.modelId ? String(args.modelId) : null;
  const limit = Math.min(Number(args.limit) || 200, 500);
  const rawFilters = (args.filters ?? {}) as Record<string, any>;

  const filters: { name: string; op: string; value: any }[] = [];
  for (const [k, v] of Object.entries(rawFilters)) {
    if (v && typeof v === "object" && "op" in v) {
      filters.push({ name: k, op: String(v.op), value: (v as any).value });
    } else {
      filters.push({ name: k, op: "eq", value: v });
    }
  }

  const hits: { modelId: string; localId: number; name: string; category: string }[] = [];

  for (const [mid, model] of ctx.fragments.list) {
    if (modelId && mid !== modelId) continue;
    let cats: Record<string, number[]> = {};
    try { cats = await (model as any).getItemsOfCategories([/.+/]); } catch { continue; }
    const ids: number[] = [];
    for (const [cat, list] of Object.entries(cats ?? {})) {
      const upper = String(cat).toUpperCase();
      if (upper === category || upper.startsWith(category)) {
        for (const id of (list as number[]) ?? []) ids.push(id);
      }
    }
    if (!ids.length) continue;

    let data: any[] = [];
    try {
      data = await (model as any).getItemsData(ids, {
        attributesDefault: true,
        psetsDefault: filters.length > 0,
      });
    } catch { /* */ }

    for (let i = 0; i < ids.length; i++) {
      if (hits.length >= limit) break;
      const d = (data as any[])?.[i] ?? {};
      const name = String(d?.Name?.value ?? d?.ObjectType?.value ?? `#${ids[i]}`);
      if (!filters.length) {
        hits.push({ modelId: mid, localId: ids[i], name, category });
        continue;
      }
      const flat = flattenData(d);
      let pass = true;
      for (const f of filters) {
        if (!matchFilter(getProp(flat, f.name), f.op, f.value)) { pass = false; break; }
      }
      if (pass) hits.push({ modelId: mid, localId: ids[i], name, category });
    }
    if (hits.length >= limit) break;
  }

  return { ok: true, data: { count: hits.length, category, filters, limit, elements: hits } };
}

/* ═════════════════════════════════════════════════════════════════════════
   Analysis
   ═════════════════════════════════════════════════════════════════════════ */
async function runClashTestTool(_args: Record<string, any>): Promise<ToolResult> {
  const clash = services.tryUse("clash");
  if (!clash) return { ok: false, error: "Clash module not loaded" };
  try {
    await clash.run?.();
    return { ok: true, data: { clashes: clash.getClashCount?.() ?? 0 } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function summarizeClashesTool(): Promise<ToolResult> {
  const clash = services.tryUse("clash");
  if (!clash) return { ok: false, error: "Clash module not loaded" };
  const list = clash.listClashes?.() ?? [];
  if (!list.length) {
    return { ok: true, data: { total: 0, clusters: [], note: "No clash results in memory" } };
  }
  const byKind: Record<string, number> = {};
  const clusters = new Map<string, { aCat: string; bCat: string; count: number; kind: string }>();
  for (const c of list) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    const key = `${c.a.cat}|${c.b.cat}|${c.kind}`;
    const e = clusters.get(key);
    if (e) e.count++;
    else clusters.set(key, { aCat: c.a.cat, bCat: c.b.cat, count: 1, kind: c.kind });
  }
  const top = [...clusters.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return { ok: true, data: { total: list.length, byKind, topClusters: top } };
}

/* ═════════════════════════════════════════════════════════════════════════
   Issues
   ═════════════════════════════════════════════════════════════════════════ */
async function createIssueTool(args: Record<string, any>): Promise<ToolResult> {
  const title = String(args.title ?? "").trim();
  if (!title) return { ok: false, error: "Title is required" };
  const description = String(args.description ?? "").trim();
  const priority = String(args.priority ?? "medium");
  const issues = (ctx.features as any).issues;
  if (!issues?.createIssue) return { ok: false, error: "Issues module not loaded" };
  try {
    const issue = issues.createIssue(title, description);
    if (priority && issue) issue.priority = priority;
    return { ok: true, data: { id: issue.id, title: issue.title } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Semantic search — dynamic import of ai-embeddings
   ═════════════════════════════════════════════════════════════════════════ */
async function semanticSearchTool(args: Record<string, any>): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) return { ok: false, error: "Query is required" };
  const limit = Math.min(Number(args.limit) || 20, 100);
  try {
    const mod: any = await import("./ai-embeddings");
    const stats = await mod.getIndexStats();
    if (!stats.total) {
      return {
        ok: false,
        error:
          "Semantic index is empty. Call build_semantic_index first, or " +
          "ask the user to build it from the settings panel.",
      };
    }
    const hits = await mod.semanticSearch(query, limit);
    return { ok: true, data: { query, count: hits.length, hits } };
  } catch (err) {
    return {
      ok: false,
      error:
        `Semantic search unavailable: ${err instanceof Error ? err.message : err}. ` +
        `Ensure src/features/ai-embeddings.ts exists.`,
    };
  }
}

async function buildSemanticIndexTool(args: Record<string, any>): Promise<ToolResult> {
  const modelId = args.modelId ? String(args.modelId) : undefined;
  const maxPerModel = args.maxPerModel ? Number(args.maxPerModel) : undefined;
  try {
    const mod: any = await import("./ai-embeddings");
    const cfg = mod.loadEmbeddingConfig();
    let lastPhase = "";
    await mod.buildIndex({
      cfg,
      modelIds: modelId ? [modelId] : undefined,
      maxPerModel,
      onProgress: (p: any) => { lastPhase = p.phase; },
    });
    const stats = await mod.getIndexStats();
    return { ok: true, data: { ...stats, lastPhase } };
  } catch (err) {
    return {
      ok: false,
      error:
        `Semantic index build failed: ${err instanceof Error ? err.message : err}. ` +
        `Ensure src/features/ai-embeddings.ts exists.`,
    };
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Scheduling — all dynamic
   ═════════════════════════════════════════════════════════════════════════ */
async function listScheduleTemplatesTool(): Promise<ToolResult> {
  try {
    const mod: any = await import("../modules/schedules/schedule-templates");
    return {
      ok: true,
      data: mod.BUILT_IN_TEMPLATES.map((t: any) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
        hasGrouping: !!t.grouping?.length,
        hasFormulas: t.columns.some((c: any) => c.format === "formula"),
        usesCost: !!t.useCostData,
        usesLiveQuantities: !!t.useLiveQuantities,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        `Schedule templates unavailable: ${err instanceof Error ? err.message : err}. ` +
        `Ensure src/modules/schedules/schedule-templates.ts exists.`,
    };
  }
}

async function runScheduleTool(args: Record<string, any>): Promise<ToolResult> {
  const templateId = String(args.templateId ?? "");
  const maxRows = Math.min(Number(args.maxRows) || 50, 500);
  if (!templateId) return { ok: false, error: "Missing templateId" };

  try {
    const tplMod: any = await import("../modules/schedules/schedule-templates");
    const genMod: any = await import("../modules/schedules/schedule-generator");

    const tpl = tplMod.getTemplate(templateId);
    if (!tpl) {
      const available = tplMod.BUILT_IN_TEMPLATES.map((t: any) => t.id).join(", ");
      return { ok: false, error: `No template with id "${templateId}". Available: ${available}` };
    }

    const run = await genMod.runSchedule(tpl);
    const dataRows = run.rows.filter((r: any) => !r.subtotal);
    const groupRows = run.rows.filter((r: any) => r.subtotal);

    return {
      ok: true,
      data: {
        template: tpl.name,
        templateId,
        totalRows: dataRows.length,
        totalGroups: groupRows.length,
        totals: run.totals,
        sampleRows: dataRows.slice(0, maxRows).map((r: any) => r.values),
        sampleGroupRows: groupRows.slice(0, 30).map((r: any) => ({
          path: r.groupPath,
          depth: r.depth,
          subtotals: r.subtotalValues,
          label: r.values,
        })),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error:
        `Schedule run failed: ${err instanceof Error ? err.message : err}. ` +
        `Ensure the schedule modules exist and export runSchedule.`,
    };
  }
}

async function scheduleDiffTool(): Promise<ToolResult> {
  try {
    const diffMod: any = await import("../modules/schedules/schedule-diff");
    const schedules = (ctx.features as any).schedules;
    if (!schedules?.getDefinition) {
      return { ok: false, error: "Schedules panel not loaded" };
    }
    const def = schedules.getDefinition();
    const snaps = diffMod.listSnapshots(def.id);
    if (!snaps.length) {
      return {
        ok: true,
        data: {
          note:
            "No snapshots for the current schedule yet. The user needs to " +
            "click 'Snapshot' in the Schedules panel first.",
        },
      };
    }
    const diff = schedules.diffLatest?.();
    if (!diff) return { ok: false, error: "Could not compute diff" };
    return {
      ok: true,
      data: {
        snapshotLabel: diff.snapshotLabel,
        takenAt: diff.snapshotAt,
        added: diff.added.length,
        removed: diff.removed.length,
        changed: diff.changed.length,
        unchanged: diff.unchanged,
        summary: diffMod.summarizeDiff(diff),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error:
        `Schedule diff unavailable: ${err instanceof Error ? err.message : err}. ` +
        `Ensure schedule-diff.ts exists.`,
    };
  }
}

async function listSavedSchedulesTool(): Promise<ToolResult> {
  try {
    const mod: any = await import("../modules/schedules/schedule-store");
    return {
      ok: true,
      data: mod.listSavedSchedules().map((s: any) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        columns: s.columns.map((c: any) => c.key),
        grouping: s.grouping?.map((g: any) => g.key) ?? [],
        updatedAt: s.updatedAt,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        `Saved schedules unavailable: ${err instanceof Error ? err.message : err}. ` +
        `Ensure schedule-store.ts exists.`,
    };
  }
}

async function listScheduleColumnsTool(): Promise<ToolResult> {
  try {
    const builder: any = await import("../modules/schedules/schedule-builder");
    const catalog: any = await import("../modules/schedules/schedule-catalog");
    return {
      ok: true,
      data: {
        columns: builder.listColumnTemplates().map((c: any) => ({
          key: c.key,
          header: c.header,
          format: c.format,
          unit: c.unit,
        })),
        categories: catalog.CATEGORY_CATALOG.map((c: any) => ({
          ifc: c.ifc,
          label: c.label,
          discipline: c.discipline,
        })),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error:
        `Column catalog unavailable: ${err instanceof Error ? err.message : err}. ` +
        `Ensure schedule-builder.ts and schedule-catalog.ts exist.`,
    };
  }
}

async function createScheduleTool(args: Record<string, any>): Promise<ToolResult> {
  const name = String(args.name ?? "").trim();
  if (!name) return { ok: false, error: "Name is required" };
  try {
    const builder: any = await import("../modules/schedules/schedule-builder");
    const store: any = await import("../modules/schedules/schedule-store");

    const spec: any = {
      name,
      category: args.category ? String(args.category) : null,
      columns: Array.isArray(args.columns) ? args.columns.map(String) : undefined,
      grouping: Array.isArray(args.grouping) ? args.grouping.map(String) : undefined,
      sortBy: args.sortBy ? String(args.sortBy) : undefined,
      useCostData: args.useCostData !== false,
      useLiveQuantities: args.useLiveQuantities !== false,
    };

    const def = builder.buildSchedule(spec);
    const stored = store.saveSchedule(def);

    try {
      const panel = (ctx.features as any).schedules;
      if (panel?.load) panel.load(stored.id);
    } catch { /* */ }

    return {
      ok: true,
      data: {
        id: stored.id,
        name: stored.name,
        category: stored.category,
        columns: stored.columns.map((c: any) => c.key),
        grouping: stored.grouping?.map((g: any) => g.key) ?? [],
        saved: true,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error:
        `Could not create schedule: ${err instanceof Error ? err.message : err}. ` +
        `Ensure schedule-builder.ts and schedule-store.ts exist.`,
    };
  }
}

async function runSavedScheduleTool(args: Record<string, any>): Promise<ToolResult> {
  const id = String(args.id ?? "");
  const maxRows = Math.min(Number(args.maxRows) || 50, 500);
  if (!id) return { ok: false, error: "Missing schedule id" };
  try {
    const store: any = await import("../modules/schedules/schedule-store");
    const genMod: any = await import("../modules/schedules/schedule-generator");
    const stored = store.getSavedSchedule(id);
    if (!stored) return { ok: false, error: `No saved schedule with id "${id}"` };
    const run = await genMod.runSchedule(stored);
    const dataRows = run.rows.filter((r: any) => !r.subtotal);
    return {
      ok: true,
      data: {
        id,
        name: stored.name,
        totalRows: dataRows.length,
        totalGroups: run.rows.filter((r: any) => r.subtotal).length,
        totals: run.totals,
        sampleRows: dataRows.slice(0, maxRows).map((r: any) => r.values),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `Run failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Destructive tools
   ═════════════════════════════════════════════════════════════════════════ */
async function deleteElementsTool(args: Record<string, any>): Promise<ToolResult> {
  const ids = Array.isArray(args.ids) ? args.ids.map((x: any) => String(x)) : [];
  if (!ids.length) return { ok: false, error: "No ids provided" };
  const authoring = services.tryUse("authoring");
  if (!authoring?.selectAllAuthored || !authoring?.deleteSelectedElement) {
    return { ok: false, error: "Authoring module does not support this operation" };
  }
  try {
    authoring.selectAllAuthored(ids);
    authoring.deleteSelectedElement();
    return { ok: true, data: { deleted: ids.length } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function clearAllElementsTool(): Promise<ToolResult> {
  const authoring = services.tryUse("authoring");
  if (!authoring?.clearAllElements) {
    return { ok: false, error: "Authoring module not loaded" };
  }
  try {
    authoring.clearAllElements(true);
    return { ok: true, data: { cleared: true } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup — register AI-friendly commands
   ═════════════════════════════════════════════════════════════════════════ */
export function setupAiTools(): void {
  registerCommand({
    id: "ai.selectDoors",
    label: "AI · Select all doors",
    category: "AI",
    run: () => executeTool({ id: "t", name: "select_by_category", args: { category: "IFCDOOR" } }),
  });
  registerCommand({
    id: "ai.selectWalls",
    label: "AI · Select all walls",
    category: "AI",
    run: () => executeTool({ id: "t", name: "select_by_category", args: { category: "IFCWALL" } }),
  });
  registerCommand({
    id: "ai.selectPipes",
    label: "AI · Select all pipes",
    category: "AI",
    run: () => executeTool({ id: "t", name: "select_by_category", args: { category: "IFCPIPESEGMENT" } }),
  });
  registerCommand({
    id: "ai.focusSelection",
    label: "AI · Focus on selection",
    category: "AI",
    run: () => executeTool({ id: "t", name: "focus_camera", args: {} }),
  });
  registerCommand({
    id: "ai.buildIndex",
    label: "AI · Build semantic index",
    category: "AI",
    run: () => executeTool({ id: "t", name: "build_semantic_index", args: {} }),
  });
  registerCommand({
    id: "ai.clearIndex",
    label: "AI · Clear semantic index",
    category: "AI",
    run: async () => {
      try {
        const mod: any = await import("./ai-embeddings");
        await mod.clearIndex();
      } catch { /* */ }
    },
  });
  registerCommand({
    id: "ai.runDoorSchedule",
    label: "AI · Run door schedule",
    category: "AI",
    run: () => executeTool({ id: "t", name: "run_schedule", args: { templateId: "tpl-door" } }),
  });
  registerCommand({
    id: "ai.runWallSchedule",
    label: "AI · Run wall schedule",
    category: "AI",
    run: () => executeTool({ id: "t", name: "run_schedule", args: { templateId: "tpl-wall" } }),
  });
  registerCommand({
    id: "ai.runCostSummary",
    label: "AI · Run cost summary",
    category: "AI",
    run: () => executeTool({ id: "t", name: "run_schedule", args: { templateId: "tpl-cost-summary" } }),
  });
  registerCommand({
    id: "ai.listSavedSchedules",
    label: "AI · List saved schedules",
    category: "AI",
    run: () => executeTool({ id: "t", name: "list_saved_schedules", args: {} }),
  });
}