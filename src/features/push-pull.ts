/**
 * Push/Pull - SketchUp-style direct face extrusion.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture } from "../core/input-router";
import { history } from "./history";
import { notify } from "../core/notify";
import type { AuthoredElement } from "../modules/projects/types";

type Dimension = "height" | "thickness" | "depth" | "length";

interface HoverState {
  elementId: string;
  faceNormal: THREE.Vector3;
  hitPoint: THREE.Vector3;
  dimension: Dimension;
  sign: 1 | -1;
}

interface DragState {
  elementId: string;
  dimension: Dimension;
  sign: 1 | -1;
  startValue: number;
  startPoint: THREE.Vector3;
  baseline: AuthoredElement["params"];
  plane: THREE.Plane;
}

const MIN_DIM = 0.02;

class PushPullManager {
  private enabled = false;
  private hovered: HoverState | null = null;
  private dragging: DragState | null = null;
  private unsubGesture: (() => void) | null = null;
  private unsubCancel: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private lastHoverAt = 0;
  private static HOVER_MS = 55;

  init(): void {
    if (this.unsubGesture) return;
    this.unsubGesture = inputRouter.subscribe((g) => this.handle(g), 90);
    this.unsubCancel = inputRouter.registerCancel(() => {
      if (!this.enabled && !this.dragging) return false;
      if (this.dragging) { this.cancelDrag(); return true; }
      this.disable();
      return true;
    });
    console.log("[push-pull] ready");
  }

  isEnabled(): boolean { return this.enabled; }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    ctx.rightHost.style.cursor = "ns-resize";
    notify("info", "Push/Pull - hover a face, then drag");
    this.emit();
  }

  disable(): void {
    if (this.dragging) this.cancelDrag();
    this.enabled = false;
    this.hovered = null;
    try { (ctx.highlighter as any)?.clear?.("pushpull"); } catch {}
    ctx.rightHost.style.cursor = "";
    this.emit();
  }

  toggle(): void { this.enabled ? this.disable() : this.enable(); }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) { try { cb(); } catch {} }
  }

  private authoring(): any { return (ctx.features as any).authoring; }

  private pickFace(e: PointerEvent): HoverState | null {
    const group: THREE.Group | null = this.authoring()?.getAuthoredGroup?.() ?? null;
    if (!group) return null;
    const rect = ctx.rightHost.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.world.camera.three);
    const hits = ray.intersectObjects(group.children, true);
    if (!hits.length || !hits[0].face) return null;
    const hit = hits[0];
    let obj: THREE.Object3D | null = hit.object;
    let elementId: string | null = null;
    while (obj && !elementId) {
      const id = obj.userData?.elementId;
      if (id) elementId = String(id);
      obj = obj.parent;
    }
    if (!elementId) return null;
    const el: AuthoredElement | null = this.authoring()?.getElementById?.(elementId) ?? null;
    if (!el || el.properties?.pinned) return null;
    const normal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld);
    const mapped = this.mapFace(el, normal);
    if (!mapped) return null;
    return {
      elementId,
      faceNormal: normal,
      hitPoint: hit.point.clone(),
      dimension: mapped.dimension,
      sign: mapped.sign,
    };
  }

  private mapFace(el: AuthoredElement, normal: THREE.Vector3): { dimension: Dimension; sign: 1 | -1 } | null {
    if (Math.abs(normal.y) > 0.7) {
      return { dimension: "height", sign: normal.y > 0 ? 1 : -1 };
    }
    const p = el.params;
    const along = new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3(0, 0, 1);
    if (p.start && p.end) {
      const dx = p.end[0] - p.start[0];
      const dz = p.end[1] - p.start[1];
      const L = Math.hypot(dx, dz) || 1;
      along.set(dx / L, 0, dz / L);
      perp.set(-dz / L, 0, dx / L);
    }
    const a = Math.abs(normal.dot(along));
    const b = Math.abs(normal.dot(perp));
    if (b >= a) {
      const linear = ["wall", "beam", "duct", "pipe", "cable-tray", "conduit", "strip"];
      return { dimension: linear.includes(el.type) ? "thickness" : "depth", sign: 1 };
    }
    return { dimension: "length", sign: normal.dot(along) > 0 ? 1 : -1 };
  }

  private normalFor(d: DragState): THREE.Vector3 {
    const el: AuthoredElement | null = this.authoring()?.getElementById?.(d.elementId) ?? null;
    if (!el) return new THREE.Vector3(0, 1, 0);
    const p = el.params;
    if (d.dimension === "height") return new THREE.Vector3(0, 1, 0);
    if (p.start && p.end) {
      const dx = p.end[0] - p.start[0];
      const dz = p.end[1] - p.start[1];
      const L = Math.hypot(dx, dz) || 1;
      if (d.dimension === "length") {
        return new THREE.Vector3(dx / L, 0, dz / L).multiplyScalar(d.sign);
      }
      return new THREE.Vector3(-dz / L, 0, dx / L);
    }
    return new THREE.Vector3(1, 0, 0);
  }

  private readDimension(el: AuthoredElement, dim: Dimension): number {
    const p = el.params as any;
    if (dim === "length" && p.start && p.end) {
      return Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
    }
    return Number(p[dim] ?? 0);
  }

  private startDrag(): boolean {
    const hover = this.hovered;
    if (!hover) return false;
    const el: AuthoredElement | null = this.authoring()?.getElementById?.(hover.elementId) ?? null;
    if (!el) return false;
    if (el.properties?.pinned) {
      notify("warn", el.name + " is pinned - unpin to edit");
      return false;
    }
    const baseline = JSON.parse(JSON.stringify(el.params)) as AuthoredElement["params"];
    const drag: DragState = {
      elementId: hover.elementId,
      dimension: hover.dimension,
      sign: hover.sign,
      startValue: this.readDimension(el, hover.dimension),
      startPoint: hover.hitPoint.clone(),
      baseline,
      plane: new THREE.Plane(),
    };
    const n = this.normalFor(drag);
    const camDir = new THREE.Vector3();
    ctx.world.camera.three.getWorldDirection(camDir);
    const side = new THREE.Vector3().crossVectors(n, camDir);
    if (side.lengthSq() < 1e-8) side.set(0, 1, 0);
    side.normalize();
    const planeN = new THREE.Vector3().crossVectors(side, n).normalize();
    drag.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeN, drag.startPoint);
    this.dragging = drag;
    try { (ctx.highlighter as any)?.clear?.("pushpull"); } catch {}
    return true;
  }

  private applyDelta(delta: number): void {
    const d = this.dragging;
    if (!d) return;
    const el: AuthoredElement | null = this.authoring()?.getElementById?.(d.elementId) ?? null;
    if (!el) return;
    const p = el.params as any;
    if (d.dimension === "height") {
      p.height = Math.max(MIN_DIM, d.startValue + delta * d.sign);
    } else if (d.dimension === "length") {
      if (p.start && p.end && d.baseline.start && d.baseline.end) {
        const dx = d.baseline.end[0] - d.baseline.start[0];
        const dz = d.baseline.end[1] - d.baseline.start[1];
        const L0 = Math.hypot(dx, dz) || 1;
        const ux = dx / L0;
        const uz = dz / L0;
        const L1 = Math.max(MIN_DIM, d.startValue + delta);
        if (d.sign > 0) {
          p.end = [d.baseline.start[0] + ux * L1, d.baseline.start[1] + uz * L1];
        } else {
          p.start = [d.baseline.end[0] - ux * L1, d.baseline.end[1] - uz * L1];
        }
      }
    } else {
      p[d.dimension] = Math.max(MIN_DIM, d.startValue + delta * d.sign);
    }
    this.authoring()?.rebuildAuthored?.();
  }

  private cancelDrag(): void {
    const d = this.dragging;
    if (!d) return;
    const el: AuthoredElement | null = this.authoring()?.getElementById?.(d.elementId) ?? null;
    if (el) {
      el.params = JSON.parse(JSON.stringify(d.baseline));
      this.authoring()?.rebuildAuthored?.();
    }
    this.dragging = null;
    ctx.rightHost.style.cursor = "ns-resize";
  }

  private commit(): void {
    const d = this.dragging;
    this.dragging = null;
    if (!d) return;
    const el: AuthoredElement | null = this.authoring()?.getElementById?.(d.elementId) ?? null;
    if (!el) return;
    const after = JSON.parse(JSON.stringify(el.params)) as AuthoredElement["params"];
    if (JSON.stringify(after) === JSON.stringify(d.baseline)) return;
    el.params = JSON.parse(JSON.stringify(d.baseline));
    this.authoring()?.rebuildAuthored?.();
    const applyParams = (params: AuthoredElement["params"]) => {
      const live: AuthoredElement | null = this.authoring()?.getElementById?.(d.elementId) ?? null;
      if (!live) return;
      live.params = JSON.parse(JSON.stringify(params));
      this.authoring()?.rebuildAuthored?.();
      try { this.authoring()?.migrateMepFittingRadii?.(); } catch {}
      try { (ctx.features as any).projects?.markDirty?.(); } catch {}
    };
    history.push({
      label: "Push/Pull - " + el.name,
      apply: () => applyParams(after),
      revert: () => applyParams(d.baseline),
    });
    applyParams(after);
    notify("success", "Push/Pull - " + el.name);
  }

  private handle = (g: Gesture): boolean => {
    if (!this.enabled) return false;
    if (g.kind === "drag-start" && g.button === 0) {
      if (!this.hovered) return false;
      return this.startDrag();
    }
    if (g.kind === "drag-move" && this.dragging) {
      const d = this.dragging;
      const rect = ctx.rightHost.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((g.event.clientX - rect.left) / rect.width) * 2 - 1,
        -((g.event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, ctx.world.camera.three);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(d.plane, hit)) return true;
      const n = this.normalFor(d);
      this.applyDelta(hit.clone().sub(d.startPoint).dot(n));
      return true;
    }
    if (g.kind === "drag-end" && this.dragging) {
      this.commit();
      return true;
    }
    return false;
  };

  installHover(): void {
    ctx.rightHost.addEventListener("pointermove", (e) => {
      if (!this.enabled || this.dragging) return;
      const now = performance.now();
      if (now - this.lastHoverAt < PushPullManager.HOVER_MS) return;
      this.lastHoverAt = now;
      const next = this.pickFace(e);
      const same =
        (!next && !this.hovered) ||
        (!!next && !!this.hovered &&
          next.elementId === this.hovered.elementId &&
          next.dimension === this.hovered.dimension);
      if (same) return;
      this.hovered = next;
      try { (ctx.highlighter as any)?.clear?.("pushpull"); } catch {}
    });
  }
}

export const pushPull = new PushPullManager();

export function setupPushPull(): void {
  pushPull.init();
  pushPull.installHover();
  (ctx.features as any).pushPull = {
    enable: () => pushPull.enable(),
    disable: () => pushPull.disable(),
    toggle: () => pushPull.toggle(),
    isEnabled: () => pushPull.isEnabled(),
    onChange: (cb: () => void) => pushPull.onChange(cb),
  };
  try { (window as any).__obsPushPull = pushPull; } catch {}
  console.log("[push-pull] setup complete");
}
