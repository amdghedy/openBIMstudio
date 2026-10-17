/**
 * BIM-gaps boot (Milestones 1, 2 and 3).
 *
 * Wires, in order: per-project store persistence, real visibility (authored +
 * Fragments), wall-bounded rooms, the M2 element types (stairs, railings, ramps,
 * curtain walls, roofs, ceilings) and the authored-model IFC export. Each step
 * is isolated; the summary printed at the end lists what actually started and
 * what failed (the older boot logged "all wired" regardless).
 */
import { ctx } from "../../core/context";
import { notify } from "../../core/notify";
import { roomsStore } from "../rooms/rooms";
import { exportAuthoredToIfc, type IfcExportOptions, type IfcSchema } from "./authored-ifc";
import { setupProjectScope } from "./project-scope";
import {
  setupVisibilityBridge, hideSelection, isolateSelection, resetTemporaryVisibility,
  promptAssignPhase, promptAssignDesignOption, tagSelection, getSelectedKeys, applyAuthored,
} from "./visibility-bridge";
import { setupRoomTool, startRoomTool, placeRoomAt, placeRoomsAutomatically, refreshRoomOverlay } from "./room-tool";
import { setupM2Register } from "./m2-register";
import { installM2Redirects, startM2Tool, ceilingsFromRooms, createM2Element } from "./m2-tools";
import { setupM3, togglePlanOption, refreshViews } from "./m3-register";

type Any = Record<string, any>;
export interface StepStatus { name: string; ok: boolean; detail: string }
export const REVIT_GAPS_VERSION = "1.2.0-m3";
const status: StepStatus[] = [];

const authoring = (): Any | null => ((ctx.features as Any).authoring ?? (window as Any).__obsAuthoring ?? null);

/** Build the IFC text for the current authored model + rooms. */
export async function buildModelIfc(schema: IfcSchema = "IFC4") {
  const a = authoring();
  if (!a) throw new Error("Authoring is not ready");
  let project: Any | null = null;
  try { project = (await import("../projects/projects")).getCurrentProject(); } catch { /* */ }
  const name: string = project?.name || "OpenBIMStudio";
  const spaces = roomsStore.listRooms().map((r) => ({
    id: r.id, name: r.name, number: r.number, levelId: r.levelId, boundary: r.boundary,
    holes: (r.properties?.holes as Array<Array<{ x: number; z: number }>> | undefined) ?? [],
    height: r.height, area: r.area, department: r.department,
  }));
  const opts: IfcExportOptions = {
    schema, projectName: name, projectId: project?.id, levels: a.getLevels?.() ?? [], spaces,
    fileName: `${name.replace(/[^\w.-]+/g, "_")}_${schema}.ifc`,
  };
  return { opts, ...exportAuthoredToIfc(a.getElements?.() ?? [], opts) };
}

/** Export the authored model to an .ifc download. */
export async function exportIfc(schema: IfcSchema = "IFC4"): Promise<void> {
  try {
    const r = await buildModelIfc(schema);
    if (!r.stats.elements && !r.stats.spaces) { notify("warn", "Nothing to export - the authored model is empty"); return; }
    const blob = new Blob([r.text], { type: "application/x-step" });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: r.opts.fileName });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const skipped = r.stats.skipped.length;
    notify(skipped ? "warn" : "success",
      `${schema}: ${r.stats.elements} element(s), ${r.stats.spaces} room(s), ${r.stats.openings} opening(s)` + (skipped ? ` - ${skipped} not exported (see console)` : ""), { timeout: 4500 });
    if (skipped) console.table(r.stats.skipped);
  } catch (e) {
    console.error("[revit-gaps] IFC export failed", e);
    notify("error", "IFC export failed: " + (e instanceof Error ? e.message : String(e)));
  }
}

async function step(name: string, fn: () => unknown): Promise<void> {
  try {
    const r: any = await fn();
    status.push({ name, ok: r?.ok !== false, detail: r?.detail ?? "started" });
  } catch (e) {
    status.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    console.error(`[revit-gaps] ${name} failed`, e);
  }
}

let booted = false;
export async function setupBIMGaps(): Promise<StepStatus[]> {
  if (booted) return status;
  booted = true;

  await step("project-scope", setupProjectScope);
  await step("visibility-bridge", setupVisibilityBridge);
  await step("room-tool", setupRoomTool);
  await step("m2-elements", () => {
    const r = setupM2Register();
    installM2Redirects();
    return { ok: r.ok, detail: r.detail + "; ST/RA/CW/RF/CL tools and parity buttons redirected" };
  });
  await step("m3-views", setupM3);
  await step("ifc-export", () => ({ ok: true, detail: "File > Export > Model > IFC4 / IFC2X3" }));
  await step("commands", async () => {
    const { registerCommand } = await import("../../features/command-palette");
    const cmds: Array<[string, string, string, () => unknown]> = [
      ["rg-room-place", "Room: place (click inside walls)", "Rooms", startRoomTool],
      ["rg-room-auto", "Room: place rooms automatically", "Rooms", () => placeRoomsAutomatically()],
      ["rg-stairs", "Stairs: straight run", "Architecture", () => startM2Tool("stairs", "straight")],
      ["rg-stairs-l", "Stairs: L-shape (quarter turn)", "Architecture", () => startM2Tool("stairs", "L")],
      ["rg-stairs-u", "Stairs: U-shape (half turn)", "Architecture", () => startM2Tool("stairs", "U")],
      ["rg-railing", "Railing: draw path", "Architecture", () => startM2Tool("railing")],
      ["rg-ramp", "Ramp: place", "Architecture", () => startM2Tool("ramp")],
      ["rg-curtain-wall", "Curtain wall: place", "Architecture", () => startM2Tool("curtain-wall")],
      ["rg-roof", "Roof: draw footprint (gable / shed)", "Architecture", () => startM2Tool("roof")],
      ["rg-ceiling", "Ceiling: draw outline", "Architecture", () => startM2Tool("ceiling")],
      ["rg-ceilings-rooms", "Ceiling: place one in every room of this level", "Architecture", () => ceilingsFromRooms()],
      ["rg-pl-poche", "Plan graphics: toggle wall poche", "Documentation", () => togglePlanOption("poche", "Wall poche")],
      ["rg-pl-rooms", "Plan graphics: toggle room tags", "Documentation", () => togglePlanOption("roomTags", "Room tags")],
      ["rg-pl-roomlines", "Plan graphics: toggle room boundaries", "Documentation", () => togglePlanOption("roomBoundaries", "Room boundaries")],
      ["rg-pl-doors", "Plan graphics: toggle door and window marks", "Documentation", () => togglePlanOption("doorTags", "Door/window marks")],
      ["rg-pl-stairs", "Plan graphics: toggle stair symbols", "Documentation", () => togglePlanOption("stairSymbols", "Stair symbols")],
      ["rg-views-refresh", "Views: regenerate all views and sheets", "Documentation", () => { void refreshViews(); }],
      ["rg-hide", "Visibility: hide selection", "Visibility", hideSelection],
      ["rg-isolate", "Visibility: isolate selection", "Visibility", isolateSelection],
      ["rg-reset-vis", "Visibility: reset temporary hide/isolate", "Visibility", resetTemporaryVisibility],
      ["rg-phase-created", "Phase: set 'phase created' on selection", "Phasing", () => promptAssignPhase("created")],
      ["rg-phase-demolished", "Phase: set 'phase demolished' on selection", "Phasing", () => promptAssignPhase("demolished")],
      ["rg-design-option", "Design option: assign selection", "Phasing", promptAssignDesignOption],
      ["rg-export-ifc4", "Export: model to IFC4", "Export", () => exportIfc("IFC4")],
      ["rg-export-ifc2x3", "Export: model to IFC2X3 (BIM 2020)", "Export", () => exportIfc("IFC2X3")],
      ["rg-status", "BIM gaps: show status", "Help", () => { console.table(status); notify("info", status.map((s) => `${s.ok ? "OK" : "FAILED"} ${s.name}`).join(" | "), { timeout: 6000 }); }],
    ];
    for (const [id, label, category, run] of cmds) registerCommand({ id, label, category, run });
    return { ok: true, detail: `${cmds.length} commands` };
  });

  (window as Any).__obsBIMGaps = {
    version: REVIT_GAPS_VERSION, status,
    exportIfc, buildModelIfc,
    placeRoomAt, placeRoomsAutomatically, startRoomTool, refreshRoomOverlay,
    m2: { start: startM2Tool, create: createM2Element, ceilingsFromRooms },
    visibility: { hideSelection, isolateSelection, reset: resetTemporaryVisibility, tagSelection, getSelectedKeys, apply: () => applyAuthored(true) },
  };
  const failed = status.filter((s) => !s.ok);
  console.log(`[revit-gaps] ${REVIT_GAPS_VERSION}: ${status.length - failed.length}/${status.length} steps started` + (failed.length ? ` - FAILED: ${failed.map((f) => `${f.name} (${f.detail})`).join("; ")}` : ""));
  if (failed.length) notify("warn", `BIM gaps: ${failed.length} step(s) failed - see console`);
  return status;
}
