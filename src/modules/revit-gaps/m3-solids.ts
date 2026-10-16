/**
 * Milestone 3 - elements as closed solids for drawing production.
 *
 * Elevation and section views need real geometry, not bounding rectangles:
 * walls with their door / window openings, glazing, sloped roofs, stairs.
 * This module turns authored elements into closed, outward-wound triangle
 * soups (three.js axes) that m3-project.ts can project and cut.
 *
 * Pure TypeScript: no three.js, no DOM.
 */
import { Soup, orientedBox, prismPlan, buildElementGeo, isM2Type, type GeoElement, type Vec2 } from "./m2-geometry";

export type V3 = [number, number, number];

export interface SolidPart { positions: number[]; role: "solid" | "glass" }
export interface Solid { id: string; type: string; parts: SolidPart[] }

export interface SolidElement extends GeoElement {
  id: string;
  hostId?: string;
  levelId?: string;
  name?: string;
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export interface Opening { id: string; kind: "door" | "window"; u0: number; u1: number; y0: number; y1: number }

/** Door / window openings of a wall in wall coordinates (u along the wall, y absolute). */
export function wallOpenings(wall: SolidElement, hosted: SolidElement[]): Opening[] {
  const p = wall.params;
  if (!p.start || !p.end) return [];
  const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
  const base = num(p.elevation, 0);
  const out: Opening[] = [];
  for (const h of hosted) {
    if (h.type !== "door" && h.type !== "window") continue;
    const w = num(h.params.width, h.type === "door" ? 0.9 : 1.2);
    const ht = num(h.params.height, h.type === "door" ? 2.1 : 1.4);
    const sill = h.type === "door" ? num(h.params.sillHeight, 0) : num(h.params.sillHeight, 0.9);
    const c = Math.max(w / 2, Math.min(L - w / 2, num(h.params.offsetAlongHost, L / 2)));
    out.push({ id: h.id, kind: h.type, u0: c - w / 2, u1: c + w / 2, y0: base + sill, y1: base + sill + ht });
  }
  return out.sort((a, b) => a.u0 - b.u0);
}

/** The wall as boxes around its openings (full-height runs, lintels, sills). */
export function wallPieces(wall: SolidElement, openings: Opening[]): Array<{ u0: number; u1: number; y0: number; y1: number }> {
  const p = wall.params;
  const L = Math.hypot(p.end![0] - p.start![0], p.end![1] - p.start![1]);
  const y0 = num(p.elevation, 0), y1 = y0 + num(p.height, 3);
  const pieces: Array<{ u0: number; u1: number; y0: number; y1: number }> = [];
  let cursor = 0;
  for (const o of openings) {
    const a = Math.max(o.u0, cursor), b = Math.min(o.u1, L);
    if (a - cursor > 1e-6) pieces.push({ u0: cursor, u1: a, y0, y1 });
    if (b > a + 1e-6) {
      if (o.y0 > y0 + 1e-6) pieces.push({ u0: a, u1: b, y0, y1: Math.min(o.y0, y1) });   // below a window
      if (o.y1 < y1 - 1e-6) pieces.push({ u0: a, u1: b, y0: Math.max(o.y1, y0), y1 });   // lintel
    }
    cursor = Math.max(cursor, b);
  }
  if (L - cursor > 1e-6) pieces.push({ u0: cursor, u1: L, y0, y1 });
  return pieces.filter((q) => q.u1 - q.u0 > 1e-6 && q.y1 - q.y0 > 1e-6);
}

function hbox(soup: Soup, start: Vec2, dir: Vec2, u0: number, u1: number, y0: number, y1: number, across: number): void {
  const yc = (y0 + y1) / 2;
  orientedBox([start[0] + dir[0] * u0, yc, start[1] + dir[1] * u0], [start[0] + dir[0] * u1, yc, start[1] + dir[1] * u1], across, y1 - y0, soup);
}

/** Door / window leaf and frame boxes inside an opening. */
function infill(op: Opening, wall: SolidElement, dir: Vec2): { solid: Soup; glass: Soup } {
  const p = wall.params;
  const start = p.start!, t = num(p.thickness, 0.2);
  const solid = new Soup(), glass = new Soup();
  const fw = 0.05, fd = Math.min(0.12, t * 0.9);
  const { u0, u1, y0, y1 } = op;
  hbox(solid, start, dir, u0, u0 + fw, y0, y1, fd);                 // left jamb
  hbox(solid, start, dir, u1 - fw, u1, y0, y1, fd);                 // right jamb
  hbox(solid, start, dir, u0 + fw, u1 - fw, y1 - fw, y1, fd);       // head
  if (op.kind === "window") {
    hbox(solid, start, dir, u0 + fw, u1 - fw, y0, y0 + fw, fd);     // sill
    hbox(glass, start, dir, u0 + fw, u1 - fw, y0 + fw, y1 - fw, 0.012);
  } else {
    hbox(solid, start, dir, u0 + fw, u1 - fw, y0, y1 - fw, 0.04);   // leaf
  }
  return { solid, glass };
}

/** Closed solids for every drawable element. Hosted doors / windows become infill of their host wall. */
export function elementSolids(elements: SolidElement[], filter?: (el: SolidElement) => boolean): Solid[] {
  const hostedBy = new Map<string, SolidElement[]>();
  for (const e of elements) if ((e.type === "door" || e.type === "window") && e.hostId) {
    const arr = hostedBy.get(e.hostId) ?? []; arr.push(e); hostedBy.set(e.hostId, arr);
  }
  const out: Solid[] = [];
  const push = (id: string, type: string, parts: SolidPart[]) => { const ps = parts.filter((x) => x.positions.length >= 9); if (ps.length) out.push({ id, type, parts: ps }); };

  for (const el of elements) {
    if (filter && !filter(el)) continue;
    const p = el.params;
    const elev = num(p.elevation, 0), H = num(p.height, 0), T = num(p.thickness, 0.2);
    try {
      if (el.type === "door" || el.type === "window") continue; // emitted with the host wall
      if (isM2Type(el.type)) {
        const g = buildElementGeo(el);
        if (g) push(el.id, el.type, g.parts.map((x) => ({ positions: x.positions, role: x.role })));
        continue;
      }
      if (el.type === "wall" && p.start && p.end) {
        const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
        if (L < 0.05) continue;
        const dir: Vec2 = [(p.end[0] - p.start[0]) / L, (p.end[1] - p.start[1]) / L];
        const ops = wallOpenings(el, hostedBy.get(el.id) ?? []);
        const body = new Soup();
        for (const q of wallPieces(el, ops)) hbox(body, p.start, dir, q.u0, q.u1, q.y0, q.y1, T);
        const parts: SolidPart[] = [{ positions: body.p, role: "solid" }];
        push(el.id, "wall", parts);
        for (const op of ops) {
          const f = infill(op, el, dir);
          push(op.id, op.kind, [{ positions: f.solid.p, role: "solid" }, { positions: f.glass.p, role: "glass" }]);
        }
        continue;
      }
      if (el.type === "slab" && p.polygon && p.polygon.length >= 3) {
        const s = new Soup(); prismPlan(p.polygon, elev, elev + (H || T || 0.2), s);
        push(el.id, "slab", [{ positions: s.p, role: "solid" }]);
        continue;
      }
      if ((el.type === "column" || el.type === "footing" || el.type === "equipment") && p.point) {
        const s = new Soup();
        const base = el.type === "footing" ? elev - H : elev;
        orientedBox([p.point[0], base, p.point[1]], [p.point[0], base + H, p.point[1]], T, num(p.depth, T), s, [1, 0, 0]);
        push(el.id, el.type, [{ positions: s.p, role: "solid" }]);
        continue;
      }
      if (["beam", "strip", "duct", "pipe", "cable-tray", "conduit"].includes(el.type) && p.start && p.end) {
        const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
        if (L < 0.05) continue;
        const s = new Soup();
        orientedBox([p.start[0], elev + H / 2, p.start[1]], [p.end[0], elev + H / 2, p.end[1]], T, H, s);
        push(el.id, el.type, [{ positions: s.p, role: "solid" }]);
        continue;
      }
      if (el.type === "brace" && p.start && p.end) {
        const s = new Soup();
        orientedBox([p.start[0], elev, p.start[1]], [p.end[0], elev + H, p.end[1]], T, T, s);
        push(el.id, "brace", [{ positions: s.p, role: "solid" }]);
      }
    } catch { /* an element with unusable parameters is simply not drawn */ }
  }
  return out;
}
