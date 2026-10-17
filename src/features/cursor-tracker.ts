/**
 * Cursor coordinate readout.
 *
 * Raycasts the pointer against loaded models + the ground plane; posts the
 * world X / Y / Z to the status bar. Throttled to one raycast per animation
 * frame so it never fights the render loop.
 */
import * as THREE from "three";
import { ctx } from "../core/context";

let coordsEl: HTMLElement | null = null;
let rafPending = false;
let lastClientX = 0;
let lastClientY = 0;
let hasPosition = false;

const ndc = new THREE.Vector2();
const ray = new THREE.Raycaster();

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(1);
  if (abs >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

function getTargets(): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  try {
    for (const [, model] of ctx.fragments.list) {
      if (model?.object) out.push(model.object);
    }
  } catch { /* */ }
  if (ctx.groundPlane) out.push(ctx.groundPlane);
  return out;
}

function doRaycast(): void {
  rafPending = false;
  if (!coordsEl) return;
  const host = ctx.rightHost;
  if (!host) return;

  const rect = host.getBoundingClientRect();
  const x = lastClientX - rect.left;
  const y = lastClientY - rect.top;

  if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
    coordsEl.textContent = "X —   Y —   Z —";
    hasPosition = false;
    return;
  }

  ndc.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, ctx.world.camera.three);

  const targets = getTargets();
  if (!targets.length) {
    coordsEl.textContent = "X —   Y —   Z —";
    hasPosition = false;
    return;
  }

  let hitPoint: THREE.Vector3 | null = null;
  try {
    const hits = ray.intersectObjects(targets, true);
    if (hits.length) hitPoint = hits[0].point.clone();
  } catch { /* */ }

  if (!hitPoint) {
    coordsEl.textContent = "X —   Y —   Z —";
    hasPosition = false;
    return;
  }

  hasPosition = true;
  // BIM axes: X/Y horizontal, Z vertical (elevation). Engine is Y-up Three.js.
  coordsEl.textContent =
    `X ${fmt(hitPoint.x)}   Y ${fmt(hitPoint.z)}   Z ${fmt(hitPoint.y)}`;
}

function onPointerMove(e: PointerEvent): void {
  lastClientX = e.clientX;
  lastClientY = e.clientY;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(doRaycast);
}

function onPointerLeave(): void {
  if (coordsEl) coordsEl.textContent = "X —   Y —   Z —";
  hasPosition = false;
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupCursorTracker(): void {
  // Reuse the status bar's coords slot if present; otherwise create one.
  coordsEl = document.querySelector("[data-obs-coords]") as HTMLElement | null;
  if (!coordsEl) {
    // Create a floating readout in the bottom-right of the viewport as a
    // fallback so the feature still works even without a status-bar slot.
    coordsEl = document.createElement("div");
    coordsEl.dataset.obsCoords = "1";
    coordsEl.style.cssText =
      "position:absolute;right:14px;bottom:14px;z-index:55;" +
      "background:rgba(20,22,30,.85);color:var(--text-primary,#e8eaf0);" +
      "border:1px solid var(--border-default,#2a2e3a);border-radius:6px;" +
      "padding:5px 10px;font:11px/1 var(--font-mono,monospace);" +
      "letter-spacing:.2px;pointer-events:none;backdrop-filter:blur(4px)";
    coordsEl.textContent = "X —   Y —   Z —";
    ctx.rightHost.appendChild(coordsEl);
  }

  ctx.rightHost.addEventListener("pointermove", onPointerMove);
  ctx.rightHost.addEventListener("pointerleave", onPointerLeave);

  ctx.features.cursorTracker = {
    isActive: () => hasPosition,
  };
}