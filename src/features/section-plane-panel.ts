/**
 * Section Plane panel - appears while an interactive section plane exists.
 *   Offset   : type the exact cut position (m along the plane normal, from the origin)
 *   - / +    : nudge by the step
 *   Reverse  : flip which side is cut away
 *   X Y Z    : snap the plane to a world axis
 *   Delete   : remove the plane
 * Works on the most recent plane in the clipper list.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { alignPlaneToAxis, dominantAxis, nudgePlane, planeOffset, reversePlane, setPlaneOffset, type Axis } from "./section-plane-math";

type Any = any;
let panel: HTMLDivElement | null = null;
let offsetInp: HTMLInputElement;
let stepInp: HTMLInputElement;
let axisLbl: HTMLSpanElement;
let sideLbl: HTMLSpanElement;
let currentItem: Any = null;

function items(): Any[] {
  try {
    const list = (ctx as Any).clipper?.list;
    if (!list) return [];
    const entries: Any[] = list[Symbol.iterator] ? [...list] : Object.values(list);
    return entries.map((e) => (Array.isArray(e) ? e[1] : e)).filter(Boolean);
  } catch { return []; }
}
function planeOf(item: Any): THREE.Plane | null {
  const p = item?.three?.plane ?? item?.plane ?? (item?.three?.isPlane ? item.three : null);
  return p?.normal && typeof p.constant === "number" ? (p as THREE.Plane) : null;
}

/** Push a modified plane back into the clipper item and its on-screen helper. */
function commit(item: Any, plane: THREE.Plane): void {
  const n = plane.normal.clone().normalize();
  const origin = n.clone().multiplyScalar(-plane.constant / (plane.normal.length() || 1));
  try { if (item.normal?.copy) item.normal.copy(n); else if ("normal" in item) item.normal = n; } catch { /* */ }
  try { if (item.origin?.copy) item.origin.copy(origin); else if ("origin" in item) item.origin = origin; } catch { /* */ }
  try {
    const h = item.helper ?? item.three;
    if (h?.position && h !== (item as Any).plane) {
      // keep the handle on the plane, preserving its position inside the plane
      const along = h.position.dot(n);
      h.position.addScaledVector(n, -(along) + origin.dot(n));
    }
  } catch { /* */ }
  try { item.update?.(); } catch { /* */ }
  try { (ctx.world.renderer as Any)?.three && ((ctx.world.renderer as Any).three.localClippingEnabled = true); } catch { /* */ }
  try { (ctx.fragments as Any).core?.update?.(true); } catch { /* */ }
  refresh(true);
}

function step(): number {
  const v = parseFloat(stepInp.value);
  return Number.isFinite(v) && v > 0 ? v : 0.1;
}

function act(fn: (p: THREE.Plane, item: Any) => void): void {
  const item = currentItem;
  const plane = item ? planeOf(item) : null;
  if (!item || !plane) return;
  fn(plane, item);
  commit(item, plane);
}

function build(): void {
  if (panel) return;
  panel = document.createElement("div");
  panel.id = "obs-section-plane-panel";
  panel.style.cssText =
    "position:fixed;left:50%;bottom:78px;transform:translateX(-50%);z-index:9000;display:none;" +
    "background:rgba(20,22,30,.94);border:1px solid rgba(239,68,68,.55);border-radius:8px;padding:8px 10px;" +
    "color:#e8eaf0;font:12px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);" +
    "align-items:center;gap:8px;flex-wrap:wrap;max-width:92vw";
  const btn = (txt: string, title: string, fn: () => void, css = "") => {
    const b = document.createElement("button");
    b.textContent = txt; b.title = title;
    b.style.cssText = "padding:4px 9px;background:#2a2e3a;color:#e8eaf0;border:1px solid #3d4250;border-radius:4px;cursor:pointer;font:12px system-ui;" + css;
    b.onclick = fn;
    return b;
  };
  const lab = (t: string) => { const s = document.createElement("span"); s.textContent = t; s.style.color = "#8b949e"; return s; };

  const title = document.createElement("b"); title.textContent = "SECTION"; title.style.color = "#ef4444";
  axisLbl = document.createElement("span"); axisLbl.style.cssText = "color:#38bdf8;min-width:34px";
  sideLbl = document.createElement("span"); sideLbl.style.cssText = "color:#8b949e;font-size:11px";

  offsetInp = document.createElement("input");
  offsetInp.type = "number"; offsetInp.step = "0.01";
  offsetInp.style.cssText = "width:84px;background:#0b0d12;color:#e6e8ee;border:1px solid #2a2e3a;border-radius:4px;padding:3px 5px;font:12px ui-monospace,monospace";
  const apply = () => { const v = parseFloat(offsetInp.value); if (Number.isFinite(v)) act((p) => setPlaneOffset(p, v)); };
  offsetInp.onchange = apply;
  offsetInp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") { apply(); offsetInp.blur(); } };

  stepInp = document.createElement("input");
  stepInp.type = "number"; stepInp.value = "0.1"; stepInp.step = "0.05"; stepInp.min = "0.001";
  stepInp.style.cssText = "width:56px;background:#0b0d12;color:#e6e8ee;border:1px solid #2a2e3a;border-radius:4px;padding:3px 5px;font:12px ui-monospace,monospace";
  stepInp.onkeydown = (e) => e.stopPropagation();

  const axes = (["x", "y", "z"] as Axis[]).map((a) =>
    btn(a.toUpperCase(), `Align the cut to the ${a.toUpperCase()} axis`, () => act((p) => {
      const o = p.normal.clone().normalize().multiplyScalar(planeOffset(p));
      alignPlaneToAxis(p, a, o);
    })));

  panel.append(
    title, axisLbl, lab("Offset (m)"), offsetInp,
    btn("−", "Move back by the step", () => act((p) => nudgePlane(p, -step()))),
    btn("+", "Move forward by the step", () => act((p) => nudgePlane(p, step()))),
    lab("step"), stepInp,
    btn("⇄ Reverse", "Flip the cut direction (R)", () => act((p) => reversePlane(p)), "border-color:#ef4444"),
    ...axes, sideLbl,
    btn("Delete", "Remove this section plane", () => {
      const item = currentItem; if (!item) return;
      try { (ctx as Any).clipper.delete?.(ctx.world, item); } catch { try { item.dispose?.(); } catch { /* */ } }
      refresh(true);
    }, "background:#3b0d0d;color:#fca5a5;border-color:#7f1d1d"),
  );
  document.body.appendChild(panel);
}

let lastKey = "";
function refresh(force = false): void {
  if (!panel) return;
  const list = items();
  const item = list.length ? list[list.length - 1] : null;
  currentItem = item;
  const plane = item ? planeOf(item) : null;
  if (!item || !plane) { panel.style.display = "none"; lastKey = ""; return; }
  panel.style.display = "flex";
  const key = `${plane.normal.x.toFixed(4)},${plane.normal.y.toFixed(4)},${plane.normal.z.toFixed(4)},${plane.constant.toFixed(4)}`;
  if (!force && key === lastKey) return;
  lastKey = key;
  if (document.activeElement !== offsetInp) offsetInp.value = planeOffset(plane).toFixed(3);
  const ax = dominantAxis(plane);
  axisLbl.textContent = ax ? ax.toUpperCase() : "Oblique";
  const n = plane.normal;
  sideLbl.textContent = `keeps ${ax ? (n[ax] > 0 ? "+" : "−") + ax.toUpperCase() : "front"} side`;
}

export function setupSectionPlanePanel(): void {
  if ((window as Any).__obsSectionPanel) return;
  build();
  window.setInterval(() => refresh(false), 250);
  window.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "r" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!currentItem) return;
    act((p) => reversePlane(p));
  });
  (window as Any).__obsSectionPanel = {
    reverse: () => act((p) => reversePlane(p)),
    setOffset: (v: number) => act((p) => setPlaneOffset(p, v)),
    nudge: (d: number) => act((p) => nudgePlane(p, d)),
  };
}
