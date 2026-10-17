/**
 * SketchUp-style primitives: Rectangle and Circle.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture } from "../core/input-router";
import { history } from "./history";
import { notify } from "../core/notify";

type PrimitiveKind = "rectangle" | "circle";
interface Pt { x: number; z: number; }

class PrimitivesManager {
  private kind: PrimitiveKind | null = null;
  private first: Pt | null = null;
  private cursor: Pt | null = null;
  private previewLine: THREE.Line | null = null;
  private unsubGesture: (() => void) | null = null;
  private unsubCancel: (() => void) | null = null;
  private listeners = new Set<() => void>();

  init(): void {
    if (this.unsubGesture) return;
    this.unsubGesture = inputRouter.subscribe((g) => this.handle(g), 85);
    this.unsubCancel = inputRouter.registerCancel(() => {
      if (!this.kind) return false;
      this.cancel();
      return true;
    });
    console.log("[primitives] ready");
  }

  isActive(): boolean { return this.kind !== null; }
  activateRectangle(): void { this.activate("rectangle"); }
  activateCircle(): void { this.activate("circle"); }

  cancel(): void {
    this.kind = null;
    this.first = null;
    this.cursor = null;
    this.clearPreview();
    ctx.rightHost.style.cursor = "";
    this.emit();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) { try { cb(); } catch {} }
  }

  private activate(kind: PrimitiveKind): void {
    try { (ctx.features as any).authoring?.setAuthoringTool?.("select"); } catch {}
    this.kind = kind;
    this.first = null;
    this.cursor = null;
    this.clearPreview();
    ctx.rightHost.style.cursor = "crosshair";
    notify("info", kind === "rectangle"
      ? "Rectangle - click first corner, then opposite corner"
      : "Circle - click center, then pick a radius");
    this.emit();
  }

  private groundPoint(e: PointerEvent): Pt | null {
    const rect = ctx.rightHost.getBoundingClientRect();
    if (rect.width < 1) return null;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, ctx.world.camera.three);
    const hits = ray.intersectObjects([ctx.groundPlane], false);
    if (!hits.length) return null;
    const p = hits[0].point;
    return { x: Math.round(p.x * 200) / 200, z: Math.round(p.z * 200) / 200 };
  }

  private ensurePreviewGroup(): THREE.Group {
    let g = (ctx.world.scene.three as any).__obsPrimitivesPreview as THREE.Group | undefined;
    if (g) return g;
    g = new THREE.Group();
    g.name = "__obsPrimitivesPreview";
    (ctx.world.scene.three as any).__obsPrimitivesPreview = g;
    ctx.world.scene.three.add(g);
    return g;
  }

  private clearPreview(): void {
    if (this.previewLine) {
      try {
        this.previewLine.geometry.dispose();
        (this.previewLine.material as THREE.Material).dispose?.();
        this.previewLine.parent?.remove(this.previewLine);
      } catch {}
      this.previewLine = null;
    }
  }

  private drawPreview(): void {
    this.clearPreview();
    if (!this.first || !this.cursor) return;
    const g = this.ensurePreviewGroup();
    const mat = new THREE.LineDashedMaterial({
      color: 0x38bdf8, dashSize: 0.3, gapSize: 0.2, transparent: true,
    });
    const pts: THREE.Vector3[] = [];
    if (this.kind === "rectangle") {
      const a = this.first;
      const b = this.cursor;
      pts.push(
        new THREE.Vector3(a.x, 0.02, a.z),
        new THREE.Vector3(b.x, 0.02, a.z),
        new THREE.Vector3(b.x, 0.02, b.z),
        new THREE.Vector3(a.x, 0.02, b.z),
        new THREE.Vector3(a.x, 0.02, a.z),
      );
    } else {
      const r = Math.hypot(this.cursor.x - this.first.x, this.cursor.z - this.first.z);
      const N = 48;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        pts.push(new THREE.Vector3(
          this.first.x + Math.cos(a) * r,
          0.02,
          this.first.z + Math.sin(a) * r,
        ));
      }
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    line.computeLineDistances();
    line.renderOrder = 999;
    g.add(line);
    this.previewLine = line;
  }

  private stamp(): string {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0")
      + String(d.getMinutes()).padStart(2, "0")
      + String(d.getSeconds()).padStart(2, "0");
  }

  private async createSlab(poly: [number, number][], name: string): Promise<void> {
    try {
      const authoring: any = (ctx.features as any).authoring;
      const els = authoring?.getElements?.() as any[] | undefined;
      if (!Array.isArray(els)) { notify("warn", "Authoring module not ready"); return; }
      const el = {
        id: (crypto as any).randomUUID?.() ?? ("slab-" + Date.now()),
        type: "slab",
        name,
        color: "#94a3b8",
        params: { polygon: poly, height: 0.2, thickness: 0.2, elevation: 0 },
      };
      els.push(el as any);
      authoring?.rebuildAuthored?.();
      try { (ctx.features as any).projects?.markDirty?.(); } catch {}
      history.push({
        label: "Create " + name,
        apply: () => {
          if (!els.includes(el as any)) els.push(el as any);
          authoring?.rebuildAuthored?.();
        },
        revert: () => {
          const i = els.indexOf(el as any);
          if (i >= 0) els.splice(i, 1);
          authoring?.rebuildAuthored?.();
        },
      });
      notify("success", name + " created - use Push/Pull to extrude");
    } catch (err) {
      console.error("[primitives] create slab failed", err);
      notify("error", "Could not create primitive - see console");
    }
  }

  private handle = (g: Gesture): boolean => {
    if (!this.kind) return false;
    if (g.kind === "click" && g.button === 0) {
      const p = this.groundPoint(g.event);
      if (!p) return false;
      if (!this.first) {
        this.first = p;
        this.cursor = p;
        notify("info", this.kind === "rectangle"
          ? "Rectangle - click opposite corner"
          : "Circle - click radius point");
        return true;
      }
      const a = this.first;
      const b = p;
      const kind = this.kind;
      this.cancel();
      if (kind === "rectangle") {
        void this.createSlab([
          [a.x, a.z], [b.x, a.z], [b.x, b.z], [a.x, b.z],
        ], "Rectangle " + this.stamp());
      } else {
        const r = Math.hypot(b.x - a.x, b.z - a.z);
        if (r < 0.05) { notify("warn", "Radius too small"); return true; }
        const N = 32;
        const poly: [number, number][] = [];
        for (let i = 0; i < N; i++) {
          const ang = (i / N) * Math.PI * 2;
          poly.push([a.x + Math.cos(ang) * r, a.z + Math.sin(ang) * r]);
        }
        void this.createSlab(poly, "Circle " + this.stamp());
      }
      return true;
    }
    return false;
  };

  installHover(): void {
    ctx.rightHost.addEventListener("pointermove", (e) => {
      if (!this.kind || !this.first) return;
      const p = this.groundPoint(e as PointerEvent);
      if (!p) return;
      this.cursor = p;
      this.drawPreview();
    });
  }
}

export const primitives = new PrimitivesManager();

export function setupPrimitives(): void {
  primitives.init();
  primitives.installHover();
  (ctx.features as any).primitives = {
    activateRectangle: () => primitives.activateRectangle(),
    activateCircle: () => primitives.activateCircle(),
    cancel: () => primitives.cancel(),
    isActive: () => primitives.isActive(),
    onChange: (cb: () => void) => primitives.onChange(cb),
  };
  console.log("[primitives] setup complete");
}
