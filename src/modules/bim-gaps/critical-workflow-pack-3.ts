/**
 * Critical workflow pack 3 — phases, issues, COBie, worksets, keynotes, revisions, visibility:
 *  1. DEFAULTPHASES     New / Existing / Demolition
 *  2. ISSUEFROMSEL      issue from selection
 *  3. COBIEEXPORT       COBie spreadsheet from model
 *  4. WORKSETPACK       Architecture / Structure / MEP worksets + assign by type
 *  5. KEYNOTESAMPLE     load sample keynotes + legend CSV
 *  6. REVISIONNOW       add revision record on active sheet pack
 *  7. HIDECATEGORY      hide selected category in authoring
 *  8. ISOLATESEL        isolate selection
 *  9. LOCKSEL           pin/lock selected elements
 * 10. DUPLICATESEL      copy selection offset 1 m in X
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { registerCommand } from "../../features/command-palette";
import { phasesStore } from "../phases/phases";

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

/* ── 1. Default phases ───────────────────────────────────────────── */

export function ensureDefaultPhases(): number {
  try {
    const store = (ctx.features as Any).phases ?? phasesStore;
    if (!store?.create && !store?.add && !store?.list) {
      notify("warn", "Phases store not ready");
      return 0;
    }
    const existing = new Set((store.list?.() ?? []).map((p: Any) => String(p.name).toLowerCase()));
    const defs = ["New Construction", "Existing", "Demolition"];
    let n = 0;
    for (const name of defs) {
      if (existing.has(name.toLowerCase())) continue;
      try {
        if (typeof store.create === "function") store.create(name);
        n++;
      } catch (e) {
        console.warn("[phases]", e);
      }
    }
    notify("success", n ? `Created ${n} phase(s)` : "Default phases already present");
    return n;
  } catch (e) {
    notify("warn", `Phases failed: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

/* ── 2. Issue from selection ─────────────────────────────────────── */

export function issueFromSelection(): string | null {
  try {
    const issues = (ctx.features as Any).issues;
    const ids = selectedIds();
    const title = ids.length
      ? `Issue on ${ids.length} element(s)`
      : "General model issue";
    const body = ids.length
      ? `Related elements: ${ids.slice(0, 12).join(", ")}`
      : "No selection — general note";
    let id: string | null = null;
    if (typeof issues?.createIssue === "function") {
      const iss = issues.createIssue(title, body);
      id = iss?.id ?? null;
    } else {
      // Fallback local store
      const list: Any[] = JSON.parse(localStorage.getItem("obs.issues.local") || "[]");
      id = `iss-${Date.now().toString(36)}`;
      list.push({ id, title, description: body, elementIds: ids, status: "open", createdAt: Date.now() });
      localStorage.setItem("obs.issues.local", JSON.stringify(list));
    }
    notify("success", `Issue created${id ? `: ${id}` : ""}`);
    return id;
  } catch (e) {
    notify("warn", `Issue failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/* ── 3. COBie export ─────────────────────────────────────────────── */

export async function exportCobieFromModel(): Promise<void> {
  try {
    const mod = await import("../export/cobie");
    await mod.exportCobie({ projectName: "OpenBIMStudio Project", format: "xls" });
    notify("success", "COBie export started");
  } catch (e) {
    console.error("[cobie]", e);
    notify("warn", `COBie export failed: ${e instanceof Error ? e.message : e}`);
  }
}

/* ── 4. Workset pack ─────────────────────────────────────────────── */

const TYPE_WORKSET: Record<string, string> = {
  wall: "Architecture",
  "curtain-wall": "Architecture",
  door: "Architecture",
  window: "Architecture",
  slab: "Architecture",
  roof: "Architecture",
  ceiling: "Architecture",
  stairs: "Architecture",
  railing: "Architecture",
  room: "Architecture",
  column: "Structure",
  beam: "Structure",
  brace: "Structure",
  footing: "Structure",
  strip: "Structure",
  truss: "Structure",
  duct: "MEP",
  pipe: "MEP",
  "cable-tray": "MEP",
  conduit: "MEP",
  equipment: "MEP",
  fitting: "MEP",
};

export async function setupWorksetPack(): Promise<number> {
  try {
    const ws = await import("../worksets/worksets");
    try { ws.initWorksets?.({}); } catch { /* */ }
    const names = ["Architecture", "Structure", "MEP", "Shared"];
    const existing = new Set(ws.listWorksets().map((w) => w.name));
    let n = 0;
    const byName = new Map<string, string>();
    for (const name of names) {
      if (!existing.has(name)) {
        const w = ws.createWorkset(name, true);
        byName.set(name, w.id);
        n++;
      } else {
        const w = ws.listWorksets().find((x) => x.name === name);
        if (w) byName.set(name, w.id);
      }
    }
    // Assign elements by type (workset API uses numeric elementId - hash string ids)
    let assigned = 0;
    for (const el of elements()) {
      const bucket = TYPE_WORKSET[el.type] ?? "Shared";
      const wid = byName.get(bucket);
      if (!wid) continue;
      const numId = hashId(el.id);
      try {
        if (ws.assignToWorkset(numId, wid)) assigned++;
      } catch { /* */ }
      // also stamp property for visibility
      el.properties = { ...(el.properties ?? {}), workset: bucket };
    }
    notify("success", `Worksets: ${n} created, ${assigned} assignments`);
    return n;
  } catch (e) {
    notify("warn", `Worksets failed: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

/* ── 5. Sample keynotes ──────────────────────────────────────────── */

const SAMPLE_KEYNOTES = `01.01\tConcrete\tCast-in-place concrete
01.02\tRebar\tReinforcing steel
02.01\tCMU\tConcrete masonry unit
03.01\tStud\tMetal stud framing
03.02\tGWB\tGypsum wall board
04.01\tDoor\tInterior door assembly
04.02\tWindow\tAluminum window system
05.01\tFloor\tFinished floor
06.01\tCeiling\tSuspended acoustic ceiling
`;

// Use real dynamic import in async path for keynotes
export async function loadSampleKeynotesAsync(): Promise<number> {
  try {
    const mod = await import("../keynotes/types");
    const n = mod.loadKeynoteFile(SAMPLE_KEYNOTES);
    for (const el of elements()) {
      if (el.type === "door") {
        mod.assignKeynote({
          code: "04.01", elementId: String(el.id), viewId: null,
          offsetMm: [0, 0], leader: true,
        });
      }
      if (el.type === "window") {
        mod.assignKeynote({
          code: "04.02", elementId: String(el.id), viewId: null,
          offsetMm: [0, 0], leader: true,
        });
      }
    }
    try {
      localStorage.setItem("obs.keynotes.legend", mod.legendToCSV());
    } catch { /* */ }
    notify("success", `Keynotes loaded (${n})`);
    return n;
  } catch (e) {
    notify("warn", `Keynotes failed: ${e instanceof Error ? e.message : e}`);
    return 0;
  }
}

/* ── 6. Revision now ─────────────────────────────────────────────── */

export async function addRevisionNow(): Promise<string | null> {
  try {
    const mod = await import("../revisions/model");
    const rec = mod.addRevisionRecord({
      description: `Model snapshot ${new Date().toLocaleString()}`,
      date: new Date().toISOString().slice(0, 10),
      issuedBy: "OpenBIMStudio",
    });
    notify("success", `Revision ${rec?.sequenceLabel ?? ""} recorded`);
    return rec?.id ?? null;
  } catch (e) {
    // local fallback
    const list: Any[] = JSON.parse(localStorage.getItem("obs.revisions.local") || "[]");
    const id = `rev-${Date.now().toString(36)}`;
    list.push({ id, number: String(list.length + 1), description: "Snapshot", date: new Date().toISOString() });
    localStorage.setItem("obs.revisions.local", JSON.stringify(list));
    notify("success", `Revision ${list.length} recorded (local)`);
    return id;
  }
}

/* ── 7. Hide category ────────────────────────────────────────────── */

export function hideSelectedCategory(): number {
  const ids = selectedIds();
  const els = elements();
  const src = ids.length ? els.find((e) => e.id === ids[0]) : null;
  if (!src) {
    notify("warn", "Select an element whose category to hide");
    return 0;
  }
  const type = src.type;
  let n = 0;
  const a = authoring();
  for (const el of els) {
    if (el.type !== type) continue;
    try {
      if (typeof a?.setElementVisibility === "function") a.setElementVisibility(el.id, false);
      else el.properties = { ...(el.properties ?? {}), hidden: true };
      n++;
    } catch { /* */ }
  }
  try { a?.rebuildAuthored?.() ?? a?.rebuild?.(); } catch { /* */ }
  notify("success", `Hidden ${n} × ${type}`);
  return n;
}

export function showAllCategories(): void {
  const a = authoring();
  for (const el of elements()) {
    try {
      if (typeof a?.setElementVisibility === "function") a.setElementVisibility(el.id, true);
      if (el.properties?.hidden) {
        const p = { ...el.properties };
        delete p.hidden;
        el.properties = p;
      }
    } catch { /* */ }
  }
  try { a?.rebuildAuthored?.() ?? a?.rebuild?.(); } catch { /* */ }
  notify("success", "All categories visible");
}

/* ── 8. Isolate selection ────────────────────────────────────────── */

export function isolateSelection(): number {
  const ids = new Set(selectedIds());
  if (!ids.size) {
    notify("warn", "Select elements to isolate");
    return 0;
  }
  const a = authoring();
  let n = 0;
  for (const el of elements()) {
    const vis = ids.has(el.id);
    try {
      if (typeof a?.setElementVisibility === "function") a.setElementVisibility(el.id, vis);
      else el.properties = { ...(el.properties ?? {}), hidden: !vis };
      if (vis) n++;
    } catch { /* */ }
  }
  try { a?.rebuildAuthored?.() ?? a?.rebuild?.(); } catch { /* */ }
  notify("success", `Isolated ${n} element(s)`);
  return n;
}

/* ── 9. Lock / pin selection ─────────────────────────────────────── */

export function lockSelection(lock = true): number {
  const ids = new Set(selectedIds());
  if (!ids.size) {
    notify("warn", "Select elements to lock");
    return 0;
  }
  let n = 0;
  for (const el of elements()) {
    if (!ids.has(el.id)) continue;
    el.properties = { ...(el.properties ?? {}), pinned: lock };
    n++;
  }
  notify("success", lock ? `Locked ${n} element(s)` : `Unlocked ${n} element(s)`);
  return n;
}

/* ── 10. Duplicate selection ─────────────────────────────────────── */

export async function duplicateSelection(offset = 1): Promise<number> {
  const a = authoring();
  const ids = selectedIds();
  if (!ids.length) {
    notify("warn", "Select elements to duplicate");
    return 0;
  }
  let n = 0;
  for (const id of ids) {
    const el = elements().find((e) => e.id === id);
    if (!el) continue;
    const params = JSON.parse(JSON.stringify(el.params ?? {}));
    if (params.start) { params.start[0] += offset; }
    if (params.end) { params.end[0] += offset; }
    if (params.point) { params.point[0] += offset; }
    if (params.polygon) params.polygon = params.polygon.map((v: number[]) => [v[0] + offset, v[1]]);
    try {
      const newId = await a?.createElementByType?.(el.type, params);
      if (newId) {
        const copy = elements().find((e) => e.id === newId);
        if (copy) copy.properties = { ...(el.properties ?? {}), Mark: undefined, mark: undefined };
        n++;
      }
    } catch (e) {
      console.warn("[dup]", e);
    }
  }
  notify("success", `Duplicated ${n} element(s)`);
  return n;
}

/* ── Boot ────────────────────────────────────────────────────────── */

export function setupCriticalWorkflowPack3(): void {
  const api = {
    ensureDefaultPhases,
    issueFromSelection,
    exportCobieFromModel,
    setupWorksetPack,
    loadSampleKeynotesAsync,
    addRevisionNow,
    hideSelectedCategory,
    showAllCategories,
    isolateSelection,
    lockSelection,
    duplicateSelection,
  };
  (ctx.features as Any).workflowPack3 = api;

  const cmds: Array<[string, string, string, () => void]> = [
    ["rg-phases", "Phases: create default set", "Project", () => void ensureDefaultPhases()],
    ["rg-issue", "Issue from selection", "Project", () => void issueFromSelection()],
    ["rg-cobie", "Export COBie", "Exchange", () => void exportCobieFromModel()],
    ["rg-worksets", "Worksets: Arch/Struct/MEP pack", "Project", () => void setupWorksetPack()],
    ["rg-keynotes", "Keynotes: load sample set", "Documentation", () => void loadSampleKeynotesAsync()],
    ["rg-revision", "Revision: record snapshot", "Documentation", () => void addRevisionNow()],
    ["rg-hide-cat", "Hide selected category", "View", () => void hideSelectedCategory()],
    ["rg-show-all", "Show all categories", "View", () => void showAllCategories()],
    ["rg-isolate", "Isolate selection", "View", () => void isolateSelection()],
    ["rg-lock", "Lock selection", "Modify", () => void lockSelection(true)],
    ["rg-dup", "Duplicate selection (+1m X)", "Modify", () => void duplicateSelection(1)],
  ];

  for (const [id, label, category, run] of cmds) {
    try {
      registerCommand({ id, label, category, run });
    } catch { /* */ }
  }
  console.log("[workflow-pack-3] project / view / exchange commands ready");
}
