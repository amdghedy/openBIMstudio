import { getProjection } from "../features/camera-tools";
import { APP_VERSION } from "../version";
import { ctx } from "../core/context";
import { togglePlanView, isPlanViewVisible } from "../features/plan-view-panel";
import { isSheets2dPanelVisible } from "../features/sheets-2d-panel";
import {
  getCurrentProject, isDirty, getDetachedModelCount, onProjectChanged,
  getSaveState,
} from "../modules/projects/projects";
import { saveProject } from "../modules/projects/projects";
import { fmtDateTime } from "../core/region";
import { getActiveTool, getElementCount, getLevel } from "../features/authoring";
import {
  getDraftingAids,
  toggleDraftingAid,
  DRAFTING_AIDS_EVENT,
  type DraftingAidKey,
} from "../modules/cad-viewer/cad-drafting-aids";

const bar = document.createElement("div");
bar.className = "bb-status";

// ── Tab-cycle readout (Revit 2D audit gap G3) ─────────────────────────────
// The 3D hover cycle (bim-experience.ts) and the plan footer report the
// pre-highlighted candidate through this transient message; it is cleared
// by Esc, by a click that consumes the cycle, or when the cursor moves
// away. It is delivered as a window event (not an import) so the status
// bar stays free of cycles with the feature modules that drive it.
let cycleStatus: string | null = null;
window.addEventListener("obs:tab-cycle-status", (e) => {
  cycleStatus = (e as CustomEvent).detail?.message ?? null;
  update();
});

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
coordsSeg.textContent = "X —   Y —   Z —  (BIM: Z↑)";

// ── Green/red zone switcher ────────────────────────────────────────────────
// The workspace is partitioned: 🟢 3D MODEL ZONE (viewport, files, options,
// history, info) vs 🔴 2D DOCS ZONE (floor plan, sheets, P&ID, print). The
// chip shows which zone owns the current context and lets the user jump.
const zoneSeg = document.createElement("div");
zoneSeg.className = "bb-status__seg";
zoneSeg.style.cssText = "gap:0;margin:0 10px";

const z3d = document.createElement("button");
z3d.textContent = "3D MODEL";
z3d.title = "Green zone — 3D model world: viewport, files, options, history and model info. Click to leave the 2D docs and return to the model.";
const z2d = document.createElement("button");
z2d.textContent = "2D DOCS";
z2d.title = "Red zone — 2D documentation: floor plan, sheets, P&ID and print. Click to open the floor plan.";
for (const b of [z3d, z2d]) {
  b.style.cssText =
    "font:700 9.5px system-ui,sans-serif;letter-spacing:.5px;padding:3px 9px;border:none;cursor:pointer;" +
    "background:transparent;color:#5b6472;transition:background .15s,color .15s";
  b.addEventListener("click", () => {
    const in2d = isPlanViewVisible() || isSheets2dPanelVisible();
    const want2d = b === z2d;
    if (want2d !== in2d) {
      togglePlanView(); // plan is the gateway between the zones
      if (b === z3d) { const svc = (ctx.features as any).sheets2dPanel; if (svc?.close) svc.close(); }
    }
  });
}
zoneSeg.append(z3d, z2d);

const spacer2 = document.createElement("div");
spacer2.className = "bb-status__spacer";

// ── Drafting-aid toggles (2D-2, A12 follow-up) ──────────────────────────
// The CAD viewer's drafting aids (GRID, SNAP, OSNAP, ORTHO, POLAR,
// OTRACK, DYN, LWT) used to live only inside the per-tab engine closure,
// so the main-shell status bar showed no toggles at all. These buttons
// switch the same shared state (`cad-drafting-aids.ts`) the viewer
// toggles switch: a toggle here is picked up by the active drawing (and
// by the next drawing opened), and a toggle inside the viewer is
// reflected here. Buttons are built once (like the zone chips) and only
// their pressed state is re-rendered by update(), so clicks survive the
// 1.2 s refresh.
const AID_DEFS: { key: DraftingAidKey; label: string; title: string }[] = [
  { key: "grid", label: "GRID", title: "Grid display (F7)" },
  { key: "snap", label: "SNAP", title: "Snap to grid (F9)" },
  { key: "osnap", label: "OSNAP", title: "Object Snap (F3)" },
  { key: "ortho", label: "ORTHO", title: "Ortho mode (F8)" },
  { key: "polar", label: "POLAR", title: "Polar tracking (F10)" },
  { key: "otrack", label: "OTRACK", title: "Object snap tracking" },
  { key: "ducs", label: "DUCS", title: "Dynamic UCS (F6)" },
  { key: "dyn", label: "DYN", title: "Dynamic Input (F12)" },
  { key: "lwt", label: "LWT", title: "Lineweight display" },
];
const AID_BTN_BASE =
  "font:700 9.5px system-ui,sans-serif;letter-spacing:.5px;padding:3px 8px;border:none;cursor:pointer;border-radius:3px;";
const AID_BTN_ON = "background:#0284c7;color:#ffffff;";
const AID_BTN_OFF = "background:transparent;color:#5b6472;";
const aidsSeg = document.createElement("div");
aidsSeg.className = "bb-status__seg";
aidsSeg.dataset.obsDraftingAids = "1";
aidsSeg.title = "Drafting aids — the same switches as the Drawing Editor status bar";
const aidButtons: HTMLButtonElement[] = [];
for (const def of AID_DEFS) {
  const b = document.createElement("button");
  b.textContent = def.label;
  b.title = def.title;
  b.dataset.aid = def.key;
  b.setAttribute("aria-pressed", "false");
  b.style.cssText = AID_BTN_BASE + AID_BTN_OFF;
  b.addEventListener("click", () => {
    toggleDraftingAid(def.key);
    update();
  });
  aidsSeg.appendChild(b);
  aidButtons.push(b);
}

function syncAidButtons() {
  const state = getDraftingAids();
  for (const b of aidButtons) {
    const on = state[b.dataset.aid as DraftingAidKey];
    b.setAttribute("aria-pressed", String(on));
    b.style.cssText = AID_BTN_BASE + (on ? AID_BTN_ON : AID_BTN_OFF);
  }
}

const right = document.createElement("div");
right.className = "bb-status__seg";

bar.append(left, spacer, center, aidsSeg, zoneSeg, coordsSeg, spacer2, right);

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

function styleZoneChip(active: "3d" | "2d") {
  const base = "font:700 9.5px system-ui,sans-serif;letter-spacing:.5px;padding:3px 9px;border:none;cursor:pointer;";
  const off = base + "background:transparent;color:#5b6472";
  z3d.style.cssText = active === "3d"
    ? base + "background:#22c55e;color:#0b0d12;border-radius:4px 0 0 4px;box-shadow:0 0 8px #22c55e66"
    : off + ";border-radius:4px 0 0 4px";
  z2d.style.cssText = active === "2d"
    ? base + "background:#ef4444;color:#160909;border-radius:0 4px 4px 0;box-shadow:0 0 8px #ef444466"
    : off + ";border-radius:0 4px 4px 0";
}

function update() {
  styleZoneChip(isPlanViewVisible() || isSheets2dPanelVisible() ? "2d" : "3d");
  syncAidButtons();
  const tool = getActiveTool();
  const levelVal = getLevel();
  
  const elevHtml = tool && tool !== "select" 
    ? `<span class="bb-status__seg" style="background:#38bdf8;color:#0b0d12;padding:2px 6px;border-radius:4px;margin-inline-end:8px;font-weight:700;display:inline-block">Elev: ${levelVal.toFixed(2)}m</span>` 
    : "";

  const toolHtml = tool
    ? `<span class="bb-status__accent">${esc(TOOL_LABELS[tool] ?? tool)}</span>` +
      `<span style="opacity:.6">·</span>` +
      `<span>LMB confirm · Esc cancel · Enter end chain</span>`
    : `${kbd("LMB")}<span>Select</span>` +
      `${kbd("MMB")}<span>Pan</span>` +
      `${kbd("⇧MMB")}<span>Orbit</span>` +
      `${kbd("Wheel")}<span>Zoom</span>` +
      `${kbd("RMB")}<span>Menu</span>` +
      `${kbd("LMB drag")}<span>Window / Crossing</span>`;

  left.innerHTML =
    (cycleStatus
      ? `<span style="background:#f59e0b;color:#160909;padding:2px 6px;border-radius:4px;margin-inline-end:8px;font-weight:700;display:inline-block">${esc(cycleStatus)}</span>`
      : "") +
    elevHtml + toolHtml;

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
  // Save state machine → explicit, trustworthy status text. A failed save
  // must never render as "saved"; it is clickable to retry.
  const st = getSaveState();
  let saveHtml = "";
  if (p) {
    if (st.state === "saving") {
      saveHtml = `<span style="color:#6aa1ff" data-save-state="saving">● saving…</span>`;
    } else if (st.state === "error") {
      saveHtml = `<span data-save-retry="1" role="button" tabindex="0" ` +
        `title="${esc(st.message)} — click to retry (or Ctrl+S)" ` +
        `style="color:#f87171;cursor:pointer;text-decoration:underline dotted">⚠ save failed — click to retry</span>`;
    } else if (st.state === "saved") {
      saveHtml = `<span style="color:#7bb040" title="Last saved ${esc(fmtDateTime(st.at))}">● saved</span>`;
    } else if (isDirty()) {
      saveHtml = `<span style="color:#dca642">● unsaved</span>`;
    } else {
      saveHtml = `<span style="color:#7bb040">● saved</span>`;
    }
  }
  right.innerHTML =
    (detached ? `<span style="color:#dca642">⚠ ${detached} detached</span><span style="opacity:.4">·</span>` : "") +
    (p
      ? `<span style="opacity:.55">${esc(p.projectNumber || "Project") }:</span> <b>${esc(p.name)}</b>` +
        `<span style="opacity:.4">·</span><span style="opacity:.55">${esc((p.units ?? "metric").toUpperCase())}</span>` +
        `<span style="opacity:.4">·</span>` +
        saveHtml
      : `<span style="opacity:.55">No project</span>`) +
    `<span style="opacity:.4">·</span>` +
    `<span style="opacity:.55">Open BIM Studio v${APP_VERSION}</span>` +
    `<span style="opacity:.4">·</span>` +
    `<a href="https://github.com/amdghedy/openBIMstudio" target="_blank" rel="noopener noreferrer" ` +
      `style="color:#93c5fd;text-decoration:none;opacity:.9" title="Source on GitHub — star the project">GitHub ⭐</a>`;
}

export function setupStatusBar() {
  (document.getElementById("app") as HTMLElement).appendChild(bar);
  onProjectChanged(update);
  // Retry affordance for a failed save (delegated — the right segment is
  // rebuilt via innerHTML on every update).
  right.addEventListener("click", (e) => {
    if ((e.target as HTMLElement | null)?.closest?.("[data-save-retry]")) void saveProject();
  });
  window.addEventListener("obs:save-state", update);
  window.addEventListener("obs:save-failed", update);
  window.addEventListener("obs:project-saved", update);
  // 2D-2: a drafting-aid toggle anywhere (shell bar, CAD viewer,
  // command, F-key) re-renders the shell buttons immediately.
  window.addEventListener(DRAFTING_AIDS_EVENT, update);
  setInterval(update, 1200);
  update();
}