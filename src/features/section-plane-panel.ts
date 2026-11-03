/**
 * Section Cut control panel — floating + dockable (left/right/top/bottom/float).
 *
 * Appears when Section mode is on or a clipper plane exists.
 * Offset, step nudge, axis snap, reverse, plane outline, delete, multi-plane list.
 * Esc is handled by escape-all (exits section mode / cancels arrow drag).
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { setAutoHideSectionVisuals, isSectionOn, setSectionOn, onSectionModeChange, deleteSectionPlanes } from "./section";
import {
  alignPlaneToAxis, dominantAxis, nudgePlane, planeOffset, reversePlane, setPlaneOffset, type Axis,
} from "./section-plane-math";
import { makeDockable, type DockHandle } from "./dockable";

type Any = any;

let panel: HTMLDivElement | null = null;
let headerEl: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let dock: DockHandle | null = null;
let offsetInp: HTMLInputElement;
let stepInp: HTMLInputElement;
let axisLbl: HTMLSpanElement;
let sideLbl: HTMLSpanElement;
let listEl: HTMLDivElement;
let statusEl: HTMLDivElement;
let currentItem: Any = null;
let planeShown = true;
let pollTimer: number | null = null;
let installed = false;

function items(): Any[] {
  try {
    const list = (ctx as Any).clipper?.list;
    if (!list) return [];
    const entries: Any[] = list[Symbol.iterator] ? [...list] : Object.values(list);
    return entries.map((e) => (Array.isArray(e) ? e[1] : e)).filter(Boolean);
  } catch {
    return [];
  }
}

function planeOf(item: Any): THREE.Plane | null {
  try {
    const p = item?.three?.plane ?? item?.plane ?? (item?.three?.isPlane ? item.three : null);
    return p?.normal && typeof p.constant === "number" ? (p as THREE.Plane) : null;
  } catch {
    return null;
  }
}

function ensureClippingOn(): void {
  try {
    (ctx as Any).clipper.enabled = true;
  } catch {
    /* */
  }
  try {
    const r = (ctx.world.renderer as Any)?.three;
    if (r) r.localClippingEnabled = true;
  } catch {
    /* */
  }
  try {
    (ctx.fragments as Any).core?.update?.(true);
  } catch {
    /* */
  }
}

/** Push a modified plane back into the clipper item and helper. */
function commit(item: Any, plane: THREE.Plane): void {
  const n = plane.normal.clone().normalize();
  plane.normal.copy(n);
  const origin = n.clone().multiplyScalar(-plane.constant);

  try {
    if (item.normal?.copy) item.normal.copy(n);
    else if ("normal" in item) item.normal = n.clone();
  } catch {
    /* */
  }
  try {
    if (item.origin?.copy) item.origin.copy(origin);
    else if ("origin" in item) item.origin = origin.clone();
  } catch {
    /* */
  }
  try {
    const thr = item.three;
    if (thr?.plane?.normal) {
      thr.plane.normal.copy(n);
      thr.plane.constant = plane.constant;
    }
  } catch {
    /* */
  }
  try {
    const h = item.helper ?? item.three;
    if (h?.position && h !== item.plane) {
      const along = h.position.dot(n);
      h.position.addScaledVector(n, -along + origin.dot(n));
      try {
        h.lookAt(h.position.clone().add(n));
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
  try {
    item.update?.();
  } catch {
    /* */
  }
  ensureClippingOn();
  refresh(true);
}

function act(fn: (p: THREE.Plane, item: Any) => void): void {
  const item = currentItem ?? items().at(-1) ?? null;
  if (!item) return;
  currentItem = item;
  const plane = planeOf(item);
  if (!plane) return;
  try {
    fn(plane, item);
    commit(item, plane);
  } catch (err) {
    console.warn("[section-panel] act failed", err);
  }
}

function step(): number {
  const v = parseFloat(stepInp?.value ?? "0.1");
  return Number.isFinite(v) && v > 0 ? v : 0.1;
}

function btn(label: string, title: string, onClick: () => void, extra = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.style.cssText =
    "padding:5px 9px;border-radius:6px;border:1px solid #3a3f4d;background:#2a2e3a;color:#e8eaf0;" +
    "cursor:pointer;font:600 11.5px system-ui;white-space:nowrap;" + extra;
  b.onmouseenter = () => {
    b.style.background = "#34384a";
  };
  b.onmouseleave = () => {
    b.style.background = "#2a2e3a";
  };
  b.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  };
  return b;
}

function lab(t: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.textContent = t;
  s.style.cssText = "font:700 10px system-ui;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px";
  return s;
}

function buildPanel(): HTMLDivElement {
  const root = document.createElement("div");
  root.id = "obs-section-plane-panel";
  root.style.cssText =
    "display:none;flex-direction:column;background:#1b1c26;border:1px solid #34353f;" +
    "border-radius:10px;box-shadow:0 16px 48px rgba(0,0,0,.55);color:#e2e8f0;" +
    "font:12.5px system-ui,sans-serif;overflow:hidden;min-width:280px;z-index:120";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #2a2e3a;" +
    "background:linear-gradient(180deg,#242632,#1b1c26);cursor:grab;user-select:none";
  header.innerHTML =
    `<span style="width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 8px #ef4444"></span>` +
    `<b style="flex:1;font:700 12.5px system-ui;letter-spacing:.3px">SECTION CUT</b>` +
    `<span style="opacity:.5;font-size:10.5px">drag · dock · Esc exits</span>`;
  headerEl = header;

  const dockBtn = btn("⊞", "Dock left / right / top / bottom / float", () => {
    const r = dockBtn.getBoundingClientRect();
    try {
      dock?.showMenu(Math.max(8, r.left - 100), r.bottom + 4);
    } catch {
      /* */
    }
  });
  const closeBtn = btn("✕", "Hide panel (section stays on)", () => hidePanel());
  header.append(dockBtn, closeBtn);
  root.appendChild(header);

  const body = document.createElement("div");
  body.style.cssText = "padding:10px 12px;display:flex;flex-direction:column;gap:10px;overflow:auto";
  bodyEl = body;

  // Plane list
  listEl = document.createElement("div");
  listEl.style.cssText = "display:flex;flex-direction:column;gap:4px;max-height:96px;overflow:auto";
  body.append(lab("Planes"), listEl);

  // Offset row
  const offsetRow = document.createElement("div");
  offsetRow.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px";
  axisLbl = document.createElement("span");
  axisLbl.style.cssText = "font:700 11px ui-monospace,monospace;color:#fbbf24;min-width:28px";
  axisLbl.textContent = "—";
  sideLbl = document.createElement("span");
  sideLbl.style.cssText = "font:11px system-ui;color:#94a3b8";
  sideLbl.textContent = "";

  offsetInp = document.createElement("input");
  offsetInp.type = "number";
  offsetInp.step = "0.01";
  offsetInp.style.cssText =
    "width:88px;background:#0b0d12;color:#e6e8ee;border:1px solid #2a2e3a;border-radius:5px;" +
    "padding:4px 6px;font:12px ui-monospace,monospace";
  const applyOffset = () => {
    const v = parseFloat(offsetInp.value);
    if (Number.isFinite(v)) act((p) => setPlaneOffset(p, v));
  };
  offsetInp.onchange = applyOffset;
  offsetInp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      applyOffset();
      offsetInp.blur();
    }
  };

  stepInp = document.createElement("input");
  stepInp.type = "number";
  stepInp.step = "0.01";
  stepInp.value = "0.1";
  stepInp.title = "Nudge step (metres)";
  stepInp.style.cssText =
    "width:56px;background:#0b0d12;color:#e6e8ee;border:1px solid #2a2e3a;border-radius:5px;" +
    "padding:4px 6px;font:12px ui-monospace,monospace";

  offsetRow.append(
    axisLbl,
    lab("Offset m"),
    offsetInp,
    btn("−", "Move back by step", () => act((p) => nudgePlane(p, -step()))),
    btn("+", "Move forward by step", () => act((p) => nudgePlane(p, step()))),
    lab("Step"),
    stepInp,
  );
  body.appendChild(offsetRow);
  body.appendChild(sideLbl);

  // Axis + actions
  const axes = document.createElement("div");
  axes.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center";
  const snapAxis = (a: Axis) =>
    act((p, item) => {
      const h = item.helper ?? item.three;
      const o = h?.position
        ? { x: h.position.x, y: h.position.y, z: h.position.z }
        : { x: 0, y: 0, z: 0 };
      alignPlaneToAxis(p, a, o);
    });
  axes.append(
    lab("Axis"),
    btn("X", "Align cut to world X", () => snapAxis("x")),
    btn("Y", "Align cut to world Y", () => snapAxis("y")),
    btn("Z", "Align cut to world Z", () => snapAxis("z")),
    btn("⇄ Reverse", "Flip which side is kept (R)", () => act((p) => reversePlane(p)), "border-color:#ef4444"),
  );
  body.appendChild(axes);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
  actions.append(
    btn("👁 Plane", "Show / hide plane outline (cut stays)", () => {
      planeShown = !planeShown;
      try {
        setAutoHideSectionVisuals(!planeShown);
      } catch {
        /* */
      }
      refresh(true);
    }),
    btn("Delete", "Remove active plane", () => {
      try {
        const clipper: Any = (ctx as Any).clipper;
        const item = currentItem ?? items().at(-1);
        if (item && typeof clipper?.delete === "function") clipper.delete(item);
        else if (typeof clipper?.deleteAll === "function" && items().length <= 1) clipper.deleteAll();
        else deleteSectionPlanes();
      } catch (err) {
        console.warn("[section-panel] delete", err);
        try {
          deleteSectionPlanes();
        } catch {
          /* */
        }
      }
      currentItem = null;
      ensureClippingOn();
      refresh(true);
      syncVisibility();
    }, "border-color:#7f1d1d;color:#fca5a5"),
    btn("Delete all", "Remove every section plane", () => {
      try {
        deleteSectionPlanes();
      } catch {
        /* */
      }
      currentItem = null;
      refresh(true);
      syncVisibility();
    }, "border-color:#7f1d1d;color:#fca5a5"),
    btn("Exit section", "Turn off section mode (Esc)", () => {
      try {
        setSectionOn(false);
      } catch {
        /* */
      }
      hidePanel();
    }),
  );
  body.appendChild(actions);

  statusEl = document.createElement("div");
  statusEl.style.cssText = "font:11px system-ui;color:#64748b;line-height:1.4";
  statusEl.textContent = "Double-click a face to cut · drag the arrow · Esc cancels";
  body.appendChild(statusEl);

  root.appendChild(body);
  return root;
}

function renderPlaneList(): void {
  if (!listEl) return;
  listEl.innerHTML = "";
  const all = items();
  if (!all.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:#64748b;font-size:11.5px;padding:4px 0";
    empty.textContent = "No planes yet — enable Section and double-click a face, or use X/Y/Z.";
    listEl.appendChild(empty);
    return;
  }
  if (!currentItem || !all.includes(currentItem)) currentItem = all[all.length - 1];

  all.forEach((item, i) => {
    const plane = planeOf(item);
    const ax = plane ? dominantAxis(plane) : null;
    const off = plane ? planeOffset(plane) : 0;
    const row = document.createElement("button");
    row.type = "button";
    const active = item === currentItem;
    row.style.cssText =
      "text-align:left;padding:6px 8px;border-radius:6px;border:1px solid " +
      (active ? "#ef4444" : "#2a2e3a") +
      ";background:" +
      (active ? "rgba(239,68,68,.12)" : "#12141c") +
      ";color:#e2e8f0;cursor:pointer;font:12px system-ui";
    row.textContent = `Plane ${i + 1} · ${ax ? ax.toUpperCase() : "oblique"} · ${off.toFixed(3)} m`;
    row.onclick = () => {
      currentItem = item;
      refresh(true);
    };
    listEl.appendChild(row);
  });
}

function refresh(force = false): void {
  const all = items();
  if (!all.length) {
    if (axisLbl) axisLbl.textContent = "—";
    if (sideLbl) sideLbl.textContent = "";
    if (statusEl) statusEl.textContent = "No active plane — double-click a model face to cut.";
    renderPlaneList();
    return;
  }
  if (!currentItem || !all.includes(currentItem)) currentItem = all[all.length - 1];
  const plane = planeOf(currentItem);
  if (!plane) {
    renderPlaneList();
    return;
  }
  const ax = dominantAxis(plane);
  if (axisLbl) axisLbl.textContent = ax ? ax.toUpperCase() : "XYZ";
  if (sideLbl) {
    const n = plane.normal;
    sideLbl.textContent = `Normal (${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)}) · keeps n·p + c ≥ 0`;
  }
  if (offsetInp && (force || document.activeElement !== offsetInp)) {
    offsetInp.value = planeOffset(plane).toFixed(3);
  }
  if (statusEl) {
    statusEl.textContent = planeShown
      ? "Plane outline visible · drag the cut arrow in the view · Esc exits section"
      : "Plane outline hidden · cut still active · Esc exits section";
  }
  renderPlaneList();
}

function showPanel(): void {
  ensurePanel();
  if (!panel) return;
  try {
    dock?.show();
  } catch {
    panel.style.display = "flex";
  }
  panel.style.display = "flex";
  refresh(true);
  ensureClippingOn();
}

function hidePanel(): void {
  try {
    dock?.hide();
  } catch {
    /* */
  }
  if (panel) panel.style.display = "none";
}

function syncVisibility(): void {
  const hasPlanes = items().length > 0;
  const on = isSectionOn() || hasPlanes;
  if (on) showPanel();
  else hidePanel();
}

function ensurePanel(): void {
  if (panel) return;
  panel = buildPanel();
  const host = (ctx.rightHost as HTMLElement) || document.body;
  try {
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
  } catch {
    /* */
  }
  host.appendChild(panel);
  try {
    dock = makeDockable(panel, {
      id: "section-cut",
      host,
      header: headerEl ?? undefined,
      minWidth: 280,
      minHeight: 180,
      defaultWidth: 340,
      defaultHeight: 320,
      defaultDock: "float",
      margin: 12,
      windowControls: false,
      headerDragOnly: true,
    });
  } catch (err) {
    console.warn("[section-panel] dockable failed — floating only", err);
    // fallback absolute position
    panel.style.position = "absolute";
    panel.style.left = "16px";
    panel.style.bottom = "64px";
  }
}

export function isSectionPlanePanelOpen(): boolean {
  return !!(panel && panel.style.display !== "none" && document.body.contains(panel));
}

export function openSectionPlanePanel(): void {
  showPanel();
}

export function closeSectionPlanePanel(): void {
  hidePanel();
}

/** Cancel section interaction for escape-all: exit mode + hide panel. */
export function cancelSectionPanel(): boolean {
  let any = false;
  if (isSectionOn()) {
    try {
      setSectionOn(false);
      any = true;
    } catch {
      /* */
    }
  }
  if (isSectionPlanePanelOpen()) {
    hidePanel();
    any = true;
  }
  return any;
}

export function setupSectionPlanePanel(): void {
  if (installed) return;
  installed = true;

  ensurePanel();
  hidePanel();

  // Poll lightly — clipper list has no reliable change event across SDK versions
  pollTimer = window.setInterval(() => {
    if (!isSectionOn() && !items().length) {
      if (isSectionPlanePanelOpen()) hidePanel();
      return;
    }
    if (isSectionOn() || items().length) {
      if (!isSectionPlanePanelOpen()) showPanel();
      else refresh(false);
    }
  }, 600);

  try {
    onSectionModeChange((on) => {
      if (on) showPanel();
      else if (!items().length) hidePanel();
    });
  } catch {
    /* */
  }

  window.addEventListener("keydown", (e) => {
    if (e.key !== "r" && e.key !== "R") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!isSectionOn() && !items().length) return;
    if (!currentItem) return;
    e.preventDefault();
    act((p) => reversePlane(p));
  });

  (window as Any).__obsSectionPanel = {
    open: openSectionPlanePanel,
    close: closeSectionPlanePanel,
    cancel: cancelSectionPanel,
    reverse: () => act((p) => reversePlane(p)),
    setOffset: (v: number) => act((p) => setPlaneOffset(p, v)),
    nudge: (d: number) => act((p) => nudgePlane(p, d)),
    isOpen: isSectionPlanePanelOpen,
  };

  try {
    (ctx.features as Any).sectionPanel = (window as Any).__obsSectionPanel;
  } catch {
    /* */
  }

  console.log("[section-panel] dockable Section Cut panel ready");
}
