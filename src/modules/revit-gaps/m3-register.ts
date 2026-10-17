/**
 * Milestone 3 registration: real plan content, true elevations and sections, PDF fills.
 *
 * Installs window.__obsViewExt, which three anchored lines (added by the installer) in
 * modules/views/generators/{plan,section,elevation}.ts call:
 *   planFilter(planView, def)  drop the base generator's geometry for elements that now get proper symbols
 *   plan(def, scene)           add poche, room tags, symbols, door marks
 *   section(def) / elevation(def)  replace the bounding-rectangle projections with real ones
 * and window.__obsM3FillPolygon, used by the PDF exporter (see m3-pdf-fill.ts).
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { roomsStore } from "../rooms/rooms";
import { listViews, updateView } from "../views/store";
import { elementSolids, type SolidElement } from "./m3-solids";
import { cutSolids, capEntities, datumEntities, elevationFrame, entitiesBounds, projectSolids, sectionFrame, DEFAULT_STYLES } from "./m3-project";
import { DEFAULT_PLAN_OPTIONS, planExtras, type PlanExtras, type PlanOptions, type PlanRoom } from "./m3-plan";
import { fillPolygonPdf } from "./m3-pdf-fill";

type Any = Record<string, any>;
const authoring = (): Any | null => ((ctx.features as Any).authoring ?? null);
const KEY = "obs.m3.planOptions";

export function getPlanOptions(): PlanOptions {
  try { return { ...DEFAULT_PLAN_OPTIONS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULT_PLAN_OPTIONS }; }
}
export function setPlanOption<K extends keyof PlanOptions>(k: K, v: PlanOptions[K]): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...getPlanOptions(), [k]: v })); } catch { /* */ }
}

function elements(): SolidElement[] { return (authoring()?.getElements?.() ?? []) as SolidElement[]; }
function levels(): Array<{ name: string; elevation: number }> {
  return ((authoring()?.getLevels?.() ?? []) as Any[]).map((l) => ({ name: String(l.name), elevation: Number(l.elevation) || 0 })).sort((a, b) => a.elevation - b.elevation);
}
function levelElevation(levelId: string | null): number {
  if (!levelId) return 0;
  return Number(((authoring()?.getLevels?.() ?? []) as Any[]).find((l) => l.id === levelId)?.elevation) || 0;
}

/** Same view range arithmetic as modules/drawings/plan-generator.ts. */
function planBand(def: Any): { cut: number; low: number; high: number } {
  const pl = def.plan;
  const lowDepth = Math.max(Math.abs(pl.bottomDepth ?? 0), Math.abs(pl.viewDepth ?? pl.bottomDepth ?? 0));
  const highDepth = Math.max(pl.cutHeight, Math.abs(pl.topHeight ?? pl.cutHeight));
  return { cut: pl.levelElevation + pl.cutHeight, low: pl.levelElevation - lowDepth, high: pl.levelElevation + highDepth };
}

function roomsFor(def: Any): PlanRoom[] {
  const elev = def.plan.levelElevation;
  return roomsStore.listRooms()
    .filter((r) => Math.abs(levelElevation(r.levelId) - elev) < 0.05)
    .map((r) => ({ id: r.id, name: r.name, number: r.number, area: r.area, levelId: r.levelId, boundary: r.boundary, labelPoint: r.properties?.labelPoint as [number, number] | undefined }));
}

export function computePlanExtras(def: Any): PlanExtras | null {
  if (!def?.plan) return null;
  const b = planBand(def);
  return planExtras({ elements: elements(), rooms: roomsFor(def), cutElevation: b.cut, bandLow: b.low, bandHigh: b.high, scale: def.scale || 100, kind: def.kind === "rcp" ? "rcp" : "plan", options: getPlanOptions() });
}

const POCHE: Record<string, string> = { wall: "#6b7280", slab: "#6b7280", roof: "#6b7280", column: "#6b7280", footing: "#6b7280" };
const pocheFor = (type: string) => POCHE[type] ?? "#9ca3af";
const LIGHT = { ...DEFAULT_STYLES, outline: { color: "#374151", widthPt: 0.18, dash: null }, crease: { color: "#6b7280", widthPt: 0.12, dash: null } };

function finishScene(scene: Any, extra: Any[]): void {
  const b = entitiesBounds([...scene.layers.project, ...scene.layers.cut, ...extra]);
  if (b) scene.bounds = b;
  scene.generatedAt = Date.now();
}

async function sectionScene(def: Any): Promise<Any | null> {
  if (!def.section) return null;
  const solids = elementSolids(elements());
  if (!solids.length) return null;
  const frame = sectionFrame(def.section.cutLine, def.section.lookDir === "left" ? "left" : "right");
  const { far, caps } = cutSolids(solids, frame);
  const scene: Any = { bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 }, layers: { cut: [], project: [], overhead: [], below: [], grid: [], annotation: [], symbols: [] }, generatedAt: Date.now() };
  scene.layers.project.push(...projectSolids(far, frame, { styles: LIGHT, farClip: def.section.farClip ?? 60 }));
  scene.layers.cut.push(...capEntities(caps, pocheFor));
  const b = entitiesBounds([...scene.layers.project, ...scene.layers.cut]);
  if (!b) return null;
  const lv = levels().filter((l) => l.elevation >= (def.section.bottom ?? -1e9) - 0.01 && l.elevation <= (def.section.top ?? 1e9) + 0.01);
  scene.layers.annotation.push(...datumEntities(lv, b.minX - 0.5, b.maxX + 0.5));
  finishScene(scene, scene.layers.annotation);
  return scene;
}

async function elevationScene(def: Any): Promise<Any | null> {
  if (!def.elevation) return null;
  const solids = elementSolids(elements());
  if (!solids.length) return null;
  const frame = elevationFrame(def.elevation.direction);
  const scene: Any = { bounds: { minX: 0, minZ: 0, maxX: 10, maxZ: 10 }, layers: { cut: [], project: [], overhead: [], below: [], grid: [], annotation: [], symbols: [] }, generatedAt: Date.now() };
  scene.layers.project.push(...projectSolids(solids, frame, { farClip: def.elevation.farClip ?? 100 }));
  const b = entitiesBounds(scene.layers.project);
  if (!b) return null;
  scene.layers.annotation.push(...datumEntities(levels().filter((l) => l.elevation >= b.minZ - 0.5 && l.elevation <= b.maxZ + 0.5), b.minX - 0.5, b.maxX + 0.5));
  finishScene(scene, scene.layers.annotation);
  return scene;
}

/** Force every saved view to regenerate (sheets cache scenes by view update time). */
export async function refreshViews(): Promise<void> {
  for (const v of listViews()) updateView(v.id, { updatedAt: Date.now() });
}

let installed = false;
export function setupM3(): { ok: boolean; detail: string } {
  if (installed) return { ok: true, detail: "already installed" };
  installed = true;
  const w = window as Any;
  w.__obsViewExt = {
    planFilter(planView: Any, def: Any) {
      const extras = computePlanExtras(def);
      def.__m3 = extras;
      if (!extras || !extras.suppressIds.size) return;
      planView.segments = planView.segments.filter((s: Any) => !s.source || !extras.suppressIds.has(s.source));
    },
    plan(def: Any, scene: Any) {
      const x: PlanExtras | null = def.__m3 ?? computePlanExtras(def);
      delete def.__m3;
      if (!x) return;
      scene.layers.cut.unshift(...x.under);
      scene.layers.cut.push(...x.cut);
      scene.layers.overhead.push(...x.overhead);
      scene.layers.symbols.push(...x.symbols);
      const b = entitiesBounds([...scene.layers.cut, ...scene.layers.overhead, ...scene.layers.symbols]);
      if (b) scene.bounds = { minX: Math.min(scene.bounds.minX, b.minX), minZ: Math.min(scene.bounds.minZ, b.minZ), maxX: Math.max(scene.bounds.maxX, b.maxX), maxZ: Math.max(scene.bounds.maxZ, b.maxZ) };
    },
    section: sectionScene,
    elevation: elevationScene,
  };
  w.__obsM3FillPolygon = fillPolygonPdf;
  w.__obsM3 = { getPlanOptions, setPlanOption, refreshViews };
  return { ok: true, detail: "plan content, true sections / elevations, PDF fills" };
}

export function togglePlanOption(k: keyof PlanOptions, label: string): void {
  const cur = getPlanOptions();
  const next = !cur[k];
  setPlanOption(k, next as never);
  void refreshViews();
  notify("info", `${label}: ${next ? "on" : "off"}`, { timeout: 1500 });
}
