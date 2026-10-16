/**
 * CAD Engine - AutoCAD-class 2D drafting operations on screen-space entities.
 *
 * Works with the existing drafting-2d overlay (screen SVG) and adds:
 *   polyline, arc, offset, erase-last, move, copy, mirror, layers, ortho, grid
 *
 * Coordinates are screen pixels (same as drafting-2d). World export is handled
 * by drafting-bridge.
 */

export type CadPt = { x: number; y: number };

export type CadEntityKind =
  | "line"
  | "polyline"
  | "rect"
  | "circle"
  | "arc"
  | "text";

export interface CadEntity {
  id: string;
  kind: CadEntityKind;
  /** Primary point / center / start */
  a: CadPt;
  /** End point / opposite corner */
  b?: CadPt;
  /** Polyline vertices (includes start) */
  points?: CadPt[];
  /** Circle / arc radius */
  r?: number;
  /** Arc end angle (radians), start inferred from a-first ray or startAngle */
  startAngle?: number;
  endAngle?: number;
  text?: string;
  color: string;
  strokeWidth: number;
  layer: string;
}

export type CadTool =
  | "line"
  | "polyline"
  | "rect"
  | "circle"
  | "arc"
  | "text"
  | "offset"
  | "erase"
  | "move"
  | "copy"
  | "mirror"
  | "trim"
  | "extend"
  | "fillet"
  | "distance"
  | null;

export interface CadLayer {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

function uid(prefix = "cad"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function dist(a: CadPt, b: CadPt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function mid(a: CadPt, b: CadPt): CadPt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function offsetPoint(p: CadPt, dx: number, dy: number): CadPt {
  return { x: p.x + dx, y: p.y + dy };
}

/** Offset a line segment by distance (left of direction). */
function offsetSegment(a: CadPt, b: CadPt, d: number): [CadPt, CadPt] {
  const len = dist(a, b) || 1;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  return [
    { x: a.x + nx * d, y: a.y + ny * d },
    { x: b.x + nx * d, y: b.y + ny * d },
  ];
}

function mirrorPoint(p: CadPt, a: CadPt, b: CadPt): CadPt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const proj = { x: a.x + t * dx, y: a.y + t * dy };
  return { x: 2 * proj.x - p.x, y: 2 * proj.y - p.y };
}

type Listener = () => void;

class CadEngine {
  private entities: CadEntity[] = [];
  private redoStack: CadEntity[] = [];
  private layers: CadLayer[] = [
    { id: "0", name: "0", color: "#38bdf8", visible: true, locked: false },
    { id: "defpoints", name: "Defpoints", color: "#64748b", visible: true, locked: false },
    { id: "annotation", name: "Annotation", color: "#fbbf24", visible: true, locked: false },
  ];
  private activeLayerId = "0";
  private tool: CadTool = null;
  private ortho = false;
  private grid = false;
  private gridSize = 20; // px
  private listeners = new Set<Listener>();
  private color = "#38bdf8";
  private strokeWidth = 1.5;

  // Multi-step tool state
  private polyPoints: CadPt[] = [];
  private pending: CadPt | null = null;

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
    try {
      window.dispatchEvent(
        new CustomEvent("obs:cad-changed", {
          detail: { count: this.entities.length, tool: this.tool },
        }),
      );
    } catch { /* */ }
  }

  /* -- Layers ------------------------------------------------------- */

  listLayers(): CadLayer[] {
    return this.layers.map((l) => ({ ...l }));
  }

  getActiveLayer(): CadLayer {
    return this.layers.find((l) => l.id === this.activeLayerId) ?? this.layers[0];
  }

  setActiveLayer(id: string): void {
    if (this.layers.some((l) => l.id === id)) {
      this.activeLayerId = id;
      const layer = this.getActiveLayer();
      this.color = layer.color;
      this.emit();
    }
  }

  addLayer(name: string, color = "#94a3b8"): CadLayer {
    const layer: CadLayer = {
      id: uid("layer"),
      name,
      color,
      visible: true,
      locked: false,
    };
    this.layers.push(layer);
    this.emit();
    return layer;
  }

  setLayerVisible(id: string, visible: boolean): void {
    const l = this.layers.find((x) => x.id === id);
    if (l) {
      l.visible = visible;
      this.emit();
    }
  }

  /* -- Tool / options ----------------------------------------------- */

  getTool(): CadTool {
    return this.tool;
  }

  setTool(tool: CadTool): void {
    this.tool = tool;
    this.polyPoints = [];
    this.pending = null;
    this.emit();
    try {
      window.dispatchEvent(
        new CustomEvent("obs:cad-tool-changed", { detail: { tool } }),
      );
    } catch { /* */ }
  }

  isOrtho(): boolean {
    return this.ortho;
  }

  setOrtho(on: boolean): void {
    this.ortho = on;
    this.emit();
  }

  toggleOrtho(): boolean {
    this.ortho = !this.ortho;
    this.emit();
    return this.ortho;
  }

  isGrid(): boolean {
    return this.grid;
  }

  setGrid(on: boolean): void {
    this.grid = on;
    this.emit();
  }

  toggleGrid(): boolean {
    this.grid = !this.grid;
    this.emit();
    return this.grid;
  }

  getGridSize(): number {
    return this.gridSize;
  }

  setColor(c: string): void {
    this.color = c;
  }

  getColor(): string {
    return this.color;
  }

  /* -- Snap helpers ------------------------------------------------- */

  applyOrtho(from: CadPt, to: CadPt): CadPt {
    if (!this.ortho) return to;
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    if (dx >= dy) return { x: to.x, y: from.y };
    return { x: from.x, y: to.y };
  }

  applyGrid(p: CadPt): CadPt {
    if (!this.grid) return p;
    const s = this.gridSize;
    return {
      x: Math.round(p.x / s) * s,
      y: Math.round(p.y / s) * s,
    };
  }

  snapPoint(from: CadPt | null, raw: CadPt): CadPt {
    let p = this.applyGrid(raw);
    if (from) p = this.applyOrtho(from, p);
    return p;
  }

  /* -- Entity CRUD -------------------------------------------------- */

  listEntities(): CadEntity[] {
    return this.entities
      .filter((e) => {
        const layer = this.layers.find((l) => l.id === e.layer);
        return !layer || layer.visible;
      })
      .map((e) => ({ ...e, points: e.points ? e.points.map((p) => ({ ...p })) : undefined }));
  }

  getAllEntities(): CadEntity[] {
    return this.entities.map((e) => ({
      ...e,
      points: e.points ? e.points.map((p) => ({ ...p })) : undefined,
    }));
  }

  getCount(): number {
    return this.entities.length;
  }

  private push(ent: CadEntity): void {
    this.entities.push(ent);
    this.redoStack = [];
    this.emit();
  }

  addLine(a: CadPt, b: CadPt): CadEntity {
    const ent: CadEntity = {
      id: uid("line"),
      kind: "line",
      a: { ...a },
      b: { ...b },
      color: this.color,
      strokeWidth: this.strokeWidth,
      layer: this.activeLayerId,
    };
    this.push(ent);
    return ent;
  }

  addRect(a: CadPt, b: CadPt): CadEntity {
    const ent: CadEntity = {
      id: uid("rect"),
      kind: "rect",
      a: { ...a },
      b: { ...b },
      color: this.color,
      strokeWidth: this.strokeWidth,
      layer: this.activeLayerId,
    };
    this.push(ent);
    return ent;
  }

  addCircle(center: CadPt, r: number): CadEntity {
    const ent: CadEntity = {
      id: uid("circle"),
      kind: "circle",
      a: { ...center },
      r: Math.max(0.5, r),
      color: this.color,
      strokeWidth: this.strokeWidth,
      layer: this.activeLayerId,
    };
    this.push(ent);
    return ent;
  }

  addPolyline(points: CadPt[]): CadEntity {
    const ent: CadEntity = {
      id: uid("pline"),
      kind: "polyline",
      a: { ...points[0] },
      b: points.length > 1 ? { ...points[points.length - 1] } : undefined,
      points: points.map((p) => ({ ...p })),
      color: this.color,
      strokeWidth: this.strokeWidth,
      layer: this.activeLayerId,
    };
    this.push(ent);
    return ent;
  }

  addArc(center: CadPt, r: number, startAngle: number, endAngle: number): CadEntity {
    const ent: CadEntity = {
      id: uid("arc"),
      kind: "arc",
      a: { ...center },
      r: Math.max(0.5, r),
      startAngle,
      endAngle,
      color: this.color,
      strokeWidth: this.strokeWidth,
      layer: this.activeLayerId,
    };
    this.push(ent);
    return ent;
  }

  addText(at: CadPt, text: string): CadEntity {
    const ent: CadEntity = {
      id: uid("text"),
      kind: "text",
      a: { ...at },
      text,
      color: this.color,
      strokeWidth: this.strokeWidth,
      layer: this.activeLayerId,
    };
    this.push(ent);
    return ent;
  }

  undo(): boolean {
    const last = this.entities.pop();
    if (!last) return false;
    this.redoStack.push(last);
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.entities.push(next);
    this.emit();
    return true;
  }

  clear(): void {
    this.entities = [];
    this.redoStack = [];
    this.polyPoints = [];
    this.pending = null;
    this.emit();
  }

  eraseLast(): boolean {
    return this.undo();
  }

  /** Offset the last line/polyline by distance (screen px). */
  offsetLast(distance: number): CadEntity | null {
    const last = this.entities[this.entities.length - 1];
    if (!last) return null;

    if (last.kind === "line" && last.b) {
      const [a, b] = offsetSegment(last.a, last.b, distance);
      return this.addLine(a, b);
    }
    if (last.kind === "polyline" && last.points && last.points.length >= 2) {
      const pts: CadPt[] = [];
      for (let i = 0; i < last.points.length - 1; i++) {
        const [oa] = offsetSegment(last.points[i], last.points[i + 1], distance);
        pts.push(oa);
      }
      const lastSeg = last.points.length - 2;
      const [, ob] = offsetSegment(
        last.points[lastSeg],
        last.points[lastSeg + 1],
        distance,
      );
      pts.push(ob);
      return this.addPolyline(pts);
    }
    if (last.kind === "circle" && last.r != null) {
      return this.addCircle(last.a, last.r + distance);
    }
    return null;
  }

  /** Copy last entity by delta. */
  copyLast(dx: number, dy: number): CadEntity | null {
    const last = this.entities[this.entities.length - 1];
    if (!last) return null;
    return this.transformClone(last, (p) => offsetPoint(p, dx, dy));
  }

  /** Mirror last entity across a line from a-b. */
  mirrorLast(axisA: CadPt, axisB: CadPt): CadEntity | null {
    const last = this.entities[this.entities.length - 1];
    if (!last) return null;
    return this.transformClone(last, (p) => mirrorPoint(p, axisA, axisB));
  }

  private transformClone(
    src: CadEntity,
    map: (p: CadPt) => CadPt,
  ): CadEntity {
    const ent: CadEntity = {
      ...src,
      id: uid(src.kind),
      a: map(src.a),
      b: src.b ? map(src.b) : undefined,
      points: src.points ? src.points.map(map) : undefined,
    };
    this.push(ent);
    return ent;
  }

  /* -- Multi-click tool helpers (polyline / arc) -------------------- */

  getPolyPoints(): CadPt[] {
    return this.polyPoints.map((p) => ({ ...p }));
  }

  addPolyVertex(raw: CadPt): void {
    const from = this.polyPoints.length
      ? this.polyPoints[this.polyPoints.length - 1]
      : null;
    const p = this.snapPoint(from, raw);
    this.polyPoints.push(p);
    this.emit();
  }

  finishPolyline(): CadEntity | null {
    if (this.polyPoints.length < 2) {
      this.polyPoints = [];
      this.emit();
      return null;
    }
    const ent = this.addPolyline(this.polyPoints);
    this.polyPoints = [];
    this.emit();
    return ent;
  }

  cancelPoly(): void {
    this.polyPoints = [];
    this.pending = null;
    this.emit();
  }

  /* -- Sync with drafting-2d simple entities ------------------------- */

  /** Push a simple line/rect/circle/text into CAD store (from drafting-2d). */
  importDraftEntity(d: {
    id?: string;
    kind: string;
    a: CadPt;
    b?: CadPt;
    r?: number;
    text?: string;
    color?: string;
    strokeWidth?: number;
  }): void {
    const base = {
      color: d.color ?? this.color,
      strokeWidth: d.strokeWidth ?? this.strokeWidth,
      layer: this.activeLayerId,
    };
    if (d.kind === "line" && d.b) {
      this.entities.push({ id: d.id ?? uid("line"), kind: "line", a: d.a, b: d.b, ...base });
    } else if (d.kind === "rect" && d.b) {
      this.entities.push({ id: d.id ?? uid("rect"), kind: "rect", a: d.a, b: d.b, ...base });
    } else if (d.kind === "circle") {
      this.entities.push({
        id: d.id ?? uid("circle"),
        kind: "circle",
        a: d.a,
        r: d.r ?? 0,
        ...base,
      });
    } else if (d.kind === "text") {
      this.entities.push({
        id: d.id ?? uid("text"),
        kind: "text",
        a: d.a,
        text: d.text,
        ...base,
      });
    }
    this.emit();
  }

  /** Export entities that drafting-2d understands (line/rect/circle/text). */
  toDraftEntities(): Array<{
    id: string;
    kind: "line" | "rect" | "circle" | "text";
    a: CadPt;
    b?: CadPt;
    r?: number;
    text?: string;
    color: string;
    strokeWidth: number;
  }> {
    const out: ReturnType<CadEngine["toDraftEntities"]> = [];
    for (const e of this.listEntities()) {
      if (e.kind === "line" || e.kind === "rect" || e.kind === "circle" || e.kind === "text") {
        out.push({
          id: e.id,
          kind: e.kind,
          a: e.a,
          b: e.b,
          r: e.r,
          text: e.text,
          color: e.color,
          strokeWidth: e.strokeWidth,
        });
      } else if (e.kind === "polyline" && e.points) {
        for (let i = 0; i < e.points.length - 1; i++) {
          out.push({
            id: `${e.id}-${i}`,
            kind: "line",
            a: e.points[i],
            b: e.points[i + 1],
            color: e.color,
            strokeWidth: e.strokeWidth,
          });
        }
      } else if (e.kind === "arc" && e.r != null && e.startAngle != null && e.endAngle != null) {
        // Approximate arc as polyline segments for drafting-2d
        const segs = 24;
        const pts: CadPt[] = [];
        let a0 = e.startAngle;
        let a1 = e.endAngle;
        if (a1 < a0) a1 += Math.PI * 2;
        for (let i = 0; i <= segs; i++) {
          const t = a0 + ((a1 - a0) * i) / segs;
          pts.push({
            x: e.a.x + e.r * Math.cos(t),
            y: e.a.y + e.r * Math.sin(t),
          });
        }
        for (let i = 0; i < pts.length - 1; i++) {
          out.push({
            id: `${e.id}-${i}`,
            kind: "line",
            a: pts[i],
            b: pts[i + 1],
            color: e.color,
            strokeWidth: e.strokeWidth,
          });
        }
      }
    }
    return out;
  }


  /* -- Geometry helpers for TRIM / EXTEND / FILLET ------------------- */

  private lineSegs(): Array<{ id: string; a: CadPt; b: CadPt; index: number }> {
    const out: Array<{ id: string; a: CadPt; b: CadPt; index: number }> = [];
    this.entities.forEach((e, index) => {
      if (e.kind === "line" && e.b) {
        out.push({ id: e.id, a: e.a, b: e.b, index });
      } else if (e.kind === "polyline" && e.points) {
        for (let i = 0; i < e.points.length - 1; i++) {
          out.push({
            id: `${e.id}:${i}`,
            a: e.points[i],
            b: e.points[i + 1],
            index,
          });
        }
      }
    });
    return out;
  }

  private static segIntersect(
    a1: CadPt,
    a2: CadPt,
    b1: CadPt,
    b2: CadPt,
  ): { x: number; y: number; t: number; u: number } | null {
    const dax = a2.x - a1.x;
    const day = a2.y - a1.y;
    const dbx = b2.x - b1.x;
    const dby = b2.y - b1.y;
    const den = dax * dby - day * dbx;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / den;
    const u = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / den;
    return { x: a1.x + t * dax, y: a1.y + t * day, t, u };
  }

  private nearestSeg(p: CadPt): { id: string; a: CadPt; b: CadPt; index: number; t: number; dist: number } | null {
    let best: ReturnType<CadEngine["nearestSeg"]> = null;
    for (const s of this.lineSegs()) {
      const dx = s.b.x - s.a.x;
      const dy = s.b.y - s.a.y;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const proj = { x: s.a.x + t * dx, y: s.a.y + t * dy };
      const d = Math.hypot(p.x - proj.x, p.y - proj.y);
      if (!best || d < best.dist) {
        best = { ...s, t, dist: d };
      }
    }
    return best;
  }

  /**
   * TRIM: pick a cutting segment near `cutterPt`, then a target near `targetPt`.
   * Removes the portion of the target beyond the intersection (the side you click).
   */
  trimAt(cutterPt: CadPt, targetPt: CadPt, pickRadius = 30): boolean {
    const cutter = this.nearestSeg(cutterPt);
    const target = this.nearestSeg(targetPt);
    if (!cutter || !target || cutter.id === target.id) return false;
    if (cutter.dist > pickRadius || target.dist > pickRadius) return false;

    const hit = CadEngine.segIntersect(cutter.a, cutter.b, target.a, target.b);
    if (!hit) return false;
    // Allow slight extension of cutter as infinite-ish within segment param 0..1 for target
    if (hit.u < -0.05 || hit.u > 1.05) return false;

    const ent = this.entities[target.index];
    if (!ent || (ent.kind !== "line" && ent.kind !== "polyline")) return false;

    // For simple lines: keep the side opposite the click (standard CAD: click side is removed)
    if (ent.kind === "line" && ent.b) {
      const clickT = target.t;
      const hitT = Math.max(0, Math.min(1, hit.u));
      if (clickT < hitT) {
        // remove start side - new start = hit
        ent.a = { x: hit.x, y: hit.y };
      } else {
        ent.b = { x: hit.x, y: hit.y };
      }
      this.redoStack = [];
      this.emit();
      return true;
    }
    return false;
  }

  /**
   * EXTEND: pick boundary near `boundaryPt`, then segment near `targetPt`.
   * Extends the target until it meets the boundary line.
   */
  extendTo(boundaryPt: CadPt, targetPt: CadPt, pickRadius = 30): boolean {
    const boundary = this.nearestSeg(boundaryPt);
    const target = this.nearestSeg(targetPt);
    if (!boundary || !target || boundary.id === target.id) return false;
    if (boundary.dist > pickRadius || target.dist > pickRadius) return false;

    // Treat boundary as infinite line for intersection
    const bdx = boundary.b.x - boundary.a.x;
    const bdy = boundary.b.y - boundary.a.y;
    const tdx = target.b.x - target.a.x;
    const tdy = target.b.y - target.a.y;
    // Extend target ray from the nearer endpoint to the click
    const useStart = target.t < 0.5;
    const origin = useStart ? target.a : target.b;
    // Direction away from segment center
    const dir = useStart
      ? { x: target.a.x - target.b.x, y: target.a.y - target.b.y }
      : { x: target.b.x - target.a.x, y: target.b.y - target.a.y };
    const far = {
      x: origin.x + dir.x * 50,
      y: origin.y + dir.y * 50,
    };
    const hit = CadEngine.segIntersect(
      boundary.a,
      { x: boundary.a.x + bdx * 20, y: boundary.a.y + bdy * 20 },
      origin,
      far,
    );
    // Better: infinite line-line
    const den = bdx * dir.y - bdy * dir.x;
    if (Math.abs(den) < 1e-9) return false;
    const t = ((origin.x - boundary.a.x) * dir.y - (origin.y - boundary.a.y) * dir.x) / (bdx * dir.y - bdy * dir.x);
    // Actually solve properly
    const hit2 = CadEngine.segIntersect(
      boundary.a,
      boundary.b,
      origin,
      { x: origin.x + dir.x * 1000, y: origin.y + dir.y * 1000 },
    );
    if (!hit2) return false;

    const ent = this.entities[target.index];
    if (!ent || ent.kind !== "line" || !ent.b) return false;

    if (useStart) {
      ent.a = { x: hit2.x, y: hit2.y };
    } else {
      ent.b = { x: hit2.x, y: hit2.y };
    }
    this.redoStack = [];
    this.emit();
    return true;
  }

  /**
   * FILLET two lines near the pick points with radius (px).
   * Trims both to the fillet and inserts an arc.
   */
  filletAt(pt1: CadPt, pt2: CadPt, radius: number, pickRadius = 30): boolean {
    const s1 = this.nearestSeg(pt1);
    const s2 = this.nearestSeg(pt2);
    if (!s1 || !s2 || s1.id === s2.id) return false;
    if (s1.dist > pickRadius || s2.dist > pickRadius) return false;
    if (radius < 1) radius = 1;

    const hit = CadEngine.segIntersect(s1.a, s1.b, s2.a, s2.b);
    if (!hit) return false;

    // Unit dirs
    const d1 = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y };
    const len1 = Math.hypot(d1.x, d1.y) || 1;
    d1.x /= len1;
    d1.y /= len1;
    const d2 = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y };
    const len2 = Math.hypot(d2.x, d2.y) || 1;
    d2.x /= len2;
    d2.y /= len2;

    // Angle between
    const dot = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
    const ang = Math.acos(dot);
    if (ang < 0.05 || ang > Math.PI - 0.05) return false;

    const distToTangent = radius / Math.tan(ang / 2);

    // Which ends meet at the intersection? Use hit params
    const t1 = hit.t;
    const t2 = hit.u;

    // Trim line 1: keep the part away from the intersection side that was clicked
    const ent1 = this.entities[s1.index];
    const ent2 = this.entities[s2.index];
    if (!ent1 || !ent2 || ent1.kind !== "line" || ent2.kind !== "line" || !ent1.b || !ent2.b) {
      return false;
    }

    // Tangent points roughly along each segment from intersection
    const sign1 = t1 > 0.5 ? -1 : 1;
    const sign2 = t2 > 0.5 ? -1 : 1;
    const tan1 = {
      x: hit.x + d1.x * distToTangent * sign1,
      y: hit.y + d1.y * distToTangent * sign1,
    };
    const tan2 = {
      x: hit.x + d2.x * distToTangent * sign2,
      y: hit.y + d2.y * distToTangent * sign2,
    };

    // Update endpoints nearest the intersection
    if (t1 < 0.5) ent1.a = tan1;
    else ent1.b = tan1;
    if (t2 < 0.5) ent2.a = tan2;
    else ent2.b = tan2;

    // Arc center - intersection offset along angle bisector
    const bis = { x: d1.x * sign1 + d2.x * sign2, y: d1.y * sign1 + d2.y * sign2 };
    const bl = Math.hypot(bis.x, bis.y) || 1;
    bis.x /= bl;
    bis.y /= bl;
    // Perp of d1 for left/right - use average of normals
    const n1 = { x: -d1.y * sign1, y: d1.x * sign1 };
    const n2 = { x: -d2.y * sign2, y: d2.x * sign2 };
    let nx = n1.x + n2.x;
    let ny = n1.y + n2.y;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const center = { x: hit.x + nx * radius, y: hit.y + ny * radius };

    const a0 = Math.atan2(tan1.y - center.y, tan1.x - center.x);
    const a1 = Math.atan2(tan2.y - center.y, tan2.x - center.x);
    this.addArc(center, radius, a0, a1);
    this.redoStack = [];
    this.emit();
    return true;
  }

  /** Distance between two points (screen px). */
  distance(a: CadPt, b: CadPt): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** Delete entity by id. */
  deleteById(id: string): boolean {
    const i = this.entities.findIndex((e) => e.id === id);
    if (i < 0) return false;
    const [removed] = this.entities.splice(i, 1);
    this.redoStack.push(removed);
    this.emit();
    return true;
  }

  /** Pick nearest entity to point within radius. */
  pickEntity(p: CadPt, radius = 20): CadEntity | null {
    let best: { e: CadEntity; d: number } | null = null;
    for (const e of this.listEntities()) {
      let d = Infinity;
      if (e.kind === "line" && e.b) {
        const dx = e.b.x - e.a.x;
        const dy = e.b.y - e.a.y;
        const len2 = dx * dx + dy * dy || 1;
        let t = ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d = Math.hypot(p.x - (e.a.x + t * dx), p.y - (e.a.y + t * dy));
      } else if (e.kind === "circle" && e.r != null) {
        d = Math.abs(Math.hypot(p.x - e.a.x, p.y - e.a.y) - e.r);
      } else if (e.kind === "rect" && e.b) {
        const minX = Math.min(e.a.x, e.b.x);
        const maxX = Math.max(e.a.x, e.b.x);
        const minY = Math.min(e.a.y, e.b.y);
        const maxY = Math.max(e.a.y, e.b.y);
        const cx = Math.max(minX, Math.min(maxX, p.x));
        const cy = Math.max(minY, Math.min(maxY, p.y));
        d = Math.hypot(p.x - cx, p.y - cy);
      } else {
        d = Math.hypot(p.x - e.a.x, p.y - e.a.y);
      }
      if (d <= radius && (!best || d < best.d)) best = { e, d };
    }
    return best?.e ?? null;
  }

  setLayerLocked(id: string, locked: boolean): void {
    const l = this.layers.find((x) => x.id === id);
    if (l) {
      l.locked = locked;
      this.emit();
    }
  }

  setLayerColor(id: string, color: string): void {
    const l = this.layers.find((x) => x.id === id);
    if (l) {
      l.color = color;
      this.emit();
    }
  }

  renameLayer(id: string, name: string): void {
    const l = this.layers.find((x) => x.id === id);
    if (l) {
      l.name = name;
      this.emit();
    }
  }

}

export const cadEngine = new CadEngine();
