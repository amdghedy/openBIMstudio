/**
 * MEP Fabrication Parts â€” catalog browser for placing prefabricated parts.
 *
 * Groups parts by system. Clicking a part activates the corresponding
 * authoring tool (duct-fitting, pipe-fitting, etc.) so the user can place
 * it in the viewport.
 */

import { ctx } from "../core/context";
import { setAuthoringTool } from "./authoring";

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

  (ctx.features as any).mepFabrication = {
    show: () => { visible = true; if (panel) panel.style.display = "flex"; },
    hide: () => { visible = false; if (panel) panel.style.display = "none"; },
    toggle: () => { visible ? (ctx.features as any).mepFabrication.hide() : (ctx.features as any).mepFabrication.show(); },
    isVisible: () => visible,
  };
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