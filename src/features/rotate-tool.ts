/** Revit-style Rotate controller. Pivot -> reference ray -> cursor angle. */
import * as THREE from "three";
import { ctx } from "../core/context";
import { rotateSelected } from "./authoring";

type Any = Record<string, any>;
type Phase = "idle" | "awaiting-pivot" | "awaiting-reference" | "previewing";

let phase: Phase = "idle";
let pivotWorld: THREE.Vector3 | null = null;
let refWorld: THREE.Vector3 | null = null;
let curWorld: THREE.Vector3 | null = null;
let ghostGroup: THREE.Group | null = null;
let hud: HTMLDivElement | null = null;
let angleLabel: HTMLElement | null = null;
let pointerId = -1;
let cancelled = false;

const CANVAS = (): HTMLCanvasElement | null => {
  const r = (ctx as Any).world?.renderer?.three ?? (ctx as Any).world?.renderer;
  return (r?.domElement as HTMLCanvasElement) ?? null;
};
const SCENE = (): THREE.Scene | null => (ctx as Any).world?.scene?.three ?? (ctx as Any).world?.scene ?? null;
const CAMERA = (): THREE.Camera | null => (ctx as Any).world?.camera?.three ?? (ctx as Any).world?.camera ?? null;

function getSelectedIds(): string[] {
  const a = (ctx as Any).features?.authoring;
  if (a?.getSelectedIds) { try { return a.getSelectedIds().map(String); } catch { return []; } }
  return [];
}

function selectionBox(): THREE.Box3 | null {
  const scene = SCENE();
  if (!scene) return null;
  const ids = new Set(getSelectedIds());
  if (!ids.size) return null;
  const box = new THREE.Box3();
  let any = false;
  scene.traverse((o) => {
    const eid = (o.userData as Any)?.elementId;
    if (!eid || !ids.has(String(eid))) return;
    const b = new THREE.Box3().setFromObject(o);
    if (Number.isFinite(b.min.x)) { box.union(b); any = true; }
  });
  return any ? box : null;
}

function screenToWorld(ev: PointerEvent): THREE.Vector3 | null {
  const cam = CAMERA(), canvas = CANVAS();
  if (!cam || !canvas) return null;
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1,
  );
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, cam);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  return rc.ray.intersectPlane(plane, hit) ? hit : null;
}

function disposeGhosts(): void {
  const scene = SCENE();
  if (!scene || !ghostGroup) return;
  scene.remove(ghostGroup);
  ghostGroup.traverse((c) => {
    const anyC = c as Any;
    anyC.geometry?.dispose?.();
    if (anyC.material) {
      if (Array.isArray(anyC.material)) anyC.material.forEach((m: any) => m.dispose?.());
      else anyC.material.dispose?.();
    }
  });
  ghostGroup = null;
}

function buildGhost(): void {
  disposeGhosts();
  const scene = SCENE();
  if (!scene || !pivotWorld) return;
  ghostGroup = new THREE.Group();
  ghostGroup.position.copy(pivotWorld).setY(0);
  scene.add(ghostGroup);
  const box = selectionBox();
  if (box) {
    const helper = new THREE.Box3Helper(box.clone(), 0x38bdf8);
    const mat = helper.material as THREE.LineBasicMaterial;
    mat.transparent = true; mat.opacity = 0.55; mat.depthTest = false;
    helper.renderOrder = 999;
    const center = box.getCenter(new THREE.Vector3());
    helper.position.copy(center.sub(pivotWorld));
    ghostGroup.add(helper);
  }
  if (refWorld) {
    const refGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.02, 0),
      new THREE.Vector3(refWorld.x - pivotWorld.x, 0.02, refWorld.z - pivotWorld.z),
    ]);
    const refLine = new THREE.Line(refGeo, new THREE.LineBasicMaterial({ color: 0x22c55e, depthTest: false, transparent: true, opacity: 0.75 }));
    refLine.renderOrder = 1000;
    ghostGroup.add(refLine);
  }
}

function updateGhostRotation(angleRad: number): void {
  if (!ghostGroup) return;
  ghostGroup.rotation.y = -angleRad;
  const existing = ghostGroup.getObjectByName("obs-cursor-ray");
  if (existing) ghostGroup.remove(existing);
  if (pivotWorld && curWorld) {
    const curGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.03, 0),
      new THREE.Vector3(curWorld.x - pivotWorld.x, 0.03, curWorld.z - pivotWorld.z),
    ]);
    const curLine = new THREE.Line(curGeo, new THREE.LineDashedMaterial({ color: 0xfacc15, dashSize: 0.15, gapSize: 0.1, depthTest: false }));
    curLine.name = "obs-cursor-ray";
    curLine.computeLineDistances();
    curLine.renderOrder = 1001;
    curLine.rotation.y = angleRad;
    ghostGroup.add(curLine);
  }
}

function currentAngleRad(): number {
  if (!pivotWorld || !refWorld || !curWorld) return 0;
  const refA = Math.atan2(refWorld.z - pivotWorld.z, refWorld.x - pivotWorld.x);
  const curA = Math.atan2(curWorld.z - pivotWorld.z, curWorld.x - pivotWorld.x);
  return curA - refA;
}

function ensureHud(): void {
  if (hud) return;
  const host = ((ctx as Any).rightHost ?? document.getElementById("viewport") ?? document.body) as HTMLElement;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  hud = document.createElement("div");
  hud.id = "obs-rotate-hud";
  hud.style.cssText =
    "position:absolute;bottom:22px;left:50%;transform:translateX(-50%);background:rgba(15,17,23,.96);" +
    "border:1px solid #38bdf8;border-radius:6px;padding:8px 16px;display:flex;align-items:center;gap:12px;" +
    "color:#f8fafc;font:11px var(--font-mono,monospace);z-index:75;box-shadow:0 8px 24px rgba(0,0,0,.55);";
  hud.innerHTML =
    `<span style="color:#94a3b8">Angle:</span>` +
    `<span id="obs-rotate-angle" style="color:#38bdf8;font-weight:700;font-size:13px">0.00°</span>` +
    `<span style="color:#64748b">|</span>` +
    `<span style="color:#94a3b8;font-size:10px">Enter or click to commit · Esc to cancel</span>` +
    `<button style="background:#0284c7;color:#fff;border:none;border-radius:3px;padding:4px 12px;cursor:pointer;font-size:10px">Apply</button>`;
  host.appendChild(hud);
  angleLabel = hud.querySelector("#obs-rotate-angle");
  hud.querySelector("button")!.onclick = () => commit();
}

function updateHud(): void {
  if (!angleLabel) return;
  angleLabel.textContent = `${((currentAngleRad() * 180) / Math.PI).toFixed(2)}°`;
}

function removeHud(): void { hud?.remove(); hud = null; angleLabel = null; }

function onDown(ev: PointerEvent): void {
  if (phase === "idle" || ev.button !== 0) return;
  if (ev.target instanceof HTMLButtonElement) return;
  ev.preventDefault(); ev.stopPropagation();
  pointerId = ev.pointerId;
  CANVAS()?.setPointerCapture(ev.pointerId);
  const w = screenToWorld(ev);
  if (!w) return;
  if (phase === "awaiting-pivot") { pivotWorld = w.clone(); phase = "awaiting-reference"; }
  else if (phase === "awaiting-reference") { refWorld = w.clone(); curWorld = w.clone(); phase = "previewing"; buildGhost(); ensureHud(); updateHud(); }
  else if (phase === "previewing") { commit(); }
}

function onMove(ev: PointerEvent): void {
  if (phase !== "awaiting-reference" && phase !== "previewing") return;
  const w = screenToWorld(ev);
  if (!w) return;
  curWorld = w.clone();
  if (phase === "previewing") { updateGhostRotation(currentAngleRad()); updateHud(); }
}

function onUp(ev: PointerEvent): void {
  if (pointerId === ev.pointerId) { CANVAS()?.releasePointerCapture(ev.pointerId); pointerId = -1; }
}

function onKey(ev: KeyboardEvent): void {
  if (phase === "idle") return;
  if (ev.key === "Escape") { ev.preventDefault(); cancel(); return; }
  if (ev.key === "Enter" && phase === "previewing") { ev.preventDefault(); commit(); }
}

function commit(): void {
  if (cancelled || !pivotWorld || phase !== "previewing") { cancel(); return; }
  const angleRad = currentAngleRad();
  if (Math.abs(angleRad) > 1e-6) rotateSelected(pivotWorld.x, pivotWorld.z, angleRad);
  cancel();
}

function cancel(): void {
  cancelled = true;
  const canvas = CANVAS();
  canvas?.removeEventListener("pointerdown", onDown, true);
  canvas?.removeEventListener("pointermove", onMove, true);
  canvas?.removeEventListener("pointerup", onUp, true);
  window.removeEventListener("keydown", onKey, true);
  if (canvas) canvas.style.cursor = "";
  disposeGhosts(); removeHud();
  phase = "idle";
  pivotWorld = null; refWorld = null; curWorld = null; pointerId = -1;
  setTimeout(() => { cancelled = false; }, 0);
}

export function startRotate(): void {
  const canvas = CANVAS();
  if (!canvas) return;
  cancel();
  if (!getSelectedIds().length) return;
  phase = "awaiting-pivot";
  canvas.style.cursor = "crosshair";
  canvas.addEventListener("pointerdown", onDown, true);
  canvas.addEventListener("pointermove", onMove, true);
  canvas.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey, true);
}