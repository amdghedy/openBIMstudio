import * as THREE from "three";
import type * as OBC from "@thatopen/components";
import { ctx, type Projection } from "../core/context";
import { forceResumeCameraControls } from "../core/camera-gate";
import { register, type CameraService } from "../core/services";
import { getElementWorldBoxes } from "../modules/geometry/world-box";

// ── Scene placement state ──
let recenterEnabled = false;
let sceneOffset: THREE.Vector3 | null = null;
let offsetEstablished = false;
const sceneCenter = new THREE.Vector3();
let sceneRadius = 10;
const lastSceneBox = new THREE.Box3();

export const boundsInfoEl = document.createElement("div");
boundsInfoEl.style.cssText = "font-size:10.5px;opacity:.7;margin-top:6px;line-height:1.5";
boundsInfoEl.textContent = "Scene: empty";

const boundsHelperGroup = new THREE.Group();
let showBounds = false;

export function setRecenterEnabled(on: boolean) {
  recenterEnabled = on;
}

export function resetPlacementState() {
  sceneOffset = null;
  offsetEstablished = false;
}

function worldReady(): boolean {
  try {
    const w: any = (ctx as any).world;
    return !!w && !!w.camera && !!w.camera.three;
  } catch {
    return false;
  }
}

function isOrthoCam(cam: THREE.Camera): boolean {
  return !!(cam as any).isOrthographicCamera;
}

function allCameras(): THREE.Camera[] {
  if (!worldReady()) return [];
  const c: any = ctx.world.camera;
  const out: any[] = [ctx.world.camera.three];
  const push = (x: any) => {
    if (!x) return;
    if (x.isCamera) out.push(x);
    else if (x.three?.isCamera) out.push(x.three);
  };
  push(c.perspectiveCamera);
  push(c.orthoCamera);
  push(c.orthographicCamera);
  return Array.from(new Set(out)).filter((x) => x && x.isCamera);
}

/**
 * Ensure the frustum of any orthographic camera is large enough to contain
 * the scene. This is what makes every camera-move work correctly in ortho.
 */
function fitOrthoFrustum(ortho: THREE.OrthographicCamera, radius: number): void {
  // Aspect must come from the viewport, not the current (possibly stale) frustum.
  let aspect = 1;
  try {
    const host = ctx.rightHost;
    if (host) {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) aspect = r.width / r.height;
    }
  } catch { /* */ }
  const safeAspect = Number.isFinite(aspect) && aspect > 0.01 ? aspect : 1;
  const safeR = Math.max(radius, 0.5);
  const halfH = safeR * 1.15;
  const halfW = halfH * safeAspect;
  ortho.left = -halfW;
  ortho.right = halfW;
  ortho.top = halfH;
  ortho.bottom = -halfH;
  ortho.zoom = 1;
  ortho.near = -safeR * 50;
  ortho.far = safeR * 200 + 1000;
  ortho.updateProjectionMatrix();
}

/** Orthographic cameras use near/far differently — set generously. */
function applyClipping(near: number, far: number) {
  for (const cam of allCameras()) {
    if (isOrthoCam(cam)) {
      let ortho = cam as THREE.OrthographicCamera;
    if (!(ortho as any).isOrthographicCamera) {
      const _c: any = ctx.world.camera;
      const _cands = [_c.orthographicCamera, _c.orthoCamera];
      for (const c of _cands) {
        const t: any = c?.three ?? c;
        if (t?.isOrthographicCamera) { ortho = t; break; }
      }
    }
      const safeFar = Math.max(Math.abs(far), sceneRadius * 4, 2000);
      let changed = false;
      // Ortho can use a negative near plane safely — this eliminates
      // z-fighting on flat models and keeps geometry behind the eye visible.
      const nearTarget = -safeFar;
      if (Math.abs(ortho.near - nearTarget) > 1e-3) {
        ortho.near = nearTarget;
        changed = true;
      }
      if (Math.abs(ortho.far - safeFar) > 1e-3) {
        ortho.far = safeFar;
        changed = true;
      }
      if (changed) ortho.updateProjectionMatrix();
    } else {
      const c = cam as THREE.PerspectiveCamera;
      let changed = false;
      if (Math.abs(c.near - near) > 1e-6) { c.near = near; changed = true; }
      if (Math.abs(c.far - far) > 1e-6) { c.far = far; changed = true; }
      if (changed) c.updateProjectionMatrix();
    }
  }
}

export function updateClipping() {
  if (!worldReady()) return;
  const cam = ctx.world.camera.three;
  const dist = Math.max(cam.position.distanceTo(sceneCenter), 0.05);
  const near = Math.max(0.005, (dist - sceneRadius) / 100);
  const far = (dist + sceneRadius) * 4 + 100;
  applyClipping(near, far);
}

function refreshBoundsInfo() {
  const size = new THREE.Vector3();
  lastSceneBox.getSize(size);
  const active: any = worldReady() ? ctx.world.camera.three : null;
  const isOrtho = active && isOrthoCam(active);
  const clip = isOrtho
    ? `Ortho zoom ${active.zoom?.toFixed(2) ?? "?"}`
    : `near ${active?.near?.toFixed(3) ?? "?"} / far ${active?.far?.toFixed(0) ?? "?"}`;
  boundsInfoEl.innerHTML = lastSceneBox.isEmpty()
    ? "Scene: empty"
    : `Scene: <b>${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} m</b><br>` +
      `Center: ${sceneCenter.x.toFixed(1)}, ${sceneCenter.y.toFixed(1)}, ${sceneCenter.z.toFixed(1)}<br>` +
      `Radius: ${sceneRadius.toFixed(1)} m · ${clip}`;
}

export function computeSceneBounds() {
  lastSceneBox.makeEmpty();
  try {
    for (const [, model] of ctx.fragments.list) {
      lastSceneBox.union(new THREE.Box3().setFromObject(model.object));
    }
  } catch {
    /* */
  }
  try {
    const ab = (ctx.features as any).fileInterop?.getAuxBox?.();
    if (ab && !ab.isEmpty()) lastSceneBox.union(ab);
  } catch {
    /* */
  }

  if (lastSceneBox.isEmpty()) {
    sceneCenter.set(0, 0, 0);
    sceneRadius = 10;
  } else {
    lastSceneBox.getCenter(sceneCenter);
    sceneRadius = Math.max(
      lastSceneBox.getBoundingSphere(new THREE.Sphere()).radius,
      0.5,
    );
  }
  updateClipping();
  try {
    (ctx.world.camera.controls as any).maxDistance = Math.max(
      sceneRadius * 100,
      1000,
    );
  } catch {
    /* */
  }
  refreshBoundsInfo();
  refreshBoundsHelpers();
}

function refreshBoundsHelpers() {
  while (boundsHelperGroup.children.length) {
    const ch = boundsHelperGroup.children[0] as any;
    boundsHelperGroup.remove(ch);
    ch.geometry?.dispose?.();
    ch.material?.dispose?.();
  }
  if (!showBounds) return;
  if (!lastSceneBox.isEmpty()) {
    boundsHelperGroup.add(
      new THREE.Box3Helper(lastSceneBox.clone(), new THREE.Color(0x22d3ee)),
    );
  }
  try {
    for (const [, model] of ctx.fragments.list) {
      const b = new THREE.Box3().setFromObject(model.object);
      if (!b.isEmpty()) {
        boundsHelperGroup.add(new THREE.Box3Helper(b, new THREE.Color(0xf59e0b)));
      }
    }
  } catch {
    /* */
  }
}

export function showBoundsHelpers(on: boolean) {
  showBounds = on;
  refreshBoundsHelpers();
}

function applySceneOffsetTo(modelId: string) {
  const model = ctx.fragments.list.get(modelId);
  if (!model) return;
  const off = sceneOffset ?? new THREE.Vector3();
  model.object.position.set(-off.x, -off.y, -off.z);
}

export function establishSceneOffset(modelId: string) {
  const model = ctx.fragments.list.get(modelId);
  if (!model) return;
  if (!recenterEnabled) return;
  if (!offsetEstablished) {
    offsetEstablished = true;
    const box = new THREE.Box3().setFromObject(model.object);
    sceneOffset = box.isEmpty()
      ? new THREE.Vector3()
      : box.getCenter(new THREE.Vector3());
  }
  applySceneOffsetTo(modelId);
}

export function alignOriginToOrigin() {
  try {
    sceneOffset = new THREE.Vector3();
    offsetEstablished = true;
    for (const id of Array.from(ctx.fragments.list.keys())) {
      const model = ctx.fragments.list.get(id);
      if (!model) continue;
      model.object.position.set(0, 0, 0);
      model.object.updateMatrixWorld(true);
    }
    computeSceneBounds();
    fitAll();
  } catch (err) {
    console.warn("[placement] alignOriginToOrigin", err);
  }
}

export function recenterSceneNow() {
  try {
    const ids = Array.from(ctx.fragments.list.keys());
    if (!ids.length) return;
    const first = ctx.fragments.list.get(ids[0])!;
    const curPos = first.object.position.clone();
    const box = new THREE.Box3().setFromObject(first.object);
    if (box.isEmpty()) return;
    sceneOffset = box.getCenter(new THREE.Vector3()).sub(curPos);
    offsetEstablished = true;
    for (const id of ids) applySceneOffsetTo(id);
    computeSceneBounds();
    fitAll();
  } catch (err) {
    console.warn("[placement] recenterSceneNow", err);
  }
}

export function resetOffsets() {
  sceneOffset = new THREE.Vector3();
  offsetEstablished = true;
  try {
    for (const id of Array.from(ctx.fragments.list.keys())) applySceneOffsetTo(id);
  } catch {
    /* */
  }
  computeSceneBounds();
}

/* ═════════════════════════════════════════════════════════════════════════
   Projection
   ═════════════════════════════════════════════════════════════════════════ */
let currentProjection: Projection = "perspective";

export function getSceneBox(): THREE.Box3 {
  return lastSceneBox.clone();
}
export function getProjection(): Projection {
  if (!worldReady()) return currentProjection;
  const cam: any = ctx.world.camera;
  const t = cam?.cameraType ?? cam?.projection?.current ?? cam?.projection;
  if (typeof t === "string") {
    if (/plan|ortho/i.test(t)) return "orthographic";
    if (/orbit|persp/i.test(t)) return "perspective";
  }
  return isOrthoCam(ctx.world.camera.three) ? "orthographic" : "perspective";
}

function afterProjectionChanged() {
  currentProjection = getProjection();
  try {
    for (const [, model] of ctx.fragments.list) model.useCamera(ctx.world.camera.three);
  } catch {
    /* */
  }
  try {
    ctx.fragments.core.update(true);
  } catch {
    /* */
  }

  if (currentProjection === "orthographic") {
    computeSceneBounds();
    const cam = ctx.world.camera.three as THREE.OrthographicCamera;
    if (isOrthoCam(cam)) fitOrthoFrustum(cam, sceneRadius);
  }
  updateClipping();
}

export function setProjection(mode: Projection): boolean {
  if (!worldReady()) {
    currentProjection = mode;
    return false;
  }
  const cam: any = ctx.world.camera;

  // Prefer projection.set — keeps orbit/pan/zoom free.
  // Do NOT use setCameraType("Plan") for Ortho: Plan locks navigation.
  if (cam.projection?.set) {
    try {
      cam.projection.set(mode === "perspective" ? "Perspective" : "Orthographic");
      try {
        if (cam.controls && cam.controls.enabled === false) cam.controls.enabled = true;
      } catch { /* */ }
      afterProjectionChanged();
      return true;
    } catch { /* fall through */ }
  }

  if (typeof cam.setCameraType === "function") {
    const attempts =
      mode === "perspective"
        ? ["Orbit", "OrbitCamera", "Perspective"]
        : ["Orthographic", "Orbit", "OrbitCamera"];
    for (const t of attempts) {
      try {
        cam.setCameraType(t as any);
        try {
          if (cam.controls && cam.controls.enabled === false) cam.controls.enabled = true;
        } catch { /* */ }
        afterProjectionChanged();
        return true;
      } catch { /* */ }
    }
  }

  console.warn(
    "[projection] could not switch — unsupported camera API in this SDK version",
  );
  return false;
}

/* ═════════════════════════════════════════════════════════════════════════
   Navigation
   ═════════════════════════════════════════════════════════════════════════ */
function getCamTarget(out: THREE.Vector3): THREE.Vector3 {
  if (!worldReady()) return out.copy(sceneCenter);
  const c: any = ctx.world.camera.controls;
  try {
    if (c.target?.isVector3) return out.copy(c.target);
  } catch {
    /* */
  }
  return out.copy(sceneCenter);
}

/**
 * Zoom by factor toward an optional world point (cursor focus).
 * factor > 1 = zoom out, factor < 1 = zoom in.
 */
/**
 * Pure zoom only — no orbit, no pan, no target shift (no vibration).
 * factor < 1 = zoom in, factor > 1 = zoom out.
 * Camera moves only along the current look axis; orientation stays fixed.
 */
export function zoomBy(factor: number, focusPoint?: THREE.Vector3) {
  if (!worldReady()) return;
  if (!Number.isFinite(factor) || factor <= 0) return;
  factor = Math.min(4.0, Math.max(0.15, factor));

  const cam = ctx.world.camera.three as any;
  const controls: any = ctx.world.camera.controls;
  const target = getCamTarget(new THREE.Vector3());

  try { if (controls && controls.enabled === false) controls.enabled = true; } catch { /* */ }

  // ── ORTHOGRAPHIC ─────────────────────────────────────────────────
  if (isOrthoCam(cam)) {
    let ortho = cam as THREE.OrthographicCamera;
    if (!(ortho as any).isOrthographicCamera) {
      const _c: any = ctx.world.camera;
      const _cands = [_c.orthographicCamera, _c.orthoCamera];
      for (const c of _cands) {
        const t: any = c?.three ?? c;
        if (t?.isOrthographicCamera) { ortho = t; break; }
      }
    }
    const oldZoom = Math.max(1e-3, ortho.zoom || 1);
    const newZoom = Math.max(0.01, Math.min(5000, oldZoom / factor));
    ortho.zoom = newZoom;
    ortho.updateProjectionMatrix();

    updateClipping();
    return;
  }

  // ── PERSPECTIVE ──────────────────────────────────────────────────
  const offset = new THREE.Vector3().subVectors(cam.position, target);
  const dist = offset.length();
  if (dist < 1e-6) return;
  const dir = offset.clone().multiplyScalar(1 / dist);
  const newDist = Math.max(0.05, dist * factor);
  let newPos = target.clone().add(dir.clone().multiplyScalar(newDist));
  let newTarget = target.clone();

  if (focusPoint && Number.isFinite(focusPoint.x)) {
    const viewN = dir.clone();
    const toFocus = focusPoint.clone().sub(target);
    const along = toFocus.dot(viewN);
    const focusOnPlane = focusPoint.clone().sub(viewN.clone().multiplyScalar(along));
    const lateral = focusOnPlane.clone().sub(target);
    const truck = lateral.multiplyScalar(1 - factor);
    newPos.add(truck);
    newTarget.add(truck);
  }

  try {
    controls.setLookAt(
      newPos.x, newPos.y, newPos.z,
      newTarget.x, newTarget.y, newTarget.z,
      false,
    );
  } catch {
    cam.position.copy(newPos);
    try { cam.lookAt(newTarget); } catch { /* */ }
  }
  try { controls.update?.(0); } catch { /* */ }
  updateClipping();
}

export function pickWorldPointUnderCursor(clientX: number, clientY: number): THREE.Vector3 | null {
  try {
    const host = ctx.rightHost;
    const rect = host.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    const cam = ctx.world.camera.three;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), cam);

    // Stable plane through the current orbit target, facing the camera.
    // This is the primary anchor so zoom never drifts when the cursor is
    // over empty space or distant background.
    const target = getCamTarget(new THREE.Vector3());
    const normal = new THREE.Vector3();
    cam.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.clone().negate(), target);
    const planeHit = new THREE.Vector3();
    const hasPlane = raycaster.ray.intersectPlane(plane, planeHit);

    // Prefer a nearby mesh hit if it is in front of the camera and not far
    // behind the target plane (keeps zoom "on the model" when hovering it).
    try {
      const hits = raycaster.intersectObjects(ctx.world.scene.three.children, true);
      const camPos = cam.position;
      const targetDist = camPos.distanceTo(target);
      for (const h of hits) {
        if (!h.point || !Number.isFinite(h.point.x)) continue;
        const d = camPos.distanceTo(h.point);
        if (d < 0.01) continue;
        // Accept hits roughly in front of / near the target depth.
        if (d < targetDist * 3 + 50) return h.point.clone();
      }
    } catch { /* */ }

    if (hasPlane && Number.isFinite(planeHit.x)) return planeHit;
  } catch { /* */ }
  return null;
}

export type ExactView = "top" | "bottom" | "front" | "back" | "right" | "left";

/**
 * Pure BIM-style cardinal view. Unlike gotoDir(), this deliberately ignores
 * Project North and the current camera rotation so Top really means +Y,
 * Front +Z, Right +X, etc. All cube-face and explicit view commands should use
 * this function to guarantee identical camera behavior.
 */
export function gotoExactView(view: ExactView): void {
  if (!worldReady()) return;
  const target = getCamTarget(new THREE.Vector3());
  const table: Record<ExactView, { dir: THREE.Vector3; up: THREE.Vector3 }> = {
    top: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) },
    bottom: { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
    front: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
    back: { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) },
    right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
    left: { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
  };
  const spec = table[view];
  const cam = ctx.world.camera.three;

  // In ortho, distance does not affect visible size; keep the camera close
  // so near/far clipping stays small and precise.
  const isOrtho = isOrthoCam(cam);
  const dist = isOrtho
    ? Math.max(sceneRadius * 1.5, 5)
    : Math.max(sceneRadius * 2, 10);
  const pos = target.clone().add(spec.dir.clone().multiplyScalar(dist));

  cam.up.copy(spec.up);
  ctx.world.camera.controls.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, true);
  cam.up.copy(spec.up);
  cam.lookAt(target);

  if (isOrtho) {
    fitOrthoFrustum(cam as THREE.OrthographicCamera, sceneRadius);
  }
  updateClipping();
}

export function gotoDir(dir: THREE.Vector3) {
  if (!worldReady()) return;
  const target = getCamTarget(new THREE.Vector3());
  const dist = Math.max(
    ctx.world.camera.three.position.distanceTo(target),
    sceneRadius,
    0.5,
  );
  const pos = target.clone().add(dir.clone().normalize().multiplyScalar(dist));
  if (Math.abs(dir.y) > 0.99) {
    pos.x += dist * 0.002;
    pos.z += dist * 0.002;
  }
  ctx.world.camera.controls.setLookAt(
    pos.x,
    pos.y,
    pos.z,
    target.x,
    target.y,
    target.z,
    true,
  );
  const cam = ctx.world.camera.three;
  if (isOrthoCam(cam)) fitOrthoFrustum(cam as THREE.OrthographicCamera, sceneRadius);
  updateClipping();
}

export function focusOnPoint(point: THREE.Vector3) {
  if (!worldReady()) return;
  // Remember current camera so Focus does not jump back to the start/home view
  preFocusView = saveCameraSnapshot();
  const cam = ctx.world.camera.three;
  const controls: any = ctx.world.camera.controls;

  const camToTarget = new THREE.Vector3().subVectors(cam.position, point);
  const horizontalDist = Math.hypot(camToTarget.x, camToTarget.z);
  let dir: THREE.Vector3;
  if (horizontalDist < 0.05) {
    dir = new THREE.Vector3(1.0, 0.7, 1.0).normalize();
  } else {
    const azimuth = Math.atan2(camToTarget.x, camToTarget.z);
    const pitchRaw = Math.atan2(camToTarget.y, horizontalDist);
    const pitch = THREE.MathUtils.clamp(
      pitchRaw,
      THREE.MathUtils.degToRad(-30),
      THREE.MathUtils.degToRad(60),
    );
    const cosP = Math.cos(pitch);
    dir = new THREE.Vector3(
      Math.sin(azimuth) * cosP,
      Math.sin(pitch),
      Math.cos(azimuth) * cosP,
    ).normalize();
  }

  // Fit so the object fills ~60% of the view (BIM Focus)
  computeSceneBounds();
  const targetDist = Math.max(sceneRadius * 0.12, 1.5, 0.5);
  const pos = point.clone().add(dir.multiplyScalar(targetDist * 1.8));
  try {
    controls.setLookAt(pos.x, pos.y, pos.z, point.x, point.y, point.z, true);
  } catch {
    cam.position.copy(pos);
    cam.lookAt(point);
  }
  if (isOrthoCam(cam)) {
    fitOrthoFrustum(cam as THREE.OrthographicCamera, Math.max(targetDist * 0.55, 0.8));
    cam.zoom = Math.max(cam.zoom || 1, 1.4);
    cam.updateProjectionMatrix();
  }
  updateClipping();
}

/** Focus a world-space box while preserving the current view direction. */

/**
 * Pin the orbit pivot to a world point without changing camera position.
 * Shift+MMB orbit will rotate around this point until the target is changed again.
 */
export function setOrbitPivot(point: THREE.Vector3): void {
  if (!worldReady()) return;
  if (!point || !Number.isFinite(point.x)) return;
  const cam = ctx.world.camera.three;
  const controls: any = ctx.world.camera.controls;
  if (!controls) return;
  const pos = cam.position.clone();

  // Direct write to the internal target first (works on all versions).
  try {
    if (controls.target?.isVector3) {
      controls.target.set(point.x, point.y, point.z);
    }
  } catch { /* */ }

  // Also tell camera-controls — this updates its interpolation endpoints.
  try {
    if (typeof controls.setTarget === "function") {
      controls.setTarget(point.x, point.y, point.z, false);
    }
  } catch { /* */ }

  // Force a look-at so the camera orientation matches the new target
  // even in versions where setTarget only updates the end state.
  try {
    if (typeof controls.setLookAt === "function") {
      controls.setLookAt(pos.x, pos.y, pos.z, point.x, point.y, point.z, false);
    } else {
      cam.lookAt(point);
    }
  } catch { /* */ }

  try { controls.update?.(0); } catch { /* */ }
  try { updateClipping(); } catch { /* */ }
}

/**
 * Pan the camera so that `point` sits at the screen center, WITHOUT
 * changing view direction or zoom. Sets the orbit target to `point`.
 */
export function centerOnPoint(point: THREE.Vector3): void {
  if (!worldReady()) return;
  if (!point || !Number.isFinite(point.x)) return;
  const cam = ctx.world.camera.three;
  const controls: any = ctx.world.camera.controls;
  if (!controls) return;

  // Read current target
  const oldTarget = new THREE.Vector3();
  if (controls.target?.isVector3) oldTarget.copy(controls.target);
  else {
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    oldTarget.copy(cam.position).add(dir.multiplyScalar(5));
  }

  // Pure translation: camera moves by delta, target becomes point.
  const delta = point.clone().sub(oldTarget);
  const newPos = cam.position.clone().add(delta);

  try {
    if (typeof controls.setLookAt === "function") {
      controls.setLookAt(newPos.x, newPos.y, newPos.z, point.x, point.y, point.z, true);
    } else {
      cam.position.copy(newPos);
      cam.lookAt(point);
    }
  } catch (err) {
    console.warn("[camera] centerOnPoint failed", err);
  }

  // After the smooth transition finishes, re-assert the pivot so
  // subsequent Shift+MMB orbits stay centered.
  setTimeout(() => {
    try { setOrbitPivot(point); } catch { /* */ }
  }, 220);

  try { updateClipping(); } catch { /* */ }
}

/** Resolve a sensible pivot from current fragment + authored selection. */
export async function pivotOnSelection(
  idMap?: Record<string, Set<number>> | null,
): Promise<boolean> {
  if (!worldReady()) return false;
  const box = new THREE.Box3();
  let found = false;

  // ── Fragment selection (use WORLD boxes, not local) ──
  try {
    const map = idMap && Object.keys(idMap).length
      ? idMap
      : (await import("./selection")).selection.snapshot();
    for (const [modelId, ids] of Object.entries(map ?? {})) {
      const model: any = ctx.fragments.list.get(modelId);
      if (!model || !ids || !(ids as Set<number>).size) continue;
      try {
        const wbs = await getElementWorldBoxes(model, [...(ids as Set<number>)], modelId);
        for (const wb of wbs) {
          if (wb?.box && !wb.box.isEmpty()) { box.union(wb.box); found = true; }
        }
      } catch (err) {
        console.warn("[camera] pivot world-box read failed", modelId, err);
      }
    }
  } catch { /* */ }

  // ── Authored selection ──
  try {
    const auth: any = (ctx.features as any).authoring;
    const ids: string[] = auth?.getSelectedIds?.() ?? [];
    for (const id of ids) {
      const el = auth?.getElementById?.(id);
      if (!el) continue;
      const wb = auth?.getElementWorldBox?.(el);
      if (wb && !wb.isEmpty()) { box.union(wb); found = true; }
    }
  } catch { /* */ }

  if (!found || box.isEmpty()) return false;
  const center = box.getCenter(new THREE.Vector3());
  setOrbitPivot(center);
  return true;
}

export function focusOnBox(box: THREE.Box3): void {
  if (!worldReady() || box.isEmpty()) return;
  preFocusView = saveCameraSnapshot();

  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.5);
  const cam = ctx.world.camera.three;
  const controls: any = ctx.world.camera.controls;

  const camToCenter = new THREE.Vector3().subVectors(cam.position, center);
  const horizontalDist = Math.hypot(camToCenter.x, camToCenter.z);
  let dir: THREE.Vector3;
  if (horizontalDist < Math.max(radius * 0.15, 0.05)) {
    dir = new THREE.Vector3(1, 0.7, 1).normalize();
  } else {
    const azimuth = Math.atan2(camToCenter.x, camToCenter.z);
    const pitchRaw = Math.atan2(camToCenter.y, horizontalDist);
    const pitch = THREE.MathUtils.clamp(
      pitchRaw,
      THREE.MathUtils.degToRad(-30),
      THREE.MathUtils.degToRad(60),
    );
    const cosP = Math.cos(pitch);
    dir = new THREE.Vector3(
      Math.sin(azimuth) * cosP,
      Math.sin(pitch),
      Math.cos(azimuth) * cosP,
    ).normalize();
  }

  if (isOrthoCam(cam)) {
    const dist = Math.max(radius * 1.5, 5);
    controls.setLookAt(
      center.x + dir.x * dist,
      center.y + dir.y * dist,
      center.z + dir.z * dist,
      center.x, center.y, center.z,
      true,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(center);
    fitOrthoFrustum(cam as THREE.OrthographicCamera, radius);
  } else {
    const persp = cam as THREE.PerspectiveCamera;
    const vFov = THREE.MathUtils.degToRad(persp.fov ?? 60);
    const dist = (radius / Math.sin(Math.max(vFov, 0.3) / 2)) * 1.15;
    controls.setLookAt(
      center.x + dir.x * dist,
      center.y + dir.y * dist,
      center.z + dir.z * dist,
      center.x, center.y, center.z,
      true,
    );
  }
  updateClipping();
}

/**
 * Handles a stationary RMB on geometry. Returns true when an object was hit,
 * so the context menu can remain closed. A dragged RMB is handled separately
 * by the camera navigation / Ctrl-crossing selection gesture.
 */
export async function handleRightClickFocus(e: MouseEvent): Promise<boolean> {
  // Auto right-click focus disabled: explicit context-menu Focus preserves selection.
  void e;
  return false;
}

/* ═════════════════════════════════════════════════════════════════════════
   Home view
   ═════════════════════════════════════════════════════════════════════════ */
let homeView: { pos: THREE.Vector3; target: THREE.Vector3; zoom?: number } | null = null;
let preFocusView: { pos: THREE.Vector3; target: THREE.Vector3; zoom?: number } | null = null;


export function saveCameraSnapshot(): { pos: THREE.Vector3; target: THREE.Vector3; zoom?: number } | null {
  if (!worldReady()) return null;
  const cam = ctx.world.camera.three as any;
  return {
    pos: cam.position.clone(),
    target: getCamTarget(new THREE.Vector3()).clone(),
    zoom: isOrthoCam(cam) ? Number(cam.zoom) : undefined,
  };
}
export function restoreCameraSnapshot(snap: { pos: THREE.Vector3; target: THREE.Vector3; zoom?: number } | null): void {
  if (!snap || !worldReady()) return;
  const controls: any = ctx.world.camera.controls;
  const cam = ctx.world.camera.three as any;
  try {
    controls.setLookAt(snap.pos.x, snap.pos.y, snap.pos.z, snap.target.x, snap.target.y, snap.target.z, true);
  } catch {
    cam.position.copy(snap.pos);
  }
  if (snap.zoom != null && isOrthoCam(cam)) {
    cam.zoom = snap.zoom;
    cam.updateProjectionMatrix();
  }
  updateClipping();
}

export function saveHome() {
  if (!worldReady()) return;
  homeView = {
    pos: ctx.world.camera.three.position.clone(),
    target: getCamTarget(new THREE.Vector3()).clone(),
  };
}

export function goHome() {
  if (!worldReady()) return;
  if (homeView) {
    ctx.world.camera.controls.setLookAt(
      homeView.pos.x,
      homeView.pos.y,
      homeView.pos.z,
      homeView.target.x,
      homeView.target.y,
      homeView.target.z,
      true,
    );
    const cam = ctx.world.camera.three;
    if (isOrthoCam(cam)) fitOrthoFrustum(cam as THREE.OrthographicCamera, sceneRadius);
    updateClipping();
  } else fitAll();
}

export function fitAll() {
  if (!worldReady()) return;
  computeSceneBounds();

  if (lastSceneBox.isEmpty()) {
    const modelCount = (() => { try { return ctx.fragments.list.size; } catch { return 0; } })();
    if (modelCount > 0) {
      console.warn(`[camera] fitAll: ${modelCount} model(s) present but scene bounds are empty — retrying in 200 ms.`);
      setTimeout(() => { try { fitAll(); } catch { /* */ } }, 200);
    }
    return;
  }

  const cam = ctx.world.camera.three;
  const controls: any = ctx.world.camera.controls;
  const dir = new THREE.Vector3(1.2, 0.7, 1.2).normalize();

  if (isOrthoCam(cam)) {
    // Orthographic: the frustum IS the fit. Position the camera a
    // comfortable distance from the scene center along the look dir.
    let ortho = cam as THREE.OrthographicCamera;
    if (!(ortho as any).isOrthographicCamera) {
      const _c: any = ctx.world.camera;
      const _cands = [_c.orthographicCamera, _c.orthoCamera];
      for (const c of _cands) {
        const t: any = c?.three ?? c;
        if (t?.isOrthographicCamera) { ortho = t; break; }
      }
    }
    const dist = Math.max(sceneRadius * 1.5, 5);
    controls.setLookAt(
      sceneCenter.x + dir.x * dist,
      sceneCenter.y + dir.y * dist,
      sceneCenter.z + dir.z * dist,
      sceneCenter.x, sceneCenter.y, sceneCenter.z,
      false,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(sceneCenter);
    fitOrthoFrustum(ortho, sceneRadius);
  } else {
    const persp = cam as THREE.PerspectiveCamera;
    const vFov = THREE.MathUtils.degToRad(persp.fov ?? 60);
    const dist = (sceneRadius / Math.sin(Math.max(vFov, 0.3) / 2)) * 1.2;
    controls.setLookAt(
      sceneCenter.x + dir.x * dist,
      sceneCenter.y + dir.y * dist,
      sceneCenter.z + dir.z * dist,
      sceneCenter.x, sceneCenter.y, sceneCenter.z,
      false,
    );
  }

  updateClipping();
  refreshBoundsInfo();
  if (!homeView) saveHome();
}

/**
 * Zoom the camera to fit a specific set of elements.
 *
 * Uses the SDK-corrected world boxes from `world-box.ts` so the camera
 * lands on the geometry as rendered — not on the pre-alignment location.
 *
 * `modelId` is passed through to `getElementWorldBoxes` so that a stale
 * entry (worker no longer has the model) can be pruned by safe-query
 * instead of throwing "Fragments: Model not found".
 */
export async function fitToMap(map: OBC.ModelIdMap) {
  if (!worldReady()) return;
  preFocusView = saveCameraSnapshot();

  const box = new THREE.Box3();

  for (const [modelId, ids] of Object.entries(map)) {
    const model: any = ctx.fragments.list.get(modelId);
    if (!model || !ids?.size) continue;
    try {
      const boxes = await getElementWorldBoxes(model, Array.from(ids), modelId);
      for (const wb of boxes) {
        if (!wb.box.isEmpty()) box.union(wb.box);
      }
    } catch (err) {
      console.warn("[camera] fitToMap box read failed", modelId, err);
    }
  }

  if (box.isEmpty()) {
    fitAll();
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.5);

  const cam = ctx.world.camera.three;

  // Natural viewing direction: keep azimuth, clamp pitch.
  const camToCenter = new THREE.Vector3().subVectors(cam.position, center);
  const horizontalDist = Math.hypot(camToCenter.x, camToCenter.z);
  let dir: THREE.Vector3;

  if (horizontalDist < Math.max(radius * 0.15, 0.05)) {
    dir = new THREE.Vector3(1.0, 0.7, 1.0).normalize();
  } else {
    const azimuth = Math.atan2(camToCenter.x, camToCenter.z);
    const pitchRaw = Math.atan2(camToCenter.y, horizontalDist);
    const pitch = THREE.MathUtils.clamp(
      pitchRaw,
      THREE.MathUtils.degToRad(-30),
      THREE.MathUtils.degToRad(60),
    );
    const cosP = Math.cos(pitch);
    dir = new THREE.Vector3(
      Math.sin(azimuth) * cosP,
      Math.sin(pitch),
      Math.cos(azimuth) * cosP,
    ).normalize();
  }

  if (isOrthoCam(cam)) {
    fitOrthoFrustum(cam as THREE.OrthographicCamera, radius);
    const dist = radius * 4;
    ctx.world.camera.controls.setLookAt(
      center.x + dir.x * dist,
      center.y + dir.y * dist,
      center.z + dir.z * dist,
      center.x,
      center.y,
      center.z,
      true,
    );
  } else {
    const persp = cam as THREE.PerspectiveCamera;
    const vFov = THREE.MathUtils.degToRad(persp.fov ?? 60);
    const dist = (radius / Math.sin(Math.max(vFov, 0.3) / 2)) * 1.15;
    ctx.world.camera.controls.setLookAt(
      center.x + dir.x * dist,
      center.y + dir.y * dist,
      center.z + dir.z * dist,
      center.x,
      center.y,
      center.z,
      true,
    );
  }

  updateClipping();
}

/* ═════════════════════════════════════════════════════════════════════════
   Recovery
   ═════════════════════════════════════════════════════════════════════════ */
export function recoverView(): void {
  try {
    const modelCount = ctx.fragments.list.size;
    computeSceneBounds();
    const boxSize = new THREE.Vector3();
    lastSceneBox.getSize(boxSize);

    const cam: any = ctx.world.camera.three;
    const isOrtho = isOrthoCam(cam);
    console.log(
      `[camera] recoverView · models=${modelCount} · ` +
        `scene ${boxSize.x.toFixed(1)}×${boxSize.y.toFixed(1)}×${boxSize.z.toFixed(1)} m · ` +
        `center (${sceneCenter.x.toFixed(1)}, ${sceneCenter.y.toFixed(1)}, ${sceneCenter.z.toFixed(1)}) · ` +
        `radius ${sceneRadius.toFixed(1)} · ` +
        `camera ${isOrtho ? "ortho" : "persp"} · ` +
        `position (${cam.position.x.toFixed(1)}, ${cam.position.y.toFixed(1)}, ${cam.position.z.toFixed(1)}) · ` +
        `near ${cam.near} · far ${cam.far}`,
    );

    if (lastSceneBox.isEmpty()) {
      console.warn("[camera] recoverView: scene bounds are empty.");
      return;
    }

    fitAll();
    try {
      ctx.fragments.core.update(true);
    } catch {
      /* */
    }

    const proj = new THREE.Matrix4().multiplyMatrices(
      cam.projectionMatrix,
      cam.matrixWorldInverse,
    );
    const ndc = sceneCenter.clone().applyMatrix4(proj);
    if (Math.abs(ndc.x) > 2 || Math.abs(ndc.y) > 2 || ndc.z < -2 || ndc.z > 2) {
      console.warn(
        `[camera] recoverView: scene center still outside frustum ` +
          `(ndc ${ndc.x.toFixed(2)}, ${ndc.y.toFixed(2)}, ${ndc.z.toFixed(2)}). ` +
          `Switching to a fresh isometric view.`,
      );

      const dist = Math.max(sceneRadius * 3, 5);
      const dir = new THREE.Vector3(1.2, 0.7, 1.2).normalize();
      ctx.world.camera.controls.setLookAt(
        sceneCenter.x + dir.x * dist,
        sceneCenter.y + dir.y * dist,
        sceneCenter.z + dir.z * dist,
        sceneCenter.x,
        sceneCenter.y,
        sceneCenter.z,
        false,
      );
      if (isOrtho) {
        fitOrthoFrustum(cam as THREE.OrthographicCamera, sceneRadius);
      }
      updateClipping();
    }
  } catch (err) {
    console.warn("[camera] recoverView failed", err);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Screenshot
   ═════════════════════════════════════════════════════════════════════════ */
export interface ScreenshotOptions {
  width?: number;
  height?: number;
  format?: "png" | "jpeg";
  quality?: number;
  filename?: string;
}

export type ScreenshotPreset = "current" | "hd" | "4k" | "8k";

const SCREENSHOT_PRESETS: Record<ScreenshotPreset, { w: number; h: number } | null> = {
  current: null,
  hd: { w: 1920, h: 1080 },
  "4k": { w: 3840, h: 2160 },
  "8k": { w: 7680, h: 4320 },
};

const SCREENSHOT_KEY = "obs.screenshot.preset";

let currentPreset: ScreenshotPreset = "hd";
try {
  const raw = localStorage.getItem(SCREENSHOT_KEY);
  if (raw === "current" || raw === "hd" || raw === "4k" || raw === "8k") {
    currentPreset = raw;
  }
} catch {
  /* */
}

export function getScreenshotPreset(): ScreenshotPreset {
  return currentPreset;
}

export function setScreenshotPreset(p: ScreenshotPreset): void {
  currentPreset = p;
  try {
    localStorage.setItem(SCREENSHOT_KEY, p);
  } catch {
    /* */
  }
  const size = SCREENSHOT_PRESETS[p];
  console.log(`[screenshot] preset → ${p}${size ? ` (${size.w}×${size.h})` : ""}`);
}

export function takeScreenshot(opts: ScreenshotOptions = {}): void {
  console.log(`[screenshot] click · preset="${currentPreset}"`);
  if (!worldReady()) {
    console.warn("[screenshot] world not ready — nothing to capture");
    return;
  }
  const renderer = ctx.world.renderer.three as THREE.WebGLRenderer;
  const cam = ctx.world.camera.three;
  const scene = ctx.world.scene.three;
  if (!renderer || !cam || !scene) {
    console.warn("[screenshot] renderer/camera/scene missing");
    return;
  }

  const preset = SCREENSHOT_PRESETS[currentPreset];
  const targetW = Math.max(
    64,
    Math.round(opts.width ?? preset?.w ?? renderer.domElement.width),
  );
  const targetH = Math.max(
    64,
    Math.round(opts.height ?? preset?.h ?? renderer.domElement.height),
  );

  console.log(`[screenshot] rendering ${targetW}×${targetH}`);

  // ── Save camera state ──
  const prevPerspAspect = (cam as THREE.PerspectiveCamera).aspect;
  const prevOrtho =
    cam instanceof THREE.OrthographicCamera
      ? {
          left: cam.left,
          right: cam.right,
          top: cam.top,
          bottom: cam.bottom,
          zoom: cam.zoom,
        }
      : null;

  // ── Save renderer state ──
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  const prevClearColor = new THREE.Color();
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(prevClearColor);

  const format = opts.format ?? "png";
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const quality = opts.quality ?? 0.95;

  let out: HTMLCanvasElement | null = null;
  let rt: THREE.WebGLRenderTarget | null = null;

  try {
    // ── Adjust camera aspect for the target resolution ──
    if (cam instanceof THREE.PerspectiveCamera) {
      cam.aspect = targetW / targetH;
      cam.updateProjectionMatrix();
    } else if (cam instanceof THREE.OrthographicCamera) {
      const h = cam.top - cam.bottom;
      const w = h * (targetW / targetH);
      const cx = (cam.left + cam.right) / 2;
      cam.left = cx - w / 2;
      cam.right = cx + w / 2;
      cam.updateProjectionMatrix();
    }

    // ── Offscreen render target ──
    // The main WebGL context was created without preserveDrawingBuffer,
    // so `renderer.domElement.toDataURL()` returns a black canvas on
    // Chrome / Edge. A render target is a texture we own; its contents
    // survive the render call and can be read back with readRenderTargetPixels.
    console.log("[screenshot] step 1/5 · creating render target");
    rt = new THREE.WebGLRenderTarget(targetW, targetH, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    // Match the renderer's output color space so the pixels we read back
    // look the same as what's on screen. Without this, Three.js writes
    // linear values into the RT and the image looks washed out / dark.
    try {
      const outputCS = (renderer as any).outputColorSpace;
      if (outputCS) (rt.texture as any).colorSpace = outputCS;
    } catch {
      /* */
    }

    console.log("[screenshot] step 2/5 · rendering scene → RT");
    renderer.autoClear = true;
    renderer.setRenderTarget(rt);
    renderer.clear(true, true, true);
    renderer.render(scene, cam);

    console.log("[screenshot] step 3/5 · reading pixels back");
    const pixels = new Uint8Array(targetW * targetH * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, targetW, targetH, pixels);

    // Restore renderer immediately.
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    rt.dispose();
    rt = null;

    // ── Sparse sanity scan ──
    const cx = targetW >> 1;
    const cy = targetH >> 1;
    const sample = (cy * targetW + cx) * 4;
    const r0 = pixels[sample];
    const g0 = pixels[sample + 1];
    const b0 = pixels[sample + 2];
    let nonBlack = 0;
    const stepX = Math.max(1, targetW >> 6);
    const stepY = Math.max(1, targetH >> 6);
    for (let y = 0; y < targetH; y += stepY) {
      for (let x = 0; x < targetW; x += stepX) {
        const i = (y * targetW + x) * 4;
        if (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8) nonBlack++;
      }
    }
    if (nonBlack < 4) {
      console.warn(
        `[screenshot] render target appears entirely black (center ${r0},${g0},${b0}). ` +
          "Likely: no models loaded, or camera inside geometry.",
      );
    } else {
      console.log(`[screenshot] pixel sanity OK · ${nonBlack} non-black sample(s)`);
    }

    // ── Flip Y into a 2D canvas ──
    // readRenderTargetPixels returns rows bottom-up; a 2D canvas is top-down.
    console.log("[screenshot] step 4/5 · composing output canvas");
    out = document.createElement("canvas");
    out.width = targetW;
    out.height = targetH;
    const outCtx = out.getContext("2d");
    if (!outCtx) throw new Error("Could not acquire 2D context for output canvas.");

    const imgData = outCtx.createImageData(targetW, targetH);
    const rowBytes = targetW * 4;
    for (let y = 0; y < targetH; y++) {
      const src = (targetH - 1 - y) * rowBytes;
      imgData.data.set(pixels.subarray(src, src + rowBytes), y * rowBytes);
    }
    outCtx.putImageData(imgData, 0, 0);
  } catch (err) {
    if (rt) {
      try {
        renderer.setRenderTarget(prevTarget);
        renderer.autoClear = prevAutoClear;
        renderer.setClearColor(prevClearColor, prevClearAlpha);
        rt.dispose();
      } catch {
        /* */
      }
    }
    console.error("[screenshot] capture failed", err);
    alert(
      "Screenshot failed.\n\n" +
        (err instanceof Error ? err.message : String(err)) +
        "\n\nTry a smaller preset (HD or Native).",
    );
    return;
  } finally {
    // ── Restore camera ──
    try {
      if (
        cam instanceof THREE.PerspectiveCamera &&
        typeof prevPerspAspect === "number"
      ) {
        cam.aspect = prevPerspAspect;
        cam.updateProjectionMatrix();
      } else if (prevOrtho && cam instanceof THREE.OrthographicCamera) {
        cam.left = prevOrtho.left;
        cam.right = prevOrtho.right;
        cam.top = prevOrtho.top;
        cam.bottom = prevOrtho.bottom;
        cam.zoom = prevOrtho.zoom;
        cam.updateProjectionMatrix();
      }
      try {
        ctx.fragments.core.update(true);
      } catch {
        /* */
      }
    } catch (err) {
      console.warn("[screenshot] restore failed", err);
    }
  }

  if (!out) return;

  // ── Encode + download ──
  // We use toBlob rather than toDataURL because 4K and 8K PNGs exceed
  // Chrome's ~2 MB data-URL cap, which silently truncates the download.
  const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const filename =
    opts.filename ??
    `open-bim-studio-${targetW}x${targetH}-${date}.${opts.format ?? "png"}`;

  console.log("[screenshot] step 5/5 · encoding blob…");
  try {
    out.toBlob(
      (blob) => {
        if (!blob) {
          console.error("[screenshot] toBlob returned null — try a smaller preset");
          alert("Encoding failed. Try a smaller preset (HD or Native).");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(url);
        }, 5_000);
        console.log(
          `[screenshot] saved ${filename} · ${targetW}×${targetH} · ` +
            `${(blob.size / 1024).toFixed(0)} KB`,
        );
      },
      mime,
      quality,
    );
  } catch (err) {
    console.error("[screenshot] toBlob threw", err);
    alert(
      "Screenshot encoding failed.\n\n" +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupCameraTools() {
  ctx.world.scene.three.add(boundsHelperGroup);
  ctx.world.camera.controls.addEventListener("update", () => updateClipping());
  currentProjection = getProjection();
  applyClipping(0.1, 20000);

  // MMB / wheel / dbl-MMB owned by features/navigation.ts via input-router.
  try {
    const controls: any = ctx.world.camera.controls;
    if (controls) {
      if ("dollyToCursor" in controls) controls.dollyToCursor = false;
      if ("infinityDolly" in controls) controls.infinityDolly = true;
      if ("smoothTime" in controls) controls.smoothTime = 0.04;
      if ("draggingSmoothTime" in controls) controls.draggingSmoothTime = 0.02;
      if ("azimuthRotateSpeed" in controls) controls.azimuthRotateSpeed = 1.0;
      if ("polarRotateSpeed" in controls) controls.polarRotateSpeed = 1.0;
      if ("truckSpeed" in controls) controls.truckSpeed = 1.0;
      
      try { if ("dollySpeed" in controls) controls.dollySpeed = 0; } catch { /* */ }


      const ACTION = controls.constructor?.ACTION || (window as any).CameraControls?.ACTION;
      if (ACTION && controls.mouseButtons) {
        controls.mouseButtons.left = ACTION.NONE ?? 0;
        controls.mouseButtons.middle = ACTION.NONE ?? 0;
        controls.mouseButtons.right = ACTION.NONE ?? 0;
        controls.mouseButtons.wheel = ACTION.NONE ?? 0;
      }
    }
  } catch (e) {
    console.warn("[camera] mouse defaults", e);
  }

  // Re-assert after a tick — some OBC versions re-enable defaults asynchronously.
  setTimeout(() => {
    try {
      const controls: any = ctx.world?.camera?.controls;
      const ACTION = controls?.constructor?.ACTION || (window as any).CameraControls?.ACTION;
      if (ACTION && controls?.mouseButtons) {
        controls.mouseButtons.left = ACTION.NONE ?? 0;
        controls.mouseButtons.middle = ACTION.NONE ?? 0;
        controls.mouseButtons.right = ACTION.NONE ?? 0;
        controls.mouseButtons.wheel = ACTION.NONE ?? 0;
      }
      forceResumeCameraControls();
    } catch { /* */ }
  }, 0);

  (window as any).__obsRmbDragging = false;

  // Clipping is driven by the camera-controls "update" listener above.
  // Avoid a permanent rAF loop — it fights navigation and burns CPU.

  Object.assign(ctx.scene, {
    center: sceneCenter,
    box: lastSceneBox,
    computeBounds: computeSceneBounds,
    establishOffset: establishSceneOffset,
    recenter: recenterSceneNow,
    alignOriginToOrigin,
    resetOffsets,
    fitAll,
    fitToMap,
  });

  Object.assign(ctx.cam, {
    updateClipping,
    setProjection,
    zoomBy,
    gotoDir,
    saveHome,
    goHome,
    screenshot: takeScreenshot,
    screenshotPreset: getScreenshotPreset,
    setScreenshotPreset,
    recoverView,
  
    viewExact: (view: ExactView) => gotoExactView(view),
    fitAll,
});
  (ctx.features as any).viewExact = (view: ExactView) => gotoExactView(view);

  const cam: CameraService = {
    fitAll,
    fitToMap,
    focusOnPoint,
    focusOnBox,
    zoomBy,
    gotoDir,
    gotoExactView,
    setProjection,
    getProjection,
    saveHome,
    goHome,
    screenshot: takeScreenshot,
    getScreenshotPreset,
    setScreenshotPreset,
    computeSceneBounds,
    recoverView,
    updateClipping,
    scene: {
      center: sceneCenter,
      box: lastSceneBox,
      radius: () => sceneRadius,
    },
  };
  register("camera", cam);
}