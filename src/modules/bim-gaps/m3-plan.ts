/**
 * Milestone 3 - plan view content that the plan generator did not draw.
 *
 * The existing plan generator draws outlines for walls, columns, MEP and
 * openings, but nothing for rooms, and the M2 types (stairs, railings, ramps,
 * curtain walls, roofs, ceilings) fell into its generic "linear thick line /
 * closed polygon" branch (a stair became a thin box, a railing a closed loop).
 * This module produces the proper drawing content:
 *   - wall / column poche (walls broken at door and window openings),
 *   - room tags (number, name, area) and optional boundaries,
 *   - stair symbols with riser lines, up arrow and landings, railings, ramps
 *     with slope, curtain walls with mullion ticks, roof outline with ridge,
 *     ceiling outline (reflected ceiling plans only),
 *   - door and window marks (D1, W1 ... or properties.mark).
 *
 * Pure TypeScript. Units follow the existing pipeline: "sizePt" and "widthPt" are
 * millimetres on paper, positions are world metres.
 */
import type { SceneEntity, StrokeStyle } from "../views/scene";
import { paperToWorld } from "../views/scene";
import { stairLayout, stairParamsOf, type Vec2 } from "./m2-geometry";
import { wallOpenings, type SolidElement } from "./m3-solids";

export interface PlanRoom {
  id: string; name: string; number: string; area: number; levelId: string | null;
  boundary: Array<{ x: number; z: number }>; labelPoint?: Vec2;
}

export interface PlanOptions {
  poche: boolean; pocheColor: string; roomTags: boolean; roomBoundaries: boolean;
  doorTags: boolean; stairSymbols: boolean; railingsAndRamps: boolean; curtainWalls: boolean; roofOutline: boolean;
  /** When true, plan view emits hatch entities (cut walls = concrete hatch, etc.)
   *  instead of solid poche fills. Falls back to solid poche when false. */
  hatch: boolean;
  /** View scale (used to size the hatch pattern tile). 1:100 -> 100. */
  hatchScale: number;
}
export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  poche: true, pocheColor: "#4b5563", roomTags: true, roomBoundaries: false,
  doorTags: true, stairSymbols: true, railingsAndRamps: true, curtainWalls: true, roofOutline: true,
  hatch: false, hatchScale: 100,
};

export interface PlanExtrasInput {
  elements: SolidElement[];
  rooms: PlanRoom[];
  cutElevation: number;
  bandLow: number;
  bandHigh: number;
  /** view scale denominator (1:100 -> 100) */
  scale: number;
  kind: "plan" | "rcp";
  options?: Partial<PlanOptions>;
}

export interface PlanExtras {
  /** poche fills: insert at the BOTTOM of the cut layer so outlines stay on top */
  under: SceneEntity[];
  cut: SceneEntity[];
  overhead: SceneEntity[];
  symbols: SceneEntity[];
  /** base-generator geometry of these elements must be removed (their symbols replace it) */
  suppressIds: Set<string>;
  stats: { stairs: number; roomsTagged: number; doorTags: number; pocheWalls: number };
}

const CUT: StrokeStyle = { color: "#111827", widthPt: 0.35, dash: null };
const FINE: StrokeStyle = { color: "#111827", widthPt: 0.18, dash: null };
const OVER: StrokeStyle = { color: "#6b7280", widthPt: 0.18, dash: [1.2, 0.8] };
const TAG: StrokeStyle = { color: "#0f766e", widthPt: 0.15, dash: null };
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const SUPPRESSED = new Set(["stairs", "railing", "ramp", "curtain-wall", "roof", "ceiling"]);

/** Marks for doors (D1, D2 ...) and windows (W1 ...) in element order; properties.mark wins. */
export function autoMarks(elements: SolidElement[]): Map<string, string> {
  const m = new Map<string, string>();
  let d = 0, w = 0;
  for (const e of elements) {
    if (e.type !== "door" && e.type !== "window") continue;
    const own = e.properties?.mark;
    const auto = e.type === "door" ? `D${++d}` : `W${++w}`;
    m.set(e.id, typeof own === "string" && own.trim() ? own.trim() : auto);
  }
  return m;
}

function rectPoly(a: Vec2, dir: Vec2, u0: number, u1: number, half: number): Array<[number, number]> {
  const n: Vec2 = [-dir[1], dir[0]];
  const P = (u: number, s: number): [number, number] => [a[0] + dir[0] * u + n[0] * s, a[1] + dir[1] * u + n[1] * s];
  return [P(u0, -half), P(u1, -half), P(u1, half), P(u0, half)];
}

function arrow(a: Vec2, b: Vec2, head: number, stroke: StrokeStyle): SceneEntity[] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1e-6) return [];
  const d: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n: Vec2 = [-d[1], d[0]];
  const h = Math.min(head, L * 0.4);
  const p1: Vec2 = [b[0] - d[0] * h + n[0] * h * 0.4, b[1] - d[1] * h + n[1] * h * 0.4];
  const p2: Vec2 = [b[0] - d[0] * h - n[0] * h * 0.4, b[1] - d[1] * h - n[1] * h * 0.4];
  return [
    { kind: "line", x1: a[0], z1: a[1], x2: b[0], z2: b[1], stroke },
    { kind: "line", x1: b[0], z1: b[1], x2: p1[0], z2: p1[1], stroke },
    { kind: "line", x1: b[0], z1: b[1], x2: p2[0], z2: p2[1], stroke },
  ];
}

const outline = (pts: Array<[number, number]>, stroke: StrokeStyle): SceneEntity => ({ kind: "polyline", points: pts, closed: true, stroke });
const seg = (a: Vec2, b: Vec2, stroke: StrokeStyle): SceneEntity => ({ kind: "line", x1: a[0], z1: a[1], x2: b[0], z2: b[1], stroke });
const txt = (x: number, z: number, text: string, sizeMm: number, color = "#111827", anchor: "start" | "middle" | "end" = "middle"): SceneEntity =>
  ({ kind: "text", x, z, text, anchor, sizePt: sizeMm, rotation: 0, color });

/** Where an element of vertical extent [base, top] is drawn: cut by the plane, visible below it, or above it (dashed). */
function classify(out: PlanExtras, base: number, top: number, cutY: number): { layer: SceneEntity[]; heavy: StrokeStyle; fine: StrokeStyle } {
  if (base <= cutY + 1e-6 && top >= cutY - 1e-6) return { layer: out.cut, heavy: CUT, fine: FINE };
  if (top < cutY) return { layer: out.cut, heavy: FINE, fine: FINE };   // wholly below the cut plane: ordinary projected lines
  return { layer: out.overhead, heavy: OVER, fine: OVER };
}

export function planExtras(input: PlanExtrasInput): PlanExtras {
  const o: PlanOptions = { ...DEFAULT_PLAN_OPTIONS, ...(input.options ?? {}) };
  const out: PlanExtras = { under: [], cut: [], overhead: [], symbols: [], suppressIds: new Set(), stats: { stairs: 0, roomsTagged: 0, doorTags: 0, pocheWalls: 0 } };
  const cutY = input.cutElevation;
  const mm = (v: number) => paperToWorld(v, input.scale);
  const hostedBy = new Map<string, SolidElement[]>();
  for (const e of input.elements) if ((e.type === "door" || e.type === "window") && e.hostId) (hostedBy.get(e.hostId) ?? hostedBy.set(e.hostId, []).get(e.hostId)!).push(e);

  for (const el of input.elements) {
    const p = el.params;
    const base = num(p.elevation, 0), H = num(p.height, 0), top = base + H;
    if (base > input.bandHigh || top < input.bandLow) continue;
    const spans = base <= cutY + 1e-6 && top >= cutY - 1e-6;
    if (SUPPRESSED.has(el.type)) out.suppressIds.add(el.id);

    /* ---- poche (or hatch when enabled) ---- */
    if (o.poche && el.type === "wall" && p.start && p.end && spans) {
      const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
      if (L > 0.05) {
        const dir: Vec2 = [(p.end[0] - p.start[0]) / L, (p.end[1] - p.start[1]) / L];
        const ops = wallOpenings(el, hostedBy.get(el.id) ?? []).filter((x) => x.y0 <= cutY && x.y1 >= cutY);
        // pieces at the cut height: runs between the openings that the cut plane passes through
        let cursor = 0;
        const runs: Array<[number, number]> = [];
        for (const x of ops) { if (x.u0 - cursor > 1e-6) runs.push([cursor, x.u0]); cursor = Math.max(cursor, x.u1); }
        if (L - cursor > 1e-6) runs.push([cursor, L]);
        for (const [u0, u1] of runs) {
          const poly = rectPoly(p.start, dir, u0, u1, num(p.thickness, 0.2) / 2);
          if (o.hatch) {
            // Emit a hatch entity: the SVG / PDF renderer will fill the polygon
            // with the named pattern (concrete for walls).
            out.under.push({
              kind: "hatch",
              polygon: poly,
              pattern: "concrete",
              color: o.pocheColor,
              scale: o.hatchScale,
            });
          } else {
            out.under.push({
              kind: "polyline",
              points: poly,
              closed: true,
              stroke: { color: o.pocheColor, widthPt: 0, dash: null },
              fill: { color: o.pocheColor, opacity: 1 },
            });
          }
        }
        out.stats.pocheWalls++;
      }
    }
    if (o.poche && (el.type === "column" || el.type === "footing") && p.point && spans) {
      const t = num(p.thickness, 0.3), d = num(p.depth, t), [x, z] = p.point;
      const poly: Array<[number, number]> = [
        [x - t / 2, z - d / 2], [x + t / 2, z - d / 2], [x + t / 2, z + d / 2], [x - t / 2, z + d / 2],
      ];
      if (o.hatch) {
        out.under.push({
          kind: "hatch",
          polygon: poly,
          pattern: "concrete",
          color: o.pocheColor,
          scale: o.hatchScale,
        });
      } else {
        out.under.push({
          kind: "polyline",
          points: poly,
          closed: true,
          stroke: { color: o.pocheColor, widthPt: 0, dash: null },
          fill: { color: o.pocheColor, opacity: 1 },
        });
      }
    }

    /* ---- stairs ---- */
    if (el.type === "stairs" && o.stairSymbols) {
      const sp = stairParamsOf(el);
      if (!sp) continue;
      let lay;
      try { lay = stairLayout(sp); } catch { continue; }
      out.stats.stairs++;
      lay.flights.forEach((f, fi) => {
        const half = lay.width / 2;
        const poly = rectPoly(f.start, f.dir, 0, f.run, half);
        const stroke = sp.elevation + f.h0 <= cutY ? CUT : OVER;
        (stroke === CUT ? out.cut : out.overhead).push(outline(poly, stroke));
        const td = f.run / f.n;
        for (let i = 1; i < f.n; i++) {
          const h = f.h0 + i * lay.riserHeight; // top of riser i
          const a: Vec2 = [f.start[0] + f.dir[0] * td * i + -f.dir[1] * -half, f.start[1] + f.dir[1] * td * i + f.dir[0] * -half];
          const b: Vec2 = [f.start[0] + f.dir[0] * td * i + -f.dir[1] * half, f.start[1] + f.dir[1] * td * i + f.dir[0] * half];
          const below = sp.elevation + h <= cutY;
          (below ? out.cut : out.overhead).push(seg(a, b, below ? FINE : OVER));
        }
        // walking line with arrow along the centre line
        const a: Vec2 = [f.start[0] + f.dir[0] * td * 0.5, f.start[1] + f.dir[1] * td * 0.5];
        const b: Vec2 = [f.start[0] + f.dir[0] * (f.run - td * 0.5), f.start[1] + f.dir[1] * (f.run - td * 0.5)];
        out.symbols.push(...arrow(a, b, mm(3), { color: "#111827", widthPt: 0.2, dash: null }));
        if (fi === 0) out.symbols.push(txt(a[0] - f.dir[1] * (half * 0.55), a[1] + f.dir[0] * (half * 0.55), "UP", 2.2));
      });
      for (const l of lay.landings) (sp.elevation + l.top <= cutY ? out.cut : out.overhead).push(outline(l.poly.map((q) => [q[0], q[1]] as [number, number]), sp.elevation + l.top <= cutY ? CUT : OVER));
    }

    /* ---- railings and ramps ---- */
    if (el.type === "railing" && o.railingsAndRamps) {
      const path = p.polygon ?? (p.start && p.end ? [p.start, p.end] : null);
      if (path && path.length >= 2) {
        const half = Math.max(0.02, num(p.thickness, 0.05) / 2);
        const { layer, fine: st } = classify(out, base, top, cutY);
        for (let i = 0; i + 1 < path.length; i++) {
          const a = path[i], b = path[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (L < 1e-6) continue;
          const nx = (-(b[1] - a[1]) / L) * half, nz = ((b[0] - a[0]) / L) * half;
          layer.push(seg([a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], st), seg([a[0] - nx, a[1] - nz], [b[0] - nx, b[1] - nz], st));
        }
      }
    }
    if (el.type === "ramp" && o.railingsAndRamps && p.start && p.end) {
      const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
      if (L > 0.1) {
        const dir: Vec2 = [(p.end[0] - p.start[0]) / L, (p.end[1] - p.start[1]) / L];
        const w = num(p.width, 1.5);
        const c = classify(out, base, base + num(p.height, 0.5) + num(p.thickness, 0.2), cutY);
        c.layer.push(outline(rectPoly(p.start, dir, 0, L, w / 2), c.heavy));
        out.symbols.push(...arrow([p.start[0] + dir[0] * 0.2, p.start[1] + dir[1] * 0.2], [p.end[0] - dir[0] * 0.2, p.end[1] - dir[1] * 0.2], mm(3), FINE));
        const slope = num(p.height, 0.5) / L;
        out.symbols.push(txt((p.start[0] + p.end[0]) / 2 - dir[1] * (w * 0.3), (p.start[1] + p.end[1]) / 2 + dir[0] * (w * 0.3), slope > 0 ? `1:${(1 / slope).toFixed(1)}` : "flat", 2.2));
      }
    }

    /* ---- curtain walls ---- */
    if (el.type === "curtain-wall" && o.curtainWalls && p.start && p.end) {
      const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
      if (L > 0.1) {
        const dir: Vec2 = [(p.end[0] - p.start[0]) / L, (p.end[1] - p.start[1]) / L];
        const half = num(p.thickness, 0.1) / 2;
        const nu = Math.max(1, Math.round(L / Math.max(0.3, num(el.properties?.uSpacing, 1.5))));
        const { layer, heavy: st, fine } = classify(out, base, top, cutY);
        const n: Vec2 = [-dir[1], dir[0]];
        const P = (u: number, s: number): Vec2 => [p.start![0] + dir[0] * u + n[0] * s, p.start![1] + dir[1] * u + n[1] * s];
        layer.push(seg(P(0, half), P(L, half), st), seg(P(0, -half), P(L, -half), st));
        for (let i = 0; i <= nu; i++) layer.push(seg(P((L * i) / nu, half), P((L * i) / nu, -half), fine));
        layer.push(seg(P(0, 0), P(L, 0), { color: "#7dd3fc", widthPt: 0.15, dash: null })); // glazing line
      }
    }

    /* ---- roofs and ceilings ---- */
    if (el.type === "roof" && o.roofOutline && input.kind === "plan" && p.polygon && p.polygon.length >= 3) {
      const poly = p.polygon.map((q) => [q[0], q[1]] as [number, number]);
      out.overhead.push(outline(poly, OVER));
      const pr = el.properties ?? {};
      const a = (num(pr.slopeDirection, 0) * Math.PI) / 180, s: Vec2 = [Math.cos(a), Math.sin(a)];
      const ps = p.polygon.map((q) => q[0] * s[0] + q[1] * s[1]);
      const mid = (Math.min(...ps) + Math.max(...ps)) / 2, ext = Math.hypot(...[Math.max(...p.polygon.map((q) => q[0])) - Math.min(...p.polygon.map((q) => q[0])), Math.max(...p.polygon.map((q) => q[1])) - Math.min(...p.polygon.map((q) => q[1]))]);
      const cx = p.polygon.reduce((acc, q) => acc + q[0], 0) / p.polygon.length, cz = p.polygon.reduce((acc, q) => acc + q[1], 0) / p.polygon.length;
      const c = cx * s[0] + cz * s[1];
      if (String(pr.roofType ?? "gable") === "gable") {
        const t: Vec2 = [-s[1], s[0]], k = mid - c; // ridge line: perpendicular to the slope direction, through the span midpoint
        out.overhead.push(seg([cx + s[0] * k - t[0] * ext, cz + s[1] * k - t[1] * ext], [cx + s[0] * k + t[0] * ext, cz + s[1] * k + t[1] * ext], { color: "#6b7280", widthPt: 0.25, dash: [3, 0.8] }));
      }
      out.symbols.push(...arrow([cx - s[0] * 0.6, cz - s[1] * 0.6], [cx + s[0] * 0.6, cz + s[1] * 0.6], mm(2.5), FINE));
      out.symbols.push(txt(cx, cz - mm(4), `${num(pr.slope, 30)}\u00B0`, 2.2));
    }
    if (el.type === "ceiling" && input.kind === "rcp" && p.polygon && p.polygon.length >= 3) {
      out.cut.push(outline(p.polygon.map((q) => [q[0], q[1]] as [number, number]), CUT));
      const cx = p.polygon.reduce((a, q) => a + q[0], 0) / p.polygon.length, cz = p.polygon.reduce((a, q) => a + q[1], 0) / p.polygon.length;
      out.symbols.push(txt(cx, cz, `CLG ${base.toFixed(2)}`, 2.2));
    }
  }

  /* ---- door / window marks ---- */
  if (o.doorTags) {
    const marks = autoMarks(input.elements);
    const byId = new Map(input.elements.map((e) => [e.id, e]));
    for (const e of input.elements) {
      if ((e.type !== "door" && e.type !== "window") || !e.hostId) continue;
      const host = byId.get(e.hostId);
      if (!host || host.type !== "wall" || !host.params.start || !host.params.end) continue;
      const hp = host.params;
      const base = num(hp.elevation, 0) + num(e.params.sillHeight, 0);
      if (base > input.bandHigh || num(hp.elevation, 0) + num(hp.height, 0) < input.bandLow) continue;
      const L = Math.hypot(hp.end![0] - hp.start![0], hp.end![1] - hp.start![1]);
      if (L < 0.05) continue;
      const dir: Vec2 = [(hp.end![0] - hp.start![0]) / L, (hp.end![1] - hp.start![1]) / L];
      const w = num(e.params.width, e.type === "door" ? 0.9 : 1.2);
      const c = Math.max(w / 2, Math.min(L - w / 2, num(e.params.offsetAlongHost, L / 2)));
      const off = num(hp.thickness, 0.2) / 2 + mm(4.5);
      const x = hp.start![0] + dir[0] * c + -dir[1] * off, z = hp.start![1] + dir[1] * c + dir[0] * off;
      out.symbols.push({ kind: "circle", cx: x, cz: z, r: mm(2.6), stroke: TAG });
      out.symbols.push(txt(x, z, marks.get(e.id) ?? "?", 2.0, "#0f766e"));
      out.stats.doorTags++;
    }
  }

  /* ---- rooms ---- */
  for (const r of input.rooms) {
    if (r.boundary.length < 3) continue;
    if (o.roomBoundaries) out.symbols.push({ kind: "polyline", points: r.boundary.map((b) => [b.x, b.z] as [number, number]), closed: true, stroke: { color: "#2563eb", widthPt: 0.12, dash: [2, 1] } });
    if (!o.roomTags) continue;
    const lp: Vec2 = r.labelPoint ?? [r.boundary.reduce((a, b) => a + b.x, 0) / r.boundary.length, r.boundary.reduce((a, b) => a + b.z, 0) / r.boundary.length];
    const lh = mm(3.4);
    out.symbols.push(txt(lp[0], lp[1] + lh, r.number, 2.8, "#1d4ed8"));
    out.symbols.push(txt(lp[0], lp[1], r.name, 2.4));
    out.symbols.push(txt(lp[0], lp[1] - lh, `${r.area.toFixed(1)} m\u00B2`, 2.0, "#374151"));
    out.stats.roomsTagged++;
  }
  return out;
}
