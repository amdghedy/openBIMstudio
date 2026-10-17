/**
 * Temporary Dimensions - BIM-style live dimensions during edit/place.
 *
 * Shows pixel-space dimension strings between the active element's key
 * points and nearby references (walls, levels, ref planes) while a tool
 * is active or a single element is selected.
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { units } from "../core/units";

type Any = Record<string, any>;

interface TempDim {
  id: string;
  a: THREE.Vector3;
  b: THREE.Vector3;
  label: string;
}

let host: HTMLDivElement | null = null;
let dims: TempDim[] = [];
let raf = 0;
let enabled = true;

function getCamera(): THREE.Camera | null {
  return (
    (ctx as Any).world?.camera?.three ??
    (ctx as Any).world?.camera ??
    null
  );
}

function getRenderer(): THREE.WebGLRenderer | null {
  return (
    (ctx as Any).world?.renderer?.three ??
    (ctx as Any).world?.renderer ??
    null
  );
}

function formatLength(metres: number): string {
  try {
    const u = units as any;
    if (u && typeof u.format === "function") return String(u.format("length", metres));
    if (u && typeof u.formatLength === "function") return String(u.formatLength(metres));
  } catch { /* */ }
  if (Math.abs(metres) >= 1) return metres.toFixed(2) + " m";
  return (metres * 1000).toFixed(0) + " mm";
}

function project(v: THREE.Vector3): { x: number; y: number; visible: boolean } | null {
  const cam = getCamera();
  const renderer = getRenderer();
  if (!cam || !renderer) return null;
  const canvas = renderer.domElement;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const ndc = v.clone().project(cam);
  if (ndc.z > 1 || ndc.z < -1) return { x: 0, y: 0, visible: false };
  return {
    x: (ndc.x * 0.5 + 0.5) * w,
    y: (-ndc.y * 0.5 + 0.5) * h,
    visible: true,
  };
}

function ensureHost(): HTMLDivElement {
  if (host) return host;
  host = document.createElement("div");
  host.id = "obs-temp-dims";
  host.style.cssText =
    "position:absolute;inset:0;pointer-events:none;z-index:70;overflow:hidden;";
  const viewport =
    (ctx as Any).rightHost ??
    document.getElementById("viewport") ??
    document.querySelector(".obs-viewport") ??
    document.body;
  if (getComputedStyle(viewport).position === "static") {
    (viewport as HTMLElement).style.position = "relative";
  }
  viewport.appendChild(host);
  return host;
}

function render(): void {
  const h = ensureHost();
  h.innerHTML = "";
  if (!enabled || !dims.length) return;

  for (const d of dims) {
    const pa = project(d.a);
    const pb = project(d.b);
    if (!pa || !pb || !pa.visible || !pb.visible) continue;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute(
      "style",
      "position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;",
    );
    svg.innerHTML = `
      <line x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}"
        stroke="#38bdf8" stroke-width="1.25" stroke-dasharray="4 3" opacity="0.9"/>
      <circle cx="${pa.x}" cy="${pa.y}" r="3" fill="#38bdf8"/>
      <circle cx="${pb.x}" cy="${pb.y}" r="3" fill="#38bdf8"/>
    `;
    h.appendChild(svg);

    const mx = (pa.x + pb.x) / 2;
    const my = (pa.y + pb.y) / 2;
    const label = document.createElement("div");
    label.style.cssText =
      "position:absolute;transform:translate(-50%,-50%);" +
      "background:rgba(15,17,23,.92);border:1px solid rgba(56,189,248,.45);" +
      "color:#e0f2fe;font:600 10px/1.2 var(--font-mono,monospace);" +
      "padding:2px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;";
    label.style.left = `${mx}px`;
    label.style.top = `${my - 12}px`;
    label.textContent = d.label;
    h.appendChild(label);
  }
}

function tick(): void {
  render();
  raf = requestAnimationFrame(tick);
}

/** Set temporary dimensions from world-space point pairs. */
export function setTempDimensions(
  pairs: Array<{ a: THREE.Vector3; b: THREE.Vector3; label?: string }>,
): void {
  dims = pairs.map((p, i) => {
    const len = p.a.distanceTo(p.b);
    return {
      id: `td-${i}`,
      a: p.a.clone(),
      b: p.b.clone(),
      label: p.label ?? formatLength(len),
    };
  });
}

/** Convenience: dimension a single segment. */
export function setTempSegment(
  a: THREE.Vector3,
  b: THREE.Vector3,
  label?: string,
): void {
  setTempDimensions([{ a, b, label }]);
}

/** Clear all temporary dimensions. */
export function clearTempDimensions(): void {
  dims = [];
  if (host) host.innerHTML = "";
}

/**
 * Auto-generate dims for an authored element against its host / nearby walls.
 */
export function autoDimsForElement(el: Any): void {
  const p = el?.params;
  if (!p) {
    clearTempDimensions();
    return;
  }
  const pairs: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
  const elev = Number(p.elevation ?? 0);

  if (p.start && p.end) {
    const a = new THREE.Vector3(p.start.x, elev, p.start.z ?? p.start.y ?? 0);
    const b = new THREE.Vector3(p.end.x, elev, p.end.z ?? p.end.y ?? 0);
    pairs.push({ a, b });
    // Height
    pairs.push({
      a: b.clone(),
      b: b.clone().setY(elev + Number(p.height ?? 0)),
    });
  } else if (p.point) {
    const c = new THREE.Vector3(p.point.x, elev, p.point.z ?? p.point.y ?? 0);
    const w = Number(p.width ?? 0.3) / 2;
    pairs.push({
      a: c.clone().add(new THREE.Vector3(-w, 0, 0)),
      b: c.clone().add(new THREE.Vector3(w, 0, 0)),
    });
    pairs.push({
      a: c.clone(),
      b: c.clone().setY(elev + Number(p.height ?? 0)),
    });
  }

  // Hosted offset
  if (typeof p.offsetAlongHost === "number" && p.start) {
    const a = new THREE.Vector3(p.start.x, elev, p.start.z ?? 0);
    const b = a.clone().add(new THREE.Vector3(p.offsetAlongHost, 0, 0));
    pairs.push({ a, b });
  }

  setTempDimensions(pairs);
}

export function setTempDimsEnabled(on: boolean): void {
  enabled = on;
  if (!on) clearTempDimensions();
}

export function setupTempDimensions(): void {
  ensureHost();
  if (!raf) raf = requestAnimationFrame(tick);

  (ctx.features as any).tempDimensions = {
    set: setTempDimensions,
    setSegment: setTempSegment,
    clear: clearTempDimensions,
    autoForElement: autoDimsForElement,
    setEnabled: setTempDimsEnabled,
  };
  (window as any).__obsTempDims = (ctx.features as any).tempDimensions;
  console.log("[temp-dimensions] ready");
}
