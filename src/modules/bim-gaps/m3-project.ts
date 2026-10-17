/**
 * Milestone 3 - projecting and cutting solids into Scene2D entities.
 *
 * Elevation: per-component painter's algorithm. Each connected piece of a solid
 * contributes its front-facing triangles; their boundary loops become one filled,
 * outlined polygon (so nearer pieces hide farther ones) and creases become lines.
 *
 * Section: closed solids are clipped by the cut plane; the cap of every cut solid
 * is rebuilt from the intersection segments (loops = poche, holes punched), and
 * what remains beyond the plane is projected like an elevation.
 *
 * View coordinates follow the existing 2D pipeline: scene x = u (to the right),
 * scene z = v (up, elevation). Pure TypeScript (type-only imports).
 */
import type { SceneEntity, StrokeStyle } from "../views/scene";
import type { Solid, V3 } from "./m3-solids";

export interface ViewFrame { origin: V3; right: V3; up: V3; fwd: V3 }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

/** Same u axis as the existing elevation generator (north: u = +x, south: -x, east: +z, west: -z). */
export function elevationFrame(direction: "north" | "south" | "east" | "west"): ViewFrame {
  const [a0, a1]: [number, number] = direction === "north" ? [1, 0] : direction === "south" ? [-1, 0] : direction === "east" ? [0, 1] : [0, -1];
  return { origin: [0, 0, 0], right: [a0, 0, a1], up: [0, 1, 0], fwd: [a1, 0, -a0] };
}

/**
 * Section frame. "right" looks to the right-hand side of the cut line direction
 * (plan with +z up); "left" looks the other way, which reverses u so the drawing
 * is never mirrored.
 */
export function sectionFrame(cut: { x1: number; z1: number; x2: number; z2: number }, lookDir: "left" | "right"): ViewFrame {
  const dx = cut.x2 - cut.x1, dz = cut.z2 - cut.z1;
  const L = Math.hypot(dx, dz) || 1;
  const d: [number, number] = [dx / L, dz / L];
  const s = lookDir === "right" ? 1 : -1;
  return { origin: [cut.x1, 0, cut.z1], right: [s * d[0], 0, s * d[1]], up: [0, 1, 0], fwd: [s * d[1], 0, -s * d[0]] };
}

export function toView(f: ViewFrame, p: V3): V3 {
  const r = sub(p, f.origin);
  return [dot(r, f.right), dot(r, f.up), dot(r, f.fwd)];
}

export interface LineStyles { outline: StrokeStyle; crease: StrokeStyle; cutLine: StrokeStyle; datum: StrokeStyle }
export const DEFAULT_STYLES: LineStyles = {
  outline: { color: "#111827", widthPt: 0.25, dash: null },
  crease: { color: "#374151", widthPt: 0.15, dash: null },
  cutLine: { color: "#111827", widthPt: 0.5, dash: null },
  datum: { color: "#2563eb", widthPt: 0.12, dash: [3, 1, 0.6, 1] },
};

/* ------------------------------------------------------------- projection */

interface Tri { v: [V3, V3, V3]; n: V3; ids: [number, number, number] }

const q = (x: number) => Math.round(x * 1e5);
const vkey = (p: V3) => `${q(p[0])},${q(p[1])},${q(p[2])}`;

function trianglesOf(positions: number[]): { tris: Tri[]; verts: V3[] } {
  const ids = new Map<string, number>();
  const verts: V3[] = [];
  const idOf = (p: V3) => { const k = vkey(p); let i = ids.get(k); if (i === undefined) { i = verts.length; verts.push(p); ids.set(k, i); } return i; };
  const tris: Tri[] = [];
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const a: V3 = [positions[i], positions[i + 1], positions[i + 2]], b: V3 = [positions[i + 3], positions[i + 4], positions[i + 5]], c: V3 = [positions[i + 6], positions[i + 7], positions[i + 8]];
    const n = cross(sub(b, a), sub(c, a));
    const l = len(n);
    if (l < 1e-12) continue;
    tris.push({ v: [a, b, c], n: [n[0] / l, n[1] / l, n[2] / l], ids: [idOf(a), idOf(b), idOf(c)] });
  }
  return { tris, verts };
}

/** Connected components of triangles that share an edge. */
function components(tris: Tri[]): number[][] {
  const parent = tris.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const edgeOwner = new Map<string, number>();
  tris.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const a = t.ids[k], b = t.ids[(k + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const o = edgeOwner.get(key);
      if (o === undefined) edgeOwner.set(key, i); else parent[find(i)] = find(o);
    }
  });
  const groups = new Map<number, number[]>();
  tris.forEach((_, i) => { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(i); });
  return [...groups.values()];
}

export interface ProjectOptions {
  styles?: LineStyles;
  /** Drop geometry deeper than this (view depth, metres). */
  farClip?: number;
  /** Crease angle in degrees: shared edges between front faces bending more than this are drawn. */
  creaseDeg?: number;
  /** Element-type specific fill (default white). */
  fillFor?: (solidType: string, role: "solid" | "glass") => { color: string; opacity: number };
}

interface Piece { entities: SceneEntity[]; minDepth: number }

/** Project solids into painter-ordered entities (far to near). */
export function projectSolids(solids: Solid[], frame: ViewFrame, opts: ProjectOptions = {}): SceneEntity[] {
  const st = opts.styles ?? DEFAULT_STYLES;
  const crease = Math.cos(((opts.creaseDeg ?? 30) * Math.PI) / 180);
  const pieces: Piece[] = [];
  for (const solid of solids) {
    for (const part of solid.parts) {
      const { tris, verts } = trianglesOf(part.positions);
      const vv = verts.map((p) => toView(frame, p));
      for (const comp of components(tris)) {
        const front = comp.filter((i) => dot(tris[i].n, frame.fwd) < -1e-9);
        if (!front.length) continue;
        let minD = Infinity;
        for (const i of front) for (const id of tris[i].ids) minD = Math.min(minD, vv[id][2]);
        if (opts.farClip !== undefined && minD > opts.farClip) continue;
        // directed boundary edges of the front-facing set
        const dir = new Map<string, [number, number]>();
        const edgeTris = new Map<string, number[]>();
        for (const i of front) {
          const t = tris[i];
          for (let k = 0; k < 3; k++) {
            const a = t.ids[k], b = t.ids[(k + 1) % 3];
            dir.set(`${a}>${b}`, [a, b]);
            const key = a < b ? `${a}:${b}` : `${b}:${a}`;
            (edgeTris.get(key) ?? edgeTris.set(key, []).get(key)!).push(i);
          }
        }
        const boundary = [...dir.values()].filter(([a, b]) => !dir.has(`${b}>${a}`));
        const next = new Map<number, number[]>();
        for (const [a, b] of boundary) (next.get(a) ?? next.set(a, []).get(a)!).push(b);
        const used = new Set<string>();
        const entities: SceneEntity[] = [];
        const fill = opts.fillFor?.(solid.type, part.role) ?? (part.role === "glass" ? { color: "#bfdbfe", opacity: 0.35 } : { color: "#ffffff", opacity: 1 });
        for (const [a0, b0] of boundary) {
          if (used.has(`${a0}>${b0}`)) continue;
          const loop: number[] = [a0];
          let a = a0, b = b0, guard = 0;
          while (guard++ < 100000) {
            used.add(`${a}>${b}`);
            if (b === a0) break;
            loop.push(b);
            const cands = (next.get(b) ?? []).filter((c) => !used.has(`${b}>${c}`));
            if (!cands.length) break;
            a = b; b = cands[0];
          }
          if (loop.length < 3) continue;
          const pts: Array<[number, number]> = loop.map((id) => [vv[id][0], vv[id][1]]);
          let area = 0;
          for (let k = 0; k < pts.length; k++) { const p = pts[k], r = pts[(k + 1) % pts.length]; area += p[0] * r[1] - r[0] * p[1]; }
          if (Math.abs(area) < 1e-9) continue;
          entities.push({ kind: "polyline", points: pts, closed: true, stroke: part.role === "glass" ? st.crease : st.outline, fill: area > 0 ? fill : undefined });
        }
        // crease lines between two front faces that bend
        for (const [key, owners] of edgeTris) {
          if (owners.length !== 2) continue;
          if (dot(tris[owners[0]].n, tris[owners[1]].n) > crease) continue;
          const [a, b] = key.split(":").map(Number);
          entities.push({ kind: "line", x1: vv[a][0], z1: vv[a][1], x2: vv[b][0], z2: vv[b][1], stroke: st.crease });
        }
        if (entities.length) pieces.push({ entities, minDepth: minD });
      }
    }
  }
  pieces.sort((a, b) => b.minDepth - a.minDepth);
  return pieces.flatMap((p) => p.entities);
}

/* -------------------------------------------------------------- sectioning */

export interface CutCap { solidId: string; type: string; loop: Array<[number, number]>; area: number }
export interface SectionResult { far: Solid[]; caps: CutCap[] }

/**
 * Clip every solid by the view plane (d = 0, keeping d >= 0) and rebuild the cap loops
 * from the intersection segments. `area` > 0 marks an outer loop, < 0 a hole.
 */
export function cutSolids(solids: Solid[], frame: ViewFrame): SectionResult {
  const far: Solid[] = [];
  const caps: CutCap[] = [];
  const EPS = 1e-9;
  for (const s of solids) {
    const keptParts: Solid["parts"] = [];
    for (const part of s.parts) {
      const kept: number[] = [];
      const segs: Array<[[number, number], [number, number]]> = [];
      const P = part.positions;
      for (let i = 0; i + 8 < P.length; i += 9) {
        const vs: V3[] = [[P[i], P[i + 1], P[i + 2]], [P[i + 3], P[i + 4], P[i + 5]], [P[i + 6], P[i + 7], P[i + 8]]];
        const d = vs.map((p) => toView(frame, p)[2]);
        if (d.every((x) => x >= -EPS)) { if (d.some((x) => x > EPS)) kept.push(...P.slice(i, i + 9)); continue; }
        if (d.every((x) => x <= EPS)) continue;
        const poly: V3[] = [];
        let exit: V3 | null = null, entry: V3 | null = null;
        for (let k = 0; k < 3; k++) {
          const a = vs[k], b = vs[(k + 1) % 3], da = d[k], db = d[(k + 1) % 3];
          const inA = da >= 0, inB = db >= 0;
          const X = (): V3 => { const t = da / (da - db); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
          if (inA && inB) poly.push(b);
          else if (inA && !inB) { exit = X(); poly.push(exit); }
          else if (!inA && inB) { entry = X(); poly.push(entry, b); }
        }
        for (let k = 1; k + 1 < poly.length; k++) kept.push(...poly[0], ...poly[k], ...poly[k + 1]);
        if (exit && entry) {
          const e = toView(frame, entry), x = toView(frame, exit);
          segs.push([[e[0], e[1]], [x[0], x[1]]]); // cap edge runs entry -> exit (reverse of the mesh edge)
        }
      }
      if (kept.length) keptParts.push({ positions: kept, role: part.role });
      // chain segments into loops
      const key = (p: [number, number]) => `${q(p[0])},${q(p[1])}`;
      const byStart = new Map<string, number[]>();
      segs.forEach((sg, i) => (byStart.get(key(sg[0])) ?? byStart.set(key(sg[0]), []).get(key(sg[0]))!).push(i));
      const used = new Array(segs.length).fill(false);
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        const loop: Array<[number, number]> = [segs[i][0]];
        let cur = i, closed = false, guard = 0;
        while (guard++ < 100000) {
          used[cur] = true;
          const end = segs[cur][1];
          if (key(end) === key(segs[i][0])) { closed = true; break; }
          loop.push(end);
          const nx = (byStart.get(key(end)) ?? []).find((j) => !used[j]);
          if (nx === undefined) break;
          cur = nx;
        }
        if (!closed || loop.length < 3) continue;
        let area = 0;
        for (let k = 0; k < loop.length; k++) { const a = loop[k], b = loop[(k + 1) % loop.length]; area += a[0] * b[1] - b[0] * a[1]; }
        area /= 2;
        if (Math.abs(area) > 1e-9 && part.role === "solid") caps.push({ solidId: s.id, type: s.type, loop, area });
      }
    }
    if (keptParts.length) far.push({ id: s.id, type: s.type, parts: keptParts });
  }
  return { far, caps };
}

/** Poche entities for the cut caps: outer loops filled, holes punched, all outlined heavy. */
export function capEntities(caps: CutCap[], pocheFor: (type: string) => string, style: StrokeStyle = DEFAULT_STYLES.cutLine): SceneEntity[] {
  const out: SceneEntity[] = [];
  for (const c of caps.filter((x) => x.area > 0)) out.push({ kind: "polyline", points: c.loop, closed: true, stroke: style, fill: { color: pocheFor(c.type), opacity: 1 } });
  for (const c of caps.filter((x) => x.area < 0)) out.push({ kind: "polyline", points: c.loop, closed: true, stroke: style, fill: { color: "#ffffff", opacity: 1 } });
  return out;
}

/* ----------------------------------------------------------------- helpers */

export function entitiesBounds(es: SceneEntity[]): { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const add = (x: number, z: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
  for (const e of es) {
    if (e.kind === "line") { add(e.x1, e.z1); add(e.x2, e.z2); }
    else if (e.kind === "polyline") for (const [x, z] of e.points) add(x, z);
    else if (e.kind === "circle") { add(e.cx - e.r, e.cz - e.r); add(e.cx + e.r, e.cz + e.r); }
    else if (e.kind === "arc") { add(e.cx - e.r, e.cz - e.r); add(e.cx + e.r, e.cz + e.r); }
  }
  return Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : null;
}

/** Dashed level datums with labels, spanning the drawing. */
export function datumEntities(levels: Array<{ name: string; elevation: number }>, minX: number, maxX: number, style: StrokeStyle = DEFAULT_STYLES.datum, textSizePt = 3): SceneEntity[] {
  const out: SceneEntity[] = [];
  for (const l of levels) {
    out.push({ kind: "line", x1: minX, z1: l.elevation, x2: maxX, z2: l.elevation, stroke: style });
    out.push({ kind: "text", x: minX, z: l.elevation + 0.05, text: `${l.name}  ${l.elevation >= 0 ? "+" : "-"}${Math.abs(l.elevation).toFixed(2)}`, anchor: "start", sizePt: textSizePt, rotation: 0, color: "#1d4ed8" });
  }
  return out;
}
