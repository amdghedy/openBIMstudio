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

// ── Toolkit dispatcher ───────────────────────────────────────────────────

const TOOLKIT_ITEMS: Array<{ value: string; label: string }> = [
  { value: "fixture-demand", label: "Fixture-Unit Demand (Hunter curve)" },
  { value: "sprinkler", label: "Sprinkler Design Demand (density/area)" },
  { value: "voltage-drop", label: "Voltage Drop & Conductor Check" },
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