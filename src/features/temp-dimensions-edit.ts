/** RVT-style editable temporary dimensions.
 *  Click a dimension label -> type a value -> geometry updates.
 *  Lock button -> persistent dimensional constraint.
 *  Cycle button -> moves the dimension line through 4 witness sides.
 *
 *  Placement policy (critical):
 *  - Project the RAW a/b points (same coordinates as wall endpoint grips).
 *  - NDC -> pixels uses the RENDER CANVAS rect (the true projection surface),
 *    then maps canvas space -> overlay-host space via the two rects' origins,
 *    so labels land on the geometry no matter where the host is attached.
 *  - The overlay host is re-parented into the real viewport (#viewport /
 *    ctx.rightHost) as soon as it exists — this module is evaluated as a
 *    static dependency of authoring.ts, BEFORE core/setup.ts builds the
 *    viewer, so it initially parks on <body>. Without the re-parent every
 *    dimension was drawn offset by the left panel + ribbon (the
 *    "dimensions appear far away from the wall" bug).
 *  - Apply a fixed screen-space perpendicular push (16px) only.
 *  - Use the provider world offset solely to decide which side the push goes.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { setTempDimsEnabled } from "./temp-dimensions";

// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsTempDimsEdit: any;

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
const SCREEN_OFFSET_PX = 16;

const CAMERA = (): THREE.Camera | null =>
  ((ctx as Any).world?.camera?.three ?? (ctx as Any).world?.camera ?? null);

const getRenderer = (): THREE.WebGLRenderer | null =>
  ((ctx as Any).world?.renderer?.three ?? (ctx as Any).world?.renderer ?? null);

/** The real viewport container (#viewport / ctx.rightHost), once core/setup.ts has run. */
function viewportEl(): HTMLElement | null {
  return (
    ((ctx as Any).rightHost as HTMLElement | undefined) ??
    (document.getElementById("viewport") as HTMLElement | null)
  );
}

/**
 * Project a world point into pixel space RELATIVE TO THE OVERLAY HOST.
 *
 * Uses the render canvas rect (the true projection surface) for the
 * NDC->pixel conversion, then maps canvas space -> host space via the two
 * rects' origins. This stays correct even if the host is temporarily
 * attached elsewhere (e.g. <body> before the viewport is created).
 */
function project(v: THREE.Vector3): { x: number; y: number; visible: boolean } | null {
  const cam = CAMERA();
  if (!cam) return null;
  const canvas = getRenderer()?.domElement as HTMLCanvasElement | undefined;
  if (!canvas || !canvas.isConnected) return null;
  const hostEl = ensureHost();
  const cRect = canvas.getBoundingClientRect();
  if (cRect.width < 1 || cRect.height < 1) return null;
  const hRect = hostEl.getBoundingClientRect();
  const ndc = v.clone().project(cam);
  if (!isFinite(ndc.x) || !isFinite(ndc.y)) return null;
  if (ndc.z < -1 || ndc.z > 1) return { x: 0, y: 0, visible: false };
  return {
    x: (ndc.x * 0.5 + 0.5) * cRect.width + (cRect.left - hRect.left),
    y: (-ndc.y * 0.5 + 0.5) * cRect.height + (cRect.top - hRect.top),
    visible: true,
  };
}

function ensureHost(): HTMLDivElement {
  if (!host) {
    host = document.createElement("div");
    host.id = "obs-temp-dims-edit";
    host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:72;overflow:hidden;";
    // This module is evaluated as a static dependency of authoring.ts, which
    // runs BEFORE core/setup.ts builds the viewer, so the real viewport does
    // not exist yet. Park the host on <body> for now; the check below
    // re-parents it into the viewport as soon as it appears (render() calls
    // ensureHost() every frame, so the recovery is automatic).
    document.body.appendChild(host);
  }
  const parent = viewportEl();
  if (parent && host.parentElement !== parent) {
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.appendChild(host);
  }
  return host;
}

function fmt(v: number): string {
  return Math.abs(v) >= 1 ? `${v.toFixed(3)} m` : `${Math.round(v * 1000)} mm`;
}

/**
 * Parse a user-typed dimension value. Accepts the formatted unit that the
 * chip itself displays ("3.564 m", "200 mm") plus plain numbers (metres,
 * the internal unit) — matching RVT's behaviour of typing what you see.
 */
function parseDimInput(raw: string, kind: TempDimKind): number | null {
  const t = String(raw ?? "").trim().toLowerCase().replace(",", ".");
  if (!t) return null;
  if (kind === "angle") {
    const v = Number.parseFloat(t);
    return Number.isFinite(v) ? v : null;
  }
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m)?$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "mm") return n / 1000;
  if (m[2] === "cm") return n / 100;
  return n; // metres (internal unit)
}

/** Flash the edit input red (invalid/rejected value) without closing it. */
function flashInvalid(input: HTMLInputElement): void {
  input.style.borderColor = "#ef4444";
  input.focus();
  input.select();
  window.setTimeout(() => { input.style.borderColor = "#38bdf8"; }, 450);
}

function clearNode(n: Node): void { while (n.firstChild) n.removeChild(n.firstChild); }

function elementOf(id: string): Any | null {
  try { return (ctx.features as any).authoring?.getElementById?.(id) ?? null; } catch { return null; }
}

/** Re-anchor wall-like length/height/thickness dims onto the wall face at base
 *  elevation (same basis as the grips). Other specs are returned unchanged. */
function anchorToElement(s: TempDimSpec): TempDimSpec {
  if (s.param !== "length" && s.param !== "height" && s.param !== "thickness") return s;
  try {
    const p = elementOf(s.elementId)?.params;
    if (!p || !Array.isArray(p.start) || !Array.isArray(p.end)) return s;

    const elev = Number(p.elevation ?? 0);
    const endElev = Number(p.endElevation ?? elev);
    const t = Number(p.thickness ?? 0);
    const h = Number(p.height ?? 0);
    const A = new THREE.Vector3(p.start[0], elev, p.start[1]);
    const B = new THREE.Vector3(p.end[0], endElev, p.end[1]);
    const dir = B.clone().sub(A).setY(0);
    if (dir.lengthSq() < 1e-12) return s;
    dir.normalize();
    const n = new THREE.Vector3(-dir.z, 0, dir.x);

    // Which wall face: taken from the provider's side choice (cycle button)
    let sgn = 1;
    const o = s.offset;
    if (o && o.lengthSq() > 1e-8) {
      const horiz = Math.hypot(o.x, o.z);
      sgn = horiz > Math.abs(o.y) ? (o.dot(n) >= 0 ? 1 : -1) : (o.y >= 0 ? 1 : -1);
    }
    const side = n.clone().multiplyScalar(sgn);
    const face = side.clone().multiplyScalar(t / 2);
    const sideOff = side.clone().multiplyScalar(0.35);

    if (s.param === "length") {
      return { ...s, a: A.clone().add(face), b: B.clone().add(face), offset: sideOff };
    }
    if (s.param === "height") {
      const base = B.clone().add(face);
      return { ...s, a: base, b: base.clone().setY(base.y + h), offset: sideOff };
    }
    return {
      ...s,
      a: B.clone().addScaledVector(n, -t / 2),
      b: B.clone().addScaledVector(n, t / 2),
      offset: dir.clone().multiplyScalar(0.35),
    };
  } catch {
    return s;
  }
}
/**
 * Project RAW a/b (no world offset), then push 28px in screen space.
 * World offset only chooses the side (for the cycle button).
 */
function projectWithScreenOffset(
  a: THREE.Vector3,
  b: THREE.Vector3,
  worldOffset?: THREE.Vector3,
): { pa: { x: number; y: number }; pb: { x: number; y: number } } | null {
  // CRITICAL: project the raw geometry points — same basis as wall grips.
  // Do not add worldOffset here; that was the source of the "far from wall" bug.
  const pa0 = project(a);
  const pb0 = project(b);
  if (!pa0 || !pb0 || !pa0.visible || !pb0.visible) return null;

  const dx = pb0.x - pa0.x;
  const dy = pb0.y - pa0.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;

  // Use world offset only to pick side (cycle button).
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
  // While an edit is open the overlay is frozen: render() runs on every
  // animation frame and would otherwise destroy the input 16 ms after it
  // appears (the "dimensions can't be edited" bug).
  if (editing) return;
  const h = ensureHost();
  clearNode(h);
  if (!provider) return;
  let specs: TempDimSpec[] = [];
  try { specs = provider.specs() ?? []; } catch { specs = []; }
  if (!specs.length) return;

  for (const spec of specs) {
    const s = anchorToElement(spec);
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
      `color:${s.locked ? "#fbbf24" : "#e0f2fe"};font:600 11px/1.2 var(--font-mono,monospace);` +
      `text-shadow:0 0 3px #0f1117,0 0 3px #0f1117,0 0 2px #0f1117;padding:0;` +
      `white-space:nowrap;pointer-events:auto;cursor:${s.editable ? "text" : "default"};`;
    if (s.editable) label.onpointerdown = (ev) => { ev.preventDefault(); ev.stopPropagation(); beginEdit(s, mx, my); }; // pointerdown: overlay is rebuilt every frame, press/release would hit different nodes
    h.appendChild(label);

    if (provider.cycleRef) {
      const cyc = document.createElement("button");
      cyc.textContent = "⇄";
      cyc.title = "Flip dimension to the other side of the wall";
      cyc.style.cssText =
        `position:absolute;left:${mx - 40}px;top:${my - 12}px;transform:translate(-50%,-50%);` +
        `background:transparent;border:0;color:#38bdf8;text-shadow:0 0 3px #0f1117;` +
        `font:11px/1 sans-serif;padding:0;pointer-events:auto;cursor:pointer;`;
      cyc.onpointerdown = (ev) => { ev.preventDefault(); ev.stopPropagation(); provider?.cycleRef?.(s); render(); };
      h.appendChild(cyc);
    }
  }
}

function beginEdit(s: TempDimSpec, x: number, y: number): void {
  cancelEdit();
  const input = document.createElement("input");
  input.type = "text";
  // Prefill with what the chip displays ("3.564 m" / "200 mm"), so the user
  // edits the value they see — not the raw internal metres.
  input.value = s.kind === "angle" ? s.value.toFixed(2) : fmt(s.value);
  input.style.cssText =
    `position:absolute;left:${x}px;top:${y - 12}px;transform:translate(-50%,-50%);width:110px;` +
    `background:#0c0e13;border:1px solid #38bdf8;border-radius:4px;color:#f8fafc;` +
    `font:600 11px/1.2 var(--font-mono,monospace);padding:3px 6px;pointer-events:auto;z-index:80;`;
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const v = parseDimInput(input.value, s.kind);
      if (v === null || !Number.isFinite(v)) { flashInvalid(input); return; }
      const ok = provider?.commit(s, v);
      if (ok === false) { flashInvalid(input); return; }
      cancelEdit();
      render();
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
  if (!editing) return;
  const { input } = editing;
  // Clear state FIRST: removing a focused input fires blur synchronously,
  // which re-enters cancelEdit — the second remove() then throws
  // "The node to be removed is no longer a child of this node".
  editing = null;
  input.onblur = null;
  try { input.remove(); } catch { /* already detached */ }
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
  obsTempDimsEdit = features.tempDimsEdit;
}

export function destroyEditableTempDims(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0; provider = null; cancelEdit();
  host?.remove(); host = null;
}
