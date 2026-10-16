import { getProjection } from "../features/camera-tools";
/** Blender-style thin status bar (bottom) — cursor readout + project state. */
import { ctx } from "../core/context";
import {
  getCurrentProject, isDirty, getDetachedModelCount, onProjectChanged,
} from "../modules/projects/projects";
import { getActiveTool, getElementCount } from "../features/authoring";

const bar = document.createElement("div");
bar.className = "bb-status";

const left = document.createElement("div");
left.className = "bb-status__seg";

const spacer = document.createElement("div");
spacer.className = "bb-status__spacer";

const center = document.createElement("div");
center.className = "bb-status__seg";

const coordsSeg = document.createElement("div");
coordsSeg.className = "bb-status__seg";
coordsSeg.dataset.obsCoords = "1";
coordsSeg.style.cssText =
  "font-family:var(--font-mono,monospace);font-size:10.5px;letter-spacing:.3px;" +
  "min-width:260px;justify-content:flex-end";
coordsSeg.textContent = "X —   Y —   Z —  (Revit: Z↑)";

const spacer2 = document.createElement("div");
spacer2.className = "bb-status__spacer";

const right = document.createElement("div");
right.className = "bb-status__seg";

bar.append(left, spacer, center, coordsSeg, spacer2, right);

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);

const TOOL_LABELS: Record<string, string> = {
  select: "Select", wall: "Wall", slab: "Slab", column: "Column",
  beam: "Beam", brace: "Brace", truss: "Truss", footing: "Footing",
  strip: "Strip", mline: "Model line", duct: "Duct", pipe: "Pipe",
  "cable-tray": "Cable tray", conduit: "Conduit", equipment: "Equipment",
  grid: "Grid", level: "Level", door: "Door", window: "Window",
  move: "Move", copy: "Copy", rotate: "Rotate", mirror: "Mirror",
  array: "Array", offset: "Offset",
};

function kbd(label: string) {
  return `<span class="bb-status__kbd">${label}</span>`;
}

function update() {
  const tool = getActiveTool();
  left.innerHTML = tool
    ? `<span class="bb-status__accent">${esc(TOOL_LABELS[tool] ?? tool)}</span>` +
      `<span style="opacity:.6">·</span>` +
      `<span>LMB confirm · Esc cancel · Enter end chain</span>`
    : `${kbd("LMB")}<span>Select</span>` +
      `${kbd("MMB")}<span>Pan</span>` +
      `${kbd("⇧MMB")}<span>Orbit</span>` +
      `${kbd("Wheel")}<span>Zoom</span>` +
      `${kbd("RMB")}<span>Menu</span>` +
      `${kbd("LMB drag")}<span>Window / Crossing</span>`;

  const models = ctx.fragments.list.size;
  const objects = getElementCount();
  const proj = getProjection();
  center.innerHTML =
    `<span style="opacity:.55">Models</span> <b>${models}</b>` +
    `<span style="opacity:.4">·</span>` +
    `<span style="opacity:.55">Objects</span> <b>${objects}</b>` +
    `<span style="opacity:.4">·</span>` +
    `<span style="opacity:.55">${proj === "orthographic" ? "Orthographic" : "Perspective"}</span>`;

  const p = getCurrentProject();
  const detached = getDetachedModelCount();
  right.innerHTML =
    (detached ? `<span style="color:#dca642">⚠ ${detached} detached</span><span style="opacity:.4">·</span>` : "") +
    (p
      ? `<span style="opacity:.55">${esc(p.projectNumber || "Project") }:</span> <b>${esc(p.name)}</b>` +
        `<span style="opacity:.4">·</span><span style="opacity:.55">${esc((p.units ?? "metric").toUpperCase())}</span>` +
        `<span style="opacity:.4">·</span>` +
        (isDirty()
          ? ` <span style="color:#dca642">● unsaved</span>`
          : ` <span style="color:#7bb040">● saved</span>`)
      : `<span style="opacity:.55">No project</span>`) +
    `<span style="opacity:.4">·</span>` +
    `<span style="opacity:.55">Open BIM Studio v52</span>`;
}

export function setupStatusBar() {
  (document.getElementById("app") as HTMLElement).appendChild(bar);
  onProjectChanged(update);
  setInterval(update, 1200);
  update();
}