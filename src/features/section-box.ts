// BIM-style live Section Box with 6-face crop and reset.
//
// Extended (v0.66): added 6 interactive face handles so the user can drag
// each face independently to size the section box live. Each face handle is
// a translucent Plane mesh positioned at the centre of its face, oriented
// perpendicular to the face normal. Dragging the handle moves that face only.
import * as THREE from "three";
import { ctx } from "../core/context";
import { getSceneBox } from "./camera-tools";
import { registerCommand } from "./command-palette";

let box: THREE.Box3 | null = null;
let helper: THREE.Box3Helper | null = null;
let faceGroup: THREE.Group | null = null;
let enabled = false;

/** Per-face drag handle definitions: axis + sign + rotation. */
const FACE_DEFS: Array<{
  axis: "x" | "y" | "z";
  sign: 1 | -1;
  rotation: [number, number, number];
  label: string;
}> = [
  { axis: "x", sign: -1, rotation: [0, -Math.PI / 2, 0], label: "−X face" },
  { axis: "x", sign:  1, rotation: [0,  Math.PI / 2, 0], label: "+X face" },
  { axis: "y", sign: -1, rotation: [ Math.PI / 2, 0, 0], label: "−Y face (bottom)" },
  { axis: "y", sign:  1, rotation: [-Math.PI / 2, 0, 0], label: "+Y face (top)" },
  { axis: "z", sign: -1, rotation: [Math.PI, 0, 0],     label: "−Z face" },
  { axis: "z", sign:  1, rotation: [0, 0, 0],            label: "+Z face" },
];

/** Internal drag state for live face editing. */
let faceDragState: {
  axis: "x" | "y" | "z";
  sign: 1 | -1;
  startBox: THREE.Box3;
  startPointerWorld: THREE.Vector3;
  dragPlane: THREE.Plane;
} | null = null;
let raycaster: THREE.Raycaster | null = null;
let pointerNDC: THREE.Vector2 | null = null;

function clipper(): any { return (ctx as any).clipper; }

export function isSectionBoxActive(): boolean { return enabled; }

export function toggleSectionBox(): boolean {
  if (enabled) disableSectionBox(); else enableSectionBox();
  return enabled;
}

export function enableSectionBox(padding = 1.0): void {
  if (enabled) return;
  const scene = getSceneBox();
  if (!scene || scene.isEmpty()) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Load a model first.", kind: "warn" },
    }));
    return;
  }
  box = scene.clone().expandByScalar(padding);
  buildHelper();
  buildFaceHandles();
  applyClipping();
  attachPointerHandlers();
  enabled = true;
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: "Section Box ON — drag cyan face handles to crop", kind: "success" },
  }));
}

export function disableSectionBox(): void {
  if (!enabled) return;
  try { clipper()?.deleteAll?.(); } catch (e) { /* ignore */ }
  detachPointerHandlers();
  if (faceGroup) {
    ctx.world.scene.three.remove(faceGroup);
    faceGroup.traverse((o: any) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m: THREE.Material) => m.dispose());
        else o.material.dispose();
      }
    });
    faceGroup = null;
  }
  if (helper) {
    ctx.world.scene.three.remove(helper);
    try { helper.geometry?.dispose?.(); } catch (e) { /* ignore */ }
    const mat = helper.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
    else mat?.dispose?.();
    helper = null;
  }
  box = null;
  enabled = false;
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: "Section Box OFF", kind: "info" },
  }));
}

export function resetSectionBox(): void {
  if (!enabled) return;
  const scene = getSceneBox();
  if (scene && !scene.isEmpty()) box = scene.clone().expandByScalar(1.0);
  if (helper && box) {
    helper.box.copy(box);
    helper.updateMatrixWorld(true);
  }
  if (faceGroup && box) positionFaceHandles();
  applyClipping();
}

function buildHelper(): void {
  if (!box) return;
  helper = new THREE.Box3Helper(box, new THREE.Color(0x22d3ee));
  helper.renderOrder = 999;
  const m = helper.material as THREE.LineBasicMaterial;
  if (m) m.depthTest = false;
  ctx.world.scene.three.add(helper);
}

/** Build 6 face handles (translucent planes at each face centre). */
function buildFaceHandles(): void {
  if (!box) return;
  faceGroup = new THREE.Group();
  faceGroup.name = "obs-section-box-handles";
  faceGroup.renderOrder = 1000;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const handleGeo = new THREE.PlaneGeometry(0.6, 0.6);
  for (const def of FACE_DEFS) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(handleGeo, mat);
    mesh.rotation.set(...def.rotation);
    mesh.userData = { kind: "section-box-face", axis: def.axis, sign: def.sign, label: def.label };
    faceGroup!.add(mesh);
  }
  positionFaceHandles();
  ctx.world.scene.three.add(faceGroup);
}

function positionFaceHandles(): void {
  if (!faceGroup || !box) return;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const handles = faceGroup.children.filter((c) => c.userData?.kind === "section-box-face");
  for (const h of handles) {
    const axis = h.userData.axis as "x" | "y" | "z";
    const sign = h.userData.sign as 1 | -1;
    const pos = center.clone();
    if (axis === "x") pos.x = sign < 0 ? box!.min.x : box!.max.x;
    else if (axis === "y") pos.y = sign < 0 ? box!.min.y : box!.max.y;
    else pos.z = sign < 0 ? box!.min.z : box!.max.z;
    h.position.copy(pos);
  }
}

function applyClipping(): void {
  if (!box) return;
  const c = clipper();
  if (!c) return;
  try {
    c.deleteAll?.();
    const min = box.min;
    const max = box.max;
    const planes = [
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), max.x),
      new THREE.Plane(new THREE.Vector3( 1, 0, 0), -min.x),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), max.y),
      new THREE.Plane(new THREE.Vector3(0,  1, 0), -min.y),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), max.z),
      new THREE.Plane(new THREE.Vector3(0, 0,  1), -min.z),
    ];
    for (const p of planes) c.create?.(p);
  } catch (err) {
    console.warn("[section-box] clipping failed", err);
  }
}

// ── Interactive face handle dragging ────────────────────────────────────

function attachPointerHandlers(): void {
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement | undefined;
  if (!canvas) return;
  raycaster = new THREE.Raycaster();
  pointerNDC = new THREE.Vector2();
  canvas.addEventListener("pointerdown", onCanvasPointerDown);
  window.addEventListener("pointermove", onCanvasPointerMove);
  window.addEventListener("pointerup", onCanvasPointerUp);
}

function detachPointerHandlers(): void {
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement | undefined;
  canvas?.removeEventListener("pointerdown", onCanvasPointerDown);
  window.removeEventListener("pointermove", onCanvasPointerMove);
  window.removeEventListener("pointerup", onCanvasPointerUp);
  faceDragState = null;
}

function getNDC(event: PointerEvent): THREE.Vector2 {
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement;
  const rect = canvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

function castRayOnHandles(ndc: THREE.Vector2): THREE.Object3D | null {
  if (!raycaster || !faceGroup) return null;
  const camera = (ctx as any).world?.camera?.three as THREE.Camera | undefined;
  if (!camera) return null;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(faceGroup.children, false);
  return hits.length ? hits[0].object : null;
}

function getDragPointWorld(event: PointerEvent, plane: THREE.Plane): THREE.Vector3 {
  const ndc = getNDC(event);
  const camera = (ctx as any).world?.camera?.three as THREE.Camera | undefined;
  if (!raycaster || !camera) return new THREE.Vector3();
  raycaster.setFromCamera(ndc, camera);
  const target = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, target);
  return target;
}

function onCanvasPointerDown(event: PointerEvent): void {
  const target = castRayOnHandles(getNDC(event));
  if (!target) return;
  const ud = target.userData;
  if (ud?.kind !== "section-box-face") return;
  // Build drag plane perpendicular to face normal.
  const normal = new THREE.Vector3();
  if (ud.axis === "x") normal.set(1, 0, 0);
  else if (ud.axis === "y") normal.set(0, 1, 0);
  else normal.set(0, 0, 1);
  const plane = new THREE.Plane(normal, 0);
  const startPointerWorld = getDragPointWorld(event, plane);
  faceDragState = {
    axis: ud.axis,
    sign: ud.sign,
    startBox: box!.clone(),
    startPointerWorld,
    dragPlane: plane,
  };
  (event.target as HTMLElement).style.cursor = "grabbing";
  event.preventDefault();
  event.stopPropagation();
}

function onCanvasPointerMove(event: PointerEvent): void {
  if (!faceDragState) {
    // Hover cursor for handles.
    if (faceGroup && raycaster && pointerNDC) {
      const hit = castRayOnHandles(getNDC(event));
      const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement;
      if (canvas) canvas.style.cursor = hit ? "grab" : "default";
    }
    return;
  }
  const current = getDragPointWorld(event, faceDragState.dragPlane);
  const delta = current.clone().sub(faceDragState.startPointerWorld).dot(
    new THREE.Vector3(
      faceDragState.axis === "x" ? 1 : 0,
      faceDragState.axis === "y" ? 1 : 0,
      faceDragState.axis === "z" ? 1 : 0,
    ),
  );
  const newBox = faceDragState.startBox.clone();
  const sign = faceDragState.sign;
  if (faceDragState.axis === "x") {
    if (sign < 0) newBox.min.x = Math.min(newBox.min.x + delta, newBox.max.x - 0.5);
    else newBox.max.x = Math.max(newBox.max.x + delta, newBox.min.x + 0.5);
  } else if (faceDragState.axis === "y") {
    if (sign < 0) newBox.min.y = Math.min(newBox.min.y + delta, newBox.max.y - 0.5);
    else newBox.max.y = Math.max(newBox.max.y + delta, newBox.min.y + 0.5);
  } else {
    if (sign < 0) newBox.min.z = Math.min(newBox.min.z + delta, newBox.max.z - 0.5);
    else newBox.max.z = Math.max(newBox.max.z + delta, newBox.min.z + 0.5);
  }
  box = newBox;
  if (helper) helper.box.copy(newBox);
  positionFaceHandles();
  applyClipping();
}

function onCanvasPointerUp(): void {
  if (!faceDragState) return;
  faceDragState = null;
  document.body.style.cursor = "default";
}

// ── Convenience APIs for ribbon + commands ───────────────────────────────

/** Grow / shrink the section box by `amount` (m) on all sides. */
export function growSectionBox(amount: number): void {
  if (!enabled || !box) return;
  box.expandByScalar(amount);
  if (helper) helper.box.copy(box);
  positionFaceHandles();
  applyClipping();
}

/** Move the section box centre to a target world position. */
export function moveSectionBox(target: THREE.Vector3): void {
  if (!enabled || !box) return;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const delta = target.clone().sub(center);
  box.translate(delta);
  if (helper) helper.box.copy(box);
  positionFaceHandles();
  applyClipping();
}

export function setupSectionBox(): void {
  (ctx.features as any).sectionBox = {
    enable: enableSectionBox,
    disable: disableSectionBox,
    toggle: toggleSectionBox,
    reset: resetSectionBox,
    isActive: isSectionBoxActive,
    getBox: () => box ? box.clone() : null,
    setBox: (b: THREE.Box3) => {
      box = b.clone();
      if (helper) helper.box.copy(box);
      positionFaceHandles();
      applyClipping();
    },
    grow: growSectionBox,
    move: moveSectionBox,
  };

  try {
    registerCommand({
      id: "view.sectionBox",
      label: "View: Section Box (on/off)",
      category: "View",
      run: () => toggleSectionBox(),
    });
    registerCommand({
      id: "view.sectionBox.reset",
      label: "View: Reset Section Box",
      category: "View",
      run: () => resetSectionBox(),
      when: () => isSectionBoxActive(),
    });
    registerCommand({
      id: "view.sectionBox.grow",
      label: "View: Section Box Grow (+0.5 m)",
      category: "View",
      run: () => growSectionBox(0.5),
      when: () => isSectionBoxActive(),
    });
    registerCommand({
      id: "view.sectionBox.shrink",
      label: "View: Section Box Shrink (−0.5 m)",
      category: "View",
      run: () => growSectionBox(-0.5),
      when: () => isSectionBoxActive(),
    });
  } catch (err) {
    console.warn("[section-box] command registration failed", err);
  }

  console.log("[section-box] ready (with interactive face handles)");
}