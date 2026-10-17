/**
 * Wall-bounded room detection (pure geometry, no DOM / three.js).
 *
 * BIM places a room by clicking inside an enclosed area; the room boundary
 * follows the wall finish faces. This module does the same on a plan:
 *   1. node the wall centre-lines into a planar graph (snapping near-misses,
 *      T-junctions and crossings),
 *   2. prune dangling edges,
 *   3. trace the faces of the planar graph,
 *   4. pick the face containing the point (islands become holes),
 *   5. offset every boundary edge by half of its wall thickness.
 *
 * Doors / windows are ignored on purpose: a room is bounded by the wall even
 * where a door opening cuts it. Room-separation lines are walls of thickness 0.
 */
export type Vec2 = [number, number];

export interface RoomWall {
  id: string;
  start: Vec2;
  end: Vec2;
  /** Wall thickness in metres (0 for room-separation lines). */
  thickness: number;
}

export interface RoomDetectOptions {
  /** Endpoint / T-junction snapping tolerance (m). Default 0.05. */
  snap?: number;
  /** Ignore faces smaller than this (m2) in detectAllRooms. Default 0.25. */
  minArea?: number;
  /** "finish" offsets by half thickness (BIM default); "center" keeps centre-lines. */
  boundary?: "finish" | "center";
}

export interface DetectedRoom {
  boundary: Vec2[];
  holes: Vec2[][];
  /** Net area (outer minus holes), m2. */
  area: number;
  perimeter: number;
  /** A point inside the room suitable for a tag. */
  labelPoint: Vec2;
  wallIds: string[];
  /** false when the finish-face offset failed and centre-lines were used. */
  exact: boolean;
}

interface Edge { u: number; v: number; t: number; ids: Set<string>; }
interface Face { nodes: number[]; edges: Edge[]; area: number; }
interface Graph { pts: Vec2[]; edges: Edge[]; faces: Face[]; }

const EPS = 1e-9;

function sub(a: Vec2, b: Vec2): Vec2 { return [a[0] - b[0], a[1] - b[1]]; }
function dist(a: Vec2, b: Vec2): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function cross(a: Vec2, b: Vec2): number { return a[0] * b[1] - a[1] * b[0]; }

export function signedArea(p: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  const [x, y] = pt;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function projectOnSeg(p: Vec2, a: Vec2, b: Vec2): { pt: Vec2; t: number; d: number } {
  const ab = sub(b, a);
  const L2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = L2 < EPS ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / L2));
  const pt: Vec2 = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return { pt, t, d: dist(p, pt) };
}

/** Proper intersection of two segments; returns params along each or null. */
function segIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < EPS) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  const e = 1e-7;
  if (t > e && t < 1 - e && u > e && u < 1 - e) return { t, u };
  return null;
}

/* ---------------------------------------------------------------- graph */

function buildGraph(walls: RoomWall[], snap: number): Graph {
  const segs = walls
    .filter((w) => dist(w.start, w.end) > 1e-6)
    .map((w) => ({ id: w.id, t: Math.max(0, w.thickness), a: -1, b: -1, pa: [w.start[0], w.start[1]] as Vec2, pb: [w.end[0], w.end[1]] as Vec2 }));

  // 1. cluster endpoints into nodes
  const pts: Vec2[] = [];
  const nodeFor = (p: Vec2): number => {
    for (let i = 0; i < pts.length; i++) if (dist(pts[i], p) <= snap) return i;
    pts.push([p[0], p[1]]);
    return pts.length - 1;
  };
  for (const s of segs) { s.a = nodeFor(s.pa); s.b = nodeFor(s.pb); }

  // 2. T-junctions: pull a node onto the nearest foreign segment it almost touches
  const endpointNodes = new Set<number>();
  for (const s of segs) { endpointNodes.add(s.a); endpointNodes.add(s.b); }
  for (const n of endpointNodes) {
    let best: { pt: Vec2; d: number } | null = null;
    for (const q of segs) {
      if (q.a === n || q.b === n) continue;
      const A = pts[q.a], B = pts[q.b];
      const pr = projectOnSeg(pts[n], A, B);
      const tol = Math.max(snap, q.t / 2 + 0.02);
      if (pr.d <= tol && pr.d > 1e-9 && dist(pr.pt, A) > snap && dist(pr.pt, B) > snap) {
        if (!best || pr.d < best.d) best = { pt: pr.pt, d: pr.d };
      }
    }
    if (best) pts[n] = best.pt;
  }

  // 3. split every segment at crossings and at nodes lying on it
  const splits: Array<Array<{ t: number; n: number }>> = segs.map((s) => [{ t: 0, n: s.a }, { t: 1, n: s.b }]);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = pts[segs[i].a], B = pts[segs[i].b], C = pts[segs[j].a], D = pts[segs[j].b];
      const x = segIntersect(A, B, C, D);
      if (x) {
        const p: Vec2 = [A[0] + (B[0] - A[0]) * x.t, A[1] + (B[1] - A[1]) * x.t];
        pts.push(p);
        const n = pts.length - 1;
        splits[i].push({ t: x.t, n });
        splits[j].push({ t: x.u, n });
      }
    }
  }
  for (let i = 0; i < segs.length; i++) {
    const A = pts[segs[i].a], B = pts[segs[i].b];
    for (let n = 0; n < pts.length; n++) {
      if (n === segs[i].a || n === segs[i].b) continue;
      if (splits[i].some((s) => s.n === n)) continue;
      const pr = projectOnSeg(pts[n], A, B);
      if (pr.d < 1e-6 && pr.t > 1e-7 && pr.t < 1 - 1e-7) splits[i].push({ t: pr.t, n });
    }
  }

  // 4. edges between consecutive split nodes (deduplicated)
  const edgeMap = new Map<string, Edge>();
  segs.forEach((s, i) => {
    const list = splits[i].slice().sort((p, q) => p.t - q.t);
    for (let k = 0; k + 1 < list.length; k++) {
      const u = list[k].n, v = list[k + 1].n;
      if (u === v || dist(pts[u], pts[v]) < 1e-7) continue;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      const ex = edgeMap.get(key);
      if (ex) { ex.t = Math.max(ex.t, s.t); ex.ids.add(s.id); }
      else edgeMap.set(key, { u, v, t: s.t, ids: new Set([s.id]) });
    }
  });
  let edges = [...edgeMap.values()];

  // 5. prune dangling edges (degree-1 vertices) repeatedly
  for (;;) {
    const deg = new Map<number, number>();
    for (const e of edges) { deg.set(e.u, (deg.get(e.u) ?? 0) + 1); deg.set(e.v, (deg.get(e.v) ?? 0) + 1); }
    const keep = edges.filter((e) => (deg.get(e.u) ?? 0) > 1 && (deg.get(e.v) ?? 0) > 1);
    if (keep.length === edges.length) break;
    edges = keep;
  }

  return { pts, edges, faces: traceFaces(pts, edges) };
}

function traceFaces(pts: Vec2[], edges: Edge[]): Face[] {
  // outgoing neighbours sorted CCW by angle
  const out = new Map<number, Array<{ to: number; edge: Edge; ang: number }>>();
  const add = (from: number, to: number, edge: Edge) => {
    const d = sub(pts[to], pts[from]);
    if (!out.has(from)) out.set(from, []);
    out.get(from)!.push({ to, edge, ang: Math.atan2(d[1], d[0]) });
  };
  for (const e of edges) { add(e.u, e.v, e); add(e.v, e.u, e); }
  for (const list of out.values()) list.sort((a, b) => a.ang - b.ang);

  const visited = new Set<string>();
  const faces: Face[] = [];
  for (const e0 of edges) {
    for (const [s, t] of [[e0.u, e0.v], [e0.v, e0.u]] as Array<[number, number]>) {
      if (visited.has(`${s}>${t}`)) continue;
      const nodes: number[] = [];
      const fe: Edge[] = [];
      let u = s, v = t, guard = 0;
      while (!visited.has(`${u}>${v}`) && guard++ < 100000) {
        visited.add(`${u}>${v}`);
        nodes.push(u);
        const here = out.get(u)!.find((o) => o.to === v)!;
        fe.push(here.edge);
        // next edge: the neighbour just before `u` in CCW order at `v` (turn as far left as possible)
        const list = out.get(v)!;
        const idx = list.findIndex((o) => o.to === u);
        const nxt = list[(idx - 1 + list.length) % list.length];
        u = v; v = nxt.to;
      }
      if (nodes.length >= 3) faces.push({ nodes, edges: fe, area: signedArea(nodes.map((n) => pts[n])) });
    }
  }
  return faces;
}

/* ------------------------------------------------------------- offsetting */

function lineIntersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(q, p), e) / den;
  return [p[0] + d[0] * t, p[1] + d[1] * t];
}

/**
 * Offset a CCW ring. sign=+1 moves every edge to its left (shrinks the ring),
 * sign=-1 to its right (grows it). thick[i] is the wall thickness of edge i.
 */
export function offsetRing(ring: Vec2[], thick: number[], sign: 1 | -1): Vec2[] {
  const n = ring.length;
  const dirs: Vec2[] = [], offs: Vec2[] = [], lens: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = dist(a, b) || 1;
    const d: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const h = (sign * (thick[i] ?? 0)) / 2;
    dirs.push(d); lens.push(L);
    offs.push([a[0] + -d[1] * h, a[1] + d[0] * h]);
  }
  const res: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const p = (k - 1 + n) % n;
    const x = lineIntersect(offs[p], dirs[p], offs[k], dirs[k]);
    if (x) res.push(x);
    else {
      res.push([offs[p][0] + dirs[p][0] * lens[p], offs[p][1] + dirs[p][1] * lens[p]]);
      res.push(offs[k]);
    }
  }
  return cleanRing(res);
}

/** Remove duplicate and collinear points. */
export function cleanRing(r: Vec2[], eps = 1e-6): Vec2[] {
  let pts = r.filter((p, i) => dist(p, r[(i + 1) % r.length]) > eps);
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if (Math.abs(cross(sub(b, a), sub(c, b))) < eps) { pts = pts.filter((_, k) => k !== i); changed = true; break; }
    }
  }
  return pts;
}

function isSimple(p: Vec2[]): boolean {
  const n = p.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segIntersect(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return false;
    }
  }
  return true;
}

function perimeterOf(p: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += dist(p[i], p[(i + 1) % p.length]);
  return s;
}

function centroid(p: Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[(i + 1) % p.length];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < EPS) return p[0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** A point guaranteed inside the polygon (centroid if inside, else widest scanline midpoint). */
export function interiorPoint(outer: Vec2[], holes: Vec2[][] = []): Vec2 {
  const inside = (q: Vec2) => pointInPolygon(q, outer) && !holes.some((h) => pointInPolygon(q, h));
  const c = centroid(outer);
  if (inside(c)) return c;
  const ys = outer.map((p) => p[1]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  let best: Vec2 = outer[0], bestW = -1;
  for (let k = 1; k < 20; k++) {
    const y = y0 + ((y1 - y0) * k) / 20;
    const xs: number[] = [];
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i], b = outer[(i + 1) % outer.length];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const mid: Vec2 = [(xs[i] + xs[i + 1]) / 2, y];
      if (xs[i + 1] - xs[i] > bestW && inside(mid)) { bestW = xs[i + 1] - xs[i]; best = mid; }
    }
  }
  return best;
}

/* ----------------------------------------------------------------- output */

function faceToRoom(g: Graph, face: Face, faces: Face[], boundaryMode: "finish" | "center"): DetectedRoom {
  const ringC = face.nodes.map((n) => g.pts[n]);
  const thickOf = (f: Face) => f.edges.map((e) => e.t);
  const ids = new Set<string>();
  face.edges.forEach((e) => e.ids.forEach((i) => ids.add(i)));

  // holes: positive faces that share no node with this face but lie inside it
  const mine = new Set(face.nodes);
  const holeFaces = faces.filter(
    (f) => f !== face && f.area > 1e-6 && f.area < face.area && !f.nodes.some((n) => mine.has(n)) && pointInPolygon(g.pts[f.nodes[0]], ringC),
  );

  let exact = true;
  let outer = ringC;
  let holes: Vec2[][] = holeFaces.map((f) => f.nodes.map((n) => g.pts[n]));
  if (boundaryMode === "finish") {
    const o = offsetRing(ringC, thickOf(face), 1);
    if (o.length >= 3 && signedArea(o) > 1e-6 && isSimple(o)) outer = o; else exact = false;
    const grown: Vec2[][] = [];
    for (const hf of holeFaces) {
      const h = offsetRing(hf.nodes.map((n) => g.pts[n]), thickOf(hf), -1);
      if (h.length >= 3 && isSimple(h)) grown.push(h); else { exact = false; grown.push(hf.nodes.map((n) => g.pts[n])); }
    }
    holes = grown;
  }
  const area = Math.abs(signedArea(outer)) - holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
  return {
    boundary: outer,
    holes,
    area,
    perimeter: perimeterOf(outer) + holes.reduce((s, h) => s + perimeterOf(h), 0),
    labelPoint: interiorPoint(outer, holes),
    wallIds: [...ids],
    exact,
  };
}

/** Room containing the point, or null when the point is not inside an enclosed wall loop. */
export function detectRoomAt(point: Vec2, walls: RoomWall[], opts: RoomDetectOptions = {}): DetectedRoom | null {
  const g = buildGraph(walls, opts.snap ?? 0.05);
  let best: Face | null = null;
  for (const f of g.faces) {
    if (f.area <= 1e-6) continue;
    if (!pointInPolygon(point, f.nodes.map((n) => g.pts[n]))) continue;
    if (!best || f.area < best.area) best = f;
  }
  if (!best) return null;
  const room = faceToRoom(g, best, g.faces, opts.boundary ?? "finish");
  // the click may fall inside a wall body (between centre-line and finish face)
  return room.area > 1e-6 ? room : null;
}

/** Every enclosed room on the plan ("Place Rooms Automatically"). */
export function detectAllRooms(walls: RoomWall[], opts: RoomDetectOptions = {}): DetectedRoom[] {
  const g = buildGraph(walls, opts.snap ?? 0.05);
  const minArea = opts.minArea ?? 0.25;
  const rooms: DetectedRoom[] = [];
  for (const f of g.faces) {
    if (f.area <= 1e-6) continue;
    const r = faceToRoom(g, f, g.faces, opts.boundary ?? "finish");
    if (r.area >= minArea) rooms.push(r);
  }
  return rooms;
}
