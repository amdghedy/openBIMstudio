/**
 * Transform gizmo (Blender/3ds Max class).
 *
 * Modes: move | rotate | scale | none
 *
 * Two independent target channels:
 *   • Fragment selection (default)
 *   • Override provider (used by authoring — authored elements)
 *   • Edit targets (used by frag-edit — model element clones)
 *
 * Priority at refresh(): editTargets > overrideProvider > fragment selection.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture } from "../core/input-router";
import { selection } from "./selection";

export type GizmoMode = "move" | "rotate" | "scale" | "none";

export interface GizmoCallbacks {
  onStart?: () => void;
  onUpdate?: (delta: THREE.Vector3, axis: "x" | "y" | "z" | "free") => void;
  onEnd?: (delta: THREE.Vector3, axis: "x" | "y" | "z" | "free") => void;
}

export interface GizmoTarget {
  center: THREE.Vector3;
  box: THREE.Box3;
}

const AXIS_COLOR = { x: 0xef4444, y: 0x22c55e, z: 0x3b82f6, free: 0xfbbf24 };

class TransformGizmo {
  private mode: GizmoMode = "none";
  private root: THREE.Group;
  private moveGroup: THREE.Group;
  private rotateGroup: THREE.Group;
  private scaleGroup: THREE.Group;
  private host: HTMLElement | null = null;
  private unsubGesture: (() => void) | null = null;
  private unsubHover: (() => void) | null = null;

  private dragging = false;
  private activeAxis: "x" | "y" | "z" | "free" | null = null;
  private dragStartValue: THREE.Vector3 | null = null;
  private hovered: THREE.Object3D | null = null;

  private basePos = new THREE.Vector3();
  private baseScale = 1;

  private cb: GizmoCallbacks = {};
  private editCb: GizmoCallbacks = {};
  private overrideProvider: (() => Promise<GizmoTarget | null>) | null = null;
  private editTargets: THREE.Object3D[] = [];

  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor() {
    this.root = new THREE.Group();
    this.root.name = "obs-gizmo";
    this.moveGroup = new THREE.Group();
    this.rotateGroup = new THREE.Group();
    this.scaleGroup = new THREE.Group();
    this.root.add(this.moveGroup, this.rotateGroup, this.scaleGroup);
    this.buildMove();
    this.buildRotate();
    this.buildScale();
    this.root.visible = false;
  }

  private mkMat(color: number, opacity = 1) {
    return new THREE.MeshBasicMaterial({
      color, transparent: opacity < 1, opacity,
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  private buildMove() {
    const len = 1.2, shaftR = 0.02, headR = 0.09, headL = 0.22;
    const axes = [
      { dir: new THREE.Vector3(1, 0, 0), color: AXIS_COLOR.x },
      { dir: new THREE.Vector3(0, 1, 0), color: AXIS_COLOR.y },
      { dir: new THREE.Vector3(0, 0, 1), color: AXIS_COLOR.z },
    ];
    for (const { dir, color } of axes) {
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(shaftR, shaftR, len, 8), this.mkMat(color));
      shaft.position.copy(dir.clone().multiplyScalar(len / 2));
      const head = new THREE.Mesh(new THREE.ConeGeometry(headR, headL, 12), this.mkMat(color));
      head.position.copy(dir.clone().multiplyScalar(len));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      shaft.quaternion.copy(q); head.quaternion.copy(q);
      const ax = dir.x ? "x" : dir.y ? "y" : "z";
      shaft.userData.axis = ax; head.userData.axis = ax;
      shaft.renderOrder = 100; head.renderOrder = 100;
      g.add(shaft, head);
      this.moveGroup.add(g);
    }
    const center = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), this.mkMat(AXIS_COLOR.free, 0.85));
    center.userData.axis = "free";
    center.renderOrder = 100;
    this.moveGroup.add(center);
  }

  private buildRotate() {
    const axes = [
      { dir: new THREE.Vector3(0, 1, 0), color: AXIS_COLOR.y },
      { dir: new THREE.Vector3(1, 0, 0), color: AXIS_COLOR.x },
      { dir: new THREE.Vector3(0, 0, 1), color: AXIS_COLOR.z },
    ];
    for (const { dir, color } of axes) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.015, 8, 64), this.mkMat(color, 0.9));
      ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
      ring.userData.axis = dir.x ? "x" : dir.y ? "y" : "z";
      ring.renderOrder = 100;
      g.add(ring);
      this.rotateGroup.add(g);
    }
  }

  private buildScale() {
    const axes = [
      { dir: new THREE.Vector3(1, 0, 0), color: AXIS_COLOR.x },
      { dir: new THREE.Vector3(0, 1, 0), color: AXIS_COLOR.y },
      { dir: new THREE.Vector3(0, 0, 1), color: AXIS_COLOR.z },
    ];
    for (const { dir, color } of axes) {
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.0, 6), this.mkMat(color));
      shaft.position.copy(dir.clone().multiplyScalar(0.5));
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), this.mkMat(color));
      head.position.copy(dir.clone().multiplyScalar(1.0));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      shaft.quaternion.copy(q);
      const ax = dir.x ? "x" : dir.y ? "y" : "z";
      shaft.userData.axis = ax; head.userData.axis = ax;
      shaft.renderOrder = 100; head.renderOrder = 100;
      g.add(shaft, head);
      this.scaleGroup.add(g);
    }
    const uni = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), this.mkMat(AXIS_COLOR.free));
    uni.userData.axis = "free";
    uni.renderOrder = 100;
    this.scaleGroup.add(uni);
  }

  /* ── Public API ──────────────────────────────────────────────────── */
  setup(host: HTMLElement): void {
    this.host = host;
    ctx.world.scene.three.add(this.root);

    // Priority 100 — gizmo runs before everything else so its handle drag
    // always claims the gesture even when a modeling tool is active.
    this.unsubGesture = inputRouter.subscribe((g) => this.handleGesture(g), 100);
    this.unsubHover = inputRouter.subscribeHover((e) => this.handleHover(e));

    ctx.world.camera.controls.addEventListener("update", () => this.refreshScale());
  }

  dispose(): void {
    this.unsubGesture?.();
    this.unsubHover?.();
    this.unsubGesture = null;
    this.unsubHover = null;
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    this.moveGroup.visible = mode === "move";
    this.rotateGroup.visible = mode === "rotate";
    this.scaleGroup.visible = mode === "scale";
    void this.refresh();
  }
  getMode(): GizmoMode { return this.mode; }

  setCallbacks(cb: GizmoCallbacks): void { this.cb = cb; }
  setEditCallbacks(cb: GizmoCallbacks): void { this.editCb = cb; }

  setOverrideProvider(provider: (() => Promise<GizmoTarget | null>) | null): void {
    this.overrideProvider = provider;
    void this.refresh();
  }
  getOverrideProvider(): (() => Promise<GizmoTarget | null>) | null {
    return this.overrideProvider;
  }

  /** Frag-edit channel. When non-empty, these objects win over everything else. */
  setEditTargets(objects: THREE.Object3D[]): void {
    this.editTargets = objects.slice();
    void this.refresh();
  }
  hasEditTargets(): boolean { return this.editTargets.length > 0; }

  private activeCallbacks(): GizmoCallbacks {
    return this.editTargets.length > 0 ? this.editCb : this.cb;
  }

  async refresh(): Promise<void> {
    if (this.mode === "none") { this.root.visible = false; return; }

    let center: THREE.Vector3 | null = null;
    const size = new THREE.Vector3(1, 1, 1);

    // Priority 1 — frag-edit targets
    if (this.editTargets.length > 0) {
      const box = new THREE.Box3();
      for (const o of this.editTargets) box.union(new THREE.Box3().setFromObject(o));
      if (box.isEmpty()) { this.root.visible = false; return; }
      center = box.getCenter(new THREE.Vector3());
      box.getSize(size);
    }
    // Priority 2 — authoring override provider
    else if (this.overrideProvider) {
      const r = await this.overrideProvider();
      if (!r) { this.root.visible = false; return; }
      center = r.center.clone();
      r.box.getSize(size);
    }
    // Priority 3 — fragment selection
    else {
      if (selection.isEmpty()) { this.root.visible = false; return; }
      const box = await selection.boundingBox();
      if (!box) { this.root.visible = false; return; }
      center = box.getCenter(new THREE.Vector3());
      box.getSize(size);
    }

    this.basePos.copy(center);
    const diag = size.length() || 1;
    this.baseScale = THREE.MathUtils.clamp(diag / 4, 0.3, 5);
    this.root.position.copy(this.basePos);
    this.refreshScale();
    this.root.visible = true;
  }

  private refreshScale(): void {
    if (!this.root.visible) return;
    const cam = ctx.world.camera.three;
    const dist = cam.position.distanceTo(this.root.position);
    const f = dist * 0.15;
    this.root.scale.setScalar(Math.max(0.2, f * this.baseScale));
  }

  isDragging(): boolean { return this.dragging; }

  /* ── Interaction (via input-router) ───────────────────────────────── */
  private handleGesture(g: Gesture): boolean {
    if (!this.root.visible) return false;

    if (g.kind === "drag-start") {
      if (g.button !== 0) return false;
      const picked = this.pickHandle(g.event);
      if (!picked) return false;
      this.dragging = true;
      this.activeAxis = (picked.userData.axis as any) ?? "free";
      const plane = this.dragPlane();
      const start = plane ? this.raycastPlane(g.event, plane) : null;
      this.dragStartValue = start ? start.clone() : null;
      this.activeCallbacks().onStart?.();
      return true;
    }

    if (g.kind === "drag-move" && this.dragging) {
      const plane = this.dragPlane();
      if (plane) {
        const hit = this.raycastPlane(g.event, plane);
        if (hit && this.dragStartValue) {
          const delta = this.constrainDelta(hit.clone().sub(this.dragStartValue));
          this.activeCallbacks().onUpdate?.(delta, this.activeAxis ?? "free");
        }
      }
      return true;
    }

    if (g.kind === "drag-end" && this.dragging) {
      const plane = this.dragPlane();
      const end = plane ? this.raycastPlane(g.event, plane) : null;
      let delta = new THREE.Vector3();
      if (end && this.dragStartValue) delta = end.clone().sub(this.dragStartValue);
      const axis = this.activeAxis ?? "free";
      const finalDelta = this.constrainDelta(delta);
      this.dragging = false;
      this.activeAxis = null;
      this.dragStartValue = null;
      this.activeCallbacks().onEnd?.(finalDelta, axis);
      return true;
    }

    return false;
  }

  private handleHover(e: PointerEvent): void {
    if (!this.root.visible || this.dragging) return;
    this.updateHover(e);
  }

  /* ── Internals ───────────────────────────────────────────────────── */
  private updateNdc(e: PointerEvent) {
    const r = ctx.rightHost.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private pickHandle(e: PointerEvent): THREE.Object3D | null {
    this.updateNdc(e);
    this.ray.setFromCamera(this.ndc, ctx.world.camera.three);
    const group = this.mode === "move" ? this.moveGroup : this.mode === "rotate" ? this.rotateGroup : this.scaleGroup;
    const hits = this.ray.intersectObjects(group.children, true);
    if (!hits.length) return null;
    let o: THREE.Object3D | null = hits[0].object;
    while (o && !o.userData.axis) o = o.parent;
    return o;
  }

  private updateHover(e: PointerEvent): void {
    const picked = this.pickHandle(e);
    if (picked === this.hovered) return;
    if (this.hovered) this.setHandleHighlight(this.hovered, false);
    this.hovered = picked;
    if (picked) this.setHandleHighlight(picked, true);
    if (this.host) this.host.style.cursor = picked ? "grab" : "";
  }

  private setHandleHighlight(obj: THREE.Object3D, on: boolean): void {
    obj.traverse((m: any) => {
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshBasicMaterial;
      if (!mat?.color) return;
      if (on) mat.color.offsetHSL(0, 0, 0.25); else mat.color.offsetHSL(0, 0, -0.25);
    });
  }

  private dragPlane(): THREE.Plane | null {
    if (!this.activeAxis) return null;
    const cam = ctx.world.camera.three;
    const camDir = new THREE.Vector3();
    cam.getWorldDirection(camDir);
    if (this.activeAxis === "free") {
      return new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, this.basePos);
    }
    const axis = new THREE.Vector3(
      this.activeAxis === "x" ? 1 : 0,
      this.activeAxis === "y" ? 1 : 0,
      this.activeAxis === "z" ? 1 : 0,
    );
    const normal = new THREE.Vector3().crossVectors(axis, camDir).cross(axis);
    if (normal.lengthSq() < 1e-6) normal.copy(camDir);
    normal.normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, this.basePos);
  }

  private raycastPlane(e: PointerEvent, plane: THREE.Plane): THREE.Vector3 | null {
    this.updateNdc(e);
    this.ray.setFromCamera(this.ndc, ctx.world.camera.three);
    const p = new THREE.Vector3();
    const hit = this.ray.ray.intersectPlane(plane, p);
    return hit ? p : null;
  }

  private constrainDelta(delta: THREE.Vector3): THREE.Vector3 {
    if (!this.activeAxis || this.activeAxis === "free") return delta;
    if (this.activeAxis === "x") return new THREE.Vector3(delta.x, 0, 0);
    if (this.activeAxis === "y") return new THREE.Vector3(0, delta.y, 0);
    return new THREE.Vector3(0, 0, delta.z);
  }
}

export const gizmo = new TransformGizmo();