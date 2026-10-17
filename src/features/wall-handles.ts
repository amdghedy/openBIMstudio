/**
 * BIM-style wall shape handles.
 *
 * When a single wall (or beam / duct / pipe / tray / conduit) is selected:
 *   - Two large blue circles appear at each end (shape handles)
 *   - Two flip arrows appear at the midpoint
 *   - Dragging a shape handle stretches / shrinks the element on the ground
 *   - A temporary dimension appears live while dragging
 *   - Endpoints snap to other wall endpoints within tolerance
 *
 * The overlay is HTML/SVG on top of the canvas, so handles are pixel-sized
 * regardless of camera distance. This matches BIM's presentation exactly.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture } from "../core/input-router";
import { history } from "./history";
import { notify } from "../core/notify";
import { units } from "../core/units";
import type { AuthoredElement } from "../modules/projects/types";

const HANDLE_RADIUS_PX = 8;
const HANDLE_HIT_RADIUS_PX = 12;
const FLIP_HIT_RADIUS_PX = 16;
const SNAP_SCREEN_TOL_PX = 14;
const DIM_OFFSET_PX = 30;

const WALL_LIKE_TYPES = new Set<string>([
  "wall", "beam", "duct", "pipe", "cable-tray", "conduit", "strip", "mline",
]);

interface ActiveWall { id: string; el: AuthoredElement; }
interface ScreenPt { x: number; y: number; visible: boolean; }
interface HandlePositions { start: ScreenPt | null; end: ScreenPt | null; mid: ScreenPt | null; }

interface DragState {
  wallId: string;
  which: "start" | "end";
  baseline: AuthoredElement["params"];
  groundY: number;
  currentWorld: { x: number; z: number };
  snapTarget: { x: number; z: number } | null;
}

class WallHandlesManager {
  private wrap: HTMLDivElement | null = null;
  private svg: SVGSVGElement | null = null;
  private dimG: SVGGElement | null = null;
  private hG: SVGGElement | null = null;
  private drag: DragState | null = null;
  private handlePos: HandlePositions = { start: null, end: null, mid: null };
  private unsubGesture: (() => void) | null = null;
  private installed = false;
  private rafScheduled = false;
  private authUnsub: (() => void) | null = null;
  private selUnsub: (() => void) | null = null;

  init(): void {
    if (this.installed) return;
    this.installed = true;
    this.ensureOverlay();
    this.hookSources();
    this.unsubGesture = inputRouter.subscribe((g) => this.handle(g), 95);
    try {
      ctx.world.camera.controls.addEventListener("update", () => this.schedule());
    } catch { /* */ }
    ctx.rightHost.addEventListener("pointermove", () => {
      if (!this.drag) this.schedule();
    });
    window.addEventListener("resize", () => this.schedule());
    (window as any).__obsWallHandlesActive = true;
    console.log("[wall-handles] ready");
  }

  private hookSources(): void {
    const auth: any = (ctx.features as any).authoring;
    if (auth?.onAuthoringChange) {
      this.authUnsub = auth.onAuthoringChange(() => this.schedule());
    }
    const sel: any = (ctx.features as any).selection;
    if (sel?.onChange) {
      this.selUnsub = sel.onChange(() => this.schedule());
    }
    this.schedule();
  }

  destroy(): void {
    this.unsubGesture?.();
    this.unsubGesture = null;
    this.authUnsub?.();
    this.selUnsub?.();
    (window as any).__obsWallHandlesActive = false;
    this.wrap?.remove();
    this.wrap = null;
    this.svg = null;
    this.dimG = null;
    this.hG = null;
    this.installed = false;
  }

  private schedule(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.render();
    });
  }

  private ensureOverlay(): void {
    if (this.svg) return;
    const host = ctx.rightHost;
    const wrap = document.createElement("div");
    wrap.id = "obs-wall-handles";
    wrap.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:45;overflow:hidden";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
    const dimG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const hG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.append(dimG, hG);
    wrap.appendChild(svg);
    host.appendChild(wrap);
    this.wrap = wrap;
    this.svg = svg;
    this.dimG = dimG;
    this.hG = hG;
  }

  private activeWall(): ActiveWall | null {
    const auth: any = (ctx.features as any).authoring;
    if (!auth) return null;
    const ids: string[] = auth.getSelectedIds?.() ?? [];
    if (ids.length !== 1) return null;
    const el: AuthoredElement | null = auth.getElementById?.(ids[0]) ?? null;
    if (!el) return null;
    if (!WALL_LIKE_TYPES.has(el.type)) return null;
    if (!el.params.start || !el.params.end) return null;
    if (el.properties?.pinned) return null;
    return { id: el.id, el };
  }

  private activeWallById(id: string): ActiveWall | null {
    const auth: any = (ctx.features as any).authoring;
    const el: AuthoredElement | null = auth?.getElementById?.(id) ?? null;
    if (!el || !el.params.start || !el.params.end) return null;
    return { id: el.id, el };
  }

  private project(x: number, y: number, z: number): ScreenPt | null {
    try {
      const cam = ctx.world.camera.three;
      const rect = ctx.rightHost.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      const v = new THREE.Vector3(x, y, z).project(cam);
      if (!isFinite(v.x) || !isFinite(v.y)) return null;
      return {
        x: (v.x * 0.5 + 0.5) * rect.width,
        y: (-v.y * 0.5 + 0.5) * rect.height,
        visible: v.z >= -1 && v.z <= 1,
      };
    } catch { return null; }
  }

  private clearAll(): void {
    while (this.dimG?.firstChild) this.dimG.removeChild(this.dimG.firstChild);
    while (this.hG?.firstChild) this.hG.removeChild(this.hG.firstChild);
  }

  private render(): void {
    if (!this.svg || !this.dimG || !this.hG) return;
    this.clearAll();
    this.handlePos = { start: null, end: null, mid: null };

    const wall = this.drag
      ? this.activeWallById(this.drag.wallId)
      : this.activeWall();
    if (!wall) return;

    const p = wall.el.params;
    if (!p.start || !p.end) return;

    const y = p.elevation + 0.02;
    const sx = (this.drag?.which === "start") ? this.drag.currentWorld.x : p.start[0];
    const sz = (this.drag?.which === "start") ? this.drag.currentWorld.z : p.start[1];
    const ex = (this.drag?.which === "end") ? this.drag.currentWorld.x : p.end[0];
    const ez = (this.drag?.which === "end") ? this.drag.currentWorld.z : p.end[1];

    const s = this.project(sx, y, sz);
    const e = this.project(ex, y, ez);
    if (!s || !e) return;
    this.handlePos.start = s;
    this.handlePos.end = e;

    const rect = ctx.rightHost.getBoundingClientRect();
    this.svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

    const dx = e.x - s.x;
    const dy = e.y - s.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;

    this.line(this.dimG, s.x, s.y, e.x, e.y, "#2563eb", 1.2, "6 3", 0.7);

    const mx = (s.x + e.x) / 2;
    const my = (s.y + e.y) / 2;
    this.handlePos.mid = { x: mx, y: my, visible: s.visible && e.visible };

    const ao = 15;
    for (const sign of [1, -1]) {
      const tipX = mx + nx * (ao - 7) * sign;
      const tipY = my + ny * (ao - 7) * sign;
      const b1x = mx + nx * (ao + 5) * sign + ux * 5;
      const b1y = my + ny * (ao + 5) * sign + uy * 5;
      const b2x = mx + nx * (ao + 5) * sign - ux * 5;
      const b2y = my + ny * (ao + 5) * sign - uy * 5;
      this.polygon(this.hG, `${tipX},${tipY} ${b1x},${b1y} ${b2x},${b2y}`,
        "#38bdf8", "#0b0d12", 1, { flip: "1" });
    }

    this.circle(this.hG, s.x, s.y, HANDLE_RADIUS_PX, "#2563eb", "#ffffff", 2, { handle: "start" });
    this.circle(this.hG, e.x, e.y, HANDLE_RADIUS_PX, "#2563eb", "#ffffff", 2, { handle: "end" });
    this.circle(this.hG, s.x, s.y, HANDLE_RADIUS_PX * 0.42, "#bae6fd", "none", 0, {});
    this.circle(this.hG, e.x, e.y, HANDLE_RADIUS_PX * 0.42, "#bae6fd", "none", 0, {});

    if (this.drag) {
      const length = Math.hypot(ex - sx, ez - sz);
      const text = units.formatLength(length, { precision: 0 });
      const w1x = s.x + nx * DIM_OFFSET_PX;
      const w1y = s.y + ny * DIM_OFFSET_PX;
      const w2x = e.x + nx * DIM_OFFSET_PX;
      const w2y = e.y + ny * DIM_OFFSET_PX;
      this.line(this.dimG, s.x, s.y, w1x, w1y, "#2563eb", 1, null, 0.6);
      this.line(this.dimG, e.x, e.y, w2x, w2y, "#2563eb", 1, null, 0.6);
      this.line(this.dimG, w1x, w1y, w2x, w2y, "#2563eb", 1, null, 1);
      for (const h of [[w1x, w1y], [w2x, w2y]] as Array<[number, number]>) {
        this.line(this.dimG,
          h[0] - ux * 4 - nx * 4, h[1] - uy * 4 - ny * 4,
          h[0] + ux * 4 + nx * 4, h[1] + uy * 4 + ny * 4,
          "#2563eb", 1.2, null, 1);
      }
      const tw = text.length * 7.2 + 12;
      const tcx = (w1x + w2x) / 2;
      const tcy = (w1y + w2y) / 2;
      this.rect(this.dimG, tcx - tw / 2, tcy - 10, tw, 20, 4, "#f8fafc", "#2563eb", 1);
      this.text(this.dimG, tcx, tcy + 4, text, "#1e3a8a", 12, "600");

      if (this.drag.snapTarget) {
        const sp = this.project(this.drag.snapTarget.x, y, this.drag.snapTarget.z);
        if (sp) this.rect(this.hG, sp.x - 6, sp.y - 6, 12, 12, 0, "#f59e0b", "#0b0d12", 1.5);
      }
    }
  }

  private line(parent: SVGGElement, x1: number, y1: number, x2: number, y2: number,
               stroke: string, width: number, dash: string | null, opacity: number): void {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1));
    l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
    l.setAttribute("stroke", stroke); l.setAttribute("stroke-width", String(width));
    if (dash) l.setAttribute("stroke-dasharray", dash);
    l.setAttribute("opacity", String(opacity));
    parent.appendChild(l);
  }
  private circle(parent: SVGGElement, cx: number, cy: number, r: number,
                 fill: string, stroke: string, sw: number, data: Record<string, string>): void {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(cx)); c.setAttribute("cy", String(cy));
    c.setAttribute("r", String(r)); c.setAttribute("fill", fill);
    if (stroke !== "none") { c.setAttribute("stroke", stroke); c.setAttribute("stroke-width", String(sw)); }
    for (const [k, v] of Object.entries(data)) c.setAttribute(`data-${k}`, v);
    parent.appendChild(c);
  }
  private polygon(parent: SVGGElement, points: string, fill: string,
                  stroke: string, sw: number, data: Record<string, string>): void {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    p.setAttribute("points", points);
    p.setAttribute("fill", fill);
    if (stroke !== "none") { p.setAttribute("stroke", stroke); p.setAttribute("stroke-width", String(sw)); }
    for (const [k, v] of Object.entries(data)) p.setAttribute(`data-${k}`, v);
    parent.appendChild(p);
  }
  private rect(parent: SVGGElement, x: number, y: number, w: number, h: number, r: number,
               fill: string, stroke: string, sw: number): void {
    const rc = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rc.setAttribute("x", String(x)); rc.setAttribute("y", String(y));
    rc.setAttribute("width", String(w)); rc.setAttribute("height", String(h));
    if (r > 0) rc.setAttribute("rx", String(r));
    rc.setAttribute("fill", fill);
    if (stroke !== "none") { rc.setAttribute("stroke", stroke); rc.setAttribute("stroke-width", String(sw)); }
    parent.appendChild(rc);
  }
  private text(parent: SVGGElement, x: number, y: number, txt: string,
               fill: string, size: number, weight: string): void {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(x)); t.setAttribute("y", String(y));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("font-family", "ui-monospace, monospace");
    t.setAttribute("font-size", String(size));
    t.setAttribute("font-weight", weight);
    t.setAttribute("fill", fill);
    t.textContent = txt;
    parent.appendChild(t);
  }

  private hitTest(e: { clientX: number; clientY: number }): "start" | "end" | "flip" | null {
    const rect = ctx.rightHost.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const { start, end, mid } = this.handlePos;
    const d = (a: ScreenPt | null) => a ? Math.hypot(px - a.x, py - a.y) : Infinity;
    const ds = d(start);
    const de = d(end);
    const dm = d(mid);
    if (ds <= HANDLE_HIT_RADIUS_PX && ds <= de) return "start";
    if (de <= HANDLE_HIT_RADIUS_PX) return "end";
    if (dm <= FLIP_HIT_RADIUS_PX) return "flip";
    return null;
  }

  private handle = (g: Gesture): boolean => {
    if (this.drag) {
      if (g.kind === "drag-move") { this.updateDrag(g.event); return true; }
      if (g.kind === "drag-end") { this.commitDrag(); return true; }
      if (g.kind === "click") { return true; }
    }
    if (g.kind === "drag-start" && g.button === 0) {
      const hit = this.hitTest(g.event);
      if (hit === "start" || hit === "end") return this.startDrag(hit, g.event);
      if (hit === "flip") {
        const w = this.activeWall();
        if (w) { this.flipWall(w); return true; }
      }
      return false;
    }
    if (g.kind === "click" && g.button === 0) {
      const hit = this.hitTest(g.event);
      if (hit === "flip") {
        const w = this.activeWall();
        if (w) { this.flipWall(w); return true; }
      }
      return false;
    }
    return false;
  };

  private startDrag(which: "start" | "end", e: PointerEvent): boolean {
    const w = this.activeWall();
    if (!w) return false;
    const p = w.el.params;
    if (!p.start || !p.end) return false;
    const groundY = p.elevation;
    const cur = which === "start"
      ? { x: p.start[0], z: p.start[1] }
      : { x: p.end[0], z: p.end[1] };
    this.drag = {
      wallId: w.id,
      which,
      baseline: JSON.parse(JSON.stringify(p)) as AuthoredElement["params"],
      groundY,
      currentWorld: cur,
      snapTarget: null,
    };
    this.updateDrag(e);
    return true;
  }

  private groundPoint(e: PointerEvent): { x: number; z: number } | null {
    const cam = ctx.world.camera.three;
    const rect = ctx.rightHost.getBoundingClientRect();
    if (rect.width < 1) return null;
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, cam);
    const y = this.drag?.groundY ?? 0;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, z: hit.z };
  }

  private findSnap(px: number, pz: number): { x: number; z: number } | null {
    const auth: any = (ctx.features as any).authoring;
    const cam = ctx.world.camera.three;
    const rect = ctx.rightHost.getBoundingClientRect();
    const y = this.drag?.groundY ?? 0;
    const project = (x: number, z: number) => {
      const v = new THREE.Vector3(x, y, z).project(cam);
      return { x: (v.x * 0.5 + 0.5) * rect.width, y: (-v.y * 0.5 + 0.5) * rect.height };
    };
    const pointer = project(px, pz);
    let best: { x: number; z: number; d: number } | null = null;
    const els: AuthoredElement[] = auth?.getElements?.() ?? [];
    const selfId = this.drag?.wallId;
    for (const el of els) {
      if (el.id === selfId) continue;
      if (!el.params.start || !el.params.end) continue;
      for (const pt of [el.params.start, el.params.end]) {
        const sp = project(pt[0], pt[1]);
        const d = Math.hypot(sp.x - pointer.x, sp.y - pointer.y);
        if (d < SNAP_SCREEN_TOL_PX && (!best || d < best.d)) {
          best = { x: pt[0], z: pt[1], d };
        }
      }
    }
    return best ? { x: best.x, z: best.z } : null;
  }

  private updateDrag(e: PointerEvent): void {
    if (!this.drag) return;
    const g = this.groundPoint(e);
    if (!g) return;
    const snap = this.findSnap(g.x, g.z);
    if (snap) {
      this.drag.snapTarget = snap;
      this.drag.currentWorld = snap;
    } else {
      this.drag.snapTarget = null;
      this.drag.currentWorld = g;
    }
    const auth: any = (ctx.features as any).authoring;
    const el: AuthoredElement | null = auth?.getElementById?.(this.drag.wallId) ?? null;
    if (!el) return;
    const p = el.params;
    if (this.drag.which === "start") {
      p.start = [this.drag.currentWorld.x, this.drag.currentWorld.z];
    } else {
      p.end = [this.drag.currentWorld.x, this.drag.currentWorld.z];
    }
    auth?.rebuildAuthored?.();
    this.schedule();
  }

  private commitDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const auth: any = (ctx.features as any).authoring;
    const el: AuthoredElement | null = auth?.getElementById?.(d.wallId) ?? null;
    if (!el) return;
    const after = JSON.parse(JSON.stringify(el.params)) as AuthoredElement["params"];
    if (JSON.stringify(after) === JSON.stringify(d.baseline)) { this.schedule(); return; }
    el.params = JSON.parse(JSON.stringify(d.baseline));
    auth?.rebuildAuthored?.();
    const apply = (params: AuthoredElement["params"]) => {
      const live: AuthoredElement | null = auth?.getElementById?.(d.wallId) ?? null;
      if (!live) return;
      live.params = JSON.parse(JSON.stringify(params));
      auth?.rebuildAuthored?.();
      try { auth?.migrateMepFittingRadii?.(); } catch { /* */ }
      try { (ctx.features as any).projects?.markDirty?.(); } catch { /* */ }
    };
    history.push({
      label: "Stretch " + el.name,
      apply: () => apply(after),
      revert: () => apply(d.baseline),
    });
    apply(after);
    notify("success", "Stretched " + el.name);
    this.schedule();
  }

  private flipWall(w: ActiveWall): void {
    const p = w.el.params;
    if (!p.start || !p.end) return;
    const before = JSON.parse(JSON.stringify(p)) as AuthoredElement["params"];
    const after = JSON.parse(JSON.stringify(p)) as AuthoredElement["params"];
    const tmp = after.start!;
    after.start = after.end!;
    after.end = tmp;
    const auth: any = (ctx.features as any).authoring;
    const apply = (params: AuthoredElement["params"]) => {
      const live: AuthoredElement | null = auth?.getElementById?.(w.id) ?? null;
      if (!live) return;
      live.params = JSON.parse(JSON.stringify(params));
      auth?.rebuildAuthored?.();
      try { (ctx.features as any).projects?.markDirty?.(); } catch { /* */ }
    };
    history.push({
      label: "Flip " + w.el.name,
      apply: () => apply(after),
      revert: () => apply(before),
    });
    apply(after);
    notify("success", "Flipped " + w.el.name);
    this.schedule();
  }
}

export const wallHandles = new WallHandlesManager();

export function setupWallHandles(): void {
  wallHandles.init();
  (ctx.features as any).wallHandles = {
    destroy: () => wallHandles.destroy(),
  };
  try { (window as any).__obsWallHandles = wallHandles; } catch { /* */ }
  console.log("[wall-handles] setup complete");
}
