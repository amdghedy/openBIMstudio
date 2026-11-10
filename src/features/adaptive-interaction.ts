/**
 * Native 3D placement and point-grip interaction for adaptive components.
 *
 * This feature deliberately uses the shared viewport gesture router and
 * snapping service. It does not install competing pointer listeners.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter } from "../core/input-router";
import { snapping } from "./snapping";
import { notify } from "../core/notify";
import { createWorkPlane, getActiveWorkPlane, setWorkPlaneRotation } from "../modules/work-planes/types";
import type {
  AdaptiveElementCreateInput,
  AdaptiveElementSnapshot,
} from "../modules/adaptive/native-integration";
import type { Pt3 } from "../modules/adaptive";

type Any = Record<string, any>;

interface AdaptiveInteractionApi {
  create(input: AdaptiveElementCreateInput): Any;
  buildMesh(element: Any): THREE.Object3D | null;
  getDefinition(elementId: string): Any | null;
  beginPointEdit(elementId: string): AdaptiveElementSnapshot | null;
  previewPointEdit(elementId: string, pointIndex: number, point: Pt3, baseline: AdaptiveElementSnapshot): boolean;
  commitPointEdit(elementId: string, baseline: AdaptiveElementSnapshot): boolean;
  cancelPointEdit(elementId: string, baseline: AdaptiveElementSnapshot): boolean;
}

interface PlacementSession {
  input: Omit<AdaptiveElementCreateInput, "points">;
  pointCount: number;
  points: Pt3[];
  resolve: (element: Any | null) => void;
}

interface GripDrag {
  elementId: string;
  pointIndex: number;
  baseline: AdaptiveElementSnapshot;
  plane: THREE.Plane;
  changed: boolean;
}

const HANDLE_COLOR = 0xf59e0b;
const HANDLE_HOVER = 0x22c55e;
let installed = false;
let api: AdaptiveInteractionApi | null = null;
let placement: PlacementSession | null = null;
let gripDrag: GripDrag | null = null;
let hoverSequence = 0;
let lastSnap: { point: THREE.Vector3; x: number; y: number } | null = null;
let workPlanePickArmed = false;
let previewRoot: THREE.Group | null = null;
let gripRoot: THREE.Group | null = null;
let hud: HTMLDivElement | null = null;
let planeEditor: HTMLDivElement | null = null;
let unsubGesture: (() => void) | null = null;
let unsubHover: (() => void) | null = null;
let unsubCancel: (() => void) | null = null;
let unsubAuthoring: (() => void) | null = null;

function ndcOf(event: MouseEvent | PointerEvent): THREE.Vector2 | null {
  const host = ctx.rightHost;
  if (!host) return null;
  const rect = host.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}

function rayFor(event: MouseEvent | PointerEvent): THREE.Raycaster | null {
  const ndc = ndcOf(event);
  const camera = ctx.world?.camera?.three as THREE.Camera | undefined;
  if (!ndc || !camera) return null;
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  return ray;
}

function isUnder(object: THREE.Object3D, root: THREE.Object3D | null): boolean {
  if (!root) return false;
  let node: THREE.Object3D | null = object;
  while (node) {
    if (node === root) return true;
    node = node.parent;
  }
  return false;
}

function surfacePoint(event: MouseEvent | PointerEvent, excludeElementId?: string): THREE.Vector3 | null {
  const ray = rayFor(event);
  const scene = ctx.world?.scene?.three as THREE.Scene | undefined;
  if (!ray || !scene) return null;
  const hits = ray.intersectObjects(scene.children, true);
  for (const hit of hits) {
    const object = hit.object as THREE.Object3D;
    if (isUnder(object, previewRoot) || isUnder(object, gripRoot)) continue;
    if (object === ctx.groundPlane || object.name === "groundPlane") continue;
    if (!object.visible) continue;
    if (excludeElementId && String(object.userData?.elementId ?? "") === excludeElementId) continue;
    if ((object as THREE.Mesh).isMesh || (object as any).isInstancedMesh) return hit.point.clone();
  }
  return null;
}

function activeWorkPlaneIntersection(event: MouseEvent | PointerEvent): THREE.Vector3 | null {
  const ray = rayFor(event);
  if (!ray) return null;
  const active = getActiveWorkPlane();
  const plane = active
    ? new THREE.Plane(
        new THREE.Vector3(active.normal[0], active.normal[1], active.normal[2]).normalize(),
        -new THREE.Vector3(active.normal[0], active.normal[1], active.normal[2]).normalize().dot(
          new THREE.Vector3(active.origin[0], active.origin[1], active.origin[2]),
        ),
      )
    : new THREE.Plane(new THREE.Vector3(0, 1, 0), -snapping.getWorkPlaneY());
  const point = new THREE.Vector3();
  return ray.ray.intersectPlane(plane, point) ? point : null;
}

function placementPoint(event: MouseEvent | PointerEvent): THREE.Vector3 | null {
  const active = getActiveWorkPlane();
  if (active) return activeWorkPlaneIntersection(event);
  return surfacePoint(event) ?? activeWorkPlaneIntersection(event);
}

function firstFaceHit(event: MouseEvent | PointerEvent): THREE.Intersection | null {
  const ray = rayFor(event);
  const scene = ctx.world?.scene?.three as THREE.Scene | undefined;
  if (!ray || !scene) return null;
  return ray.intersectObjects(scene.children, true).find((hit) => {
    const object = hit.object as THREE.Object3D;
    return !!hit.face && object.visible && !isUnder(object, previewRoot) && !isUnder(object, gripRoot) &&
      object !== ctx.groundPlane && object.name !== "groundPlane";
  }) ?? null;
}

function armWorkPlaneFromFace(event: MouseEvent | PointerEvent): boolean {
  const hit = firstFaceHit(event);
  if (!hit?.face) {
    notify("warn", "Pick a visible model face to define the adaptive work plane.");
    return false;
  }
  const object = hit.object as THREE.Mesh;
  object.updateWorldMatrix(true, false);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
  const worldNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
  const worldOrigin = hit.point.clone();
  let root: THREE.Object3D = object;
  while (root.parent && !root.userData?.elementId) root = root.parent;
  const elementId = String(root.userData?.elementId ?? object.userData?.elementId ?? "");
  const sceneRoot = elementId ? root : object;
  let meshIndex = -1;
  let meshCursor = 0;
  sceneRoot.traverse((node) => {
    if (!(node as THREE.Mesh).isMesh) return;
    if (node === object) meshIndex = meshCursor;
    meshCursor++;
  });
  const localOrigin = object.worldToLocal(worldOrigin.clone());
  const localNormal = hit.face.normal.clone().normalize();
  const face = {
    ...(elementId ? { elementId } : {}),
    ...(meshIndex >= 0 ? { meshIndex } : {}),
    ...(Number.isInteger(hit.faceIndex) ? { faceIndex: hit.faceIndex } : {}),
    localOrigin: [localOrigin.x, localOrigin.y, localOrigin.z] as [number, number, number],
    localNormal: [localNormal.x, localNormal.y, localNormal.z] as [number, number, number],
  };
  const plane = createWorkPlane(
    "Adaptive face · " + (root.name || object.name || elementId || "Picked surface"),
    [worldOrigin.x, worldOrigin.y, worldOrigin.z],
    [worldNormal.x, worldNormal.y, worldNormal.z],
    face,
  );
  workPlanePickArmed = false;
  if (hud) {
    const button = hud.querySelector<HTMLButtonElement>("[data-work-plane]");
    if (button) button.textContent = "Pick Work Plane";
    hud.querySelector<HTMLElement>("[data-step]")!.textContent = "Active plane: " + plane.name;
  }
  snapping.hideIndicator();
  lastSnap = null;
  notify("success", "Adaptive work plane set from picked face.");
  return true;
}

function cursorMatchesSnap(event: MouseEvent | PointerEvent): THREE.Vector3 | null {
  if (!lastSnap) return null;
  if (Math.hypot(event.clientX - lastSnap.x, event.clientY - lastSnap.y) > 14) return null;
  return lastSnap.point.clone();
}

function removeObject(root: THREE.Group | null): void {
  if (!root) return;
  root.parent?.remove(root);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) material.dispose();
  });
}

function ensureGroups(): void {
  const scene = ctx.world?.scene?.three;
  if (!scene) throw new Error("The 3D viewport is not ready");
  if (!previewRoot) {
    previewRoot = new THREE.Group();
    previewRoot.name = "adaptive-placement-preview";
    previewRoot.userData.adaptiveInteractionOverlay = true;
    scene.add(previewRoot);
  }
  if (!gripRoot) {
    gripRoot = new THREE.Group();
    gripRoot.name = "adaptive-placement-grips";
    gripRoot.userData.adaptiveInteractionOverlay = true;
    scene.add(gripRoot);
  }
}

function pointCountLabel(): string {
  if (!placement) return "";
  return "Point " + Math.min(placement.points.length + 1, placement.pointCount) +
    " of " + placement.pointCount;
}

function updateHud(): void {
  if (!hud || !placement) return;
  const family = placement.input.familyName || "Adaptive component";
  const count = placement.points.length;
  const next = Math.min(count + 1, placement.pointCount);
  hud.querySelector<HTMLElement>("[data-status]")!.textContent =
    family + " · " + count + "/" + placement.pointCount + " points placed";
  hud.querySelector<HTMLElement>("[data-step]")!.textContent =
    count < placement.pointCount ? "Click to place " + pointCountLabel() : "Finalizing component…";
  const undo = hud.querySelector<HTMLButtonElement>("[data-undo]");
  if (undo) undo.disabled = count === 0;
  void next;
}

function closePlaneEditor(): void {
  if (planeEditor?.parentElement) planeEditor.parentElement.removeChild(planeEditor);
  planeEditor = null;
}

function parsePlaneVector(raw: string, label: string): [number, number, number] {
  const values = String(raw).trim().split(/[,;\\s]+/).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(label + " must contain exactly three finite coordinates");
  }
  return [values[0], values[1], values[2]];
}

function openCustomPlaneEditor(step: HTMLElement, button: HTMLButtonElement): void {
  if (planeEditor) {
    closePlaneEditor();
    return;
  }
  const current = getActiveWorkPlane();
  planeEditor = document.createElement("div");
  planeEditor.dataset.adaptiveWorkPlaneEditor = "true";
  planeEditor.style.cssText =
    "position:absolute;z-index:78;top:66px;left:50%;transform:translateX(-50%);" +
    "display:flex;flex-direction:column;gap:8px;width:340px;padding:12px;" +
    "background:rgba(15,17,23,.98);border:1px solid #475569;border-radius:9px;" +
    "box-shadow:0 12px 30px rgba(0,0,0,.42);color:#e5e7eb;font:11px system-ui,sans-serif";
  const heading = document.createElement("strong");
  heading.textContent = "Define Arbitrary Work Plane";
  const makeField = (labelText: string, value: string) => {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex;flex-direction:column;gap:4px;color:#cbd5e1";
    wrap.textContent = labelText;
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.style.cssText =
      "box-sizing:border-box;width:100%;padding:7px 8px;border:1px solid #475569;border-radius:5px;" +
      "background:#0b1220;color:#f8fafc;font:12px ui-monospace,monospace";
    wrap.appendChild(input);
    return { wrap, input };
  };
  const origin = makeField("Origin X, Y, Z (metres)",
    current ? current.origin.join(", ") : "0, 0, 0");
  const normal = makeField("Normal NX, NY, NZ",
    current ? current.normal.join(", ") : "0, 1, 0");
  const rotation = makeField("Local sketch rotation (radians)",
    String(current?.rotation ?? 0));
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;justify-content:flex-end;gap:7px";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.textContent = "Set Work Plane";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  for (const action of [apply, close]) action.style.cssText =
    "border:1px solid #475569;border-radius:5px;padding:6px 9px;background:#1e293b;color:#e2e8f0;cursor:pointer";
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    closePlaneEditor();
  });
  apply.addEventListener("click", (event) => {
    event.stopPropagation();
    try {
      const point = parsePlaneVector(origin.input.value, "Work plane origin");
      const direction = parsePlaneVector(normal.input.value, "Work plane normal");
      const angle = Number(rotation.input.value);
      if (!Number.isFinite(angle)) throw new Error("Work plane rotation must be a finite number");
      const plane = createWorkPlane("Adaptive custom work plane", point, direction);
      setWorkPlaneRotation(plane.id, angle);
      workPlanePickArmed = false;
      button.textContent = "Pick Work Plane";
      step.textContent = "Active plane: " + plane.name;
      closePlaneEditor();
      snapping.hideIndicator();
      lastSnap = null;
      notify("success", "Arbitrary adaptive work plane activated.");
    } catch (error) {
      notify("error", (error as Error).message);
    }
  });
  actions.append(apply, close);
  planeEditor.append(heading, origin.wrap, normal.wrap, rotation.wrap, actions);
  ctx.rightHost?.appendChild(planeEditor);
}

function ensureHud(): void {
  if (hud || !ctx.rightHost) return;
  hud = document.createElement("div");
  hud.dataset.adaptivePlacementHud = "true";
  hud.style.cssText =
    "position:absolute;z-index:75;top:14px;left:50%;transform:translateX(-50%);" +
    "display:flex;align-items:center;gap:12px;min-width:360px;padding:10px 12px;" +
    "background:rgba(15,17,23,.96);border:1px solid #475569;border-radius:9px;" +
    "box-shadow:0 10px 28px rgba(0,0,0,.35);color:#e5e7eb;font:12px system-ui,sans-serif";
  const info = document.createElement("div");
  info.style.cssText = "display:flex;flex-direction:column;gap:3px;flex:1;min-width:0";
  const status = document.createElement("strong");
  status.dataset.status = "true";
  status.style.cssText = "font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  const step = document.createElement("span");
  step.dataset.step = "true";
  step.style.cssText = "font-size:11px;color:#94a3b8";
  info.append(status, step);
  const undo = document.createElement("button");
  undo.dataset.undo = "true";
  undo.textContent = "Undo point";
  undo.title = "Remove the last placed point (Backspace)";
  const pickPlane = document.createElement("button");
  pickPlane.dataset.workPlane = "true";
  pickPlane.type = "button";
  pickPlane.textContent = "Pick Work Plane";
  pickPlane.title = "Use a model face as the active adaptive work plane";
  const definePlane = document.createElement("button");
  definePlane.type = "button";
  definePlane.textContent = "Define Plane";
  definePlane.title = "Define any 3D work plane by origin, normal and sketch rotation";
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  for (const button of [undo, pickPlane, definePlane, cancel]) {
    button.type = "button";
    button.style.cssText =
      "border:1px solid #475569;border-radius:6px;padding:6px 9px;background:#1e293b;" +
      "color:#e2e8f0;font:11px system-ui;cursor:pointer";
  }
  undo.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!placement || placement.points.length === 0) return;
    placement.points.pop();
    drawPlacementPreview(null);
    updateHud();
  });
  pickPlane.addEventListener("click", (event) => {
    event.stopPropagation();
    workPlanePickArmed = !workPlanePickArmed;
    pickPlane.textContent = workPlanePickArmed ? "Click a Face…" : "Pick Work Plane";
    step.textContent = workPlanePickArmed
      ? "Click a visible model face. Escape cancels plane picking."
      : "Continue placing points on the active plane.";
    notify("info", workPlanePickArmed ? "Click a visible 3D face to set the adaptive work plane." : "Face picking cancelled.");
  });
  definePlane.addEventListener("click", (event) => {
    event.stopPropagation();
    workPlanePickArmed = false;
    pickPlane.textContent = "Pick Work Plane";
    openCustomPlaneEditor(step, pickPlane);
  });
  cancel.addEventListener("click", (event) => {
    event.stopPropagation();
    finishPlacement(null);
  });
  hud.append(info, undo, pickPlane, definePlane, cancel);
  ctx.rightHost.appendChild(hud);
}

function disposePreview(): void {
  if (!previewRoot) return;
  while (previewRoot.children.length) {
    const child = previewRoot.children[0];
    previewRoot.remove(child);
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) material.dispose();
    });
  }
}

function drawPlacementPreview(cursor: THREE.Vector3 | null): void {
  if (!placement || !api || !previewRoot) return;
  disposePreview();
  const points = placement.points.map((p) => ({ ...p }));
  if (cursor) points.push({ x: cursor.x, y: cursor.y, z: cursor.z });
  if (points.length) {
    try {
      const definition = {
        schemaVersion: 1,
        familyId: String(placement.input.familyId),
        familyName: String(placement.input.familyName),
        pointCount: points.length,
        points,
        profile: placement.input.profile,
        ...(placement.input.pointLength === undefined ? {} : { pointLength: placement.input.pointLength }),
      };
      const mesh = api.buildMesh({
        id: "adaptive-placement-preview",
        type: "adaptive-component",
        color: "#f59e0b",
        properties: { adaptiveDefinition: definition },
      });
      if (mesh) {
        mesh.traverse((obj) => {
          const child = obj as THREE.Mesh;
          if (!child.isMesh) return;
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          child.material = materials.map((material) => {
            const clone = material.clone();
            (clone as THREE.Material).transparent = true;
            (clone as THREE.Material).opacity = 0.38;
            (clone as THREE.Material).depthWrite = false;
            if ((clone as any).color) (clone as any).color.set("#f59e0b");
            return clone;
          }) as any;
          child.renderOrder = 900;
        });
        previewRoot.add(mesh);
      }
    } catch { /* partial placement may not yet define a valid sweep */ }
  }
  if (points.length > 0) {
    const geometry = new THREE.BufferGeometry().setFromPoints(
      points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
    );
    const material = new THREE.LineBasicMaterial({ color: 0xfbbf24, depthTest: false });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 901;
    previewRoot.add(line);
    points.forEach((point, index) => {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 12, 8),
        new THREE.MeshBasicMaterial({ color: index === points.length - 1 ? 0x22c55e : 0xf59e0b, depthTest: false }),
      );
      marker.position.set(point.x, point.y, point.z);
      marker.renderOrder = 902;
      previewRoot!.add(marker);
    });
  }
}

function finishPlacement(element: Any | null): void {
  if (!placement) return;
  const current = placement;
  placement = null;
  workPlanePickArmed = false;
  hoverSequence++;
  lastSnap = null;
  snapping.hideIndicator();
  removeObject(previewRoot);
  previewRoot = null;
  if (hud?.parentElement) hud.parentElement.removeChild(hud);
  hud = null;
  closePlaneEditor();
  current.resolve(element);
  try { (window as Any).obsRefreshRibbon?.(); } catch { /* */ }
}

async function placeCurrentPoint(event: MouseEvent | PointerEvent): Promise<void> {
  if (!placement || !api) return;
  const world = cursorMatchesSnap(event) ?? placementPoint(event);
  if (!world) {
    notify("warn", "No 3D surface or active work plane was found under the cursor.");
    return;
  }
  placement.points.push({ x: world.x, y: world.y, z: world.z });
  if (placement.points.length < placement.pointCount) {
    drawPlacementPreview(null);
    updateHud();
    return;
  }
  const current = placement;
  try {
    const activePlane = getActiveWorkPlane();
    const faceReference = activePlane?.face ? {
      ...(activePlane.face.elementId ? { elementId: activePlane.face.elementId } : {}),
      ...(activePlane.face.meshIndex !== undefined ? { meshIndex: activePlane.face.meshIndex } : {}),
      ...(activePlane.face.faceIndex !== undefined ? { faceIndex: activePlane.face.faceIndex } : {}),
      ...(activePlane.face.localOrigin ? { localOrigin: { x: activePlane.face.localOrigin[0], y: activePlane.face.localOrigin[1], z: activePlane.face.localOrigin[2] } } : {}),
      ...(activePlane.face.localNormal ? { localNormal: { x: activePlane.face.localNormal[0], y: activePlane.face.localNormal[1], z: activePlane.face.localNormal[2] } } : {}),
    } : undefined;
    const planeConstraints = activePlane
      ? current.points.map((_, pointIndex) => ({
          kind: (faceReference ? "face-lock" : "plane") as "face-lock" | "plane",
          pointIndex,
          origin: { x: activePlane.origin[0], y: activePlane.origin[1], z: activePlane.origin[2] },
          normal: { x: activePlane.normal[0], y: activePlane.normal[1], z: activePlane.normal[2] },
          ...(faceReference ? { face: faceReference } : {}),
        }))
      : [];
    const workPlane = activePlane ? {
      id: activePlane.id,
      name: activePlane.name,
      origin: { x: activePlane.origin[0], y: activePlane.origin[1], z: activePlane.origin[2] },
      normal: { x: activePlane.normal[0], y: activePlane.normal[1], z: activePlane.normal[2] },
      rotation: activePlane.rotation,
      ...(faceReference ? { face: faceReference } : {}),
    } : undefined;
    const element = api.create({
      ...current.input,
      points: current.points,
      constraints: [...(current.input.constraints ?? []), ...planeConstraints],
      ...(workPlane ? { workPlane } : {}),
    });
    finishPlacement(element);
    notify("success", "Placed native adaptive component: " + String(element?.name ?? current.input.familyName));
    refreshAdaptiveGrips();
  } catch (error) {
    current.points.pop();
    drawPlacementPreview(null);
    updateHud();
    notify("error", "Adaptive placement failed: " + (error as Error).message);
  }
}

function handlePlacementHover(event: PointerEvent): void {
  if (!placement) return;
  const cursor = placementPoint(event);
  const sequence = ++hoverSequence;
  if (!cursor) {
    lastSnap = null;
    snapping.hideIndicator();
    drawPlacementPreview(null);
    return;
  }
  drawPlacementPreview(cursor);
  void snapping.query(event, cursor).then((result) => {
    if (!placement || sequence !== hoverSequence) return;
    if (result) {
      const active = getActiveWorkPlane();
      const snapped = result.point.clone();
      if (active) {
        const normal = new THREE.Vector3(active.normal[0], active.normal[1], active.normal[2]).normalize();
        const origin = new THREE.Vector3(active.origin[0], active.origin[1], active.origin[2]);
        const distance = result.point.clone().sub(origin).dot(normal);
        snapped.copy(result.point).addScaledVector(normal, -distance);
      }
      const snapResult = { ...result, point: snapped };
      lastSnap = { point: snapped.clone(), x: event.clientX, y: event.clientY };
      snapping.showIndicator(snapResult);
      drawPlacementPreview(snapped);
    } else {
      lastSnap = null;
      snapping.hideIndicator();
    }
  }).catch(() => { /* snapping is an enhancement; plane/surface picking still works */ });
}

function gripSize(point: THREE.Vector3): number {
  const camera = ctx.world?.camera?.three as any;
  const host = ctx.rightHost;
  if (!camera || !host) return 0.07;
  const pixels = 8;
  if (camera.isOrthographicCamera) {
    return Math.max(0.025, Math.min(0.12,
      Math.abs((camera.top - camera.bottom) / (camera.zoom || 1)) / Math.max(1, host.clientHeight) * pixels));
  }
  const distance = Math.max(0.1, camera.position.distanceTo(point));
  const fov = THREE.MathUtils.degToRad(camera.fov ?? 50);
  return Math.max(0.025, Math.min(0.16,
    2 * distance * Math.tan(fov / 2) * pixels / Math.max(1, host.clientHeight)));
}

function addConstraintLine(
  points: THREE.Vector3[],
  kind: string,
  color: number,
  elementId: string,
): void {
  if (!gripRoot || points.length < 2) return;
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  line.renderOrder = 1090;
  line.userData.adaptiveConstraintGlyph = kind;
  line.userData.elementId = elementId;
  gripRoot.add(line);
}

function addConstraintGlyph(
  constraint: Any,
  points: Pt3[],
  elementId: string,
): void {
  if (!gripRoot) return;
  const at = (index: number): THREE.Vector3 | null => {
    const p = points[index];
    return p && Number.isInteger(index) ? new THREE.Vector3(p.x, p.y, p.z) : null;
  };
  const addMarker = (position: THREE.Vector3, kind: string, color: number, size = 0.045) => {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(size, 10, 8),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    marker.position.copy(position);
    marker.renderOrder = 1105;
    marker.userData.adaptiveConstraintGlyph = kind;
    marker.userData.elementId = elementId;
    gripRoot!.add(marker);
  };
  const kind = String(constraint?.kind ?? "");
  const colors: Record<string, number> = {
    fixed: 0x60a5fa, axis: 0x22d3ee, plane: 0x38bdf8, "face-lock": 0x38bdf8,
    coincident: 0x34d399, distance: 0xfbbf24, horizontal: 0x4ade80,
    vertical: 0x4ade80, parallel: 0xa78bfa, perpendicular: 0xfb923c,
    equalLength: 0x2dd4bf, angle: 0xf472b6,
  };
  const color = colors[kind] ?? 0xe5e7eb;

  if (kind === "fixed" || kind === "axis") {
    const p = at(constraint.pointIndex);
    if (!p) return;
    if (kind === "fixed") {
      const axis = 0.11;
      addConstraintLine([p.clone().add(new THREE.Vector3(-axis, 0, 0)), p.clone().add(new THREE.Vector3(axis, 0, 0))], kind, color, elementId);
      addConstraintLine([p.clone().add(new THREE.Vector3(0, -axis, 0)), p.clone().add(new THREE.Vector3(0, axis, 0))], kind, color, elementId);
      addConstraintLine([p.clone().add(new THREE.Vector3(0, 0, -axis)), p.clone().add(new THREE.Vector3(0, 0, axis))], kind, color, elementId);
    } else {
      const direction = constraint.axis === "x" ? new THREE.Vector3(1, 0, 0)
        : constraint.axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      addConstraintLine([p.clone().addScaledVector(direction, -0.2), p.clone().addScaledVector(direction, 0.2)], kind, color, elementId);
    }
    addMarker(p, kind, color, 0.055);
    return;
  }

  if (kind === "plane" || kind === "face-lock") {
    const origin = constraint.origin;
    const normal = constraint.normal;
    if (!origin || !normal) return;
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.7, 0.7),
      new THREE.MeshBasicMaterial({
        color, side: THREE.DoubleSide, transparent: true, opacity: 0.12,
        depthTest: false, depthWrite: false,
      }),
    );
    plane.position.set(origin.x, origin.y, origin.z);
    plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    plane.renderOrder = 1080;
    plane.userData.adaptiveConstraintGlyph = kind;
    plane.userData.elementId = elementId;
    gripRoot.add(plane);
    const end = plane.position.clone().addScaledVector(n, 0.24);
    addConstraintLine([plane.position.clone(), end], kind, color, elementId);
    addMarker(plane.position, kind, color, 0.04);
    return;
  }

  const a = at(constraint.a), b = at(constraint.b);
  if (a && b && ["coincident", "distance", "horizontal", "vertical"].includes(kind)) {
    addConstraintLine([a, b], kind, color, elementId);
    addMarker(a, kind, color, 0.035);
    addMarker(b, kind, color, 0.035);
    if (kind === "distance") {
      addMarker(a.clone().lerp(b, 0.5), kind, color, 0.055);
    } else if (kind === "coincident") {
      addMarker(a.clone().lerp(b, 0.5), kind, color, 0.065);
    }
    return;
  }

  const c = at(constraint.c), d = at(constraint.d);
  if (!a || !b || !c || !d) return;
  addConstraintLine([a, b], kind, color, elementId);
  addConstraintLine([c, d], kind, color, elementId);
  const midAB = a.clone().lerp(b, 0.5);
  const midCD = c.clone().lerp(d, 0.5);
  addConstraintLine([midAB, midCD], kind, color, elementId);
  addMarker(midAB, kind, color, 0.05);
  addMarker(midCD, kind, color, 0.05);
  if (kind === "perpendicular") {
    const ab = b.clone().sub(a).normalize().multiplyScalar(0.13);
    const cd = d.clone().sub(c).normalize().multiplyScalar(0.13);
    const corner = midAB.clone();
    addConstraintLine([corner, corner.clone().add(ab), corner.clone().add(ab).add(cd), corner.clone().add(cd)], kind, color, elementId);
  } else if (kind === "equalLength") {
    addMarker(midAB, "equalLength-tick", color, 0.075);
    addMarker(midCD, "equalLength-tick", color, 0.075);
  }
}

export function refreshAdaptiveGrips(): void {
  if (!gripRoot || !api) return;
  while (gripRoot.children.length) {
    const child = gripRoot.children[0];
    gripRoot.remove(child);
    child.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) material.dispose();
    });
  }
  const authoring = (ctx.features as Any)?.authoring;
  const selected = authoring?.getSelectedIds?.() ?? [];
  for (const id of selected) {
    const element = (authoring?.getElements?.() ?? []).find((item: Any) => item.id === id && item.type === "adaptive-component");
    const definition = element?.properties?.adaptiveDefinition;
    if (!definition || !Array.isArray(definition.points)) continue;
    definition.points.forEach((point: Pt3, pointIndex: number) => {
      const position = new THREE.Vector3(point.x, point.y, point.z);
      const handle = new THREE.Mesh(
        new THREE.SphereGeometry(gripSize(position), 16, 12),
        new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true, opacity: 0.98 }),
      );
      handle.position.copy(position);
      handle.renderOrder = 1100;
      handle.userData.adaptivePlacementGrip = true;
      handle.userData.elementId = element.id;
      handle.userData.pointIndex = pointIndex;
      gripRoot!.add(handle);
    });
    for (const constraint of definition.constraints ?? []) {
      addConstraintGlyph(constraint, definition.points as Pt3[], element.id);
    }
  }
}

function gripAt(event: MouseEvent | PointerEvent): { elementId: string; pointIndex: number } | null {
  if (!gripRoot || !gripRoot.children.length) return null;
  const ray = rayFor(event);
  if (!ray) return null;
  const hit = ray.intersectObjects(gripRoot.children, true)
    .find((candidate) => candidate.object.userData?.adaptivePlacementGrip === true);
  if (!hit) return null;
  const object = hit.object as THREE.Object3D;
  const elementId = String(object.userData.elementId ?? "");
  const pointIndex = Number(object.userData.pointIndex);
  return elementId && Number.isInteger(pointIndex) ? { elementId, pointIndex } : null;
}

function pointOnDragPlane(event: MouseEvent | PointerEvent, drag: GripDrag): THREE.Vector3 | null {
  const ray = rayFor(event);
  if (!ray) return null;
  const point = new THREE.Vector3();
  return ray.ray.intersectPlane(drag.plane, point) ? point : surfacePoint(event, drag.elementId);
}

function updateGripFromEvent(event: MouseEvent | PointerEvent, point?: THREE.Vector3): void {
  if (!gripDrag || !api) return;
  const world = point ?? pointOnDragPlane(event, gripDrag);
  if (!world) return;
  try {
    const changed = api.previewPointEdit(gripDrag.elementId, gripDrag.pointIndex, {
      x: world.x, y: world.y, z: world.z,
    }, gripDrag.baseline);
    gripDrag.changed = gripDrag.changed || changed;
    refreshAdaptiveGrips();
  } catch (error) {
    console.warn("[adaptive] live placement grip update rejected", error);
  }
}

function beginGripDrag(event: MouseEvent | PointerEvent): boolean {
  if (!api) return false;
  const grip = gripAt(event);
  if (!grip) return false;
  const baseline = api.beginPointEdit(grip.elementId);
  const camera = ctx.world?.camera?.three as THREE.Camera | undefined;
  if (!baseline || !camera) return false;
  const definition = baseline.definition as Any;
  const point = definition.points?.[grip.pointIndex] as Pt3 | undefined;
  if (!point) return false;
  const anchor = new THREE.Vector3(point.x, point.y, point.z);
  const normal = new THREE.Vector3();
  camera.getWorldDirection(normal);
  gripDrag = {
    elementId: grip.elementId,
    pointIndex: grip.pointIndex,
    baseline,
    plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, anchor),
    changed: false,
  };
  return true;
}

function cancelActive(): boolean {
  if (placement && workPlanePickArmed) {
    workPlanePickArmed = false;
    const button = hud?.querySelector<HTMLButtonElement>("[data-work-plane]");
    if (button) button.textContent = "Pick Work Plane";
    const step = hud?.querySelector<HTMLElement>("[data-step]");
    if (step) step.textContent = "Continue placing points on the active plane.";
    notify("info", "Face work-plane picking cancelled.");
    return true;
  }
  if (placement) {
    finishPlacement(null);
    notify("info", "Adaptive placement cancelled.");
    return true;
  }
  if (gripDrag && api) {
    const drag = gripDrag;
    gripDrag = null;
    try { api.cancelPointEdit(drag.elementId, drag.baseline); } catch (error) {
      notify("error", "Could not restore adaptive point: " + (error as Error).message);
    }
    refreshAdaptiveGrips();
    if (ctx.rightHost) ctx.rightHost.style.cursor = "";
    return true;
  }
  return false;
}

function backspacePlacementPoint(): boolean {
  if (!placement) return false;
  if (placement.points.length) placement.points.pop();
  drawPlacementPreview(null);
  updateHud();
  return true;
}

function disposeAdaptiveInteraction(): void {
  cancelActive();
  unsubGesture?.();
  unsubHover?.();
  unsubCancel?.();
  unsubAuthoring?.();
  unsubGesture = null;
  unsubHover = null;
  unsubCancel = null;
  unsubAuthoring = null;
  removeObject(previewRoot);
  removeObject(gripRoot);
  previewRoot = null;
  gripRoot = null;
  if (hud?.parentElement) hud.parentElement.removeChild(hud);
  hud = null;
  closePlaneEditor();
  installed = false;
  api = null;
}

export function setupAdaptiveInteraction(targetApi: Any): Any {
  if (installed) return (ctx.features as Any).adaptiveInteraction;
  api = targetApi as AdaptiveInteractionApi;
  if (!ctx.world?.scene?.three || !ctx.rightHost) {
    throw new Error("Adaptive viewport interaction requires an initialized 3D viewport");
  }
  ensureGroups();
  unsubGesture = inputRouter.subscribe((gesture) => {
    if (placement) {
      if (gesture.kind === "drag-start" && gesture.button === 0) return true;
      if (gesture.kind === "click" && gesture.button === 0) {
        if (workPlanePickArmed) {
          armWorkPlaneFromFace(gesture.event);
          return true;
        }
        void placeCurrentPoint(gesture.event);
        return true;
      }
      if (gesture.kind === "rmb-click") {
        if (workPlanePickArmed) {
          workPlanePickArmed = false;
          const button = hud?.querySelector<HTMLButtonElement>("[data-work-plane]");
          if (button) button.textContent = "Pick Work Plane";
          const step = hud?.querySelector<HTMLElement>("[data-step]");
          if (step) step.textContent = "Continue placing points on the active plane.";
          return true;
        }
        return backspacePlacementPoint();
      }
      return false;
    }
    if (gripDrag) {
      if (gesture.kind === "drag-move") {
        updateGripFromEvent(gesture.event);
        const drag = gripDrag;
        const raw = pointOnDragPlane(gesture.event, drag);
        if (raw) {
          const sequence = ++hoverSequence;
          void snapping.query(gesture.event, raw).then((result) => {
            if (gripDrag === drag && sequence === hoverSequence && result) updateGripFromEvent(gesture.event, result.point);
          }).catch(() => {});
        }
        return true;
      }
      if (gesture.kind === "drag-end") {
        const drag = gripDrag;
        gripDrag = null;
        try {
          if (drag.changed) api?.commitPointEdit(drag.elementId, drag.baseline);
          else api?.cancelPointEdit(drag.elementId, drag.baseline);
        } catch (error) {
          try { api?.cancelPointEdit(drag.elementId, drag.baseline); } catch { /* keep failure visible */ }
          notify("error", "Adaptive grip commit failed: " + (error as Error).message);
        }
        if (ctx.rightHost) ctx.rightHost.style.cursor = "";
        refreshAdaptiveGrips();
        return true;
      }
      return false;
    }
    if (gesture.kind === "drag-start" && gesture.button === 0 && beginGripDrag(gesture.event)) {
      if (ctx.rightHost) ctx.rightHost.style.cursor = "grabbing";
      return true;
    }
    if (gesture.kind === "click" && gesture.button === 0) {
      refreshAdaptiveGrips();
    }
    return false;
  }, 80);
  unsubHover = inputRouter.subscribeHover((event) => {
    if (placement) handlePlacementHover(event);
  });
  unsubCancel = inputRouter.registerCancel(cancelActive);
  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" || target.isContentEditable)) return;
    if (event.key === "Backspace" && placement) {
      event.preventDefault();
      backspacePlacementPoint();
    }
  });
  const authoring = (ctx.features as Any)?.authoring;
  if (typeof authoring?.onAuthoringChange === "function") {
    unsubAuthoring = authoring.onAuthoringChange(() => refreshAdaptiveGrips());
  }
  window.addEventListener("obs:authoring-changed", () => refreshAdaptiveGrips());
  window.addEventListener("resize", () => refreshAdaptiveGrips());

  const beginPlacement = (input: Omit<AdaptiveElementCreateInput, "points"> & { pointCount: number }): Promise<Any | null> => {
    if (placement) finishPlacement(null);
    if (!Number.isInteger(input.pointCount) || input.pointCount < 1 || input.pointCount > 8) {
      throw new Error("Adaptive placement requires between 1 and 8 points");
    }
    const { pointCount, ...createInput } = input;
    return new Promise<Any | null>((resolve) => {
      const resolvePlacement = (element: Any | null): void => {
        if (ctx.rightHost) ctx.rightHost.style.cursor = "";
        resolve(element);
      };
      placement = { input: createInput, pointCount, points: [], resolve: resolvePlacement };
      ensureHud();
      updateHud();
      drawPlacementPreview(null);
      ctx.rightHost.style.cursor = "crosshair";
      notify("info", "Adaptive placement: click the 3D model to place each ordered point. Escape cancels.");
    });
  };

  const interactionApi = { beginPlacement, cancelPlacement: cancelActive, refreshGrips: refreshAdaptiveGrips, dispose: disposeAdaptiveInteraction };
  targetApi.beginPlacement = beginPlacement;
  targetApi.cancelPlacement = cancelActive;
  targetApi.refreshGrips = refreshAdaptiveGrips;
  (ctx.features as Any).adaptiveInteraction = interactionApi;
  if (typeof targetApi.connectFamilyTypePropagation === "function") targetApi.connectFamilyTypePropagation();
  installed = true;
  refreshAdaptiveGrips();
  return interactionApi;
}
