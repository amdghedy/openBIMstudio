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
import { closestParamOnLine, handleSize, moveBoxFace } from "./section-box-math";

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
  /** Axis parameter under the pointer at drag start, and the face value then. */
  startParam: number;
  startValue: number;
  /** Camera controls state to restore when the drag ends. */
  controlsWasEnabled: boolean | null;
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

/** Enable the section box around an explicit world box (e.g. a selection), without needing loaded models. */
export function enableSectionBoxWithBox(b: THREE.Box3): void {
  if (!b || b.isEmpty()) return;
  if (enabled) {
    box = b.clone();
    if (helper) helper.box.copy(box);
    positionFaceHandles();
    applyClipping();
    return;
  }
  box = b.clone();
  buildHelper();
  buildFaceHandles();
  applyClipping();
  attachPointerHandlers();
  enabled = true;
}

export function disableSectionBox(): void {
  if (!enabled) return;
  try { clipper()?.deleteAll?.(); } catch (e) { /* ignore */ }
  try {
    const renderer = (ctx as any).world?.renderer?.three;
    if (renderer) {
      renderer.clippingPlanes = [];
      renderer.localClippingEnabled = false;
    }
  } catch { /* */ }
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
  updateHandleScale();
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

/**
 * Apply 6 clipping planes for the current section box.
 *
 * ThatOpen Clipper.create() expects a *world*, not a THREE.Plane.
 * Passing a Plane made the SDK construct a Casters/raycaster without a
 * renderer → "A renderer is needed for the raycaster to work!".
 *
 * Correct APIs (same as features/section.ts):
 *   1. createFromNormalAndCoplanarPoint(world, normal, coplanarPoint)
 *   2. create(world) then mutate item.three.plane
 * Fallback: assign THREE.WebGLRenderer.clippingPlanes directly.
 */
function applyClipping(): void {
  if (!box) return;
  const c = clipper();
  const world = (ctx as any).world;
  const min = box.min;
  const max = box.max;

  // Plane specs: outward normals so the *inside* of the box is kept.
  // THREE.Plane: normal · x + constant = 0  →  constant = -normal · point
  const specs: Array<{ normal: THREE.Vector3; point: THREE.Vector3 }> = [
    { normal: new THREE.Vector3( 1, 0, 0), point: new THREE.Vector3(max.x, 0, 0) }, // +X face (keep x <= max.x)
    { normal: new THREE.Vector3(-1, 0, 0), point: new THREE.Vector3(min.x, 0, 0) }, // -X
    { normal: new THREE.Vector3( 0, 1, 0), point: new THREE.Vector3(0, max.y, 0) }, // +Y
    { normal: new THREE.Vector3( 0,-1, 0), point: new THREE.Vector3(0, min.y, 0) }, // -Y
    { normal: new THREE.Vector3( 0, 0, 1), point: new THREE.Vector3(0, 0, max.z) }, // +Z
    { normal: new THREE.Vector3( 0, 0,-1), point: new THREE.Vector3(0, 0, min.z) }, // -Z
  ];

  // Clear existing clip planes
  try {
    if (c && typeof c.deleteAll === "function") c.deleteAll();
  } catch { /* */ }

  let applied = false;

  // API 1 — preferred
  if (c && world && typeof c.createFromNormalAndCoplanarPoint === "function") {
    try {
      for (const s of specs) {
        c.createFromNormalAndCoplanarPoint(world, s.normal.clone(), s.point.clone());
      }
      applied = true;
    } catch (err) {
      console.warn("[section-box] createFromNormalAndCoplanarPoint failed", err);
    }
  }

  // API 2 — create(world) then set plane
  if (!applied && c && world && typeof c.create === "function") {
    try {
      for (const s of specs) {
        const item: any = c.create(world);
        const plane: THREE.Plane | undefined =
          item?.three?.plane ?? item?.plane ?? item?.three;
        if (plane?.normal) {
          plane.normal.copy(s.normal);
          plane.constant = -s.point.dot(s.normal);
        }
      }
      applied = true;
    } catch (err) {
      console.warn("[section-box] clipper.create(world) failed", err);
    }
  }

  // Fallback — native WebGLRenderer clippingPlanes (no ThatOpen raycaster)
  if (!applied) {
    try {
      const renderer =
        (world as any)?.renderer?.three ??
        (ctx as any).world?.renderer?.three;
      if (renderer) {
        // THREE keeps the side the plane normal points to, so the outward
        // normals above must be flipped to keep the INSIDE of the box.
        const threePlanes = specs.map((s) => {
          const n = s.normal.clone().negate();
          return new THREE.Plane(n, -s.point.dot(n));
        });
        renderer.clippingPlanes = threePlanes;
        renderer.localClippingEnabled = true;
        applied = true;
      }
    } catch (err) {
      console.warn("[section-box] native clippingPlanes fallback failed", err);
    }
  }

  if (!applied) {
    console.warn(
      "[section-box] could not apply clipping — clipper missing or world/renderer not ready",
    );
  }

  // Ensure ThatOpen clipper is enabled when present
  try {
    if (c && "enabled" in c) c.enabled = true;
  } catch { /* */ }
}

// ── Interactive face handle dragging ────────────────────────────────────

function attachPointerHandlers(): void {
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement | undefined;
  if (!canvas) return;
  raycaster = new THREE.Raycaster();
  pointerNDC = new THREE.Vector2();
  canvas.addEventListener("pointerdown", onCanvasPointerDown, true);
  window.addEventListener("pointermove", onCanvasPointerMove);
  window.addEventListener("pointerup", onCanvasPointerUp);
}

function detachPointerHandlers(): void {
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement | undefined;
  canvas?.removeEventListener("pointerdown", onCanvasPointerDown, true);
  window.removeEventListener("pointermove", onCanvasPointerMove);
  window.removeEventListener("pointerup", onCanvasPointerUp);
  if (faceDragState && faceDragState.controlsWasEnabled !== false) setControls(true);
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

function axisDir(axis: "x" | "y" | "z"): THREE.Vector3 {
  return new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
}

/** Parameter along the face axis (through the box centre) closest to the pointer ray. */
function pointerAxisParam(event: PointerEvent, axis: "x" | "y" | "z"): number | null {
  const camera = (ctx as any).world?.camera?.three as THREE.Camera | undefined;
  if (!raycaster || !camera || !box) return null;
  raycaster.setFromCamera(getNDC(event), camera);
  const c = box.getCenter(new THREE.Vector3());
  return closestParamOnLine(raycaster.ray.origin, raycaster.ray.direction, c, axisDir(axis));
}

function faceValue(b: THREE.Box3, axis: "x" | "y" | "z", sign: 1 | -1): number {
  return sign < 0 ? b.min[axis] : b.max[axis];
}

function updateHandleScale(): void {
  if (!faceGroup || !box) return;
  const cam = (ctx as any).world?.camera?.three as THREE.Camera | undefined;
  if (!cam) return;
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  for (const h of faceGroup.children) {
    const d = cam.position.distanceTo(h.position);
    const k = handleSize(d, maxDim) / 0.6;
    h.scale.set(k, k, k);
  }
}

function setControls(enabled: boolean): void {
  try { const c: any = (ctx as any).world?.camera?.controls; if (c) c.enabled = enabled; } catch { /* */ }
}

function onCanvasPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const target = castRayOnHandles(getNDC(event));
  if (!target) return;
  const ud = target.userData;
  if (ud?.kind !== "section-box-face" || !box) return;
  const startParam = pointerAxisParam(event, ud.axis);
  if (startParam == null) return;
  let wasEnabled: boolean | null = null;
  try { wasEnabled = !!(ctx as any).world?.camera?.controls?.enabled; } catch { /* */ }
  setControls(false);
  faceDragState = {
    axis: ud.axis,
    sign: ud.sign,
    startBox: box.clone(),
    startParam,
    startValue: faceValue(box, ud.axis, ud.sign),
    controlsWasEnabled: wasEnabled,
  };
  (event.target as HTMLElement).style.cursor = "grabbing";
  // Capture phase: keep the camera controls from also orbiting.
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onCanvasPointerMove(event: PointerEvent): void {
  if (!faceDragState) {
    if (faceGroup && raycaster) {
      updateHandleScale();
      const hit = castRayOnHandles(getNDC(event));
      const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement;
      if (canvas) canvas.style.cursor = hit ? "grab" : "";
    }
    return;
  }
  const p = pointerAxisParam(event, faceDragState.axis);
  if (p == null) return;
  const value = faceDragState.startValue + (p - faceDragState.startParam);
  const nb = moveBoxFace(
    { min: faceDragState.startBox.min, max: faceDragState.startBox.max },
    faceDragState.axis, faceDragState.sign, value, 0.1,
  );
  box = new THREE.Box3(
    new THREE.Vector3(nb.min.x, nb.min.y, nb.min.z),
    new THREE.Vector3(nb.max.x, nb.max.y, nb.max.z),
  );
  if (helper) helper.box.copy(box);
  positionFaceHandles();
  updateHandleScale();
  applyClipping();
}

function onCanvasPointerUp(): void {
  if (!faceDragState) return;
  if (faceDragState.controlsWasEnabled !== false) setControls(true);
  faceDragState = null;
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement | undefined;
  if (canvas) canvas.style.cursor = "";
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
    enableWithBox: enableSectionBoxWithBox,
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