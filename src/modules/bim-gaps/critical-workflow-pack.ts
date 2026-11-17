/**
 * Critical workflow pack — 10 documentation / production gaps closed as one unit:
 *  1. AUTOTAGALL        tags on doors, windows, rooms, columns
 *  2. DOORSCHEDULE      door schedule from model
 *  3. WINDOWSCHEDULE    window schedule
 *  4. WALLSCHEDULE      wall type/length schedule
 *  5. CREATESHEETPACK   standard A-101/A-201/A-301 sheets
 *  6. CREATEVIEWS       plan per level + 4 elevations
 *  7. MATERIALTAKEOFF   simple quantity report
 *  8. COLUMNSONGRID     columns at grid intersections
 *  9. MATCHPROP         copy type props between same-category elements
 * 10. SPACEELEMENTS     equal spacing along a line for selected point elements
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { buildTagAll } from "../views/plan-tags";
import { createSheet, listSheets } from "../sheets/sheets";
import { createView, listViews } from "../views/store";
import { registerCommand } from "../../features/command-palette";

/* ── Module-local result state (retrieved via ctx.features.workflowPack) ── */
let lastTags: Any[] = [];
let lastSchedule: { title: string; rows: ScheduleRow[]; at: number } | null = null;
let lastTakeoff: Array<{ category: string; qty: number; unit: string }> = [];

type Any = Record<string, any>;

function authoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? null;
}

function elements(): Any[] {
  return authoring()?.getElements?.() ?? [];
}

function levels(): Any[] {
  return (authoring()?.getLevels?.() ?? []).slice().sort((a: Any, b: Any) => a.elevation - b.elevation);
}

function grids(): Any[] {
  return authoring()?.getGrids?.() ?? [];
}

/* ── 1. Auto tag all ─────────────────────────────────────────────── */

const TAG_KEY = "obs.plan.autoTags";

export function autoTagAll(): number {
  const els = elements();
  const targets = els.filter((e) =>
    ["door", "window", "column", "room", "equipment", "stairs"].includes(e.type),
  );
  const tags = buildTagAll(targets, [], { mode: "category" });
  // Persist marks on elements when missing
  let marked = 0;
  const byType = new Map<string, number>();
  for (const e of targets) {
    if (e.properties?.Mark || e.properties?.mark) continue;
    const n = (byType.get(e.type) ?? 0) + 1;
    byType.set(e.type, n);
    const prefix = e.type === "door" ? "D" : e.type === "window" ? "W" : e.type === "column" ? "C" : "E";
    e.properties = { ...(e.properties ?? {}), Mark: `${prefix}${String(n).padStart(2, "0")}` };
    marked++;
  }
  try {
    localStorage.setItem(TAG_KEY, JSON.stringify(tags));
  } catch { /* */ }
  lastTags = tags;
  try {
    authoring()?.rebuildAuthored?.() ?? authoring()?.rebuild?.();
  } catch { /* */ }
  notify("success", `Tagged ${targets.length} element(s), assigned ${marked} new mark(s)`);
  return tags.length;
}

/* ── 2–4. Schedules ──────────────────────────────────────────────── */

export interface ScheduleRow {
  mark: string;
  type: string;
  size: string;
  count: number;
  level?: string;
  length?: number;
  notes?: string;
}

function doorWindowRows(kind: "door" | "window"): ScheduleRow[] {
  const map = new Map<string, ScheduleRow>();
  for (const e of elements()) {
    if (e.type !== kind) continue;
    const mark = String(e.properties?.Mark ?? e.properties?.mark ?? e.name ?? e.id);
    const w = Number(e.params?.width ?? 0.9);
    const h = Number(e.params?.height ?? (kind === "door" ? 2.1 : 1.4));
    const size = `${Math.round(w * 1000)}×${Math.round(h * 1000)}`;
    const key = `${mark}|${size}`;
    const prev = map.get(key);
    if (prev) prev.count++;
    else map.set(key, { mark, type: kind, size, count: 1, notes: String(e.properties?.family ?? "") });
  }
  return [...map.values()].sort((a, b) => a.mark.localeCompare(b.mark));
}

function wallRows(): ScheduleRow[] {
  const map = new Map<string, ScheduleRow>();
  for (const e of elements()) {
    if (e.type !== "wall" && e.type !== "curtain-wall") continue;
    const typeName = String(e.properties?.wallTypeId ?? e.properties?.family ?? e.type);
    const th = Number(e.params?.thickness ?? 0.2);
    const len =
      e.params?.start && e.params?.end
        ? Math.hypot(e.params.end[0] - e.params.start[0], e.params.end[1] - e.params.start[1])
        : 0;
    const key = `${typeName}|${th.toFixed(3)}`;
    const prev = map.get(key);
    if (prev) {
      prev.count++;
      prev.length = (prev.length ?? 0) + len;
    } else {
      map.set(key, {
        mark: typeName,
        type: e.type,
        size: `${Math.round(th * 1000)} mm`,
        count: 1,
        length: len,
      });
    }
  }
  return [...map.values()];
}

function emitSchedule(title: string, rows: ScheduleRow[]): ScheduleRow[] {
  lastSchedule = { title, rows, at: Date.now() };
  console.table(rows);
  notify(
    "success",
    rows.length
      ? `${title}: ${rows.length} row(s)`
      : `${title}: no matching elements`,
  );
  try {
    localStorage.setItem(
      `obs.schedule.${title.replace(/\s+/g, "_")}`,
      JSON.stringify({ title, rows }),
    );
  } catch { /* */ }
  return rows;
}

export const buildDoorSchedule = () => emitSchedule("Door Schedule", doorWindowRows("door"));
export const buildWindowSchedule = () => emitSchedule("Window Schedule", doorWindowRows("window"));
export const buildWallSchedule = () => emitSchedule("Wall Schedule", wallRows());

/* ── 5. Sheet pack ───────────────────────────────────────────────── */

export function createSheetPack(): number {
  const existing = new Set((listSheets() ?? []).map((s: Any) => s.number));
  const pack = [
    { number: "A-001", name: "Cover / Notes" },
    { number: "A-101", name: "Floor Plans" },
    { number: "A-201", name: "Elevations" },
    { number: "A-301", name: "Sections" },
    { number: "A-401", name: "Schedules" },
    { number: "A-501", name: "Details" },
  ];
  let n = 0;
  for (const s of pack) {
    if (existing.has(s.number)) continue;
    try {
      createSheet({ number: s.number, name: s.name, size: "A1" });
      n++;
    } catch (e) {
      console.warn("[sheet-pack]", e);
    }
  }
  notify("success", n ? `Created ${n} sheet(s)` : "Sheet pack already exists");
  return n;
}

/* ── 6. Views pack ───────────────────────────────────────────────── */

export function createStandardViews(): number {
  let n = 0;
  const existing = new Set((listViews() ?? []).map((v: Any) => v.name));
  for (const lv of levels()) {
    const name = `Plan — ${lv.name ?? lv.id}`;
    if (existing.has(name)) continue;
    try {
      const def = createView("plan", name, "ARC");
      if (def?.plan) {
        def.plan.levelElevation = Number(lv.elevation) || 0;
        def.plan.cutHeight = 1.2;
      }
      n++;
    } catch (e) {
      console.warn("[views]", e);
    }
  }
  for (const dir of ["north", "south", "east", "west"] as const) {
    const name = `Elevation — ${dir}`;
    if (existing.has(name)) continue;
    try {
      const def = createView("elevation", name, "ARC");
      if (def?.elevation) def.elevation.direction = dir;
      n++;
    } catch (e) {
      console.warn("[elev]", e);
    }
  }
  if (!existing.has("Section — A")) {
    try {
      createView("section", "Section — A", "ARC");
      n++;
    } catch { /* */ }
  }
  notify("success", n ? `Created ${n} view(s)` : "Standard views already present");
  return n;
}

/* ── 7. Material takeoff ─────────────────────────────────────────── */

export function materialTakeoff(): Array<{ category: string; qty: number; unit: string }> {
  const out: Array<{ category: string; qty: number; unit: string }> = [];
  let wallLen = 0, wallArea = 0, slabArea = 0, doorN = 0, winN = 0, colN = 0;
  for (const e of elements()) {
    if (e.type === "wall" || e.type === "curtain-wall") {
      const len =
        e.params?.start && e.params?.end
          ? Math.hypot(e.params.end[0] - e.params.start[0], e.params.end[1] - e.params.start[1])
          : 0;
      const h = Number(e.params?.height) || 3;
      wallLen += len;
      wallArea += len * h;
    } else if (e.type === "slab" || e.type === "roof" || e.type === "ceiling") {
      const poly = e.params?.polygon as Array<[number, number]> | undefined;
      if (poly && poly.length >= 3) {
        let a = 0;
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length];
          a += p[0] * q[1] - q[0] * p[1];
        }
        slabArea += Math.abs(a) * 0.5;
      }
    } else if (e.type === "door") doorN++;
    else if (e.type === "window") winN++;
    else if (e.type === "column") colN++;
  }
  out.push(
    { category: "Walls length", qty: +wallLen.toFixed(2), unit: "m" },
    { category: "Walls area (gross)", qty: +wallArea.toFixed(2), unit: "m²" },
    { category: "Floor/roof area", qty: +slabArea.toFixed(2), unit: "m²" },
    { category: "Doors", qty: doorN, unit: "ea" },
    { category: "Windows", qty: winN, unit: "ea" },
    { category: "Columns", qty: colN, unit: "ea" },
  );
  console.table(out);
  lastTakeoff = out;
  notify("success", `Material takeoff ready — ${out.length} categories`);
  return out;
}

/* ── 8. Columns on grid ──────────────────────────────────────────── */

export async function columnsOnGrid(): Promise<number> {
  const a = authoring();
  const gs = grids();
  if (gs.length < 2) {
    notify("warn", "Need at least 2 grids");
    return 0;
  }
  // Intersect axis-aligned / general grid lines
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < gs.length; i++) {
    for (let j = i + 1; j < gs.length; j++) {
      const A = gs[i], B = gs[j];
      if (!A.start || !A.end || !B.start || !B.end) continue;
      const hit = segIntersect(
        A.start[0], A.start[1], A.end[0], A.end[1],
        B.start[0], B.start[1], B.end[0], B.end[1],
      );
      if (hit) pts.push(hit);
    }
  }
  // Dedupe
  const seen = new Set<string>();
  const unique = pts.filter(([x, z]) => {
    const k = `${x.toFixed(2)},${z.toFixed(2)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  let n = 0;
  for (const [x, z] of unique) {
    try {
      const id = await a?.createElementByType?.("column", { point: [x, z] });
      if (id) n++;
    } catch { /* */ }
  }
  notify("success", n ? `Placed ${n} column(s) on grid intersections` : "No intersections or create failed");
  return n;
}

function segIntersect(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): [number, number] | null {
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t < -0.02 || t > 1.02 || u < -0.02 || u > 1.02) return null;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/* ── 9. Match properties ─────────────────────────────────────────── */

export function matchProperties(sourceId: string, targetIds: string[]): number {
  const els = elements();
  const src = els.find((e) => e.id === sourceId);
  if (!src) {
    notify("warn", "Source element not found");
    return 0;
  }
  let n = 0;
  for (const id of targetIds) {
    if (id === sourceId) continue;
    const t = els.find((e) => e.id === id);
    if (!t || t.type !== src.type) continue;
    t.properties = {
      ...(t.properties ?? {}),
      wallTypeId: src.properties?.wallTypeId,
      family: src.properties?.family,
      layers: src.properties?.layers,
      Material: src.properties?.Material ?? src.properties?.material,
      material: src.properties?.material ?? src.properties?.Material,
    };
    if (src.params?.thickness != null) t.params.thickness = src.params.thickness;
    if (src.params?.height != null && (t.type === "wall" || t.type === "column")) {
      t.params.height = src.params.height;
    }
    n++;
  }
  try {
    authoring()?.rebuildAuthored?.() ?? authoring()?.rebuild?.();
  } catch { /* */ }
  notify("success", `Matched properties onto ${n} element(s)`);
  return n;
}

/** Match from first selected onto rest (via authoring selection if available). */
export function matchPropertiesFromSelection(): number {
  const a = authoring();
  const ids: string[] =
    a?.getSelectedIds?.() ??
    a?.getSelection?.() ??
    [];
  if (!ids.length) {
    notify("warn", "Select source then targets (source = first)");
    return 0;
  }
  return matchProperties(ids[0], ids.slice(1));
}

/* ── 10. Space point elements evenly ─────────────────────────────── */

export function spaceElementsEvenly(ids?: string[]): number {
  const a = authoring();
  const sel: string[] =
    ids ??
    a?.getSelectedIds?.() ??
    [];
  const pts = elements().filter(
    (e) => sel.includes(e.id) && e.params?.point,
  );
  if (pts.length < 3) {
    notify("warn", "Select 3+ point elements (columns, equipment) to space");
    return 0;
  }
  pts.sort((a, b) => a.params.point[0] - b.params.point[0] || a.params.point[1] - b.params.point[1]);
  const first = pts[0].params.point as [number, number];
  const last = pts[pts.length - 1].params.point as [number, number];
  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    pts[i].params.point = [
      first[0] + (last[0] - first[0]) * t,
      first[1] + (last[1] - first[1]) * t,
    ];
  }
  try {
    a?.rebuildAuthored?.() ?? a?.rebuild?.();
  } catch { /* */ }
  notify("success", `Spaced ${pts.length} elements evenly`);
  return pts.length;
}

/* ── Boot ────────────────────────────────────────────────────────── */

export function setupCriticalWorkflowPack(): void {
  const api = {
    autoTagAll,
    buildDoorSchedule,
    buildWindowSchedule,
    buildWallSchedule,
    createSheetPack,
    createStandardViews,
    materialTakeoff,
    columnsOnGrid,
    matchProperties,
    matchPropertiesFromSelection,
    spaceElementsEvenly,
    getAutoTags: () => lastTags,
    getLastSchedule: () => lastSchedule,
    getLastTakeoff: () => lastTakeoff,
  };
  (ctx.features as Any).workflowPack = api;

  const cmds: Array<[string, string, string, () => void]> = [
    ["rg-autotag", "Tag all doors/windows/rooms", "Documentation", () => void autoTagAll()],
    ["rg-door-sch", "Schedule: doors", "Documentation", () => void buildDoorSchedule()],
    ["rg-win-sch", "Schedule: windows", "Documentation", () => void buildWindowSchedule()],
    ["rg-wall-sch", "Schedule: walls", "Documentation", () => void buildWallSchedule()],
    ["rg-sheet-pack", "Sheets: create standard pack", "Documentation", () => void createSheetPack()],
    ["rg-views-pack", "Views: plans + elevations", "Documentation", () => void createStandardViews()],
    ["rg-takeoff", "Material takeoff", "Documentation", () => void materialTakeoff()],
    ["rg-cols-grid", "Columns on grid intersections", "Structure", () => void columnsOnGrid()],
    ["rg-matchprop", "Match properties (selection)", "Modify", () => void matchPropertiesFromSelection()],
    ["rg-space", "Space elements evenly", "Modify", () => void spaceElementsEvenly()],
  ];

  // Register into the real command palette (the legacy window registry and the
  // CustomEvent channel had no backing — commands registered there never appeared).
  for (const [id, label, category, run] of cmds) {
    try {
      registerCommand({ id, label, category, run });
    } catch (e) {
      console.warn("[workflow-pack] register failed", id, e);
    }
  }

  console.log("[workflow-pack] 10 critical documentation/production commands registered");
}
