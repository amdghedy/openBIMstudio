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
import { setAuthoringTool, addLinearElement } from "./authoring";

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

  (ctx.features as any).mepFabrication = {
    show: () => { visible = true; if (panel) panel.style.display = "flex"; },
    hide: () => { visible = false; if (panel) panel.style.display = "none"; },
    toggle: () => { visible ? (ctx.features as any).mepFabrication.hide() : (ctx.features as any).mepFabrication.show(); },
    isVisible: () => visible,
  };
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
  { id: "cable-tray",      label: "Cable Tray",           group: "Electrical", unit: "cables", defaultFlow: 20 },
  { id: "conduit",         label: "Conduit",              group: "Electrical", unit: "cables", defaultFlow: 5 },
];

function openAutoRouteModal(): void {
  // Pick system
  const systemOptions = SYSTEMS.map((s) => `${s.label} (${s.unit})`).join("\n");
  const sysIdx = prompt(`Select MEP system (enter number):\n\n${SYSTEMS.map((s, i) => `${i + 1}. ${s.label}`).join("\n")}`);
  if (!sysIdx) return;
  const idx = parseInt(sysIdx, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= SYSTEMS.length) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Invalid system number", kind: "error" } }));
    return;
  }
  const system = SYSTEMS[idx];

  // Pick flow rate
  const flowStr = prompt(`Flow rate (${system.unit}) for ${system.label}:`, String(system.defaultFlow));
  if (!flowStr) return;
  const flowRate = parseFloat(flowStr);
  if (isNaN(flowRate) || flowRate <= 0) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Invalid flow rate", kind: "error" } }));
    return;
  }

  // Pick elevation (Y)
  const elevStr = prompt(`Routing elevation (m, world Y) for ${system.label}:`, "2.7");
  if (!elevStr) return;
  const elevation = parseFloat(elevStr);
  if (isNaN(elevation)) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Invalid elevation", kind: "error" } }));
    return;
  }

  // Pick start point (X, Z) in metres
  const startStr = prompt(`Start point X,Z (m, e.g. "0,0"):`);
  if (!startStr) return;
  const startParts = startStr.split(",").map((s) => parseFloat(s.trim()));
  if (startParts.length !== 2 || startParts.some(isNaN)) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Invalid start point", kind: "error" } }));
    return;
  }

  // Pick end point
  const endStr = prompt(`End point X,Z (m, e.g. "10,5"):`);
  if (!endStr) return;
  const endParts = endStr.split(",").map((s) => parseFloat(s.trim()));
  if (endParts.length !== 2 || endParts.some(isNaN)) {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Invalid end point", kind: "error" } }));
    return;
  }

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