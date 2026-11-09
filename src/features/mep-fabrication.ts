/**
 * MEP Fabrication Parts - catalog browser for placing prefabricated parts.
 *
 * Groups parts by system. Clicking a part activates the corresponding
 * authoring tool (duct-fitting, pipe-fitting, etc.) so the user can place
 * it in the viewport.
 *
 * Also exposes an "MEP Auto-Route..." command that opens a modal:
 * user picks system + flow rate, then clicks two points in the viewport.
 * The router (src/modules/mep/router.ts) runs A* over a 3D voxel grid with
 * obstacle avoidance; sizing (sizing.ts) picks the standard cross-section
 * from ASHRAE tables. Each leg becomes an `addLinearElement` call, with
 * the existing chain-bend-fitting logic auto-inserting elbows.
 */

import { ctx } from "../core/context";
import { openFormModal, pickFromList } from "./form-modal";
import { setAuthoringTool, addLinearElement } from "./authoring";
import { registerCommand } from "./command-palette";
import { fixtureUnitsToDemand, waterHammerSurge, surgeMarginCheck } from "../modules/mep/plumbing";
import {
  equivalentDiameter, equalAreaDiameter, roundToRectEquivalent,
  achToAirflow, cfmToLs, lsToCfm, gpmToLs, lsToGpm, fpmToMs, msToFpm,
  inWgToPa, paToInWg, psiToKpa, kpaToPsi,
} from "../modules/mep/convert";
import { designDemand, HAZARD_PRESETS, K_FACTORS } from "../modules/mep/fire";
import { voltageDrop, selectConductor, CONDUCTOR_SIZES } from "../modules/mep/electrical-calc";
import { insulatePipe, insulateDuct, condensationRisk, runTakeoff } from "../modules/mep/insulation";
import {
  sizeRectDuctByFriction, sizeRoundDuctByFriction, sizePipeByFriction, staticRegainSeries,
} from "../modules/mep/sizing-methods";
import { auditNetwork } from "../modules/mep/network";
import { calcZoneLoadsDetailed } from "../modules/mep/hvac-loads";
import type { ZoneLoadInput } from "../modules/mep/hvac-loads";
import { buildPanelSchedule } from "../modules/mep/electrical";
import type { ElectricalPanel, ElectricalLoad } from "../modules/mep/electrical";
import { fanSelection, pumpSelection } from "../modules/mep/equipment";
import { sizeDrain, sizeDrainFromFixtures, totalDfu } from "../modules/mep/drainage";
import type { DrainSlopeInFt } from "../modules/mep/drainage";

interface FabPart {
  id: string;
  label: string;
  system: "duct" | "pipe" | "tray" | "conduit";
  kind: string;
  dimensions: string;
}

const PARTS: FabPart[] = [
  // Duct
  { id: "duct-elbow-90",   label: "90\u00B0 Elbow",         system: "duct",    kind: "elbow",      dimensions: "\u00D8 300\u2013600" },
  { id: "duct-elbow-45",   label: "45\u00B0 Elbow",         system: "duct",    kind: "elbow",      dimensions: "\u00D8 300\u2013600" },
  { id: "duct-tee",        label: "Tee",                    system: "duct",    kind: "tee",        dimensions: "\u00D8 300\u2013600" },
  { id: "duct-cross",      label: "Cross",                  system: "duct",    kind: "cross",      dimensions: "\u00D8 300\u2013600" },
  { id: "duct-reducer",    label: "Reducer",                system: "duct",    kind: "transition", dimensions: "various" },
  { id: "duct-cap",        label: "End Cap",                system: "duct",    kind: "cap",        dimensions: "\u00D8 300\u2013600" },
  { id: "duct-damper",     label: "Volume Damper",          system: "duct",    kind: "damper",     dimensions: "\u00D8 300\u2013600" },

  // Pipe
  { id: "pipe-elbow-90",   label: "90\u00B0 Elbow",         system: "pipe",    kind: "elbow",      dimensions: "DN 15\u2013200" },
  { id: "pipe-elbow-45",   label: "45\u00B0 Elbow",         system: "pipe",    kind: "elbow",      dimensions: "DN 15\u2013200" },
  { id: "pipe-tee",        label: "Tee",                    system: "pipe",    kind: "tee",        dimensions: "DN 15\u2013200" },
  { id: "pipe-cross",      label: "Cross",                  system: "pipe",    kind: "cross",      dimensions: "DN 15\u2013200" },
  { id: "pipe-reducer",    label: "Reducer",                system: "pipe",    kind: "transition", dimensions: "various" },
  { id: "pipe-valve",      label: "Gate Valve",             system: "pipe",    kind: "valve",      dimensions: "DN 15\u2013200" },
  { id: "pipe-union",      label: "Union",                  system: "pipe",    kind: "union",      dimensions: "DN 15\u2013200" },

  // Cable tray
  { id: "tray-elbow-90",   label: "90\u00B0 Elbow",         system: "tray",    kind: "elbow",      dimensions: "100\u2013600 mm" },
  { id: "tray-elbow-45",   label: "45\u00B0 Elbow",         system: "tray",    kind: "elbow",      dimensions: "100\u2013600 mm" },
  { id: "tray-tee",        label: "Tee",                    system: "tray",    kind: "tee",        dimensions: "100\u2013600 mm" },
  { id: "tray-cross",      label: "Cross",                  system: "tray",    kind: "cross",      dimensions: "100\u2013600 mm" },
  { id: "tray-reducer",    label: "Reducer",                system: "tray",    kind: "transition", dimensions: "various" },

  // Conduit
  { id: "cond-elbow-90",   label: "90\u00B0 Elbow",         system: "conduit", kind: "elbow",      dimensions: "\u00D8 20\u201350" },
  { id: "cond-coupling",   label: "Coupling",               system: "conduit", kind: "union",      dimensions: "\u00D8 20\u201350" },
  { id: "cond-junction",   label: "Junction Box",           system: "conduit", kind: "tee",        dimensions: "\u00D8 20\u201350" },
];

const SYSTEM_LABELS: Record<FabPart["system"], { label: string; color: string }> = {
  duct:    { label: "Ductwork",   color: "#38bdf8" },
  pipe:    { label: "Piping",     color: "#22c55e" },
  tray:    { label: "Cable Tray", color: "#f59e0b" },
  conduit: { label: "Conduit",    color: "#a855f7" },
};

let panel: HTMLDivElement | null = null;
let visible = false;

export function setupMepFabrication(): void {
  panel = document.createElement("div");
  panel.id = "obs-mep-fabrication";
  panel.style.cssText =
    "position:fixed;left:16px;top:200px;width:320px;max-height:65vh;z-index:33;" +
    "display:none;flex-direction:column;background:#1a1d27;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.5);font:12px system-ui,sans-serif;overflow:hidden";
  panel.onmousedown = (e) => e.stopPropagation();

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;padding:9px 12px;" +
    "border-bottom:1px solid #2a2e3a;background:#12141b;flex-shrink:0";
  header.innerHTML = "<div style='font-weight:700;flex:1'>\u2699 MEP Fabrication Parts</div>";

  const body = document.createElement("div");
  body.style.cssText = "flex:1;overflow-y:auto;padding:6px";

  const systems: FabPart["system"][] = ["duct", "pipe", "tray", "conduit"];
  for (const sysKey of systems) {
    const sysMeta = SYSTEM_LABELS[sysKey];
    const parts = PARTS.filter((p) => p.system === sysKey);
    if (!parts.length) continue;

    const headerRow = document.createElement("div");
    headerRow.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:7px 8px;margin-top:6px;" +
      "border-bottom:1px solid #242734;color:" + sysMeta.color + ";font-weight:700;font-size:11px";
    headerRow.innerHTML = "<span>\u25CF</span><span>" + sysMeta.label + "</span>";
    body.appendChild(headerRow);

    for (const part of parts) {
      const row = document.createElement("div");
      row.style.cssText =
        "display:grid;grid-template-columns:1fr auto;gap:8px;padding:7px 9px;" +
        "background:#0e1017;border:1px solid #242734;border-radius:5px;" +
        "margin:3px 0;cursor:pointer;align-items:center";
      row.onmouseenter = () => { row.style.background = "#181a23"; row.style.borderColor = sysMeta.color; };
      row.onmouseleave = () => { row.style.background = "#0e1017"; row.style.borderColor = "#242734"; };
      row.onclick = () => placePart(part);

      const text = document.createElement("div");
      const name = document.createElement("div");
      name.textContent = part.label;
      name.style.cssText = "font-weight:600;font-size:11.5px";
      const dim = document.createElement("div");
      dim.textContent = part.dimensions;
      dim.style.cssText = "font-size:9.5px;color:#6b7280;font-family:ui-monospace,monospace;margin-top:1px";
      text.append(name, dim);

      const btn = document.createElement("span");
      btn.textContent = "+";
      btn.style.cssText =
        "width:22px;height:22px;display:flex;align-items:center;justify-content:center;" +
        "border-radius:4px;background:" + sysMeta.color + "22;color:" + sysMeta.color +
        ";border:1px solid " + sysMeta.color + "66;font-weight:700";

      row.append(text, btn);
      body.appendChild(row);
    }
  }

  panel.append(header, body);
  ctx.rightHost.appendChild(panel);

  // Auto-Route command - opens a small modal that lets the user pick a
  // system + flow rate, then click two points in the viewport. The router
  // runs A* over a 3D voxel grid and creates one addLinearElement call per
  // leg, with the existing chain-bend-fitting logic auto-inserting elbows.
  const autoRouteBtn = document.createElement("button");
  autoRouteBtn.textContent = "MEP Auto-Route\u2026";
  autoRouteBtn.style.cssText =
    "margin:8px;padding:8px 12px;background:#3b82f6;color:white;border:0;" +
    "border-radius:5px;font:600 12px system-ui,sans-serif;cursor:pointer;width:calc(100% - 16px)";
  autoRouteBtn.onclick = openAutoRouteModal;
  body.insertBefore(autoRouteBtn, body.firstChild);

  // v0.75: parametric Design Toolkit — the Hunter-demand, sprinkler,
  // voltage-drop, insulation and conversion calculators.
  const toolkitBtn = document.createElement("button");
  toolkitBtn.textContent = "MEP Design Toolkit\u2026";
  toolkitBtn.style.cssText =
    "margin:0 8px 8px;padding:8px 12px;background:#8b5cf6;color:white;border:0;" +
    "border-radius:5px;font:600 12px system-ui,sans-serif;cursor:pointer;width:calc(100% - 16px)";
  toolkitBtn.onclick = () => void openMepDesignToolkit();
  body.insertBefore(toolkitBtn, autoRouteBtn.nextSibling);

  (ctx.features as any).mepFabrication = {
    show: () => { visible = true; if (panel) panel.style.display = "flex"; },
    hide: () => { visible = false; if (panel) panel.style.display = "none"; },
    toggle: () => { visible ? (ctx.features as any).mepFabrication.hide() : (ctx.features as any).mepFabrication.show(); },
    isVisible: () => visible,
  };

  // Command-palette entries for the parametric calculators.
  registerCommand({ id: "mep.toolkit", label: "MEP Design Toolkit\u2026", category: "MEP", run: () => void openMepDesignToolkit() });
  registerCommand({ id: "mep.fixture-demand", label: "Fixture-Unit Demand (Hunter curve)", category: "MEP", run: () => void fixtureDemandCalc() });
  registerCommand({ id: "mep.sprinkler-demand", label: "Sprinkler Design Demand", category: "MEP", run: () => void sprinklerCalc() });
  registerCommand({ id: "mep.voltage-drop", label: "Voltage Drop Check", category: "MEP", run: () => void voltageDropCalc() });
  registerCommand({ id: "mep.network-audit", label: "MEP Network Audit \u2014 Pressure Loss Report", category: "MEP", run: () => void networkAuditCalc() });
  registerCommand({ id: "mep.zone-loads", label: "Zone Heating & Cooling Loads (CLTD)", category: "MEP", run: () => void zoneLoadCalc() });
  registerCommand({ id: "mep.panel-wire", label: "Panel Schedule \u2014 Wire Size & Voltage Drop", category: "MEP", run: () => void panelWireCalc() });
  registerCommand({ id: "mep.drainage-dfu", label: "Drainage Size (DFU, IPC 710)", category: "MEP", run: () => void drainageCalc() });
  registerCommand({ id: "mep.drainage-direct", label: "DFU \u2192 Pipe Size (direct)", category: "MEP", run: () => void drainageDirectCalc() });
}

// ─── Auto-Route modal ────────────────────────────────────────────────────

const SYSTEMS: Array<{ id: string; label: string; group: string; unit: string; defaultFlow: number }> = [
  { id: "supply-air",     label: "Supply Air Duct",      group: "HVAC",   unit: "m\u00B3/s", defaultFlow: 0.5 },
  { id: "return-air",     label: "Return Air Duct",      group: "HVAC",   unit: "m\u00B3/s", defaultFlow: 0.5 },
  { id: "exhaust-air",    label: "Exhaust Air Duct",      group: "HVAC",   unit: "m\u00B3/s", defaultFlow: 0.3 },
  { id: "outside-air",    label: "Outside Air Duct",      group: "HVAC",   unit: "m\u00B3/s", defaultFlow: 0.2 },
  { id: "chilled-water",   label: "Chilled Water Pipe",   group: "Hydronic", unit: "L/s",   defaultFlow: 5 },
  { id: "hot-water",       label: "Hot Water Pipe",        group: "Hydronic", unit: "L/s",   defaultFlow: 5 },
  { id: "domestic-cold",   label: "Domestic Cold Water",   group: "Plumbing",  unit: "L/s",   defaultFlow: 1 },
  { id: "domestic-hot",    label: "Domestic Hot Water",    group: "Plumbing",  unit: "L/s",   defaultFlow: 1 },
  { id: "sanitary",        label: "Sanitary Drain",       group: "Plumbing",  unit: "L/s",   defaultFlow: 2 },
  { id: "condensate",      label: "Condensate Drain",     group: "HVAC",   unit: "L/s",    defaultFlow: 0.5 },
  { id: "gas",             label: "Fuel Gas Pipe",        group: "Fuel",   unit: "L/s",    defaultFlow: 5 },
  { id: "medical-vacuum",  label: "Medical Vacuum",       group: "Medical", unit: "L/s",   defaultFlow: 1 },
  { id: "medical-oxygen",  label: "Medical Oxygen",       group: "Medical", unit: "L/s",   defaultFlow: 1 },
  { id: "sprinkler",       label: "Fire Sprinkler Pipe",  group: "Fire",     unit: "L/s",    defaultFlow: 1 },
  { id: "cable-tray",      label: "Cable Tray",           group: "Electrical", unit: "cables", defaultFlow: 20 },
  { id: "conduit",         label: "Conduit",              group: "Electrical", unit: "cables", defaultFlow: 5 },
];

async function openAutoRouteModal(): Promise<void> {
  // Pick system
  const sysId = await pickFromList("Auto-route MEP", "MEP system", SYSTEMS.map((s) => ({ value: s.id, label: s.label })), SYSTEMS[0].id);
  if (!sysId) return;
  const system = SYSTEMS.find((s) => s.id === sysId);
  if (!system) return;
  const num = (x: unknown) => Number.isFinite(Number(x)) ? null : "Enter a number";
  const vals = await openFormModal({
    title: `Auto-route ${system.label}`,
    fields: [
      { kind: "number", key: "flow", label: "Flow rate", default: system.defaultFlow, unit: system.unit, validate: (x) => Number(x) > 0 ? null : "Must be positive" },
      { kind: "number", key: "elev", label: "Routing elevation (world Y)", default: 2.7, unit: "m", validate: num },
      { kind: "number", key: "sx", label: "Start X", default: 0, unit: "m", validate: num },
      { kind: "number", key: "sz", label: "Start Z", default: 0, unit: "m", validate: num },
      { kind: "number", key: "ex", label: "End X", default: 10, unit: "m", validate: num },
      { kind: "number", key: "ez", label: "End Z", default: 5, unit: "m", validate: num },
    ],
    submitLabel: "Route",
  });
  if (!vals) return;
  const flowRate = Number(vals.flow);
  const elevation = Number(vals.elev);
  const startParts = [Number(vals.sx), Number(vals.sz)];
  const endParts = [Number(vals.ex), Number(vals.ez)];

  // Run the route
  const mep = (ctx.features as any).mep;
  if (!mep || typeof mep.route !== "function") {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "MEP module not ready - check console", kind: "error" } }));
    return;
  }

  const result = mep.route({
    start: { x: startParts[0], y: elevation, z: startParts[1] },
    end: { x: endParts[0], y: elevation, z: endParts[1] },
    system: system.id,
    flowRate,
    voxelSize: 0.25,
    clearance: 0.1,
    maxIterations: 5000,
  });

  if (!result) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "No route found - check obstacles or increase maxIterations", kind: "error" } }));
    return;
  }

  // Convert legs to addLinearElement calls.
  // The existing chain-bend-fitting logic in addLinearElement handles
  // inserting elbows at each bend automatically when consecutive legs of
  // the same type meet within the snap tolerance.
  const elementTypeMap: Record<string, "duct" | "pipe" | "cable-tray" | "conduit"> = {
    duct: "duct", pipe: "pipe", "cable-tray": "cable-tray", conduit: "conduit",
  };
  const elementType = elementTypeMap[result.elementType];

  (async () => {
    for (const leg of result.legs) {
      // addLinearElement uses plan coords (x, z) + elevation; vertical legs
      // are not directly supported by the existing API, so we project
      // vertical legs onto the XY plan at the elevation of the leg start.
      // A future v0.6 will add proper 3D routing support to addLinearElement.
      const x1 = leg.start.x;
      const z1 = leg.start.z;
      const x2 = leg.end.x;
      const z2 = leg.end.z;
      // Skip degenerate plan legs (both endpoints at the same XY).
      if (Math.hypot(x2 - x1, z2 - z1) < 0.05) continue;
      await addLinearElement(
        elementType,
        x1, z1, x2, z2,
        leg.start.y,
        { thickness: result.size.thickness, height: result.size.height },
      );
    }
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: {
        message: `Route complete: ${result.legs.length} leg(s), ${result.bendCount} bend(s), ` +
                 `${result.totalLength.toFixed(2)} m, ${result.size.thickness}\u00D7${result.size.height} m`,
        kind: "success",
      },
    }));
    console.log("[mep:auto-route] result:", result);
  })().catch((e) => {
    console.error("[mep:auto-route] failed", e);
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: `Route placement failed: ${e.message || e}`, kind: "error" },
    }));
  });
}

function placePart(part: FabPart): void {
  const toolMap: Record<FabPart["system"], string> = {
    duct: "duct-fitting",
    pipe: "pipe-fitting",
    tray: "cable-tray-fitting",
    conduit: "conduit-fitting",
  };
  const tool = toolMap[part.system];
  setAuthoringTool(tool);
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: part.label + " \u2014 click in the viewport to place", kind: "success" },
  }));
}

// ─── MEP Design Toolkit ──────────────────────────────────────────────────
//
// Parametric calculators that turn design inputs (fixture units, hazard
// class, cable length, insulation spec) into engineering results, using
// the pure modules in src/modules/mep/. Each calculator is a small
// form-modal → result-dialog pair; everything is also reachable from the
// command palette (mep.* commands) and from the MEP ribbon tab.

interface ResultRow {
  label: string;
  value: string;
  strong?: boolean;
}

/** Lightweight result dialog — dark card matching the form-modal look. */
function showResultDialog(title: string, rows: ResultRow[], notes: string[] = []): void {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100001;" +
    "display:flex;align-items:center;justify-content:center";
  const card = document.createElement("div");
  card.style.cssText =
    "width:470px;max-width:92vw;max-height:80vh;overflow:auto;background:#1a1d27;" +
    "color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 18px 50px rgba(0,0,0,.55);font:12px system-ui,sans-serif";
  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #2a2e3a;" +
    "background:#12141b;font-weight:700";
  const titleEl = document.createElement("div");
  titleEl.textContent = title;
  titleEl.style.flex = "1";
  const close = document.createElement("button");
  close.textContent = "\u2715";
  close.style.cssText = "background:none;border:0;color:#9ca3af;font-size:14px;cursor:pointer";
  close.onclick = () => overlay.remove();
  header.append(titleEl, close);

  const body = document.createElement("div");
  body.style.cssText = "padding:8px 14px 14px";
  for (const r of rows) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;justify-content:space-between;gap:12px;padding:6px 0;" +
      "border-bottom:1px solid #232733";
    const l = document.createElement("div");
    l.textContent = r.label;
    l.style.color = "#9ca3af";
    const v = document.createElement("div");
    v.textContent = r.value;
    v.style.cssText = "font-family:ui-monospace,monospace;text-align:right" +
      (r.strong ? ";color:#22d3ee;font-weight:700" : "");
    row.append(l, v);
    body.appendChild(row);
  }
  for (const n of notes) {
    const note = document.createElement("div");
    note.textContent = n;
    note.style.cssText =
      "margin-top:8px;padding:8px 10px;background:#312a12;border:1px solid #6b5a1e;" +
      "border-radius:6px;color:#fbbf24;font-size:11px;line-height:1.5";
    body.appendChild(note);
  }
  card.append(header, body);
  overlay.appendChild(card);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") overlay.remove(); });
  document.body.appendChild(overlay);
}

const mustBePositive = (x: unknown): string | null => Number(x) > 0 ? null : "Must be positive";
const mustBeNumber = (x: unknown): string | null => Number.isFinite(Number(x)) ? null : "Enter a number";

// ── Hunter fixture-unit demand ───────────────────────────────────────────

async function fixtureDemandCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Fixture-Unit Demand (Hunter curve)",
    subtitle: "Probable peak domestic-water demand from the WSFU load (IPC/UPC Appendix table)",
    fields: [
      { kind: "number", key: "wsfu", label: "Total water-supply fixture units", default: 120, validate: mustBePositive },
      { kind: "select", key: "flush", label: "Water-closet flushing", options: [["valve", "Flushometer valves"], ["tank", "Flush tanks"]], default: "valve" },
    ],
    submitLabel: "Compute",
  });
  if (!vals) return;
  const d = fixtureUnitsToDemand(Number(vals.wsfu), vals.flush === "tank" ? "tank" : "valve");
  showResultDialog("Fixture-Unit Demand", [
    { label: "Fixture-unit load", value: `${Number(vals.wsfu)} WSFU` },
    { label: "Probable peak demand", value: `${d.gpm.toFixed(1)} gpm`, strong: true },
    { label: "Metric", value: `${d.ls.toFixed(3)} L/s`, strong: true },
    { label: "Curve", value: d.curve },
  ], [
    "Feed this flow into MEP Auto-Route (domestic-cold / domestic-hot) and the ASHRAE sizing picks the DN.",
    "Estimation aid \u2014 final sizing must follow the governing local code.",
  ]);
}

// ── Sprinkler density/area demand ────────────────────────────────────────

async function sprinklerCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Sprinkler Design Demand (density/area)",
    subtitle: "Remote-area demand anchored on the K-factor end-head pressure",
    fields: [
      { kind: "select", key: "hazard", label: "Occupancy hazard", options: HAZARD_PRESETS.map((h) => [h.id, h.label] as [string, string]), default: HAZARD_PRESETS[0].id },
      { kind: "number", key: "area", label: "Remote-area design area", default: 139, unit: "m\u00B2", validate: mustBePositive },
      { kind: "number", key: "coverage", label: "Coverage per head", default: 12, unit: "m\u00B2", validate: mustBePositive },
      { kind: "select", key: "k", label: "K-factor", options: K_FACTORS.map((k) => [String(k.k), `K${k.k} (${k.imperial}) \u2014 ${k.use}`] as [string, string]), default: "80" },
      { kind: "number", key: "heads", label: "Heads flowing in remote area", default: 0, unit: "0 = area \u00F7 coverage", validate: mustBeNumber },
    ],
    submitLabel: "Compute",
  });
  if (!vals) return;
  const r = designDemand({
    hazardId: String(vals.hazard),
    designAreaM2: Number(vals.area),
    headCoverageM2: Number(vals.coverage),
    kFactor: Number(vals.k),
    headCount: Number(vals.heads) > 0 ? Number(vals.heads) : 0,
  });
  showResultDialog("Sprinkler Design Demand", [
    { label: "Design density", value: `${r.densityLminM2} L/min\u00B7m\u00B2` },
    { label: "Heads flowing", value: String(r.headCount) },
    { label: "End-head flow", value: `${r.endHeadFlowLmin.toFixed(1)} L/min` },
    { label: "End-head pressure", value: `${r.endHeadPressureBar.toFixed(2)} bar`, strong: true },
    { label: "Sprinkler demand", value: `${r.sprinklerDemandLmin.toFixed(0)} L/min` },
    { label: "Hose allowance", value: `${r.hoseAllowanceLmin} L/min` },
    { label: "Total demand", value: `${r.totalDemandLmin.toFixed(0)} L/min`, strong: true },
    { label: "Supply duration", value: `${r.durationMin} min` },
  ], [...r.warnings, "Design aid \u2014 the listed criteria and the AHJ govern the final calculation."]);
}

// ── Voltage drop ─────────────────────────────────────────────────────────

async function voltageDropCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Voltage Drop & Conductor Check",
    subtitle: "IEC 60228 resistances, temperature-corrected; \u221A3 path for three-phase",
    fields: [
      { kind: "select", key: "phase", label: "System", options: [["3", "Three-phase"], ["1", "Single-phase"]], default: "3" },
      { kind: "number", key: "voltage", label: "System voltage", default: 400, unit: "V", validate: mustBePositive },
      { kind: "number", key: "current", label: "Design current", default: 100, unit: "A", validate: mustBePositive },
      { kind: "number", key: "length", label: "One-way route length", default: 50, unit: "m", validate: mustBeNumber },
      { kind: "select", key: "size", label: "Conductor cross-section", options: CONDUCTOR_SIZES.map((s) => [String(s), `${s} mm\u00B2`] as [string, string]), default: "25" },
      { kind: "number", key: "pf", label: "Power factor", default: 0.9, min: 0, max: 1 },
      { kind: "number", key: "maxDrop", label: "Permitted drop", default: 3, unit: "%" },
    ],
    submitLabel: "Check",
  });
  if (!vals) return;
  const vd = voltageDrop({
    phase: Number(vals.phase) === 1 ? 1 : 3,
    voltageV: Number(vals.voltage),
    currentA: Number(vals.current),
    lengthM: Number(vals.length),
    conductorMm2: Number(vals.size),
    powerFactor: Number(vals.pf),
  });
  const pass = vd.dropPercent <= Number(vals.maxDrop);
  const alt = selectConductor(Number(vals.current));
  const rows: ResultRow[] = [
    { label: "Voltage drop", value: `${vd.dropV.toFixed(2)} V`, strong: true },
    { label: "Drop percent", value: `${vd.dropPercent.toFixed(2)} %`, strong: true },
    { label: "Permitted", value: `${Number(vals.maxDrop)} %` },
    { label: "Verdict", value: pass ? "PASS" : "FAIL \u2014 upsize the cable or shorten the run" },
  ];
  if (alt) rows.push({ label: "Smallest standard conductor", value: `${alt.mm2} mm\u00B2 (ref ${alt.ampacityA} A)` });
  showResultDialog("Voltage Drop", rows, [
    "Reference ampacity: IEC 60364-5-52 method C, PVC, 30 \u00B0C \u2014 re-check derating for the real installation method.",
  ]);
}

// ── Insulation calculators ───────────────────────────────────────────────

async function pipeInsulationCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Pipe Insulation Heat Loss",
    subtitle: "Radial conduction + outer film, with condensation screening and takeoff",
    fields: [
      { kind: "number", key: "od", label: "Pipe outer diameter", default: 0.06, unit: "m", validate: mustBePositive },
      { kind: "number", key: "thk", label: "Insulation thickness", default: 0.025, unit: "m", validate: mustBeNumber },
      { kind: "number", key: "k", label: "Conductivity", default: 0.035, unit: "W/m\u00B7K", validate: mustBePositive },
      { kind: "number", key: "fluid", label: "Fluid temperature", default: 60, unit: "\u00B0C" },
      { kind: "number", key: "ambient", label: "Ambient temperature", default: 25, unit: "\u00B0C" },
      { kind: "number", key: "rh", label: "Ambient humidity", default: 70, unit: "%RH" },
      { kind: "number", key: "length", label: "Run length (takeoff)", default: 10, unit: "m", validate: mustBePositive },
    ],
    submitLabel: "Compute",
  });
  if (!vals) return;
  const r = insulatePipe({
    outerDiameterM: Number(vals.od),
    insulationThicknessM: Number(vals.thk),
    conductivityWmK: Number(vals.k),
    fluidC: Number(vals.fluid),
    ambientC: Number(vals.ambient),
  });
  const cond = condensationRisk(r.surfaceTempC, Number(vals.ambient), Number(vals.rh));
  const takeoff = runTakeoff(Number(vals.length), { outerDiameterM: Number(vals.od) }, Number(vals.thk));
  showResultDialog("Pipe Insulation", [
    { label: "Heat loss", value: `${r.heatLossWPerM.toFixed(1)} W/m`, strong: true },
    { label: "Insulated outer \u00D8", value: `${(r.insulatedOuterDiameterM * 1000).toFixed(0)} mm` },
    { label: "Surface temperature", value: `${r.surfaceTempC.toFixed(1)} \u00B0C` },
    { label: "Condensation", value: cond.risk ? "RISK \u2014 increase thickness" : "No condensation expected" },
    { label: `Takeoff (${vals.length} m) \u2014 jacket area`, value: `${takeoff.areaM2.toFixed(2)} m\u00B2` },
    { label: "Material volume", value: `${(takeoff.volumeM3 * 1000).toFixed(1)} L` },
  ], [cond.message]);
}

async function ductInsulationCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Duct Insulation Heat Loss",
    subtitle: "Flat-wall conduction + outer film, with condensation screening and takeoff",
    fields: [
      { kind: "number", key: "w", label: "Duct width", default: 0.5, unit: "m", validate: mustBePositive },
      { kind: "number", key: "h", label: "Duct height", default: 0.25, unit: "m", validate: mustBePositive },
      { kind: "number", key: "thk", label: "Insulation thickness", default: 0.025, unit: "m", validate: mustBeNumber },
      { kind: "number", key: "k", label: "Conductivity", default: 0.035, unit: "W/m\u00B7K", validate: mustBePositive },
      { kind: "number", key: "internal", label: "Internal air temperature", default: 12, unit: "\u00B0C" },
      { kind: "number", key: "ambient", label: "Ambient temperature", default: 25, unit: "\u00B0C" },
      { kind: "number", key: "rh", label: "Ambient humidity", default: 70, unit: "%RH" },
      { kind: "number", key: "length", label: "Run length (takeoff)", default: 10, unit: "m", validate: mustBePositive },
    ],
    submitLabel: "Compute",
  });
  if (!vals) return;
  const r = insulateDuct({
    widthM: Number(vals.w),
    heightM: Number(vals.h),
    insulationThicknessM: Number(vals.thk),
    conductivityWmK: Number(vals.k),
    internalC: Number(vals.internal),
    ambientC: Number(vals.ambient),
  });
  const cond = condensationRisk(r.surfaceTempC, Number(vals.ambient), Number(vals.rh));
  const takeoff = runTakeoff(Number(vals.length), { widthM: Number(vals.w), heightM: Number(vals.h) }, Number(vals.thk));
  showResultDialog("Duct Insulation", [
    { label: "Heat loss", value: `${r.heatLossWPerM.toFixed(1)} W/m`, strong: true },
    { label: "U-value", value: `${r.uValueWm2K.toFixed(2)} W/m\u00B2\u00B7K` },
    { label: "Insulated size", value: `${(r.insulatedWidthM * 1000).toFixed(0)}\u00D7${(r.insulatedHeightM * 1000).toFixed(0)} mm` },
    { label: "Surface temperature", value: `${r.surfaceTempC.toFixed(1)} \u00B0C` },
    { label: "Condensation", value: cond.risk ? "RISK \u2014 increase thickness / vapour barrier" : "No condensation expected" },
    { label: `Takeoff (${vals.length} m) \u2014 jacket area`, value: `${takeoff.areaM2.toFixed(2)} m\u00B2` },
    { label: "Material volume", value: `${(takeoff.volumeM3 * 1000).toFixed(1)} L` },
  ], [cond.message]);
}

// ── Duct equivalents ─────────────────────────────────────────────────────

async function equivalentDuctCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Round \u2194 Rectangular Duct Equivalent",
    subtitle: "ASHRAE hydraulic equivalent diameter (equal friction per metre)",
    fields: [
      { kind: "select", key: "mode", label: "Conversion", options: [["rect2r", "Rectangular \u2192 round"], ["r2r", "Round \u2192 rectangular"]], default: "rect2r" },
      { kind: "number", key: "w", label: "Width / round \u00D8", default: 0.5, unit: "m", validate: mustBePositive },
      { kind: "number", key: "h", label: "Height (rect \u2192 round)", default: 0.25, unit: "m", validate: mustBeNumber },
      { kind: "number", key: "aspect", label: "Aspect ratio (round \u2192 rect)", default: 2, validate: mustBeNumber },
    ],
    submitLabel: "Convert",
  });
  if (!vals) return;
  if (vals.mode === "r2r") {
    const rect = roundToRectEquivalent(Number(vals.w), Math.max(1, Number(vals.aspect) || 2));
    showResultDialog("Round \u2192 Rectangular", [
      { label: "Target round \u00D8", value: `${(Number(vals.w) * 1000).toFixed(0)} mm` },
      { label: `Equivalent rect @ ${Math.max(1, Number(vals.aspect) || 2)}:1`, value: `${(rect.w * 1000).toFixed(0)}\u00D7${(rect.h * 1000).toFixed(0)} mm`, strong: true },
      { label: "Check \u2014 hydraulic De", value: `${(equivalentDiameter(rect.w, rect.h) * 1000).toFixed(0)} mm` },
    ], ["Snap the result to your local standard widths before fabrication."]);
  } else {
    const de = equivalentDiameter(Number(vals.w), Number(vals.h));
    const da = equalAreaDiameter(Number(vals.w), Number(vals.h));
    showResultDialog("Rectangular \u2192 Round", [
      { label: "Rectangular duct", value: `${(Number(vals.w) * 1000).toFixed(0)}\u00D7${(Number(vals.h) * 1000).toFixed(0)} mm` },
      { label: "Hydraulic equivalent \u00D8 (equal friction)", value: `${(de * 1000).toFixed(0)} mm`, strong: true },
      { label: "Equal-area \u00D8 (same free area)", value: `${(da * 1000).toFixed(0)} mm` },
    ], ["Use the hydraulic diameter when matching round-duct pressure loss; equal-area only matches capacity."]);
  }
}

// ── Air changes ──────────────────────────────────────────────────────────

async function achCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Air Changes \u2192 Airflow",
    subtitle: "Ventilation airflow from room volume and ACH target",
    fields: [
      { kind: "number", key: "area", label: "Room floor area", default: 20, unit: "m\u00B2", validate: mustBePositive },
      { kind: "number", key: "height", label: "Ceiling height", default: 3, unit: "m", validate: mustBePositive },
      { kind: "number", key: "ach", label: "Air changes per hour", default: 6, validate: mustBePositive },
    ],
    submitLabel: "Compute",
  });
  if (!vals) return;
  const q = achToAirflow(Number(vals.area) * Number(vals.height), Number(vals.ach));
  showResultDialog("Air Changes \u2192 Airflow", [
    { label: "Room volume", value: `${(Number(vals.area) * Number(vals.height)).toFixed(1)} m\u00B3` },
    { label: `Airflow @ ${vals.ach} ACH`, value: `${q.toFixed(3)} m\u00B3/s`, strong: true },
    { label: "Metric", value: `${(q * 1000).toFixed(0)} L/s`, strong: true },
    { label: "Imperial", value: `${lsToCfm(q).toFixed(0)} CFM` },
  ], ["Feed this into MEP Auto-Route (supply-air) to size and route the duct."]);
}

// ── Water hammer ─────────────────────────────────────────────────────────

async function waterHammerCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Water Hammer Surge (Joukowsky)",
    subtitle: "Surge pressure for a sudden closure, with pipe-rating margin check",
    fields: [
      { kind: "number", key: "dv", label: "Velocity change at closure", default: 1.2, unit: "m/s", validate: mustBePositive },
      { kind: "number", key: "d", label: "Pipe inner diameter", default: 0.05, unit: "m", validate: mustBePositive },
      { kind: "number", key: "wall", label: "Pipe wall thickness", default: 3, unit: "mm", validate: mustBePositive },
      { kind: "number", key: "working", label: "Working pressure", default: 4, unit: "bar" },
      { kind: "number", key: "rating", label: "Pipe pressure rating", default: 16, unit: "bar", validate: mustBePositive },
    ],
    submitLabel: "Compute",
  });
  if (!vals) return;
  const r = waterHammerSurge({
    velocityChangeMs: Number(vals.dv),
    innerDiameterM: Number(vals.d),
    wallThicknessM: Number(vals.wall) / 1000,
  });
  const margin = surgeMarginCheck({
    workingPressureBar: Number(vals.working),
    surgePressureBar: r.surgePressureBar,
    pipeRatingBar: Number(vals.rating),
  });
  showResultDialog("Water Hammer Surge", [
    { label: "Wave speed", value: `${r.waveSpeedMs.toFixed(0)} m/s` },
    { label: "Surge pressure", value: `${r.surgePressureBar.toFixed(2)} bar`, strong: true },
    { label: "Working + surge", value: `${margin.totalBar.toFixed(2)} bar` },
    { label: "Rating margin", value: `${margin.marginBar.toFixed(2)} bar` },
    { label: "Verdict", value: margin.ok ? "PASS" : "FAIL \u2014 slow-closing valves or a surge vessel needed" },
  ], [margin.message]);
}

// ── Unit converter ───────────────────────────────────────────────────────

const CONVERSIONS: Array<[string, string, (v: number) => number]> = [
  ["cfm-ls", "CFM \u2192 L/s", cfmToLs],
  ["ls-cfm", "L/s \u2192 CFM", lsToCfm],
  ["gpm-ls", "GPM \u2192 L/s", gpmToLs],
  ["ls-gpm", "L/s \u2192 GPM", lsToGpm],
  ["fpm-ms", "FPM \u2192 m/s", fpmToMs],
  ["ms-fpm", "m/s \u2192 FPM", msToFpm],
  ["inwg-pa", "inWG \u2192 Pa", inWgToPa],
  ["pa-inwg", "Pa \u2192 inWG", paToInWg],
  ["psi-kpa", "psi \u2192 kPa", psiToKpa],
  ["kpa-psi", "kPa \u2192 psi", kpaToPsi],
];

async function unitConvertCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Unit Converter",
    subtitle: "The conversions MEP engineers actually switch between",
    fields: [
      { kind: "number", key: "v", label: "Value", default: 100, validate: mustBeNumber },
      { kind: "select", key: "conv", label: "Conversion", options: CONVERSIONS.map(([id, label]) => [id, label] as [string, string]), default: CONVERSIONS[0][0] },
    ],
    submitLabel: "Convert",
  });
  if (!vals) return;
  const conv = CONVERSIONS.find(([id]) => id === vals.conv);
  if (!conv) return;
  const out = conv[2](Number(vals.v));
  showResultDialog("Unit Converter", [
    { label: "Input", value: `${Number(vals.v)} ${conv[1].split(" \u2192 ")[0]}` },
    { label: "Result", value: `${Number(out.toPrecision(6))} ${conv[1].split(" \u2192 ")[1]}`, strong: true },
  ]);
}

// ── Revit-parity engineering calculators ─────────────────────────────────

async function frictionSizeCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Auto-Size by Friction Rate",
    subtitle: "Revit's friction method: smallest standard section at or below the target Pa/m (Colebrook\u2013White)",
    fields: [
      { kind: "select", key: "shape", label: "Cross-section", options: [["rect", "Rectangular duct"], ["round", "Round duct"], ["pipe", "Circular pipe"]], default: "rect" },
      { kind: "number", key: "flow", label: "Design flow", default: 1, unit: "m\u00B3/s (ducts) \u00B7 L/s (pipes)", validate: mustBePositive },
      { kind: "number", key: "target", label: "Target friction rate", default: 0.8, unit: "Pa/m (ducts) \u00B7 Pa/m (pipes)", validate: mustBePositive },
      { kind: "number", key: "pipeTarget", label: "Pipe target (when pipe)", default: 150, unit: "Pa/m" },
    ],
    submitLabel: "Size",
  });
  if (!vals) return;
  const rows: ResultRow[] = [];
  const notes: string[] = ["Friction targets: low-velocity supply 0.8\u20131.0 Pa/m, quiet systems 0.4\u20130.6 Pa/m, water mains 100\u2013400 Pa/m."];
  if (vals.shape === "pipe") {
    const r = sizePipeByFriction(Number(vals.flow), Number(vals.pipeTarget) || 150);
    rows.push(
      { label: "Selected pipe", value: `DN ${(r.diameter * 1000).toFixed(0)} mm`, strong: true },
      { label: "Velocity", value: `${r.velocity.toFixed(2)} m/s` },
      { label: "Friction rate", value: `${r.frictionRatePaM.toFixed(1)} Pa/m` },
      { label: "Head loss", value: `${r.headLossPer100m.toFixed(2)} m / 100 m` },
      { label: "Rule", value: r.rule },
    );
    notes.push(...r.warnings);
  } else {
    const r = vals.shape === "round"
      ? sizeRoundDuctByFriction(Number(vals.flow), Number(vals.target))
      : sizeRectDuctByFriction(Number(vals.flow), Number(vals.target));
    rows.push(
      { label: "Selected duct", value: r.round ? `\u2300 ${(r.thickness * 1000).toFixed(0)} mm` : `${(r.thickness * 1000).toFixed(0)}\u00D7${(r.height * 1000).toFixed(0)} mm`, strong: true },
      { label: "Velocity", value: `${r.velocity.toFixed(2)} m/s` },
      { label: "Friction rate", value: `${r.frictionRatePaM.toFixed(3)} Pa/m` },
      { label: "Rule", value: r.rule },
    );
    notes.push(...r.warnings);
  }
  showResultDialog("Friction-Method Auto-Size", rows, notes);
}

async function staticRegainCalc(): Promise<void> {
  const SAMPLE = '[{"flow":1.0,"length":12},{"flow":0.6,"length":8},{"flow":0.3,"length":6}]';
  const vals = await openFormModal({
    title: "Static Regain Duct Main",
    subtitle: "Classic static-regain sizing: each section may run slower only while velocity-head regain covers its friction",
    fields: [
      { kind: "textarea", key: "sections", label: "Main sections JSON", default: SAMPLE, placeholder: "[{flow: m\u00B3/s, length: m}, ...] in order from the fan", hint: "First section is sized by the friction method; successors downsize only when regain pays the friction." },
      { kind: "number", key: "target", label: "Initial friction target", default: 0.8, unit: "Pa/m" },
    ],
    submitLabel: "Size series",
  });
  if (!vals) return;
  let sections: Array<{ flowM3s: number; lengthM: number }>;
  try {
    const parsed = JSON.parse(String(vals.sections));
    sections = (Array.isArray(parsed) ? parsed : []).map((s: any) => ({ flowM3s: Number(s.flow ?? s.flowM3s), lengthM: Number(s.length ?? s.lengthM) }));
  } catch {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Sections must be a JSON array", kind: "error" } }));
    return;
  }
  try {
    const results = staticRegainSeries(sections, { targetFrictionPaM: Number(vals.target) || 0.8 });
    const rows: ResultRow[] = results.map((r, i) => ({
      label: `Section ${i + 1} \u2014 ${(sections[i].flowM3s).toFixed(2)} m\u00B3/s, ${sections[i].lengthM} m`,
      value: `${(r.thickness * 1000).toFixed(0)}\u00D7${(r.height * 1000).toFixed(0)} mm @ ${r.velocity.toFixed(2)} m/s (${r.sizedBy})`,
      strong: i === 0,
    }));
    const notes = results.flatMap((r) => r.warnings);
    notes.push("Regain sizing keeps static pressure roughly constant along the main \u2014 branches balance without dampers.");
    showResultDialog("Static Regain Series", rows, notes);
  } catch (e) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Static regain failed: ${(e as Error).message}`, kind: "error" } }));
  }
}

async function networkAuditCalc(): Promise<void> {
  const SAMPLE = JSON.stringify({
    source: "ahu1",
    terminals: { t1: 0.4, t2: 0.35, t3: 0.25 },
    segments: [
      { id: "s1", from: "ahu1", to: "j1", lengthM: 15, system: "supply-air", width: 0.5, height: 0.3, fittings: [{ kind: "elbow-90-radius", count: 2 }] },
      { id: "s2", from: "j1", to: "t1", lengthM: 8, system: "supply-air", width: 0.35, height: 0.25, fittings: [{ kind: "diffuser" }] },
      { id: "s3", from: "j1", to: "j2", lengthM: 10, system: "supply-air", width: 0.4, height: 0.25 },
      { id: "s4", from: "j2", to: "t2", lengthM: 7, system: "supply-air", width: 0.3, height: 0.2, fittings: [{ kind: "diffuser" }] },
      { id: "s5", from: "j2", to: "t3", lengthM: 9, system: "supply-air", width: 0.3, height: 0.2, fittings: [{ kind: "diffuser" }] },
    ],
  }, null, 1);
  const vals = await openFormModal({
    title: "MEP Network Audit (Pressure Loss Report)",
    subtitle: "System-Inspector parity: flow accumulation \u2192 per-section sizing/losses \u2192 critical path \u2192 fan/pump duty",
    width: 560,
    fields: [
      { kind: "textarea", key: "json", label: "Network JSON", default: SAMPLE, hint: "segments: {id, from, to, lengthM, system, width+height | diameter, fittings[]}; terminals: node \u2192 demand (m\u00B3/s air, L/s water); source: node id." },
      { kind: "select", key: "method", label: "Sizing for unsized/undersized sections", options: [["velocity", "Velocity method"], ["friction", "Friction method"]], default: "velocity" },
      { kind: "number", key: "lift", label: "Static lift (water only)", default: 0, unit: "m" },
    ],
    submitLabel: "Audit",
  });
  if (!vals) return;
  let parsed: any;
  try { parsed = JSON.parse(String(vals.json)); } catch {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Network JSON is invalid", kind: "error" } }));
    return;
  }
  try {
    const report = auditNetwork(parsed.segments, parsed.terminals ?? {}, parsed.source, {
      method: vals.method === "friction" ? "friction" : "velocity",
      staticLiftM: Number(vals.lift) || 0,
    });
    const rows: ResultRow[] = [
      { label: "System", value: report.system },
      { label: "Source flow", value: `${report.sourceFlowNative.toFixed(3)} ${report.system.includes("air") ? "m\u00B3/s" : "L/s"}`, strong: true },
      { label: "Sections audited", value: `${report.rows.length}` },
      ...report.rows.map((r) => ({
        label: `${r.id} (${r.flowNative.toFixed(2)}) ${r.resized ? "\u21BB" : ""}`,
        value: `${(r.size.thickness * 1000).toFixed(0)}${r.size.height !== r.size.thickness ? `\u00D7${(r.size.height * 1000).toFixed(0)}` : ""} mm \u00B7 ${r.velocity.toFixed(1)} m/s \u00B7 ${r.dpTotal.toFixed(0)} Pa`,
      })),
      { label: "Critical path", value: report.criticalPathSegmentIds.join(" \u2192 ") || "\u2014", strong: true },
      { label: "Worst-path drop", value: `${report.worstPathDpPa.toFixed(0)} Pa`, strong: true },
    ];
    if (report.fan) {
      rows.push(
        { label: "Fan total / static", value: `${report.fan.fanTotalPressurePa.toFixed(0)} / ${report.fan.fanStaticPressurePa.toFixed(0)} Pa` },
        { label: "Fan shaft power", value: `${(report.fan.shaftPowerW / 1000).toFixed(2)} kW \u2192 motor ${report.fan.recommendedMotorKw} kW` },
      );
    }
    if (report.pump) {
      rows.push(
        { label: "Pump duty head", value: `${report.pump.dutyHeadM.toFixed(1)} m (${report.pump.dutyHeadBar.toFixed(2)} bar)` },
        { label: "Pump shaft power", value: `${(report.pump.shaftPowerW / 1000).toFixed(2)} kW \u2192 motor ${report.pump.recommendedMotorKw} kW` },
      );
    }
    const notes = [...report.diagnostics, ...report.warnings.slice(0, 8)];
    if (notes.length === 0) notes.push("No velocity, friction or topology warnings \u2014 the tree passes.");
    showResultDialog("Network Audit \u2014 " + report.system, rows, notes);
  } catch (e) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Audit failed: ${(e as Error).message}`, kind: "error" } }));
  }
}

// ── Zone heating & cooling loads (CLTD, orientation-aware) ───────────────

async function zoneLoadCalc(): Promise<void> {
  const SAMPLE = JSON.stringify({
    zones: [{
      id: "Z1", name: "Open office", areaM2: 60, ceilingHeightM: 2.9,
      surfaces: [
        { id: "roof", kind: "roof", areaM2: 60, uValueWm2K: 0.28 },
        { id: "wall-s", kind: "wall", orientationDeg: 180, areaM2: 20, uValueWm2K: 0.45 },
        { id: "wall-w", kind: "wall", orientationDeg: 270, areaM2: 18, uValueWm2K: 0.45 },
      ],
      glazing: [
        { id: "glaz-s", orientationDeg: 180, areaM2: 6, uValueWm2K: 1.8, shgc: 0.42 },
        { id: "glaz-w", orientationDeg: 270, areaM2: 5, uValueWm2K: 1.8, shgc: 0.42 },
      ],
      gains: { people: 8, lightingWm2: 9, equipmentWm2: 14 },
      outdoorAirLsPerPerson: 10, infiltrationAch: 0.5,
    }],
    conditions: { summerOutdoorC: 35, winterOutdoorC: -5 },
    supplyDeltaTC: 12,
  }, null, 1);
  const vals = await openFormModal({
    title: "Zone Heating & Cooling Loads (CLTD)",
    subtitle: "Orientation-aware sol-air + solar gains + internal + ventilation/infiltration \u2014 sensible/latent split and supply airflow",
    width: 560,
    fields: [
      { kind: "textarea", key: "json", label: "Zones JSON", default: SAMPLE, hint: "zones: {id, name, areaM2, ceilingHeightM, surfaces[{kind: wall|roof|floor, orientationDeg, areaM2, uValueWm2K}], glazing[{orientationDeg, areaM2, uValueWm2K, shgc}], gains{people, lightingWm2, equipmentWm2}, outdoorAirLsPerPerson, infiltrationAch}; conditions{summerOutdoorC, summerIndoorC, winterOutdoorC, winterIndoorC, groundC}." },
      { kind: "number", key: "dt", label: "Supply air \u0394T", default: 12, unit: "K", validate: mustBePositive },
    ],
    submitLabel: "Analyse",
  });
  if (!vals) return;
  let parsed: { zones?: ZoneLoadInput[]; conditions?: Record<string, number> };
  try { parsed = JSON.parse(String(vals.json)); } catch {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Zones JSON is invalid", kind: "error" } }));
    return;
  }
  if (!Array.isArray(parsed.zones) || parsed.zones.length === 0) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Provide at least one zone in 'zones'", kind: "error" } }));
    return;
  }
  try {
    const { zones, totals } = calcZoneLoadsDetailed(parsed.zones as ZoneLoadInput[], {
      conditions: parsed.conditions,
      supplyDeltaTC: Number(vals.dt) || 12,
    });
    const rows: ResultRow[] = [
      { label: "Zones analysed", value: String(zones.length) },
      { label: "Building cooling total", value: `${totals.coolingW.toFixed(0)} W (${totals.tons.toFixed(2)} tons)`, strong: true },
      { label: "Building heating total", value: `${totals.heatingW.toFixed(0)} W`, strong: true },
      { label: "Cooling airflow total", value: `${totals.airflowLs.toFixed(0)} L/s (${Math.round(totals.airflowLs * 2.11888)} CFM)` },
      { label: "Outdoor air total", value: `${totals.outdoorAirLs.toFixed(0)} L/s` },
      ...zones.slice(0, 6).map((z) => ({
        label: `${z.zoneName}: cool ${z.cooling.sensibleW.toFixed(0)}S+${z.cooling.latentW.toFixed(0)}L W, SHR ${z.cooling.shr}`,
        value: `${z.cooling.airflowLs.toFixed(0)} L/s (${z.cooling.airflowCfm} CFM) \u00B7 heat ${z.heating.totalW.toFixed(0)} W`,
      })),
    ];
    if (zones.length > 6) rows.push({ label: "\u2026", value: `${zones.length - 6} more zones in the JSON export` });
    showResultDialog("Zone Loads \u2014 CLTD Analysis", rows, [
      "Sol-air walls (AS structural \u03B1=0.26, h\u1D62=22.7), clear-sky solar peaks per fa\u00E7ade, people 75S/55L W, OA per ASHRAE 62.1 style rate, infiltration from ACH.",
      "Heating excludes solar and internal gains (conservative). Design aid \u2014 the project code and a full heat-balance run govern the final plant sizing.",
    ]);
  } catch (e) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Zone load analysis failed: ${(e as Error).message}`, kind: "error" } }));
  }
}

// ── Panel schedule wire size + voltage drop ──────────────────────────────

async function panelWireCalc(): Promise<void> {
  const SAMPLE = JSON.stringify({
    panel: {
      id: "P1", name: "LP-1", voltageV: 230, phase: 1, busRatingA: 100, circuitSpaces: 24,
      circuits: [
        { id: "c1", panelId: "P1", circuitNumber: 1, loadIds: ["l1"], breakerRatingA: 16, poles: 1, voltageV: 230, phase: 1, wireLengthM: 35 },
        { id: "c2", panelId: "P1", circuitNumber: 2, loadIds: ["l2"], breakerRatingA: 20, poles: 1, voltageV: 230, phase: 1, wireLengthM: 90 },
      ],
    },
    loads: [
      { id: "l1", name: "Office lighting", apparentPowerVA: 1800, voltageV: 230, phase: 1, poles: 1, powerFactor: 0.95 },
      { id: "l2", name: "Workshop sockets", apparentPowerVA: 3200, voltageV: 230, phase: 1, poles: 1, powerFactor: 0.9 },
    ],
  }, null, 1);
  const vals = await openFormModal({
    title: "Panel Schedule \u2014 Wire Size & Voltage Drop",
    subtitle: "Auto conductor selection from the design current + per-circuit voltage drop (3% advisory, 5% limit)",
    width: 560,
    fields: [
      { kind: "textarea", key: "json", label: "Panel + loads JSON", default: SAMPLE, hint: "panel{id,name,voltageV,phase,busRatingA,circuitSpaces,circuits[{id,panelId,circuitNumber,loadIds,breakerRatingA,poles,voltageV,phase,wireLengthM?}]}; loads[{id,name,apparentPowerVA,voltageV,phase,poles,powerFactor?,demandFactor?}]." },
    ],
    submitLabel: "Build schedule",
  });
  if (!vals) return;
  let parsed: { panel?: ElectricalPanel; loads?: ElectricalLoad[] };
  try { parsed = JSON.parse(String(vals.json)); } catch {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Panel JSON is invalid", kind: "error" } }));
    return;
  }
  if (!parsed.panel) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Provide a 'panel' object", kind: "error" } }));
    return;
  }
  try {
    const schedule = buildPanelSchedule(parsed.panel, parsed.loads ?? []);
    const rows: ResultRow[] = [
      { label: "Panel", value: `${schedule.panelName} \u00B7 ${schedule.voltageV} V ${schedule.phase}\u00D8` },
      { label: "Connected / demand", value: `${schedule.totalConnectedVA.toFixed(0)} / ${schedule.totalDemandVA.toFixed(0)} VA` },
      { label: "Demand current", value: `${schedule.estimatedDemandCurrentA.toFixed(1)} A \u00B7 bus ${schedule.busRatingA} A` },
      { label: "Spaces used", value: `${schedule.usedSpaces} / ${schedule.usedSpaces + schedule.availableSpaces}` },
      ...schedule.rows.map((r) => ({
        label: `Ckt ${r.circuitNumber} \u2014 ${r.loadNames.join(", ") || "\u2014"} (${r.demandVA.toFixed(0)} VA, ${r.designCurrentA.toFixed(1)} A)`,
        value: `${r.wireSizeMm2 != null ? `${r.wireSizeMm2} mm\u00B2` : "no wire fits"}${r.voltageDropPercent != null ? ` \u00B7 ${r.voltageDropPercent.toFixed(2)}% drop` : ""} \u00B7 ${r.status.toUpperCase()}`,
        strong: r.status !== "ok",
      })),
    ];
    const notes = schedule.diagnostics
      .filter((d) => d.severity !== "ok")
      .map((d) => `${d.code}: ${d.message}`);
    if (notes.length === 0) notes.push("All circuits pass ampacity and voltage-drop checks.");
    showResultDialog("Panel Schedule \u2014 " + schedule.panelName, rows, notes);
  } catch (e) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Panel schedule failed: ${(e as Error).message}`, kind: "error" } }));
  }
}

async function fanDutyCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Fan Duty Selection",
    subtitle: "Total/static pressure, air power and the standard IEC motor frame",
    fields: [
      { kind: "number", key: "dp", label: "Worst-path system drop", default: 320, unit: "Pa", validate: (x) => Number(x) >= 0 ? null : "Must be \u2265 0" },
      { kind: "number", key: "flow", label: "Design airflow", default: 2.5, unit: "m\u00B3/s", validate: mustBePositive },
      { kind: "number", key: "exit", label: "Discharge velocity", default: 6, unit: "m/s (0 = ignore)" },
      { kind: "number", key: "safety", label: "Safety factor", default: 1.1 },
      { kind: "number", key: "eff", label: "Fan mechanical efficiency", default: 0.65, min: 0.05, max: 1 },
    ],
    submitLabel: "Select",
  });
  if (!vals) return;
  const r = fanSelection({
    worstPathDpPa: Number(vals.dp), flowM3s: Number(vals.flow),
    exitVelocityMs: Number(vals.exit) > 0 ? Number(vals.exit) : 0,
    safetyFactor: Number(vals.safety) || 1.1, mechanicalEfficiency: Number(vals.eff) || 0.65,
  });
  showResultDialog("Fan Duty", [
    { label: "Fan total pressure", value: `${r.fanTotalPressurePa.toFixed(0)} Pa`, strong: true },
    { label: "Fan static pressure", value: `${r.fanStaticPressurePa.toFixed(0)} Pa`, strong: true },
    { label: "Exit velocity head", value: `${r.exitVelocityHeadPa.toFixed(0)} Pa` },
    { label: "Air power", value: `${(r.airPowerW / 1000).toFixed(2)} kW` },
    { label: "Shaft power", value: `${(r.shaftPowerW / 1000).toFixed(2)} kW` },
    { label: "Recommended motor", value: `${r.recommendedMotorKw} kW (IEC frame)`, strong: true },
  ], [...r.warnings, "Selection aid \u2014 verify against the manufacturer fan curve and the fire/smoke mode duties."]);
}

async function pumpDutyCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "Pump Duty Selection",
    subtitle: "Duty head = worst-path loss + static lift + terminal residual, with IEC motor frame",
    fields: [
      { kind: "number", key: "loss", label: "Worst-path head loss", default: 6, unit: "m", validate: (x) => Number(x) >= 0 ? null : "Must be \u2265 0" },
      { kind: "number", key: "lift", label: "Static lift", default: 12, unit: "m" },
      { kind: "number", key: "residual", label: "Terminal residual head", default: 3, unit: "m" },
      { kind: "number", key: "flow", label: "Design flow", default: 5, unit: "L/s", validate: mustBePositive },
      { kind: "number", key: "safety", label: "Safety factor", default: 1.1 },
      { kind: "number", key: "eff", label: "Pump efficiency", default: 0.7, min: 0.05, max: 1 },
    ],
    submitLabel: "Select",
  });
  if (!vals) return;
  const r = pumpSelection({
    worstPathHeadLossM: Number(vals.loss), staticLiftM: Number(vals.lift),
    terminalResidualHeadM: Number(vals.residual), flowLs: Number(vals.flow),
    safetyFactor: Number(vals.safety) || 1.1, pumpEfficiency: Number(vals.eff) || 0.7,
  });
  showResultDialog("Pump Duty", [
    { label: "Duty head", value: `${r.dutyHeadM.toFixed(1)} m`, strong: true },
    { label: "Duty pressure", value: `${r.dutyHeadKPa.toFixed(0)} kPa (${r.dutyHeadBar.toFixed(2)} bar)`, strong: true },
    { label: "Hydraulic power", value: `${(r.hydraulicPowerW / 1000).toFixed(2)} kW` },
    { label: "Shaft power", value: `${(r.shaftPowerW / 1000).toFixed(2)} kW` },
    { label: "Recommended motor", value: `${r.recommendedMotorKw} kW (IEC frame)`, strong: true },
  ], [...r.warnings, "Selection aid \u2014 verify against the pump curve, NPSH and the commissioning tolerance."]);
}

async function drainageCalc(): Promise<void> {
  const SAMPLE = JSON.stringify({
    "water-closet-public-1.6-gpf": 6,
    "lavatory": 8,
    "floor-drain": 3,
  });
  const vals = await openFormModal({
    title: "Drainage Size (DFU)",
    subtitle: "IPC Tables 709.1 / 710.1(1) / 710.1(2) \u2014 a capability Revit ships only through add-ins",
    fields: [
      { kind: "textarea", key: "fixtures", label: "Fixture counts JSON", default: SAMPLE, hint: "Keys: water-closet-public-1.6-gpf, water-closet-private-1.6-gpf, urinal-standard, lavatory, shower-5.7-gpm-or-less, floor-drain, kitchen-sink-domestic, bathtub, \u2026" },
      { kind: "select", key: "element", label: "Element to size", options: [["building-drain", "Building drain / sewer"], ["horizontal-branch", "Horizontal branch"], ["stack", "Stack"]], default: "building-drain" },
      { kind: "select", key: "slope", label: "Slope (building drain)", options: [["0.0625", "1/16 in/ft"], ["0.125", "1/8 in/ft"], ["0.25", "1/4 in/ft"], ["0.5", "1/2 in/ft"]], default: "0.25" },
      { kind: "select", key: "intervals", label: "Stack branch intervals", options: [["1", "One interval"], ["2", "Two intervals"], ["3-or-less", "Three or fewer"], ["over-3", "More than three"]], default: "3-or-less" },
      { kind: "checkbox", key: "wc", label: "Serves a water closet (3 in minimum)", default: true },
    ],
    submitLabel: "Size",
  });
  if (!vals) return;
  let counts: Record<string, number>;
  try { counts = JSON.parse(String(vals.fixtures)); } catch {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Fixture JSON is invalid", kind: "error" } }));
    return;
  }
  const dfu = totalDfu(counts);
  if (dfu < 0) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Unknown fixture key \u2014 see the hint for valid names", kind: "error" } }));
    return;
  }
  try {
    const element = String(vals.element) as "building-drain" | "horizontal-branch" | "stack";
    const r = sizeDrain(element, dfu, {
      slopeInFt: Number(vals.slope) as DrainSlopeInFt,
      intervals: String(vals.intervals) as any,
      servesWaterCloset: !!vals.wc,
    });
    showResultDialog("Drainage Sizing (DFU)", [
      { label: "Total load", value: `${r.dfu} DFU` },
      { label: "Required size", value: `${r.diameterIn} in (${r.diameterMm.toFixed(0)} mm nom.)`, strong: true },
      { label: "Capacity", value: `${r.capacityDfu} DFU` },
      { label: "Sizing rule", value: r.rule },
    ], [...r.notes, ...r.warnings, "Sizing aid \u2014 the AHJ and the governing local code (IPC / UPC / EN 12056) win."]);
  } catch (e) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Drainage sizing failed: ${(e as Error).message}`, kind: "error" } }));
  }
}

async function drainageDirectCalc(): Promise<void> {
  const vals = await openFormModal({
    title: "DFU \u2192 Pipe Size (direct)",
    subtitle: "Enter the DFU load directly",
    fields: [
      { kind: "number", key: "dfu", label: "Drainage fixture units", default: 90, validate: mustBePositive },
      { kind: "select", key: "element", label: "Element to size", options: [["building-drain", "Building drain / sewer"], ["horizontal-branch", "Horizontal branch"], ["stack", "Stack"]], default: "horizontal-branch" },
    ],
    submitLabel: "Size",
  });
  if (!vals) return;
  try {
    const r = sizeDrain(String(vals.element) as "building-drain" | "horizontal-branch" | "stack", Number(vals.dfu));
    showResultDialog("DFU \u2192 Pipe Size", [
      { label: "Load", value: `${r.dfu} DFU` },
      { label: "Required size", value: `${r.diameterIn} in (${r.diameterMm.toFixed(0)} mm nom.)`, strong: true },
      { label: "Capacity", value: `${r.capacityDfu} DFU` },
      { label: "Sizing rule", value: r.rule },
    ], r.notes);
  } catch (e) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Sizing failed: ${(e as Error).message}`, kind: "error" } }));
  }
}

// ── Toolkit dispatcher ───────────────────────────────────────────────────

const TOOLKIT_ITEMS: Array<{ value: string; label: string }> = [
  { value: "fixture-demand", label: "Fixture-Unit Demand (Hunter curve)" },
  { value: "sprinkler", label: "Sprinkler Design Demand (density/area)" },
  { value: "voltage-drop", label: "Voltage Drop & Conductor Check" },
  { value: "friction-size", label: "Auto-Size by Friction Rate (Revit method)" },
  { value: "static-regain", label: "Static Regain Duct Main (Revit method)" },
  { value: "network-audit", label: "Network Audit \u2014 Pressure Loss Report" },
  { value: "zone-loads", label: "Zone Heating & Cooling Loads (CLTD)" },
  { value: "panel-wire", label: "Panel Schedule \u2014 Wire Size & Voltage Drop" },
  { value: "fan-duty", label: "Fan Duty Selection" },
  { value: "pump-duty", label: "Pump Duty Selection" },
  { value: "drainage-dfu", label: "Drainage Size (DFU, IPC 710)" },
  { value: "pipe-insulation", label: "Pipe Insulation Heat Loss" },
  { value: "duct-insulation", label: "Duct Insulation Heat Loss" },
  { value: "equivalent-duct", label: "Round \u2194 Rectangular Duct Equivalent" },
  { value: "ach", label: "Air Changes \u2192 Airflow" },
  { value: "water-hammer", label: "Water Hammer Surge (Joukowsky)" },
  { value: "unit-convert", label: "Unit Converter" },
];

/**
 * Open the MEP Design Toolkit menu. Exported for the ribbon button and the
 * command palette; each entry dispatches into its calculator form.
 */
export async function openMepDesignToolkit(): Promise<void> {
  const pick = await pickFromList(
    "MEP Design Toolkit",
    "Calculator",
    TOOLKIT_ITEMS,
    TOOLKIT_ITEMS[0].value,
  );
  if (!pick) return;
  const runners: Record<string, () => Promise<void>> = {
    "fixture-demand": fixtureDemandCalc,
    "sprinkler": sprinklerCalc,
    "voltage-drop": voltageDropCalc,
    "friction-size": frictionSizeCalc,
    "static-regain": staticRegainCalc,
    "network-audit": networkAuditCalc,
    "zone-loads": zoneLoadCalc,
    "panel-wire": panelWireCalc,
    "fan-duty": fanDutyCalc,
    "pump-duty": pumpDutyCalc,
    "drainage-dfu": drainageCalc,
    "pipe-insulation": pipeInsulationCalc,
    "duct-insulation": ductInsulationCalc,
    "equivalent-duct": equivalentDuctCalc,
    "ach": achCalc,
    "water-hammer": waterHammerCalc,
    "unit-convert": unitConvertCalc,
  };
  const run = runners[pick];
  if (run) await run();
}