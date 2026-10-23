/**
 * Dimension / snap reference points for EVERY authored element type.
 *
 *  linear (wall, beam, duct, pipe, ...) : Start, End (centreline) + the four face corners
 *  point  (column, footing, equipment)  : Centre, four corners, four edge midpoints
 *  polygon (slab, room, roof, ceiling)  : every vertex + every edge midpoint
 *  hosted (door, window)                : left jamb, right jamb, centre (follow the host wall)
 *  fitting (elbow, tee, ...)            : centre of the fitting
 *
 * Each point carries a ref that can be re-resolved later (resolveElementRef) so
 * dimensions follow the element when it is moved or edited.
 * Pure module - no DOM, no imports from the panel.
 */

export type SnapRefKind =
  | "linear-side" | "linear-cap" | "point-edge" | "point-corner"
  | "static-boundary" | "polygon-vertex" | "hosted";

export interface SnapRef {
  elementId?: string;
  x?: number; z?: number;
  kind: SnapRefKind;
  t?: number; n?: number;
  dx?: number; dz?: number;
  /** polygon-vertex: vertex index. hosted: -1 left jamb, 0 centre, 1 right jamb. */
  index?: number;
  side?: "left" | "right" | "start" | "end" | "top" | "bottom";
}

export type ElementPointKind = "start" | "end" | "vertex" | "corner" | "edge-mid" | "center" | "jamb";

export interface ElementSnapPoint {
  x: number; z: number;
  kind: ElementPointKind;
  label: string;
  /** Higher wins when several are inside the tolerance. */
  priority: number;
  ref: SnapRef;
  elementId: string;
}

const NAME: Record<string, string> = {
  wall: "Wall", beam: "Beam", brace: "Brace", truss: "Truss", strip: "Strip footing", mline: "Line",
  duct: "Duct", pipe: "Pipe", "cable-tray": "Cable tray", conduit: "Conduit", railing: "Railing",
  column: "Column", footing: "Footing", equipment: "Equipment", fitting: "Fitting",
  door: "Door", window: "Window", slab: "Slab", room: "Room", area: "Area", roof: "Roof",
  ceiling: "Ceiling", terrain: "Terrain", stairs: "Stairs", ramp: "Ramp", "curtain-wall": "Curtain wall",
  generic: "Element",
};
const nm = (el: any) => NAME[el?.type] ?? "Element";

const P = { start: 100, end: 100, vertex: 97, corner: 96, jamb: 95, center: 88, edgeMid: 86 };

function hostWall(el: any, byId: Map<string, any>) {
  const h = el?.hostId ? byId.get(String(el.hostId)) : null;
  return h?.params?.start && h?.params?.end ? h : null;
}

/** World point of a hosted opening at local index (-1 left, 0 centre, 1 right). */
export function hostedPoint(el: any, host: any, index: number): { x: number; z: number } | null {
  const hp = host?.params;
  if (!hp?.start || !hp?.end) return null;
  const [ax, az] = hp.start, [bx, bz] = hp.end;
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 1e-9) return null;
  const ux = (bx - ax) / L, uz = (bz - az) / L;
  const along = Number(el.params?.offsetAlongHost ?? 0) + index * (Number(el.params?.width ?? 0.9) / 2);
  return { x: ax + ux * along, z: az + uz * along };
}

export function collectElementSnapPoints(elements: readonly any[]): ElementSnapPoint[] {
  const byId = new Map<string, any>();
  for (const e of elements) if (e?.id) byId.set(String(e.id), e);
  const out: ElementSnapPoint[] = [];
  for (const el of elements) {
    if (!el?.id || !el.params) continue;
    const id = String(el.id), p = el.params, n = nm(el);

    // Hosted openings follow their wall.
    const host = (el.type === "door" || el.type === "window") ? hostWall(el, byId) : null;
    if (host) {
      for (const [idx, label, pri] of [[-1, `${n} left jamb`, P.jamb], [1, `${n} right jamb`, P.jamb], [0, `${n} centre`, P.center]] as const) {
        const q = hostedPoint(el, host, idx);
        if (q) out.push({ ...q, kind: idx === 0 ? "center" : "jamb", label, priority: pri, elementId: id,
          ref: { kind: "hosted", elementId: id, index: idx } });
      }
      continue;
    }

    if (p.start && p.end) {
      const [ax, az] = p.start, [bx, bz] = p.end;
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1e-6) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
      const half = Math.max(0.01, Number(p.thickness ?? p.width ?? 0.2) / 2);
      out.push({ x: ax, z: az, kind: "start", label: `Start of ${n.toLowerCase()}`, priority: P.start, elementId: id,
        ref: { kind: "linear-cap", elementId: id, side: "start", t: 0, n: 0 } });
      out.push({ x: bx, z: bz, kind: "end", label: `End of ${n.toLowerCase()}`, priority: P.end, elementId: id,
        ref: { kind: "linear-cap", elementId: id, side: "end", t: 1, n: 0 } });
      for (const [side, t, bx0, bz0] of [["start", 0, ax, az], ["end", 1, bx, bz]] as const) {
        for (const s of [1, -1]) {
          out.push({ x: bx0 + nx * half * s, z: bz0 + nz * half * s, kind: "corner",
            label: `${n} ${side} corner`, priority: P.corner, elementId: id,
            ref: { kind: "linear-cap", elementId: id, side, t, n: half * s } });
        }
      }
      continue;
    }

    if (p.polygon && p.polygon.length >= 2) {
      const poly: [number, number][] = p.polygon;
      poly.forEach((v, i) => {
        out.push({ x: v[0], z: v[1], kind: "vertex", label: `${n} vertex ${i + 1}`, priority: P.vertex, elementId: id,
          ref: { kind: "polygon-vertex", elementId: id, index: i } });
        const w = poly[(i + 1) % poly.length];
        if (poly.length > 2 || i === 0) {
          const mx = (v[0] + w[0]) / 2, mz = (v[1] + w[1]) / 2;
          out.push({ x: mx, z: mz, kind: "edge-mid", label: `${n} edge midpoint`, priority: P.edgeMid, elementId: id,
            ref: { kind: "static-boundary", elementId: id, x: mx, z: mz } });
        }
      });
      continue;
    }

    if (p.point) {
      const cx = Number(p.point[0]), cz = Number(p.point[1]);
      const hw = Math.max(0.01, Number(p.width ?? p.thickness ?? 0.3) / 2);
      const hd = Math.max(0.01, Number(p.depth ?? p.thickness ?? p.width ?? 0.3) / 2);
      out.push({ x: cx, z: cz, kind: "center", label: `${n} centre`, priority: P.center, elementId: id,
        ref: { kind: "point-edge", elementId: id, dx: 0, dz: 0 } });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        out.push({ x: cx + sx * hw, z: cz + sz * hd, kind: "corner", label: `${n} corner`, priority: P.corner, elementId: id,
          ref: { kind: "point-edge", elementId: id, dx: sx * hw, dz: sz * hd } });
      }
      for (const [dx, dz, side] of [[-hw, 0, "left"], [hw, 0, "right"], [0, -hd, "bottom"], [0, hd, "top"]] as const) {
        out.push({ x: cx + dx, z: cz + dz, kind: "edge-mid", label: `${n} edge`, priority: P.edgeMid, elementId: id,
          ref: { kind: "point-edge", elementId: id, dx, dz, side } });
      }
    }
  }
  return out;
}

/** Best point within tol of (px,pz): highest priority first, then nearest. */
export function pickElementSnapPoint(points: readonly ElementSnapPoint[], px: number, pz: number, tol: number): (ElementSnapPoint & { distance: number }) | null {
  let best: (ElementSnapPoint & { distance: number }) | null = null;
  for (const q of points) {
    const d = Math.hypot(q.x - px, q.z - pz);
    if (d > tol) continue;
    if (!best || q.priority > best.priority || (q.priority === best.priority && d < best.distance)) best = { ...q, distance: d };
  }
  return best;
}

/** Re-resolve a polygon-vertex or hosted ref against the current elements. */
export function resolveElementRef(ref: SnapRef | undefined, elements: readonly any[]): { x: number; z: number } | null {
  if (!ref?.elementId) return null;
  const el = elements.find((e) => String(e?.id) === String(ref.elementId));
  if (!el?.params) return null;
  if (ref.kind === "polygon-vertex") {
    const v = el.params.polygon?.[ref.index ?? -1];
    return v ? { x: v[0], z: v[1] } : null;
  }
  if (ref.kind === "hosted") {
    const host = elements.find((e) => String(e?.id) === String(el.hostId));
    return hostedPoint(el, host, ref.index ?? 0);
  }
  return null;
}
