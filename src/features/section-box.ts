// BIM-style live Section Box with 6-face crop and reset.
//
// Extended (v0.66): added 6 interactive face handles so the user can drag
// each face independently to size the section box live. Each face handle is
// a translucent Plane mesh positioned at the centre of its face, oriented
// perpendicular to the face normal. Dragging the handle moves that face only.
//
// Extended (BIM workflow): every face now also carries a double-headed drag
// arrow pointing along its face normal (standard section-box face handles).
// The arrow is a real drag target — grabbing it stretches or shrinks that
// face exactly like dragging the quad — and hovering either highlights the
// whole face. Arrow geometry is built along local +Z, which each face's
// rotation maps onto the outward normal, with the lift baked in so the
// arrow straddles the plane (inner head inside the crop, outer head proud).
import * as THREE from "three";
import { ctx } from "../core/context";
import { getSceneBox } from "./camera-tools";
import { registerCommand } from "./command-palette";
import {
  ARROW_SPEC,
  closestParamOnLine,
  faceCenter,
  FACE_DEFS,
  handleSize,
  moveBoxFace,
} from "./section-box-math";

let box: THREE.Box3 | null = null;
let helper: THREE.Box3Helper | null = null;
let faceGroup: THREE.Group | null = null;
let enabled = false;

/** Hovered face (matches by axis+sign across the plane and its arrow). */
let hoveredFace: { axis: "x" | "y" | "z"; sign: 1 | -1 } | null = null;

/** Face-quad opacity: faint at rest so the model shows through, stronger on hover. */
const PLANE_OPACITY = { base: 0.3, hot: 0.55 } as const;

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

/** Clipper planes created by the section box itself - the Section tool's own planes are left alone. */
let boxItems: any[] = [];
let usedNativeClipping = false;

function clipperItems(c: any): any[] {
  try {
    const list = c?.list;
    if (!list) return [];
    const entries: any[] = list[Symbol.iterator] ? [...list] : Object.values(list);
    return entries.map((e) => (Array.isArray(e) ? e[1] : e)).filter(Boolean);
  } catch { return []; }
}

function planeOf(item: any): THREE.Plane | null {
  const p = item?.three?.plane ?? item?.plane ?? item?.three ?? null;
  return p && p.normal ? (p as THREE.Plane) : null;
}

/** Clipper items that existed before the box added its planes, and the plane equations the box last asked for. */
let baselineItems = new Set<any>();
let lastSpecPlanes: THREE.Plane[] = [];

/** The clipper may register planes asynchronously, so the box's own planes are found again by geometry when removing. */
function currentBoxItems(): any[] {
  const known = new Set<any>(boxItems);
  const eq = (a: THREE.Plane, b: THREE.Plane) =>
    (a.normal.distanceToSquared(b.normal) < 1e-8 && Math.abs(a.constant - b.constant) < 1e-6) ||
    (a.normal.clone().negate().distanceToSquared(b.normal) < 1e-8 && Math.abs(-a.constant - b.constant) < 1e-6); // ThatOpen may store the flipped plane
  for (const it of clipperItems(clipper())) {
    if (known.has(it) || baselineItems.has(it)) continue;
    const pl = planeOf(it);
    if (pl && lastSpecPlanes.some((sp) => eq(pl, sp))) known.add(it);
  }
  return [...known];
}

function removeBoxItems(): void {
  const c = clipper();
  const world = (ctx as any).world;
  boxItems = currentBoxItems();
  // Remember the planes we are about to delete: ThatOpen keeps pushing them into renderer.clippingPlanes and does not
  // always take them out again, which left the whole model clipped (and the list growing by 6 on every edit).
  const gone: THREE.Plane[] = [];
  for (const item of boxItems) { const pl = planeOf(item); if (pl) gone.push(pl); }
  for (const item of boxItems) {
    try {
      // Clipper.delete(world, id) takes the list KEY, not the plane object - passing the object silently did nothing.
      const key = c?.list?.getKey?.(item);
      if (key != null && typeof c.list.delete === "function") c.list.delete(key);
      else item?.dispose?.();
    } catch { try { item?.dispose?.(); } catch { /* */ } }
  }
  boxItems = [];
  try {
    const r = world?.renderer?.three;
    if (r) {
      if (usedNativeClipping) r.clippingPlanes = [];
      else if (Array.isArray(r.clippingPlanes) && gone.length) {
        const same = (a: THREE.Plane, b: THREE.Plane) => a === b || (a.normal.distanceToSquared(b.normal) < 1e-12 && Math.abs(a.constant - b.constant) < 1e-9);
        r.clippingPlanes = r.clippingPlanes.filter((p: THREE.Plane) => !gone.some((g) => same(p, g)));
      }
    }
  } catch { /* */ }
  usedNativeClipping = false;
}

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
    detail: { message: "Section Box ON — drag the cyan arrows on each face to stretch or shrink", kind: "success" },
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
  removeBoxItems();
  try {
    const renderer = (ctx as any).world?.renderer?.three;
    // keep local clipping on while Section-tool planes still exist
    if (renderer && clipperItems(clipper()).length === 0) renderer.localClippingEnabled = false;
  } catch { /* */ }
  detachPointerHandlers();
  hoveredFace = null;
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

/**
 * Build the 6 face handles: a translucent drag quad plus a BIM-style
 * double-headed arrow on each face. Both carry the same "section-box-face"
 * userData, so the existing drag logic treats them as one handle per face.
 */
function buildFaceHandles(): void {
  if (!box) return;
  faceGroup = new THREE.Group();
  faceGroup.name = "obs-section-box-handles";

  // Shared geometry for all six faces (local units; scaled per handle).
  const planeGeo = new THREE.PlaneGeometry(0.6, 0.6);
  const shaftGeo = new THREE.CylinderGeometry(ARROW_SPEC.shaftR, ARROW_SPEC.shaftR, ARROW_SPEC.shaftLen, 12);
  shaftGeo.rotateX(Math.PI / 2); // cylinder Y axis → Z
  const coneOutGeo = new THREE.ConeGeometry(ARROW_SPEC.coneR, ARROW_SPEC.coneLen, 16);
  coneOutGeo.rotateX(Math.PI / 2);  // apex +Y → +Z (outward head)
  const coneInGeo = new THREE.ConeGeometry(ARROW_SPEC.coneR, ARROW_SPEC.coneLen, 16);
  coneInGeo.rotateX(-Math.PI / 2); // apex +Y → −Z (inward head)
  const headOutZ = ARROW_SPEC.lift + ARROW_SPEC.shaftLen / 2 + ARROW_SPEC.coneLen / 2;
  const headInZ = ARROW_SPEC.lift - ARROW_SPEC.shaftLen / 2 - ARROW_SPEC.coneLen / 2;

  for (const def of FACE_DEFS) {
    const ud = { kind: "section-box-face", axis: def.axis, sign: def.sign, label: def.label };

    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: PLANE_OPACITY.base,
      depthTest: false,
    });
    const plane = new THREE.Mesh(planeGeo, planeMat);
    plane.rotation.set(...def.rotation);
    plane.renderOrder = 1000;
    plane.userData = { ...ud, part: "plane" };
    faceGroup!.add(plane);

    const arrow = new THREE.Group();
    arrow.rotation.set(...def.rotation); // same mapping: local +Z = outward normal
    arrow.userData = { ...ud, part: "arrow" };
    const arrowMat = new THREE.MeshBasicMaterial({
      color: 0x22d3ee,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    const shaft = new THREE.Mesh(shaftGeo, arrowMat);
    shaft.position.z = ARROW_SPEC.lift;
    const headOut = new THREE.Mesh(coneOutGeo, arrowMat);
    headOut.position.z = headOutZ;
    const headIn = new THREE.Mesh(coneInGeo, arrowMat);
    headIn.position.z = headInZ;
    for (const part of [shaft, headOut, headIn]) {
      part.renderOrder = 1001; // draw after the quad so the arrow reads on top
      part.userData = { ...ud, part: "arrow-mesh" };
      arrow.add(part);
    }
    faceGroup!.add(arrow);
  }
  positionFaceHandles();
  ctx.world.scene.three.add(faceGroup);
  updateHandleScale();
}

function positionFaceHandles(): void {
  if (!faceGroup || !box) return;
  // Both the quads and the arrow groups are face handles: centre each on
  // its face (arrow heads straddle the plane via the baked-in lift).
  for (const h of faceGroup.children) {
    const ud = h.userData;
    if (ud?.kind !== "section-box-face") continue;
    const c = faceCenter(
      { min: box.min, max: box.max },
      ud.axis as "x" | "y" | "z",
      ud.sign as 1 | -1,
    );
    h.position.set(c.x, c.y, c.z);
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

  // Replace only the box's own previous planes (Section-tool planes stay).
  removeBoxItems();
  const existingItems = new Set(clipperItems(c));
  baselineItems = existingItems;
  lastSpecPlanes = specs.map((sp) => new THREE.Plane(sp.normal.clone(), -sp.point.dot(sp.normal)));

  let applied = false;
  const created: any[] = [];

  // API 1 — preferred
  if (c && world && typeof c.createFromNormalAndCoplanarPoint === "function") {
    try {
      for (const s of specs) {
        const made = c.createFromNormalAndCoplanarPoint(world, s.normal.clone(), s.point.clone());
        if (made && typeof made === "object") created.push(made);
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
        if (item && typeof item === "object") created.push(item);
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

  if (applied) {
    const diff = clipperItems(c).filter((i) => !existingItems.has(i));
    boxItems = created.length >= diff.length ? created : diff;
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
        usedNativeClipping = true;
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
  window.addEventListener("pointermove", onCanvasPointerMove, true); // capture: the input router stops propagation of moves during its own drags
  window.addEventListener("pointerup", onCanvasPointerUp, true);
  window.addEventListener("pointercancel", onCanvasPointerUp, true);
}

function detachPointerHandlers(): void {
  const canvas = (ctx as any).world?.renderer?.three?.domElement as HTMLElement | undefined;
  canvas?.removeEventListener("pointerdown", onCanvasPointerDown, true);
  window.removeEventListener("pointermove", onCanvasPointerMove, true);
  window.removeEventListener("pointerup", onCanvasPointerUp, true);
  window.removeEventListener("pointercancel", onCanvasPointerUp, true);
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
  // Arrows are groups of cone/shaft meshes: raycast recursively, then climb
  // to the face handle (quad or arrow group) that owns the hit.
  const hits = raycaster.intersectObjects(faceGroup.children, true);
  if (!hits.length) return null;
  let o: THREE.Object3D | null = hits[0].object;
  while (o && o !== faceGroup) {
    if (o.userData?.kind === "section-box-face") return o;
    o = o.parent;
  }
  return null;
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

/** Restyle every face so the hovered (or dragged) one lights up. */
function applyHoverStyles(): void {
  if (!faceGroup) return;
  for (const h of faceGroup.children) {
    const ud = h.userData;
    if (ud?.kind !== "section-box-face") continue;
    const hot = !!hoveredFace && ud.axis === hoveredFace.axis && ud.sign === hoveredFace.sign;
    if ((h as THREE.Mesh).isMesh) {
      // Face quad: raise its translucency while hovered.
      const m = (h as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if (m) m.opacity = hot ? PLANE_OPACITY.hot : PLANE_OPACITY.base;
    } else {
      // Arrow group: brighten the shaft + heads.
      h.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (!m || !(m as unknown as { isMaterial?: boolean }).isMaterial) return;
        m.opacity = hot ? 1 : 0.9;
        m.color.setHex(hot ? 0x67e8f9 : 0x22d3ee);
      });
    }
  }
}

function setHoveredFace(face: { axis: "x" | "y" | "z"; sign: 1 | -1 } | null): void {
  hoveredFace = face;
  applyHoverStyles();
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
  setHoveredFace({ axis: ud.axis, sign: ud.sign });
  // Capture phase: keep the camera controls from also orbiting.
  event.preventDefault();
  event.stopImmediatePropagation();
}

function onCanvasPointerMove(event: PointerEvent): void {
  if (!faceDragState) {
    if (faceGroup && raycaster) {
      updateHandleScale();
      const hit = castRayOnHandles(getNDC(event));
      const ud = hit?.userData as { axis?: "x" | "y" | "z"; sign?: 1 | -1 } | undefined;
      setHoveredFace(ud?.axis && ud?.sign ? { axis: ud.axis, sign: ud.sign } : null);
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
  setHoveredFace(null);
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
    debugPlanes: () => ({ dragging: !!faceDragState, boxItems: boxItems.length, clipperList: clipperItems(clipper()).length, renderer: ((ctx as any).world?.renderer?.three?.clippingPlanes ?? []).length }),
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