/**
 * Scope Box Visualizer — renders scope boxes in the 3D viewport with
 * draggable corner + edge handles so the user can resize them live.
 *
 * BIM-equivalent of Revit's scope box 3D gizmo. Each scope box has:
 *   - A wireframe Box3Helper showing the bounds
 *   - 8 corner spheres (drag to scale all 3 axes)
 *   - 6 face handles (drag to move that face only)
 *   - A centre handle (drag to translate)
 *
 * Drag uses pointer events on a THREE.Raycaster — no external transform
 * controls dependency. Snaps to 0.1 m for predictable sizing.
 */

import * as THREE from "three";
import { ctx } from "../../core/context";
import {
  listScopeBoxes, getScopeBox, updateScopeBox, deleteScopeBox,
  type ScopeBox,
} from "../scope-box/scope-box";

type DragMode = "translate" | "corner" | "face";

interface DragState {
  scopeBoxId: string;
  mode: DragMode;
  startPointer: THREE.Vector3;
  startBox: THREE.Box3;
  /** For corner drag: which corner index (0..7). */
  cornerIdx?: number;
  /** For face drag: which face normal axis + sign. */
  faceAxis?: "x" | "y" | "z";
  faceSign?: 1 | -1;
}

const SNAP = 0.1; // 10 cm grid snap

const CORNER_OFFSETS: Array<[number, number, number]> = [
  [-1, -1, -1], [ 1, -1, -1], [-1,  1, -1], [ 1,  1, -1],
  [-1, -1,  1], [ 1, -1,  1], [-1,  1,  1], [ 1,  1,  1],
];

const FACE_DEFS: Array<{ axis: "x" | "y" | "z"; sign: 1 | -1; label: string }> = [
  { axis: "x", sign: -1, label: "−X" },
  { axis: "x", sign:  1, label: "+X" },
  { axis: "y", sign: -1, label: "−Y" },
  { axis: "y", sign:  1, label: "+Y" },
  { axis: "z", sign: -1, label: "−Z" },
  { axis: "z", sign:  1, label: "+Z" },
];

const visualizers = new Map<string, { group: THREE.Group; helper: THREE.LineSegments; corners: THREE.Mesh[]; faces: THREE.Mesh[]; center: THREE.Mesh; }>();
let raycaster: THREE.Raycaster | null = null;
let pointer: THREE.Vector2 | null = null;
let dragState: DragState | null = null;
let enabled = false;
let dragging = false;

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

function buildBoxGeometry(box: THREE.Box3): THREE.BufferGeometry {
  const size = new THREE.Vector3();
  box.getSize(size);
  return new THREE.BoxGeometry(size.x, size.y, size.z);
}

function buildLineSegments(box: THREE.Box3, color: number): THREE.LineSegments {
  const geo = new THREE.EdgesGeometry(buildBoxGeometry(box));
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
  const lines = new THREE.LineSegments(geo, mat);
  const center = new THREE.Vector3();
  box.getCenter(center);
  lines.position.copy(center);
  lines.renderOrder = 999;
  return lines;
}

function buildCornerHandles(box: THREE.Box3, color: number): THREE.Mesh[] {
  const handles: THREE.Mesh[] = [];
  const geo = new THREE.SphereGeometry(0.12, 12, 8);
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  for (const off of CORNER_OFFSETS) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(
      off[0] < 0 ? box.min.x : box.max.x,
      off[1] < 0 ? box.min.y : box.max.y,
      off[2] < 0 ? box.min.z : box.max.z,
    );
    m.renderOrder = 1000;
    m.userData = { kind: "scope-corner", cornerIdx: CORNER_OFFSETS.indexOf(off) };
    handles.push(m);
  }
  return handles;
}

function buildFaceHandles(box: THREE.Box3, color: number): THREE.Mesh[] {
  const handles: THREE.Mesh[] = [];
  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  const geo = new THREE.PlaneGeometry(0.4, 0.4);
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.7 });
  for (const face of FACE_DEFS) {
    const m = new THREE.Mesh(geo, mat);
    const pos = center.clone();
    if (face.axis === "x") {
      pos.x = face.sign < 0 ? box.min.x : box.max.x;
      m.rotation.y = face.sign < 0 ? -Math.PI / 2 : Math.PI / 2;
    } else if (face.axis === "y") {
      pos.y = face.sign < 0 ? box.min.y : box.max.y;
      m.rotation.x = face.sign < 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      pos.z = face.sign < 0 ? box.min.z : box.max.z;
    }
    m.position.copy(pos);
    m.renderOrder = 1001;
    m.userData = { kind: "scope-face", axis: face.axis, sign: face.sign };
    handles.push(m);
  }
  return handles;
}

function buildCenterHandle(box: THREE.Box3, color: number): THREE.Mesh {
  const geo = new THREE.OctahedronGeometry(0.18, 0);
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  const m = new THREE.Mesh(geo, mat);
  const center = new THREE.Vector3();
  box.getCenter(center);
  m.position.copy(center);
  m.renderOrder = 1002;
  m.userData = { kind: "scope-center" };
  return m;
}

function buildScopeBoxVisualizer(sb: ScopeBox): { group: THREE.Group; helper: THREE.LineSegments; corners: THREE.Mesh[]; faces: THREE.Mesh[]; center: THREE.Mesh; } {
  const box = new THREE.Box3(
    new THREE.Vector3(sb.min.x, sb.min.y, sb.min.z),
    new THREE.Vector3(sb.max.x, sb.max.y, sb.max.z),
  );
  const group = new THREE.Group();
  group.name = `obs-scope-box-${sb.id}`;
  group.userData = { kind: "scope-box-visualizer", scopeBoxId: sb.id };
  const helper = buildLineSegments(box, sb.color);
  const corners = buildCornerHandles(box, sb.color);
  const faces = buildFaceHandles(box, sb.color);
  const center = buildCenterHandle(box, sb.color);
  group.add(helper, ...corners, ...faces, center);
  return { group, helper, corners, faces, center };
}

function syncVisualizer(sbId: string): void {
  const sb = getScopeBox(sbId);
  const viz = visualizers.get(sbId);
  if (!sb || !viz) return;
  const box = new THREE.Box3(
    new THREE.Vector3(sb.min.x, sb.min.y, sb.min.z),
    new THREE.Vector3(sb.max.x, sb.max.y, sb.max.z),
  );
  // Rebuild helper geometry.
  viz.helper.geometry.dispose();
  viz.helper.geometry = new THREE.EdgesGeometry(buildBoxGeometry(box));
  const center = new THREE.Vector3();
  box.getCenter(center);
  viz.helper.position.copy(center);
  // Reposition corners.
  for (const c of viz.corners) {
    const idx = c.userData.cornerIdx as number;
    const off = CORNER_OFFSETS[idx];
    c.position.set(
      off[0] < 0 ? box.min.x : box.max.x,
      off[1] < 0 ? box.min.y : box.max.y,
      off[2] < 0 ? box.min.z : box.max.z,
    );
  }
  // Reposition face handles.
  for (const f of viz.faces) {
    const axis = f.userData.axis as "x" | "y" | "z";
    const sign = f.userData.sign as 1 | -1;
    const c = center.clone();
    if (axis === "x") c.x = sign < 0 ? box.min.x : box.max.x;
    else if (axis === "y") c.y = sign < 0 ? box.min.y : box.max.y;
    else c.z = sign < 0 ? box.min.z : box.max.z;
    f.position.copy(c);
  }
  viz.center.position.copy(center);
}

/** Show all scope boxes in the viewport. */
export function enableScopeBoxVisualizer(): void {
  if (enabled) return;
  const scene = (ctx as any).world?.scene?.three as THREE.Scene | undefined;
  if (!scene) {
    console.warn("[scope-box-viz] scene not ready");
    return;
  }
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2();
  for (const sb of listScopeBoxes()) {
    const viz = buildScopeBoxVisualizer(sb);
    visualizers.set(sb.id, viz);
    scene.add(viz.group);
  }
  // Pointer handlers attach to the renderer's canvas (DOM Element), not the scene.
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement | undefined;
  if (canvas) {
    canvas.addEventListener("pointerdown", onPointerDown as any);
    canvas.addEventListener("pointermove", onPointerMove as any);
    window.addEventListener("pointerup", onPointerUp);
  } else {
    console.warn("[scope-box-viz] renderer canvas not ready — handles will not be draggable");
  }
  enabled = true;
  console.log(`[scope-box-viz] enabled — ${visualizers.size} scope box(es)`);
}

/** Hide all scope boxes from the viewport. */
export function disableScopeBoxVisualizer(): void {
  if (!enabled) return;
  const scene = (ctx as any).world?.scene?.three as THREE.Scene | undefined;
  for (const viz of visualizers.values()) {
    scene?.remove(viz.group);
    viz.helper.geometry.dispose();
    (viz.helper.material as THREE.Material).dispose();
    for (const c of viz.corners) c.geometry.dispose();
    for (const f of viz.faces) f.geometry.dispose();
    viz.center.geometry.dispose();
  }
  visualizers.clear();
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement | undefined;
  if (canvas) {
    canvas.removeEventListener("pointerdown", onPointerDown as any);
    canvas.removeEventListener("pointermove", onPointerMove as any);
  }
  window.removeEventListener("pointerup", onPointerUp);
  dragState = null;
  dragging = false;
  enabled = false;
  console.log("[scope-box-viz] disabled");
}

/** Refresh after a scope box is added/removed externally. */
export function refreshScopeBoxVisualizer(): void {
  if (!enabled) return;
  const scene = (ctx as any).world?.scene?.three as THREE.Scene | undefined;
  const existing = new Set(visualizers.keys());
  const current = new Set(listScopeBoxes().map((sb) => sb.id));
  // Remove deleted.
  for (const id of Array.from(existing)) {
    if (!current.has(id)) {
      const viz = visualizers.get(id)!;
      scene?.remove(viz.group);
      viz.helper.geometry.dispose();
      visualizers.delete(id);
    }
  }
  // Add new.
  for (const sb of listScopeBoxes()) {
    if (!visualizers.has(sb.id)) {
      const viz = buildScopeBoxVisualizer(sb);
      visualizers.set(sb.id, viz);
      scene?.add(viz.group);
    } else {
      syncVisualizer(sb.id);
    }
  }
}

function getNDC(event: PointerEvent): THREE.Vector2 {
  const rect = (event.target as HTMLElement).getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

function castRay(ndc: THREE.Vector2): THREE.Object3D | null {
  if (!raycaster || !pointer) return null;
  const camera = (ctx as any).world?.camera?.three as THREE.Camera | undefined;
  if (!camera) return null;
  raycaster.setFromCamera(ndc, camera);
  const targets: THREE.Object3D[] = [];
  for (const viz of visualizers.values()) {
    targets.push(...viz.corners, ...viz.faces, viz.center);
  }
  const hits = raycaster.intersectObjects(targets, false);
  return hits.length ? hits[0].object : null;
}

function getDragPlane(faceAxis?: "x" | "y" | "z"): THREE.Plane {
  // Drag plane is perpendicular to camera direction so dragging feels natural.
  const camera = (ctx as any).world?.camera?.three as THREE.Camera | undefined;
  if (!camera) return new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  // Use face axis if dragging a face; else camera-aligned.
  const normal = faceAxis
    ? new THREE.Vector3(faceAxis === "x" ? 1 : 0, faceAxis === "y" ? 1 : 0, faceAxis === "z" ? 1 : 0)
    : camDir.clone().negate();
  return new THREE.Plane(normal, 0);
}

function getDragPoint(event: PointerEvent, plane: THREE.Plane): THREE.Vector3 {
  const ndc = getNDC(event);
  const camera = (ctx as any).world?.camera?.three as THREE.Camera | undefined;
  if (!raycaster || !camera) return new THREE.Vector3();
  raycaster.setFromCamera(ndc, camera);
  const target = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, target);
  return target;
}

function onPointerDown(event: PointerEvent): void {
  const target = castRay(getNDC(event));
  if (!target) return;
  const ud = target.userData;
  let scopeBoxId: string | undefined;
  if (ud.kind === "scope-corner" || ud.kind === "scope-face" || ud.kind === "scope-center") {
    // Find which scope box this handle belongs to.
    for (const [id, viz] of visualizers) {
      if (viz.corners.includes(target as THREE.Mesh) ||
          viz.faces.includes(target as THREE.Mesh) ||
          viz.center === target) {
        scopeBoxId = id;
        break;
      }
    }
  }
  if (!scopeBoxId) return;
  const sb = getScopeBox(scopeBoxId);
  if (!sb) return;
  const startBox = new THREE.Box3(
    new THREE.Vector3(sb.min.x, sb.min.y, sb.min.z),
    new THREE.Vector3(sb.max.x, sb.max.y, sb.max.z),
  );
  const plane = getDragPlane(ud.kind === "scope-face" ? ud.axis : undefined);
  const startPointer = getDragPoint(event, plane);
  dragState = {
    scopeBoxId,
    mode: ud.kind === "scope-center" ? "translate" : ud.kind === "scope-corner" ? "corner" : "face",
    startPointer,
    startBox: startBox.clone(),
    cornerIdx: ud.cornerIdx,
    faceAxis: ud.axis,
    faceSign: ud.sign,
  };
  dragging = true;
  (event.target as HTMLElement).style.cursor = "grabbing";
  event.preventDefault();
}

function onPointerMove(event: PointerEvent): void {
  if (!dragState) {
    // Hover cursor.
    const target = castRay(getNDC(event));
    const elem = event.target as HTMLElement;
    if (elem) elem.style.cursor = target ? "grab" : "default";
    return;
  }
  if (!dragging) return;
  const plane = getDragPlane(dragState.faceAxis);
  const current = getDragPoint(event, plane);
  const delta = current.clone().sub(dragState.startPointer);
  // Snap delta to grid.
  delta.x = snap(delta.x);
  delta.y = snap(delta.y);
  delta.z = snap(delta.z);
  const sb = getScopeBox(dragState.scopeBoxId);
  if (!sb) return;
  const newBox = dragState.startBox.clone();

  if (dragState.mode === "translate") {
    newBox.min.add(delta);
    newBox.max.add(delta);
  } else if (dragState.mode === "corner" && dragState.cornerIdx !== undefined) {
    const off = CORNER_OFFSETS[dragState.cornerIdx];
    if (off[0] < 0) newBox.min.x = Math.min(newBox.min.x + delta.x, newBox.max.x - 0.5);
    else newBox.max.x = Math.max(newBox.max.x + delta.x, newBox.min.x + 0.5);
    if (off[1] < 0) newBox.min.y = Math.min(newBox.min.y + delta.y, newBox.max.y - 0.5);
    else newBox.max.y = Math.max(newBox.max.y + delta.y, newBox.min.y + 0.5);
    if (off[2] < 0) newBox.min.z = Math.min(newBox.min.z + delta.z, newBox.max.z - 0.5);
    else newBox.max.z = Math.max(newBox.max.z + delta.z, newBox.min.z + 0.5);
  } else if (dragState.mode === "face" && dragState.faceAxis) {
    const axis = dragState.faceAxis;
    const sign = dragState.faceSign;
    if (axis === "x") {
      if (sign === -1) newBox.min.x = Math.min(newBox.min.x + delta.x, newBox.max.x - 0.5);
      else newBox.max.x = Math.max(newBox.max.x + delta.x, newBox.min.x + 0.5);
    } else if (axis === "y") {
      if (sign === -1) newBox.min.y = Math.min(newBox.min.y + delta.y, newBox.max.y - 0.5);
      else newBox.max.y = Math.max(newBox.max.y + delta.y, newBox.min.y + 0.5);
    } else {
      if (sign === -1) newBox.min.z = Math.min(newBox.min.z + delta.z, newBox.max.z - 0.5);
      else newBox.max.z = Math.max(newBox.max.z + delta.z, newBox.min.z + 0.5);
    }
  }

  updateScopeBox(dragState.scopeBoxId, {
    min: { x: newBox.min.x, y: newBox.min.y, z: newBox.min.z },
    max: { x: newBox.max.x, y: newBox.max.y, z: newBox.max.z },
  });
  syncVisualizer(dragState.scopeBoxId);
}

function onPointerUp(): void {
  if (!dragState) return;
  dragState = null;
  dragging = false;
  document.body.style.cursor = "default";
}

export function isScopeBoxVisualizerEnabled(): boolean {
  return enabled;
}

export function toggleScopeBoxVisualizer(): boolean {
  if (enabled) disableScopeBoxVisualizer();
  else enableScopeBoxVisualizer();
  return enabled;
}
