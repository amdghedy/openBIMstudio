/** Revit-style editable temporary dimensions.
 *  Click a dimension label -> type a value -> geometry updates.
 *  Lock button -> persistent dimensional constraint.
 *  Cycle button -> moves the dimension line through 4 witness sides.
 *
 *  Placement: world points are projected with the SAME host rect used by
 *  wall-handles, then a fixed screen-space offset is applied so the string
 *  always sits tightly beside the selected element.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { setTempDimsEnabled } from "./temp-dimensions";

type Any = Record<string, any>;

export type TempDimKind =
  | "length" | "height" | "thickness" | "offset" | "width" | "angle" | "elevation";

export interface TempDimSpec {
  id: string;
  elementId: string;
  param: string;
  kind: TempDimKind;
  a: THREE.Vector3;
  b: THREE.Vector3;
  value: number;
  label: string;
  editable: boolean;
  locked?: boolean;
  offset?: THREE.Vector3;
}

export interface TempDimProvider {
  specs(): TempDimSpec[];
  commit(spec: TempDimSpec, value: number): boolean;
  toggleLock?(spec: TempDimSpec): boolean;
  cycleRef?(spec: TempDimSpec): boolean;
}

let provider: TempDimProvider | null = null;
let host: HTMLDivElement | null = null;
let raf = 0;
let editing: { spec: TempDimSpec; input: HTMLInputElement } | null = null;

/** Screen-space distance (px) the dimension line is pushed away from the element. */
const SCREEN_OFFSET_PX = 28;

const CAMERA = (): THREE.Camera | null =>
  ((ctx as Any).world?.camera?.three ?? (ctx as Any).world?.camera ?? null);

/**
 * Project a world point into the same pixel space used by wall-handles.
 * MUST use ctx.rightHost.getBoundingClientRect() — never renderer.domElement
 * size alone — otherwise dimensions drift far from the selected geometry.
 */
function project(v: THREE.Vector3): { x: number; y: number; visible: boolean } | null {
  const cam = CAMERA();
  if (!cam) return null;
  const hostEl =
    ((ctx as Any).rightHost as HTMLElement | undefined) ??
    document.getElementById("viewport") ??
    null;
  if (!hostEl) return null;
  const rect = hostEl.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const ndc = v.clone().project(cam);
  if (!isFinite(ndc.x) || !isFinite(ndc.y)) return null;
  if (ndc.z < -1 || ndc.z > 1) return { x: 0, y: 0, visible: false };
  return {
    x: (ndc.x * 0.5 + 0.5) * rect.width,
    y: (-ndc.y * 0.5 + 0.5) * rect.height,
    visible: true,
  };
}

function ensureHost(): HTMLDivElement {
  if (host) return host;
  host = document.createElement("div");
  host.id = "obs-temp-dims-edit";
  host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:72;overflow:hidden;";
  const parent = ((ctx as Any).rightHost ?? document.getElementById("viewport") ?? document.body) as HTMLElement;
  if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
  parent.appendChild(host);
  return host;
}

function fmt(v: number): string {
  return Math.abs(v) >= 1 ? `${v.toFixed(3)} m` : `${Math.round(v * 1000)} mm`;
}

function clearNode(n: Node): void { while (n.firstChild) n.removeChild(n.firstChild); }

/**
 * Project the two world endpoints, then push them a fixed pixel distance
 * along the screen-space perpendicular so the dimension always sits
 * immediately beside the selected geometry.
 */
function projectWithScreenOffset(
  a: THREE.Vector3,
  b: THREE.Vector3,
  worldOffset?: THREE.Vector3,
): { pa: { x: number; y: number }; pb: { x: number; y: number } } | null {
  // Prefer the side indicated by the provider's world offset when present.
  const baseA = worldOffset ? a.clone().add(worldOffset) : a.clone();
  const baseB = worldOffset ? b.clone().add(worldOffset) : b.clone();

  const pa0 = project(baseA);
  const pb0 = project(baseB);
  if (!pa0 || !pb0 || !pa0.visible || !pb0.visible) return null;

  const dx = pb0.x - pa0.x;
  const dy = pb0.y - pa0.y;
  const len = Math.hypot(dx, dy) || 1;
  // Screen-space unit perpendicular (rotate 90°)
  let nx = -dy / len;
  let ny = dx / len;

  // If a world offset was supplied, flip the screen push so it agrees with
  // the direction the provider intended (keeps cycle button behaviour).
  if (worldOffset && worldOffset.lengthSq() > 1e-8) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const midOff = mid.clone().add(worldOffset);
    const pMid = project(mid);
    const pMidOff = project(midOff);
    if (pMid && pMidOff && pMid.visible && pMidOff.visible) {
      const ox = pMidOff.x - pMid.x;
      const oy = pMidOff.y - pMid.y;
      if (ox * nx + oy * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
    }
  }

  const ox = nx * SCREEN_OFFSET_PX;
  const oy = ny * SCREEN_OFFSET_PX;

  return {
    pa: { x: pa0.x + ox, y: pa0.y + oy },
    pb: { x: pb0.x + ox, y: pb0.y + oy },
  };
}

function render(): void {
  const h = ensureHost();
  clearNode(h);
  if (!provider) return;
  let specs: TempDimSpec[] = [];
  try { specs = provider.specs() ?? []; } catch { specs = []; }
  if (!specs.length) return;

  for (const s of specs) {
    const placed = projectWithScreenOffset(s.a, s.b, s.offset);
    if (!placed) continue;
    const { pa, pb } = placed;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("style", "position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;");
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, tick = 5;
    svg.innerHTML =
      `<line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}" stroke="#38bdf8" stroke-width="1" opacity="0.9"/>` +
      `<line x1="${pa.x - nx * tick}" y1="${pa.y - ny * tick}" x2="${pa.x + nx * tick}" y2="${pa.y + ny * tick}" stroke="#38bdf8" stroke-width="1.2"/>` +
      `<line x1="${pb.x - nx * tick}" y1="${pb.y - ny * tick}" x2="${pb.x + nx * tick}" y2="${pb.y + ny * tick}" stroke="#38bdf8" stroke-width="1.2"/>`;
    h.appendChild(svg);

    const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
    const label = document.createElement("div");
    label.textContent = s.label;
    label.style.cssText =
      `position:absolute;left:${mx}px;top:${my - 12}px;transform:translate(-50%,-50%);` +
      `background:rgba(15,17,23,.94);border:1px solid ${s.locked ? "#fbbf24" : "rgba(56,189,248,.6)"};` +
      `color:#e0f2fe;font:600 10px/1.2 var(--font-mono,monospace);padding:2px 6px;border-radius:4px;` +
      `white-space:nowrap;pointer-events:auto;cursor:${s.editable ? "text" : "default"};`;
    if (s.editable) label.onclick = (ev) => { ev.stopPropagation(); beginEdit(s, mx, my); };
    h.appendChild(label);

    if (s.editable) {
      const lock = document.createElement("button");
      lock.textContent = s.locked ? "🔒" : "🔓";
      lock.title = s.locked ? "Unlock dimension" : "Lock dimension (create constraint)";
      lock.style.cssText =
        `position:absolute;left:${mx + 34}px;top:${my - 12}px;transform:translate(-50%,-50%);` +
        `background:rgba(15,17,23,.94);border:1px solid rgba(56,189,248,.5);color:#fbbf24;` +
        `font:10px/1 sans-serif;border-radius:4px;padding:2px 4px;pointer-events:auto;cursor:pointer;`;
      lock.onclick = (ev) => { ev.stopPropagation(); provider?.toggleLock?.(s); render(); };
      h.appendChild(lock);
    }

    if (provider.cycleRef) {
      const cyc = document.createElement("button");
      cyc.textContent = "⇄";
      cyc.title = "Cycle dimension witness line";
      cyc.style.cssText =
        `position:absolute;left:${mx - 40}px;top:${my - 12}px;transform:translate(-50%,-50%);` +
        `background:rgba(15,17,23,.94);border:1px solid rgba(56,189,248,.5);color:#38bdf8;` +
        `font:10px/1 sans-serif;border-radius:4px;padding:2px 4px;pointer-events:auto;cursor:pointer;`;
      cyc.onclick = (ev) => { ev.stopPropagation(); provider?.cycleRef?.(s); render(); };
      h.appendChild(cyc);
    }
  }
}

function beginEdit(s: TempDimSpec, x: number, y: number): void {
  cancelEdit();
  const input = document.createElement("input");
  input.type = "text";
  input.value = s.kind === "angle" ? s.value.toFixed(2) : s.value.toFixed(3);
  input.style.cssText =
    `position:absolute;left:${x}px;top:${y - 12}px;transform:translate(-50%,-50%);width:96px;` +
    `background:#0c0e13;border:1px solid #38bdf8;border-radius:4px;color:#f8fafc;` +
    `font:600 11px/1.2 var(--font-mono,monospace);padding:3px 6px;pointer-events:auto;z-index:80;`;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const v = parseFloat(input.value.replace(",", "."));
      if (Number.isFinite(v) && v > 0) provider?.commit(s, v);
      cancelEdit(); render();
    } else if (ev.key === "Escape") {
      ev.preventDefault(); cancelEdit();
    }
  };
  input.onblur = () => cancelEdit();
  ensureHost().appendChild(input);
  input.focus(); input.select();
  editing = { spec: s, input };
}

function cancelEdit(): void {
  if (editing) { editing.input.remove(); editing = null; }
}

export function registerTempDimProvider(p: TempDimProvider): () => void {
  provider = p;
  return () => { if (provider === p) provider = null; };
}

export function refreshTempDims(): void { render(); }

function tick(): void { render(); raf = requestAnimationFrame(tick); }

export function setupEditableTempDims(): void {
  if (raf) return;
  try { setTempDimsEnabled(false); } catch { /* old module optional */ }
  ensureHost();
  raf = requestAnimationFrame(tick);
  const features = ((ctx as Any).features ??= {});
  features.tempDimsEdit = { refresh: refreshTempDims };
  (window as Any).__obsTempDimsEdit = features.tempDimsEdit;
}

export function destroyEditableTempDims(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0; provider = null; cancelEdit();
  host?.remove(); host = null;
}
