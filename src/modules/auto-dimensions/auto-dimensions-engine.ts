/**
 * Auto-Dimensions engine – creates aligned dimension strings from model geometry.
 *
 * Strategy:
 *  1. Collect candidate reference edges/faces from walls, grids, columns, openings.
 *  2. Project onto the active view plane (plan = XY, section/elevation = appropriate).
 *  3. Cluster parallel references and sort along the orthogonal axis.
 *  4. Emit overall + intermediate dimension strings.
 *  5. Persist as non-temporary DimensionString objects; render in 2D overlay + 3D helper.
 */

import * as THREE from "three";
import {
  type DimensionString,
  type DimPoint,
  type DimensionStyle,
  type AutoDimOptions,
  defaultDimStyle,
  defaultAutoDimOptions,
} from "./types";

type Any = Record<string, any>;

function uid(prefix = "dim"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatLength(metres: number, style: DimensionStyle): string {
  try {
    const units = (window as Any).__obsUnits ?? (window as Any).units;
    if (units?.format) return String(units.format("length", metres));
    if (units?.formatLength) return String(units.formatLength(metres));
  } catch { /* */ }

  if (style.unit === "mm") return `${(metres * 1000).toFixed(0)} mm`;
  if (style.unit === "m") return `${metres.toFixed(style.precision)} m`;
  if (style.unit === "ft-in") {
    const totalIn = metres * 39.3700787;
    const ft = Math.floor(totalIn / 12);
    const inches = totalIn - ft * 12;
    return `${ft}'-${inches.toFixed(1)}"`;
  }
  // auto
  if (Math.abs(metres) >= 1) return `${metres.toFixed(style.precision)} m`;
  return `${(metres * 1000).toFixed(0)} mm`;
}

interface RefEdge {
  a: THREE.Vector3;
  b: THREE.Vector3;
  elementId?: string;
  category?: string;
  /** Direction of the edge (unit). */
  dir: THREE.Vector3;
  /** Midpoint. */
  mid: THREE.Vector3;
}

type Listener = () => void;

class AutoDimensionsEngine {
  private dims = new Map<string, DimensionString>();
  private styles = new Map<string, DimensionStyle>();
  private options: AutoDimOptions = defaultAutoDimOptions();
  private listeners = new Set<Listener>();
  private overlayHost: HTMLDivElement | null = null;
  private raf = 0;
  private enabled = true;

  constructor() {
    const def = defaultDimStyle();
    this.styles.set(def.id, def);
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch { /* */ }
    }
  }

  setOptions(patch: Partial<AutoDimOptions>): void {
    this.options = { ...this.options, ...patch };
  }

  getOptions(): AutoDimOptions {
    return { ...this.options };
  }

  listDimensions(viewId?: string | null): DimensionString[] {
    const all = Array.from(this.dims.values());
    if (viewId === undefined) return all;
    return all.filter((d) => d.viewId === viewId || (viewId === null && d.viewId === null));
  }

  getDimension(id: string): DimensionString | null {
    return this.dims.get(id) ?? null;
  }

  addDimension(dim: Omit<DimensionString, "id" | "createdAt"> & { id?: string }): DimensionString {
    const id = dim.id ?? uid("dim");
    const full: DimensionString = {
      ...dim,
      id,
      createdAt: nowIso(),
    };
    this.dims.set(id, full);
    this.emit();
    this.requestRender();
    return full;
  }

  removeDimension(id: string): boolean {
    const ok = this.dims.delete(id);
    if (ok) {
      this.emit();
      this.requestRender();
    }
    return ok;
  }

  clearTemporary(): void {
    let changed = false;
    for (const [id, d] of this.dims) {
      if (d.temporary) {
        this.dims.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
      this.requestRender();
    }
  }

  clearView(viewId: string | null): void {
    let changed = false;
    for (const [id, d] of this.dims) {
      if (d.viewId === viewId) {
        this.dims.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
      this.requestRender();
    }
  }

  promoteTemporary(): number {
    let n = 0;
    for (const d of this.dims.values()) {
      if (d.temporary) {
        d.temporary = false;
        d.source = "user";
        n++;
      }
    }
    if (n) {
      this.emit();
      this.requestRender();
    }
    return n;
  }

  /**
   * Create a single aligned dimension between two world points.
   */
  createAligned(
    a: THREE.Vector3 | DimPoint,
    b: THREE.Vector3 | DimPoint,
    opts?: {
      viewId?: string | null;
      temporary?: boolean;
      offset?: number;
      styleId?: string;
      source?: "auto" | "user" | "temp";
    }
  ): DimensionString {
    const pa = toDimPoint(a);
    const pb = toDimPoint(b);
    const va = new THREE.Vector3(pa.x, pa.y, pa.z);
    const vb = new THREE.Vector3(pb.x, pb.y, pb.z);
    const dist = va.distanceTo(vb);
    const style = this.styles.get(opts?.styleId ?? "default") ?? defaultDimStyle();
    return this.addDimension({
      kind: "aligned",
      points: [pa, pb],
      value: dist,
      label: formatLength(dist, style),
      offset: opts?.offset ?? this.options.baseOffset,
      viewId: opts?.viewId ?? null,
      temporary: opts?.temporary ?? false,
      styleId: style.id,
      source: opts?.source ?? "user",
    });
  }

  /**
   * Auto-generate dimension strings for the active plan view from wall/grid geometry.
   * Uses a simplified parallel-edge clustering approach suitable for floor plans.
   */
  autoDimensionPlan(opts?: {
    viewId?: string | null;
    elements?: Any[];
    grids?: Any[];
    axis?: "x" | "y" | "both";
  }): DimensionString[] {
    const viewId = opts?.viewId ?? "default";
    const axis = opts?.axis ?? "both";
    const style = this.styles.get("default") ?? defaultDimStyle();
    const created: DimensionString[] = [];

    // Clear previous auto dims for this view (keep user dims)
    for (const [id, d] of this.dims) {
      if (d.viewId === viewId && d.source === "auto") this.dims.delete(id);
    }

    const refs = this.collectPlanReferences(opts?.elements, opts?.grids);
    if (refs.length < 2) {
      this.emit();
      this.requestRender();
      return created;
    }

    if (axis === "x" || axis === "both") {
      created.push(...this.buildChain(refs, "x", viewId, style));
    }
    if (axis === "y" || axis === "both") {
      created.push(...this.buildChain(refs, "y", viewId, style));
    }

    this.emit();
    this.requestRender();
    return created;
  }

  private collectPlanReferences(elements?: Any[], grids?: Any[]): RefEdge[] {
    const refs: RefEdge[] = [];
    const elms =
      elements ??
      this.safeGetElements();

    for (const el of elms) {
      const cat = String(el.category ?? el.type ?? el.ifcType ?? "").toLowerCase();
      const id = String(el.id ?? el.globalId ?? "");
      if (!this.categoryAllowed(cat)) continue;

      // Prefer explicit footprint / outline if present
      const outline = el.outline ?? el.footprint ?? el.boundary;
      if (Array.isArray(outline) && outline.length >= 2) {
        for (let i = 0; i < outline.length; i++) {
          const a = toVec(outline[i]);
          const b = toVec(outline[(i + 1) % outline.length]);
          if (!a || !b) continue;
          const dir = b.clone().sub(a);
          if (dir.length() < 1e-6) continue;
          dir.normalize();
          refs.push({
            a,
            b,
            elementId: id,
            category: cat,
            dir,
            mid: a.clone().add(b).multiplyScalar(0.5),
          });
        }
        continue;
      }

      // Bounding box faces projected to plan (XZ or XY depending on engine)
      const box = this.getWorldBox(el);
      if (box) {
        const { min, max } = box;
        // four vertical edges in plan → two pairs of parallel sides
        const corners = [
          new THREE.Vector3(min.x, min.y, min.z),
          new THREE.Vector3(max.x, min.y, min.z),
          new THREE.Vector3(max.x, min.y, max.z),
          new THREE.Vector3(min.x, min.y, max.z),
        ];
        // If engine is Y-up, plan is XZ; if Z-up, plan is XY. Detect via extents.
        const useXZ = Math.abs(max.z - min.z) > Math.abs(max.y - min.y) * 0.5;
        if (useXZ) {
          // edges along X at min/max Z, and along Z at min/max X
          const edges: [THREE.Vector3, THREE.Vector3][] = [
            [corners[0], corners[1]],
            [corners[3], corners[2]],
            [corners[0], corners[3]],
            [corners[1], corners[2]],
          ];
          for (const [a, b] of edges) {
            const dir = b.clone().sub(a).normalize();
            refs.push({
              a,
              b,
              elementId: id,
              category: cat,
              dir,
              mid: a.clone().add(b).multiplyScalar(0.5),
            });
          }
        } else {
          const c2 = [
            new THREE.Vector3(min.x, min.y, min.z),
            new THREE.Vector3(max.x, min.y, min.z),
            new THREE.Vector3(max.x, max.y, min.z),
            new THREE.Vector3(min.x, max.y, min.z),
          ];
          const edges: [THREE.Vector3, THREE.Vector3][] = [
            [c2[0], c2[1]],
            [c2[3], c2[2]],
            [c2[0], c2[3]],
            [c2[1], c2[2]],
          ];
          for (const [a, b] of edges) {
            const dir = b.clone().sub(a).normalize();
            refs.push({
              a,
              b,
              elementId: id,
              category: cat,
              dir,
              mid: a.clone().add(b).multiplyScalar(0.5),
            });
          }
        }
      }
    }

    // Grids as infinite lines → finite segments around model extents
    const gridList = grids ?? this.safeGetGrids();
    for (const g of gridList) {
      const origin = toVec(g.origin ?? g.point ?? g.start);
      const dir = toVec(g.direction ?? g.dir);
      if (!origin || !dir) continue;
      dir.normalize();
      const len = 100;
      const a = origin.clone().addScaledVector(dir, -len);
      const b = origin.clone().addScaledVector(dir, len);
      refs.push({
        a,
        b,
        elementId: String(g.id ?? g.name ?? ""),
        category: "grids",
        dir,
        mid: origin.clone(),
      });
    }

    return refs;
  }

  private categoryAllowed(cat: string): boolean {
    const allowed = this.options.categories.map((c) => c.toLowerCase());
    if (allowed.length === 0) return true;
    return allowed.some((a) => cat.includes(a.replace(/\s/g, "")) || a.includes(cat));
  }

  private buildChain(
    refs: RefEdge[],
    axis: "x" | "y",
    viewId: string,
    style: DimensionStyle
  ): DimensionString[] {
    const created: DimensionString[] = [];
    // For plan: "x" chain = sort by X, measure horizontal spans (edges parallel to Z/Y)
    // "y" chain = sort by Z or Y depending on up-axis
    const isX = axis === "x";

    // Filter edges that are roughly perpendicular to the measure axis
    // (i.e. the edge itself runs along the orthogonal direction)
    const candidates = refs.filter((r) => {
      if (isX) {
        // want vertical edges in plan → dir mostly along Z or Y
        return Math.abs(r.dir.x) < 0.35;
      }
      return Math.abs(r.dir.x) > 0.65; // horizontal edges
    });

    // Project to a 1D coordinate along the measure axis
    const keyed = candidates.map((r) => {
      const coord = isX ? r.mid.x : pickOrtho(r.mid);
      return { ref: r, coord };
    });

    // Cluster by coordinate (merge nearly coincident faces)
    keyed.sort((a, b) => a.coord - b.coord);
    const clusters: { coord: number; refs: RefEdge[] }[] = [];
    const tol = 0.02; // 20 mm
    for (const k of keyed) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(last.coord - k.coord) <= tol) {
        last.refs.push(k.ref);
        last.coord = (last.coord * (last.refs.length - 1) + k.coord) / last.refs.length;
      } else {
        clusters.push({ coord: k.coord, refs: [k.ref] });
      }
    }

    if (clusters.length < 2) return created;

    // Build overall + intermediate
    const pts: DimPoint[] = clusters.map((c) => {
      const r = c.refs[0];
      const p = r.mid.clone();
      if (isX) p.x = c.coord;
      else setOrtho(p, c.coord);
      return {
        x: p.x,
        y: p.y,
        z: p.z,
        elementId: r.elementId,
        refName: r.category,
      };
    });

    // Overall
    const overallDist = Math.abs(clusters[clusters.length - 1].coord - clusters[0].coord);
    if (overallDist >= this.options.minLength) {
      created.push(
        this.addDimension({
          kind: "aligned",
          points: [pts[0], pts[pts.length - 1]],
          value: overallDist,
          label: formatLength(overallDist, style),
          offset: this.options.baseOffset + this.options.stackSpacing,
          viewId,
          temporary: false,
          styleId: style.id,
          source: "auto",
        })
      );
    }

    // Intermediate chain
    if (pts.length >= 3) {
      const segs: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        segs.push(Math.abs(clusters[i + 1].coord - clusters[i].coord));
      }
      const allEqual =
        style.showEquality &&
        segs.length > 1 &&
        segs.every((s) => Math.abs(s - segs[0]) < 0.005);

      created.push(
        this.addDimension({
          kind: "aligned",
          points: pts,
          value: segs.reduce((a, b) => a + b, 0),
          label: allEqual
            ? segs.map(() => "EQ").join("  ")
            : segs.map((s) => formatLength(s, style)).join("  "),
          offset: this.options.baseOffset,
          viewId,
          temporary: false,
          styleId: style.id,
          source: "auto",
        })
      );
    } else if (pts.length === 2) {
      // already covered by overall
    }

    return created;
  }

  private safeGetElements(): Any[] {
    try {
      const c = (window as Any).__OBS_CTX__ ?? (window as Any).ctx;
      const list =
        c?.model?.elements ??
        c?.elements ??
        c?.world?.elements ??
        c?.document?.elements ??
        [];
      if (Array.isArray(list)) return list;
      if (list && typeof list.values === "function") return Array.from(list.values());
    } catch { /* */ }
    return [];
  }

  private safeGetGrids(): Any[] {
    try {
      const c = (window as Any).__OBS_CTX__ ?? (window as Any).ctx;
      const g = c?.grids ?? c?.model?.grids ?? [];
      return Array.isArray(g) ? g : [];
    } catch {
      return [];
    }
  }

  private getWorldBox(el: Any): { min: THREE.Vector3; max: THREE.Vector3 } | null {
    try {
      if (el.bbox || el.boundingBox) {
        const b = el.bbox ?? el.boundingBox;
        const min = toVec(b.min ?? b.Min);
        const max = toVec(b.max ?? b.Max);
        if (min && max) return { min, max };
      }
      if (el.mesh?.geometry) {
        el.mesh.geometry.computeBoundingBox?.();
        const bb = el.mesh.geometry.boundingBox;
        if (bb) {
          const min = bb.min.clone();
          const max = bb.max.clone();
          if (el.mesh.matrixWorld) {
            min.applyMatrix4(el.mesh.matrixWorld);
            max.applyMatrix4(el.mesh.matrixWorld);
          }
          return { min, max };
        }
      }
    } catch { /* */ }
    return null;
  }

  // ---------- Overlay rendering ----------

  ensureOverlay(): void {
    if (this.overlayHost) return;
    const host = document.createElement("div");
    host.id = "obs-auto-dims-overlay";
    host.style.cssText = `
      position: absolute; inset: 0; pointer-events: none; z-index: 40;
      overflow: hidden; font-family: "Segoe UI", system-ui, sans-serif;
    `;
    const viewport =
      document.getElementById("viewport") ||
      document.querySelector(".obs-viewport") ||
      document.querySelector("canvas")?.parentElement;
    if (viewport) {
      const parent = viewport as HTMLElement;
      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative";
      }
      parent.appendChild(host);
    } else {
      document.body.appendChild(host);
    }
    this.overlayHost = host;
  }

  requestRender(): void {
    if (!this.enabled) return;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.renderOverlay();
    });
  }

  private renderOverlay(): void {
    this.ensureOverlay();
    if (!this.overlayHost) return;

    const cam = this.getCamera();
    const renderer = this.getRenderer();
    if (!cam || !renderer) {
      this.overlayHost.innerHTML = "";
      return;
    }

    const canvas = renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dims = this.listDimensions();

    let html = "";
    for (const d of dims) {
      if (d.points.length < 2) continue;
      const projected = d.points
        .map((p) => projectPoint(new THREE.Vector3(p.x, p.y, p.z), cam, w, h))
        .filter(Boolean) as { x: number; y: number; visible: boolean }[];
      if (projected.length < 2) continue;

      // Simple 2-point or multi-segment line
      for (let i = 0; i < projected.length - 1; i++) {
        const a = projected[i];
        const b = projected[i + 1];
        if (!a.visible && !b.visible) continue;
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const label =
          d.points.length === 2
            ? d.label
            : d.label.split(/\s{2,}/)[i] ?? d.label;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        // offset in screen px (approx from model offset)
        const offPx = 28 + (d.offset > this.options.baseOffset ? 22 : 0);
        const ox = nx * offPx;
        const oy = ny * offPx;

        const ax = a.x + ox;
        const ay = a.y + oy;
        const bx = b.x + ox;
        const by = b.y + oy;
        const midx = mx + ox;
        const midy = my + oy;

        const stroke = d.temporary ? "#0078D4" : "#201F1E";
        const tick = 6;

        html += `<svg style="position:absolute;left:0;top:0;width:${w}px;height:${h}px;overflow:visible">
          <line x1="${a.x}" y1="${a.y}" x2="${ax}" y2="${ay}" stroke="${stroke}" stroke-width="1" opacity="0.7"/>
          <line x1="${b.x}" y1="${b.y}" x2="${bx}" y2="${by}" stroke="${stroke}" stroke-width="1" opacity="0.7"/>
          <line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${stroke}" stroke-width="1.25"/>
          <line x1="${ax - nx * tick}" y1="${ay - ny * tick}" x2="${ax + nx * tick}" y2="${ay + ny * tick}" stroke="${stroke}" stroke-width="1.25"/>
          <line x1="${bx - nx * tick}" y1="${by - ny * tick}" x2="${bx + nx * tick}" y2="${by + ny * tick}" stroke="${stroke}" stroke-width="1.25"/>
        </svg>`;
        html += `<div style="
          position:absolute;left:${midx}px;top:${midy}px;transform:translate(-50%,-50%);
          background:rgba(255,255,255,.92);border:1px solid #E1DFDD;border-radius:4px;
          padding:1px 6px;font:600 11px 'Segoe UI',system-ui;color:${stroke};
          white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.08);
          ${d.temporary ? "border-color:#0078D4;color:#0078D4;" : ""}
        ">${escapeHtml(label)}</div>`;
      }
    }
    this.overlayHost.innerHTML = html;
  }

  private getCamera(): THREE.Camera | null {
    try {
      const c = (window as Any).__OBS_CTX__ ?? (window as Any).ctx;
      return c?.world?.camera?.three ?? c?.world?.camera ?? null;
    } catch {
      return null;
    }
  }

  private getRenderer(): THREE.WebGLRenderer | null {
    try {
      const c = (window as Any).__OBS_CTX__ ?? (window as Any).ctx;
      return c?.world?.renderer?.three ?? c?.world?.renderer ?? null;
    } catch {
      return null;
    }
  }

  startRenderLoop(): void {
    this.ensureOverlay();
    const tick = () => {
      this.requestRender();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function toVec(v: any): THREE.Vector3 | null {
  if (!v) return null;
  if (v instanceof THREE.Vector3) return v.clone();
  if (typeof v.x === "number") return new THREE.Vector3(v.x, v.y ?? 0, v.z ?? 0);
  if (Array.isArray(v) && v.length >= 2) return new THREE.Vector3(v[0], v[1], v[2] ?? 0);
  return null;
}

function toDimPoint(v: THREE.Vector3 | DimPoint): DimPoint {
  if (v instanceof THREE.Vector3) return { x: v.x, y: v.y, z: v.z };
  return { ...v };
}

function projectPoint(
  v: THREE.Vector3,
  cam: THREE.Camera,
  w: number,
  h: number
): { x: number; y: number; visible: boolean } | null {
  const ndc = v.clone().project(cam);
  const visible = ndc.z > -1 && ndc.z < 1;
  return {
    x: (ndc.x * 0.5 + 0.5) * w,
    y: (-ndc.y * 0.5 + 0.5) * h,
    visible,
  };
}

function pickOrtho(v: THREE.Vector3): number {
  // Prefer Z if the scene is Y-up (common in three.js BIM), else Y
  return Math.abs(v.z) >= Math.abs(v.y) ? v.z : v.y;
}

function setOrtho(v: THREE.Vector3, coord: number): void {
  if (Math.abs(v.z) >= Math.abs(v.y)) v.z = coord;
  else v.y = coord;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const autoDimensionsEngine = new AutoDimensionsEngine();

export function exposeAutoDimensionsGlobal(): void {
  (window as Any).__obsAutoDimensions = autoDimensionsEngine;
}
