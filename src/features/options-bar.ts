/** Revit-style contextual Options Bar. Switches with the active tool. */
import { ctx } from "../core/context";
import {
  getActiveTool, onAuthoringChange,
  getWallLocationLine, setWallLocationLine, getWallChain, setWallChain,
  getWallOffset, setWallOffset, getWallJoinStatus, setWallJoinStatus,
  getBeamJustification, setBeamJustification,
  getBeamZJustification, setBeamZJustification,
  getMepJustification, setMepJustification,
  getDrawSlope, setDrawSlope,
  getTypeDefaults, setTypeDefault,
} from "./authoring";
import { runModifyAction } from "./modify-actions";
import { startMultiMove } from "./multi-move";
import { startArray } from "./array-tool";
import { startRotate } from "./rotate-tool";

type Any = Record<string, any>;
let host: HTMLDivElement | null = null;
let unsub: (() => void) | null = null;
let timer = 0;
let lastTool: string | null = null;

const DRAW = new Set([
  "wall", "slab", "column", "beam", "brace", "truss", "footing", "strip", "mline",
  "duct", "pipe", "cable-tray", "conduit", "equipment", "door", "window",
  "curtain-wall", "grid", "level", "terrain",
]);

const field = (label: string, control: string): string =>
  `<label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#94a3b8;white-space:nowrap">${label}${control}</label>`;

const num = (k: string, v: number, step = 0.05): string =>
  `<input data-k="${k}" type="number" step="${step}" value="${Number(v).toFixed(3)}" style="width:64px;background:#0b0e14;border:1px solid #334155;border-radius:3px;color:#f8fafc;font:11px var(--font-mono,monospace);padding:2px 4px">`;

const sel = (k: string, v: string, opts: Array<[string, string]>): string =>
  `<select data-k="${k}" style="background:#0b0e14;border:1px solid #334155;border-radius:3px;color:#f8fafc;font:11px sans-serif;padding:2px 4px">${opts
    .map(([val, label]) => `<option value="${val}" ${val === v ? "selected" : ""}>${label}</option>`)
    .join("")}</select>`;

const chk = (k: string, v: boolean, label: string): string =>
  `<label style="display:flex;align-items:center;gap:3px;font-size:10px;color:#94a3b8"><input data-k="${k}" type="checkbox" ${v ? "checked" : ""}>${label}</label>`;

const btn = (action: string, label: string): string =>
  `<button data-m="${action}" style="background:#1b212c;border:1px solid #2f3846;border-radius:3px;color:#cbd5e1;font:10px sans-serif;padding:2px 6px;cursor:pointer">${label}</button>`;

function render(): void {
  if (!host) return;
  const tool = (getActiveTool() ?? "select") as string;
  lastTool = tool;
  const defaults = getTypeDefaults(tool);
  let html =
    `<span style="color:#38bdf8;font-weight:700;font-size:10px;letter-spacing:.04em;text-transform:uppercase">${tool}</span>` +
    `<span style="width:1px;height:16px;background:#2f3846"></span>`;

  if (tool === "wall" || tool === "curtain-wall") {
    html += field("Location Line", sel("wallLocationLine", getWallLocationLine(), [
      ["wall-centerline", "Wall Centerline"], ["core-centerline", "Core Centerline"],
      ["finish-exterior", "Finish Exterior"], ["finish-interior", "Finish Interior"],
      ["core-exterior", "Core Exterior"], ["core-interior", "Core Interior"],
    ]));
    html += field("Join", sel("wallJoinStatus", getWallJoinStatus(), [
      ["allow", "Allow"], ["disallow", "Disallow"], ["butt", "Butt"],
      ["chamfer", "Chamfer"], ["extended", "Extended"],
    ]));
    html += chk("wallChain", getWallChain(), "Chain");
    html += field("Offset", num("wallOffset", getWallOffset()));
    html += field("Height", num("height", defaults.params.height ?? 3));
    html += field("Thickness", num("thickness", defaults.params.thickness ?? 0.2));
  } else if (tool === "beam" || tool === "strip") {
    html += field("Justification", sel("beamJustification", getBeamJustification(), [
      ["center", "Center"], ["outer", "Outer"], ["inner", "Inner"],
    ]));
    html += field("Z-Just.", sel("beamZJustification", getBeamZJustification(), [
      ["bottom", "Bottom"], ["center", "Center"], ["top", "Top"],
    ]));
    html += field("Height", num("height", defaults.params.height ?? 0.5));
    html += field("Width", num("thickness", defaults.params.thickness ?? 0.25));
  } else if (tool === "duct" || tool === "pipe" || tool === "cable-tray" || tool === "conduit") {
    html += field("Justification", sel("mepJustification", getMepJustification(), [
      ["center", "Center"], ["outer", "Outer"], ["inner", "Inner"],
    ]));
    html += field("Slope %", num("drawSlope", getDrawSlope(), 0.1));
    html += field("Size", num("thickness", defaults.params.thickness ?? 0.4));
    html += field("Height", num("height", defaults.params.height ?? 0.4));
  } else if (DRAW.has(tool)) {
    html += field("Height", num("height", defaults.params.height ?? 1));
    html += field("Thickness", num("thickness", defaults.params.thickness ?? 0.2));
    if (defaults.params.width != null) html += field("Width", num("width", defaults.params.width ?? 1));
    html += field("Elevation", num("elevation", defaults.params.elevation ?? 0));
  } else {
    html += `<span style="color:#94a3b8;font-size:10px">Modify</span>`;
    html += `<button data-mm="move">Move</button><button data-mm="copy">Copy</button>` + `<button data-rot="1" style="position:relative;background:#1b212c;border:1px solid #2f3846;border-radius:3px;color:#cbd5e1;font:10px sans-serif;padding:2px 6px;cursor:pointer">Rotate</button>` +
      btn("mirror", "Mirror") + `<button data-arr="1" style="background:#1b212c;border:1px solid #2f3846;border-radius:3px;color:#cbd5e1;font:10px sans-serif;padding:2px 6px;cursor:pointer">Array</button>` + btn("offset", "Offset") +
      btn("pin", "Pin") + btn("delete", "Delete");
  }

  html += `<span style="flex:1"></span><span style="color:#64748b;font-size:9px">Esc cancels · Space repeats</span>`;
  host.innerHTML = html;
  host.querySelectorAll<HTMLElement>("button").forEach((b) => {
    const isNew =
      (b.dataset.mm === "move") ||
      (b.dataset.mm === "copy") ||
      (b.dataset.arr === "1") ||
      (b.dataset.rot === "1");
    if (!isNew || b.querySelector(".obs-new-dot")) return;
    b.style.position = "relative";
    const dot = document.createElement("span");
    dot.className = "obs-new-dot";
    dot.title = "New tool — try it";
    dot.style.cssText = "position:absolute;top:-2px;right:-2px;width:4px;height:4px;background:#22c55e;border-radius:50%;box-shadow:0 0 3px #22c55e;pointer-events:none;";
    b.appendChild(dot);
  });

  host.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => {
    const k = el.dataset.k!;
    if (el.tagName === "SELECT") {
      (el as HTMLSelectElement).onchange = () => apply(k, (el as HTMLSelectElement).value);
    } else if ((el as HTMLInputElement).type === "checkbox") {
      (el as HTMLInputElement).onchange = () => apply(k, (el as HTMLInputElement).checked);
    } else {
      (el as HTMLInputElement).onchange = () => apply(k, parseFloat((el as HTMLInputElement).value));
    }
  });
  host.querySelectorAll<HTMLElement>("button").forEach((b) => {
    if (b.dataset.mm) b.onclick = () => startMultiMove(b.dataset.mm === "copy");
    else if (b.dataset.arr) b.onclick = () => startArray();
    else if (b.dataset.rot) b.onclick = () => startRotate();
    else if (b.dataset.m) b.onclick = () => runModifyAction(b.dataset.m as any);
  });
}

function apply(k: string, v: any): void {
  try {
    switch (k) {
      case "wallLocationLine": setWallLocationLine(v); break;
      case "wallJoinStatus": setWallJoinStatus(v); break;
      case "wallChain": setWallChain(!!v); break;
      case "wallOffset": setWallOffset(Number(v) || 0); break;
      case "beamJustification": setBeamJustification(v); break;
      case "beamZJustification": setBeamZJustification(v); break;
      case "mepJustification": setMepJustification(v); break;
      case "drawSlope": setDrawSlope(Number(v) || 0); break;
      default:
        if (Number.isFinite(v)) setTypeDefault(lastTool ?? "wall", "params", k, Number(v));
        break;
    }
  } catch { /* */ }
  render();
}

export function setupOptionsBar(): void {
  if (host) return;
  host = document.createElement("div");
  host.id = "obs-options-bar";
  host.style.cssText =
    "position:absolute;left:0;right:0;top:0;z-index:60;display:flex;align-items:center;gap:10px;" +
    "flex-wrap:wrap;padding:4px 10px;background:rgba(15,17,23,.92);border-bottom:1px solid #2a3140;" +
    "backdrop-filter:blur(6px);pointer-events:auto;";
  const parent = ((ctx as Any).rightHost ?? document.getElementById("viewport") ?? document.body) as HTMLElement;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  parent.appendChild(host);
  unsub = onAuthoringChange(render);
  timer = window.setInterval(() => {
    const t = (getActiveTool() ?? "select") as string;
    if (t !== lastTool) render();
  }, 350);
  render();
}

export function destroyOptionsBar(): void {
  unsub?.(); unsub = null;
  if (timer) clearInterval(timer);
  timer = 0;
  host?.remove(); host = null;
}