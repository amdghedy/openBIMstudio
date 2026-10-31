/** Revit-style Array controller — base, direction, live count preview, single undo. */
import * as THREE from "three";
import { ctx } from "../core/context";
import { duplicateSelected } from "./authoring";

type Any = Record<string, any>;
type Phase = "idle" | "awaiting-base" | "awaiting-direction" | "previewing";

let phase: Phase = "idle";
let baseWorld: THREE.Vector3 | null = null;
let directionWorld: THREE.Vector3 | null = null;
let count = 3;
const ghostGroup = new THREE.Group();
let pointerId = -1;
let hud: HTMLDivElement | null = null;
let countInput: HTMLInputElement | null = null;
let cancelled = false;

const CANVAS = (): HTMLCanvasElement | null => {
  const r = (ctx as Any).world?.renderer?.three ?? (ctx as Any).world?.renderer;
  return (r?.domElement as HTMLCanvasElement) ?? null;
};
const SCENE = (): THREE.Scene | null => (ctx as Any).world?.scene?.three ?? (ctx as Any).world?.scene ?? null;
const CAMERA = (): THREE.Camera | null => (ctx as Any).world?.camera?.three ?? (ctx as Any).world?.camera ?? null;

function getSelectedIds(): string[] {
  const a = (ctx as Any).features?.authoring;
  if (a?.getSelectedIds) {
    try { return a.getSelectedIds().map(String); } catch { return []; }
  }
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

function ensureGhostGroup(): void {
  const scene = SCENE();
  if (!scene) return;
  if (ghostGroup.parent !== scene) scene.add(ghostGroup);
}

function clearGhosts(): void {
  while (ghostGroup.children.length) {
    const c = ghostGroup.children[0];
    ghostGroup.remove(c);
    const anyC = c as Any;
    anyC.geometry?.dispose?.();
    if (anyC.material) {
      if (Array.isArray(anyC.material)) anyC.material.forEach((m: any) => m.dispose?.());
      else anyC.material.dispose?.();
    }
  }
}

function rebuildGhosts(): void {
  clearGhosts();
  if (!baseWorld || !directionWorld) return;
  const origin = selectionBox();
  if (!origin) return;
  const dx = directionWorld.x - baseWorld.x;
  const dz = directionWorld.z - baseWorld.z;
  for (let i = 1; i < count; i++) {
    const box = origin.clone().translate(new THREE.Vector3(dx * i, 0, dz * i));
    const helper = new THREE.Box3Helper(box, 0x38bdf8);
    const mat = helper.material as THREE.LineBasicMaterial;
    mat.transparent = true; mat.opacity = 0.45; mat.depthTest = false;
    helper.renderOrder = 999;
    ghostGroup.add(helper);
  }
  const geo = new THREE.BufferGeometry().setFromPoints([
    baseWorld.clone(),
    new THREE.Vector3(baseWorld.x + dx * (count - 1), baseWorld.y, baseWorld.z + dz * (count - 1)),
  ]);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
    color: 0xfacc15, dashSize: 0.15, gapSize: 0.1, depthTest: false,
  }));
  line.computeLineDistances();
  line.renderOrder = 1000;
  ghostGroup.add(line);
}

function showHud(): void {
  removeHud();
  const host = ((ctx as Any).rightHost ?? document.getElementById("viewport") ?? document.body) as HTMLElement;
  if (getComputedStyle(host).position === "static") host.style.position = "relative";
  hud = document.createElement("div");
  hud.id = "obs-array-hud";
  hud.style.cssText =
    "position:absolute;bottom:22px;left:50%;transform:translateX(-50%);background:rgba(15,17,23,.96);" +
    "border:1px solid #38bdf8;border-radius:6px;padding:8px 14px;display:flex;align-items:center;gap:10px;" +
    "color:#f8fafc;font:11px var(--font-mono,monospace);z-index:75;box-shadow:0 8px 24px rgba(0,0,0,.55);";
  hud.innerHTML =
    `<span style="color:#94a3b8">Count:</span>` +
    `<input type="number" min="2" max="100" value="${count}" style="width:60px;background:#0c0e13;border:1px solid #334155;border-radius:3px;color:#f8fafc;font:11px monospace;padding:3px 5px">` +
    `<span style="color:#64748b">|</span>` +
    `<span style="color:#94a3b8;font-size:10px">Enter or click to commit · Esc to cancel</span>` +
    `<button style="background:#0284c7;color:#fff;border:none;border-radius:3px;padding:4px 12px;cursor:pointer;font-size:10px">Apply</button>`;
  host.appendChild(hud);
  countInput = hud.querySelector("input");
  if (countInput) {
    countInput.onchange = () => {
      const v = parseInt(countInput!.value, 10);
      if (Number.isFinite(v) && v >= 2 && v <= 100) { count = v; rebuildGhosts(); }
    };
    countInput.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    setTimeout(() => { countInput?.focus(); countInput?.select(); }, 10);
  }
  hud.querySelector("button")!.onclick = () => commit();
}

function removeHud(): void {
  hud?.remove();
  hud = null;
  countInput = null;
}

function onDown(ev: PointerEvent): void {
  if (phase === "idle" || ev.button !== 0) return;
  if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLButtonElement) return;
  ev.preventDefault(); ev.stopPropagation();
  pointerId = ev.pointerId;
  CANVAS()?.setPointerCapture(ev.pointerId);
  const w = screenToWorld(ev);
  if (!w) return;
  if (phase === "awaiting-base") {
    baseWorld = w.clone();
    phase = "awaiting-direction";
  } else if (phase === "awaiting-direction") {
    directionWorld = w.clone();
    phase = "previewing";
    rebuildGhosts();
    showHud();
  } else if (phase === "previewing") {
    commit();
  }
}

function onMove(ev: PointerEvent): void {
  if (phase !== "awaiting-direction" || !baseWorld) return;
  const w = screenToWorld(ev);
  if (!w) return;
  const dx = w.x - baseWorld.x, dz = w.z - baseWorld.z;
  clearGhosts();
  const geo = new THREE.BufferGeometry().setFromPoints([
    baseWorld.clone(),
    new THREE.Vector3(baseWorld.x + dx, baseWorld.y, baseWorld.z + dz),
  ]);
  const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0xfacc15, dashSize: 0.15, gapSize: 0.1, depthTest: false }));
  line.computeLineDistances();
  line.renderOrder = 1000;
  ghostGroup.add(line);
}

function onUp(ev: PointerEvent): void {
  if (pointerId === ev.pointerId) {
    CANVAS()?.releasePointerCapture(ev.pointerId);
    pointerId = -1;
  }
}

function onKey(ev: KeyboardEvent): void {
  if (phase === "idle") return;
  if (ev.key === "Escape") { ev.preventDefault(); cancel(); return; }
  if (ev.key === "Enter" && phase === "previewing") {
    if (ev.target instanceof HTMLInputElement) return;
    ev.preventDefault();
    commit();
  }
}

function commit(): void {
  if (cancelled || !baseWorld || !directionWorld) { cancel(); return; }
  const dx = directionWorld.x - baseWorld.x;
  const dz = directionWorld.z - baseWorld.z;
  const totalCopies = Math.max(1, count - 1);
  const newIds: string[] = [];
  for (let i = 1; i <= totalCopies; i++) {
    const ids = duplicateSelected(dx * i, dz * i);
    newIds.push(...ids);
  }
  const setSel = (ctx as Any).features?.authoring?.setSelectedIds;
  if (typeof setSel === "function" && newIds.length) {
    try {
      const orig = getSelectedIds();
      setSel([...orig, ...newIds]);
    } catch { /* */ }
  }
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
  clearGhosts();
  removeHud();
  const scene = SCENE();
  if (scene && ghostGroup.parent === scene) scene.remove(ghostGroup);
  phase = "idle";
  baseWorld = null;
  directionWorld = null;
  count = 3;
  pointerId = -1;
  setTimeout(() => { cancelled = false; }, 0);
}

export function startArray(): void {
  const canvas = CANVAS();
  if (!canvas) return;
  cancel();
  if (!getSelectedIds().length) return;
  ensureGhostGroup();
  count = 3;
  phase = "awaiting-base";
  canvas.style.cursor = "crosshair";
  canvas.addEventListener("pointerdown", onDown, true);
  canvas.addEventListener("pointermove", onMove, true);
  canvas.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey, true);
}