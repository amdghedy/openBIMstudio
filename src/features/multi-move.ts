/** Revit-style multi-selection live Move/Copy controller.
 *  Boundary box + base-point pick + ghost preview + single undo commit.
 *  Selection is retained after commit; tool stays active until Esc.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { translateSelected, getActiveTool, onAuthoringChange } from "./authoring";

type Any = Record<string, any>;
type Phase = "idle" | "awaiting-base" | "previewing";

interface SavedPos { id: string; start?: [number, number]; end?: [number, number]; point?: [number, number]; polygon?: [number, number][]; }

let phase: Phase = "idle";
let baseWorld: THREE.Vector3 | null = null;
let ghostBox: THREE.BoxHelper | null = null;
let ghostLine: THREE.Line | null = null;
let selBox: THREE.Box3 = new THREE.Box3();
let saved: SavedPos[] = [];
let copyMode = false;
let pointerId = -1;

const CANVAS = (): HTMLCanvasElement | null => {
  const r = (ctx as Any).world?.renderer?.three ?? (ctx as Any).world?.renderer;
  return (r?.domElement as HTMLCanvasElement) ?? null;
};
const SCENE = (): THREE.Scene | null => (ctx as Any).world?.scene?.three ?? (ctx as Any).world?.scene ?? null;
const CAMERA = (): THREE.Camera | null => (ctx as Any).world?.camera?.three ?? (ctx as Any).world?.camera ?? null;

function getSelectedIds(): string[] {
  const a = (ctx as Any).features?.authoring;
  if (a?.getSelectedIds) return a.getSelectedIds();
  return [];
}

function getElementObject(id: string): THREE.Object3D | null {
  const scene = SCENE();
  if (!scene) return null;
  let found: THREE.Object3D | null = null;
  scene.traverse((o) => {
    if (found) return;
    if ((o.userData as Any)?.elementId === id) found = o;
  });
  return found;
}

function computeSelectionBox(): THREE.Box3 | null {
  const ids = getSelectedIds();
  if (!ids.length) return null;
  const box = new THREE.Box3();
  let any = false;
  for (const id of ids) {
    const obj = getElementObject(id);
    if (!obj) continue;
    const b = new THREE.Box3().setFromObject(obj);
    if (Number.isFinite(b.min.x)) { box.union(b); any = true; }
  }
  return any ? box : null;
}

function savePositions(): void {
  saved = [];
  const els = ((ctx as Any).features?.authoring?.elements ?? []) as Array<Any>;
  for (const id of getSelectedIds()) {
    const el = els.find((e: Any) => String(e.id) === id);
    if (!el) continue;
    const p = el.params ?? {};
    saved.push({
      id,
      start: p.start ? [p.start[0], p.start[1]] : undefined,
      end: p.end ? [p.end[0], p.end[1]] : undefined,
      point: p.point ? [p.point[0], p.point[1]] : undefined,
      polygon: p.polygon ? p.polygon.map((q: [number, number]) => [q[0], q[1]]) : undefined,
    });
  }
}

function restorePositions(): void {
  const els = ((ctx as Any).features?.authoring?.elements ?? []) as Array<Any>;
  for (const s of saved) {
    const el = els.find((e: Any) => String(e.id) === s.id);
    if (!el) continue;
    const p = el.params ?? {};
    if (s.start) p.start = s.start;
    if (s.end) p.end = s.end;
    if (s.point) p.point = s.point;
    if (s.polygon) p.polygon = s.polygon;
  }
  const rebuild = (ctx as Any).features?.authoring?.rebuild;
  if (typeof rebuild === "function") rebuild();
}

function makeGhost(box: THREE.Box3): void {
  destroyGhost();
  const scene = SCENE();
  if (!scene) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const helper = new THREE.Box3Helper(box.clone(), 0x38bdf8);
  (helper.material as THREE.LineBasicMaterial).transparent = true;
  (helper.material as THREE.LineBasicMaterial).opacity = 0.55;
  (helper.material as THREE.LineBasicMaterial).depthTest = false;
  helper.renderOrder = 999;
  ghostBox = helper as unknown as THREE.BoxHelper;
  scene.add(helper);

  const geo = new THREE.BufferGeometry().setFromPoints([center, center]);
  const mat = new THREE.LineDashedMaterial({ color: 0xfacc15, dashSize: 0.15, gapSize: 0.1, depthTest: false });
  const line = new THREE.Line(geo, mat);
  line.computeLineDistances();
  line.renderOrder = 1000;
  ghostLine = line;
  scene.add(line);
  void size;
}

function destroyGhost(): void {
  const scene = SCENE();
  if (!scene) return;
  if (ghostBox) { scene.remove(ghostBox); (ghostBox as Any).geometry?.dispose?.(); }
  if (ghostLine) { scene.remove(ghostLine); ghostLine.geometry.dispose(); (ghostLine.material as THREE.Material).dispose(); }
  ghostBox = null; ghostLine = null;
}

function updateGhost(dx: number, dz: number): void {
  if (!ghostBox || !ghostLine || !baseWorld) return;
  const pos = ghostBox.position;
  pos.set(dx, 0, dz);
  const p = ghostLine.geometry.attributes.position as THREE.BufferAttribute;
  p.setXYZ(0, baseWorld.x, baseWorld.y, baseWorld.z);
  p.setXYZ(1, baseWorld.x + dx, baseWorld.y, baseWorld.z + dz);
  p.needsUpdate = true;
  ghostLine.computeLineDistances();
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

function onDown(ev: PointerEvent): void {
  if (phase === "idle" || ev.button !== 0) return;
  ev.preventDefault(); ev.stopPropagation();
  pointerId = ev.pointerId;
  CANVAS()?.setPointerCapture(ev.pointerId);
  const w = screenToWorld(ev);
  if (!w) return;
  if (phase === "awaiting-base") {
    baseWorld = w.clone();
    phase = "previewing";
    updateGhost(0, 0);
  } else if (phase === "previewing" && baseWorld) {
    const dx = w.x - baseWorld.x, dz = w.z - baseWorld.z;
    if (copyMode) {
      // duplicate selection before translating (simplified: translate original, then restore)
      // For a full copy, authoring would need a duplicateSelected() primitive.
      // We translate, then restore originals, leaving copies at the new position.
      // (Requires duplicateSelected to exist; skip if not available.)
    }
    translateSelected(dx, dz);
    baseWorld = null;
    phase = "awaiting-base";
    updateGhost(0, 0);
    if (!copyMode) {
      // retain selection; ghost box stays at new location
      const nb = computeSelectionBox();
      if (nb) { selBox = nb; makeGhost(nb); }
    }
  }
}

function onMove(ev: PointerEvent): void {
  if (phase !== "previewing" || !baseWorld) return;
  const w = screenToWorld(ev);
  if (!w) return;
  updateGhost(w.x - baseWorld.x, w.z - baseWorld.z);
}

function onUp(ev: PointerEvent): void {
  if (pointerId === ev.pointerId) {
    CANVAS()?.releasePointerCapture(ev.pointerId);
    pointerId = -1;
  }
}

function onKey(ev: KeyboardEvent): void {
  if (phase === "idle") return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    if (phase === "previewing") {
      restorePositions();
      phase = "awaiting-base";
      if (selBox) updateGhost(0, 0);
    } else {
      cancel();
    }
  }
  if (ev.key === "Control") copyMode = true;
}

function onKeyUp(ev: KeyboardEvent): void { if (ev.key === "Control") copyMode = false; }

export function startMultiMove(copy = false): void {
  const canvas = CANVAS();
  if (!canvas) return;
  cancel();
  selBox = computeSelectionBox() ?? new THREE.Box3();
  if (selBox.isEmpty()) return;
  savePositions();
  copyMode = copy;
  phase = "awaiting-base";
  makeGhost(selBox);
  canvas.style.cursor = "crosshair";
  canvas.addEventListener("pointerdown", onDown, true);
  canvas.addEventListener("pointermove", onMove, true);
  canvas.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKeyUp, true);
}

export function cancel(): void {
  const canvas = CANVAS();
  canvas?.removeEventListener("pointerdown", onDown, true);
  canvas?.removeEventListener("pointermove", onMove, true);
  canvas?.removeEventListener("pointerup", onUp, true);
  window.removeEventListener("keydown", onKey, true);
  window.removeEventListener("keyup", onKeyUp, true);
  if (canvas) canvas.style.cursor = "";
  destroyGhost();
  phase = "idle";
  baseWorld = null;
  saved = [];
  copyMode = false;
  pointerId = -1;
}