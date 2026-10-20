/**
 * Milestone 2 - geometry of the "real" authored element types that the app
 * had no mesh for: stairs, railings, curtain walls, ramps, roofs, ceilings.
 *
 * Pure TypeScript (no three.js, no DOM). Every generator returns closed,
 * outward-wound triangle soups in three.js coordinates (x, y up, z). The same
 * output feeds the viewport mesh builder, the IFC exporter (tessellation) and
 * the quantity takeoff, so what you see is what is exported and counted.
 *
 * Authored parameter conventions (so move / copy / rotate / grips / undo work
 * with the existing authoring engine):
 *   stairs        start,end = run line of the first flight; width; height = total rise
 *   railing       polygon   = open path (vertices are grips); height = rail height
 *   ramp          start,end; width; height = rise; thickness = slab
 *   curtain-wall  start,end; height; thickness = mullion depth
 *   roof          polygon;   elevation = eaves level; thickness
 *   ceiling       polygon;   elevation = ceiling level; thickness
 * Everything else lives in element.properties (see readParams below).
 */
export type Vec2 = [number, number];
type V3 = [number, number, number];

export interface Part { positions: number[]; color: string; role: "solid" | "glass"; name: string }
export interface GeoResult { parts: Part[]; info: Record<string, number | string | boolean> }

export interface GeoElement {
  type: string;
  params: { start?: Vec2; end?: Vec2; polygon?: Vec2[]; point?: Vec2; width?: number; depth?: number; height: number; thickness: number; elevation: number; [k: string]: unknown };
  properties?: Record<string, unknown>;
  color?: string;
}

/* ----------------------------------------------------------------- soup */

export class Soup {
  p: number[] = [];
  tri(a: V3, b: V3, c: V3): void { this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
  quad(a: V3, b: V3, c: V3, d: V3): void { this.tri(a, b, c); this.tri(a, c, d); }
}
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a: V3): V3 => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const area2 = (p: Vec2[]): number => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

/** Signed volume of a closed triangle soup (positive when wound outward). */
export function signedVolume(pos: number[]): number {
  let v = 0;
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const a: V3 = [pos[i], pos[i + 1], pos[i + 2]], b: V3 = [pos[i + 3], pos[i + 4], pos[i + 5]], c: V3 = [pos[i + 6], pos[i + 7], pos[i + 8]];
    v += dot3(a, cross3(b, c)) / 6;
  }
  return v;
}

/** Every undirected edge must be shared by exactly two triangles, once per direction. */
export function isWatertight(pos: number[], eps = 1e-5): boolean {
  const key = (v: V3) => `${Math.round(v[0] / eps)},${Math.round(v[1] / eps)},${Math.round(v[2] / eps)}`;
  const count = new Map<string, number>();
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const vs: V3[] = [[pos[i], pos[i + 1], pos[i + 2]], [pos[i + 3], pos[i + 4], pos[i + 5]], [pos[i + 6], pos[i + 7], pos[i + 8]]];
    for (let k = 0; k < 3; k++) {
      const a = key(vs[k]), b = key(vs[(k + 1) % 3]);
      if (a === b) continue;
      count.set(`${a}>${b}`, (count.get(`${a}>${b}`) ?? 0) + 1);
    }
  }
  for (const [k, n] of count) {
    const [a, b] = k.split(">");
    if (n !== 1 || count.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/* ---------------------------------------------------- triangulation (ear clip) */

/** Ear-clip a simple polygon; returns CCW index triples (in the polygon's own axes). */
export function earClip(poly: Vec2[]): Array<[number, number, number]> {
  const n = poly.length;
  if (n < 3) return [];
  const idx = poly.map((_, i) => i);
  if (area2(poly) < 0) idx.reverse();
  const out: Array<[number, number, number]> = [];
  const cr = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p: Vec2, a: Vec2, b: Vec2, c: Vec2) => cr(a, b, p) >= -1e-12 && cr(b, c, p) >= -1e-12 && cr(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i - 1 + idx.length) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (cr(a, b, c) <= 1e-12) continue; // reflex or collinear
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const q = poly[j];
        if ((q[0] === a[0] && q[1] === a[1]) || (q[0] === b[0] && q[1] === b[1]) || (q[0] === c[0] && q[1] === c[1])) continue;
        if (inTri(q, a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) { // degenerate input: drop a vertex so we always terminate
      const i = 0;
      out.push([idx[(i - 1 + idx.length) % idx.length], idx[i], idx[(i + 1) % idx.length]]);
      idx.splice(i, 1);
    }
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out.filter(([a, b, c]) => Math.abs(cr(poly[a], poly[b], poly[c])) > 1e-14);
}

/* -------------------------------------------------------------- primitives */

/** Convex oriented box between two points with a w x h cross-section (winding fixed by centroid test). */
export function orientedBox(a: V3, b: V3, w: number, h: number, soup: Soup, sideHint?: V3): void {
  const axis = norm3(sub3(b, a));
  let side = cross3(axis, [0, 1, 0]);
  if (len3(side) < 1e-6) {
    // vertical member: take the hint (e.g. the wall normal) made perpendicular to the axis, else world X
    const hint = sideHint ?? [1, 0, 0];
    side = sub3(hint, mul3(axis, dot3(hint, axis)));
    if (len3(side) < 1e-6) side = [1, 0, 0];
  }
  side = norm3(side);
  const upv = norm3(cross3(side, axis));
  const corner = (base: V3, sx: number, sy: number): V3 => add3(add3(base, mul3(side, (sx * w) / 2)), mul3(upv, (sy * h) / 2));
  const c: V3[] = [];
  for (const base of [a, b]) for (const sy of [-1, 1]) for (const sx of [-1, 1]) c.push(corner(base, sx, sy));
  // corner index = base*4 + (sy>0)*2 + (sx>0)
  const faces: Array<[number, number, number, number]> = [
    [0, 1, 3, 2], [4, 6, 7, 5], // start / end caps
    [0, 4, 5, 1], [2, 3, 7, 6], // -sy / +sy
    [0, 2, 6, 4], [1, 5, 7, 3], // -sx / +sx
  ];
  const centre = mul3(add3(a, b), 0.5);
  for (const f of faces) {
    const [p, q, r, s] = f.map((i) => c[i]);
    const nrm = cross3(sub3(q, p), sub3(r, p));
    const fc = mul3(add3(add3(p, q), add3(r, s)), 0.25);
    if (dot3(nrm, sub3(fc, centre)) >= 0) soup.quad(p, q, r, s); else soup.quad(s, r, q, p);
  }
}

/** Vertical prism of a plan polygon between y0 and y1 (outward winding for any simple polygon). */
export function prismPlan(poly: Vec2[], y0: number | ((x: number, z: number) => number), y1: number | ((x: number, z: number) => number), soup: Soup): void {
  const pts = area2(poly) < 0 ? poly.slice().reverse() : poly.slice(); // CCW in (x, z) axes
  const f0 = typeof y0 === "function" ? y0 : () => y0;
  const f1 = typeof y1 === "function" ? y1 : () => y1;
  const P = (p: Vec2, f: (x: number, z: number) => number): V3 => [p[0], f(p[0], p[1]), p[1]];
  for (const [a, b, c] of earClip(pts)) {
    soup.tri(P(pts[a], f0), P(pts[b], f0), P(pts[c], f0)); // CCW in (x,z) => normal -Y (bottom)
    soup.tri(P(pts[c], f1), P(pts[b], f1), P(pts[a], f1)); // reversed => normal +Y (top)
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) continue;
    soup.quad(P(b, f0), P(a, f0), P(a, f1), P(b, f1));
  }
}

/**
 * Extrude a (u, h) profile (any simple polygon) along a lateral width.
 * Position = origin + dir*u + up*h + lat*s, s in [-width/2, +width/2].
 */
function extrudeProfile(profile: Vec2[], origin: V3, dir: Vec2, lat: Vec2, width: number, soup: Soup): void {
  const pr = area2(profile) < 0 ? profile.slice().reverse() : profile.slice(); // CCW in (u, h)
  const eu: V3 = [dir[0], 0, dir[1]], eh: V3 = [0, 1, 0], es: V3 = [lat[0], 0, lat[1]];
  const rightHanded = dot3(cross3(eu, eh), es) > 0;
  const at = (q: Vec2, s: number): V3 => [origin[0] + dir[0] * q[0] + lat[0] * s, origin[1] + q[1], origin[2] + dir[1] * q[0] + lat[1] * s];
  const emit = (a: V3, b: V3, c: V3) => (rightHanded ? soup.tri(a, b, c) : soup.tri(a, c, b));
  const hw = width / 2;
  for (const [a, b, c] of earClip(pr)) {
    emit(at(pr[a], hw), at(pr[b], hw), at(pr[c], hw));      // +s cap
    emit(at(pr[c], -hw), at(pr[b], -hw), at(pr[a], -hw));   // -s cap
  }
  for (let i = 0; i < pr.length; i++) {
    const a = pr[i], b = pr[(i + 1) % pr.length];
    emit(at(a, -hw), at(b, -hw), at(b, hw));
    emit(at(a, -hw), at(b, hw), at(a, hw));
  }
}

/* ------------------------------------------------------------------ stairs */

export interface StairParams {
  start: Vec2; end: Vec2; width: number; totalRise: number; elevation: number;
  shape?: "straight" | "L" | "U" | "winder" | "spiral"; turn?: "left" | "right"; maxRiser?: number;
  waist?: number; landingThickness?: number; run2?: number; gap?: number; color?: string;
  /** Spiral only: inner radius (the central column). Default 0.1 m. */
  innerRadius?: number;
  /** Spiral only: number of full 360-degree turns. Default 1. */
  spiralTurns?: number;
}

/**
 * (u, h) profile of one flight: n risers over run length L (n equal treads; the last tread is flush with the
 * landing / upper floor), stepped top, sloped underside leaving `waist` of solid under every inside corner.
 */
export function flightProfile(n: number, L: number, rh: number, waist: number): Vec2[] {
  const td = L / n;
  const top: Vec2[] = [];
  for (let i = 0; i < n; i++) top.push([i * td, i * rh], [i * td, (i + 1) * rh]);
  top.push([L, n * rh]);
  const bottom: Vec2[] = [[0, 0]];
  const u0 = waist > 1e-6 ? (waist * td) / rh : 0;
  if (waist > 1e-6 && u0 < L * 0.9) bottom.push([u0, 0], [L, n * rh - waist]);
  else bottom.push([L, 0]);
  const rev = top.slice().reverse(); // starts at (L, n*rh), ends at (0, 0)
  rev.pop();                          // (0, 0) is already the first bottom point
  return [...bottom, ...rev];
}

export interface StairFlight { n: number; run: number; start: Vec2; dir: Vec2; /** height of the flight's floor above the stair base */ h0: number }
export interface StairLayout {
  n: number; riserHeight: number; width: number; flights: StairFlight[];
  /** landing slabs: plan polygon + top height above the stair base */
  landings: Array<{ poly: Vec2[]; top: number }>;
  info: GeoResult["info"];
}

/** Plan layout of a stair (flights, landings, riser count). Shared by the 3D generator and the plan symbol. */
export function stairLayout(p: StairParams): StairLayout {
  const dx = p.end[0] - p.start[0], dz = p.end[1] - p.start[1];
  const L1 = Math.hypot(dx, dz);
  if (L1 < 0.3) throw new Error("stair run is shorter than 0.3 m");
  if (!(p.width > 0.1)) throw new Error("stair width must be > 0.1 m");
  if (!(p.totalRise > 0.05)) throw new Error("stair rise must be > 0.05 m");
  const dir: Vec2 = [dx / L1, dz / L1];
  const leftPerp: Vec2 = [dir[1], -dir[0]];
  const rightPerp: Vec2 = [-dir[1], dir[0]];
  const shape = p.shape ?? "straight";
  const w = p.width;
  const maxRiser = p.maxRiser ?? 0.175;
  const info: GeoResult["info"] = {};
  const n = Math.max(shape === "straight" ? 2 : 4, Math.ceil(p.totalRise / maxRiser - 1e-9));
  const rh = p.totalRise / n;
  const flights: StairFlight[] = [];
  const landings: StairLayout["landings"] = [];
  if (shape === "straight") {
    flights.push({ n, run: L1, start: p.start, dir, h0: 0 });
    info.flights = 1; info.treadDepth = L1 / n;
  } else {
    const n1 = Math.floor(n / 2), n2 = n - n1;
    const L2 = Math.max(0.3, p.run2 ?? L1);
    const h1 = n1 * rh;
    const turnDir = (p.turn ?? "left") === "left" ? leftPerp : rightPerp;
    const at = (u: number, s: number, latDir: Vec2): Vec2 => [p.start[0] + dir[0] * u + latDir[0] * s, p.start[1] + dir[1] * u + latDir[1] * s];
    flights.push({ n: n1, run: L1, start: p.start, dir, h0: 0 });
    if (shape === "L") {
      landings.push({ poly: [at(L1, -w / 2, leftPerp), at(L1 + w, -w / 2, leftPerp), at(L1 + w, w / 2, leftPerp), at(L1, w / 2, leftPerp)], top: h1 });
      const c = at(L1 + w / 2, 0, leftPerp);
      flights.push({ n: n2, run: L2, start: [c[0] + turnDir[0] * (w / 2), c[1] + turnDir[1] * (w / 2)], dir: turnDir, h0: h1 });
    } else {
      const gap = p.gap ?? 0.1;
      const a0 = -w / 2, a1 = a0 + w + gap + w; // lateral range measured along turnDir
      landings.push({ poly: [at(L1, a0, turnDir), at(L1 + w, a0, turnDir), at(L1 + w, a1, turnDir), at(L1, a1, turnDir)], top: h1 });
      const off = w + gap;
      flights.push({ n: n2, run: L2, start: [p.start[0] + dir[0] * L1 + turnDir[0] * off, p.start[1] + dir[1] * L1 + turnDir[1] * off], dir: [-dir[0], -dir[1]], h0: h1 });
    }
    info.flights = 2; info.treadDepth = L1 / n1; info.treadDepth2 = L2 / n2; info.landingHeight = h1 + p.elevation;
  }
  info.risers = n; info.riserHeight = rh; info.totalRise = p.totalRise;
  info.pitchDeg = (Math.atan2(rh, info.treadDepth as number) * 180) / Math.PI;
  info.compliant = rh <= 0.19 + 1e-9 && (info.treadDepth as number) >= 0.25 - 1e-9;
  return { n, riserHeight: rh, width: w, flights, landings, info };
}

/**
 * Winder stair: an L-shaped stair where the corner is filled with
 * tapered treads (winders) instead of a flat landing. Each winder is
 * wider at the outer edge and narrower at the inner pivot, allowing
 * the stair to turn 90 degrees while continuing to rise.
 *
 * Layout: first flight goes straight for `L1` metres, then a series
 * of (default 3) winders fill the corner, then a second flight
 * continues for `L2` metres in the turn direction.
 *
 * The winders are generated as triangular wedges that fan out from
 * the inner pivot point. Each winder's top is a horizontal slice at
 * its riser height; the bottom is the previous winder's top. This
 * produces a watertight solid.
 *
 * Compliance: building codes typically require winder treads to be
 * at least 250 mm deep at the narrow end (measured 270 mm from the
 * inner pivot). The geometry here does NOT enforce this — the user
 * must size the stair appropriately. A future PR could add a
 * compliance check to the info block.
 */
export function buildWinderStair(p: StairParams): GeoResult {
  const dx = p.end[0] - p.start[0], dz = p.end[1] - p.start[1];
  const L1 = Math.hypot(dx, dz);
  if (L1 < 0.3) throw new Error("winder stair run is shorter than 0.3 m");
  if (!(p.width > 0.1)) throw new Error("stair width must be > 0.1 m");
  if (!(p.totalRise > 0.05)) throw new Error("stair rise must be > 0.05 m");

  const dir: Vec2 = [dx / L1, dz / L1];
  const leftPerp: Vec2 = [dir[1], -dir[0]];
  const rightPerp: Vec2 = [-dir[1], dir[0]];
  const turnDir = (p.turn ?? "left") === "left" ? leftPerp : rightPerp;
  const w = p.width;
  const maxRiser = p.maxRiser ?? 0.175;
  const n = Math.max(6, Math.ceil(p.totalRise / maxRiser - 1e-9));
  const rh = p.totalRise / n;
  const waist = Math.max(0, p.waist ?? 0.12);

  // Split risers: 40% first flight, 20% winders, 40% second flight.
  const n1 = Math.max(2, Math.floor(n * 0.4));
  const nWinders = Math.max(3, Math.floor(n * 0.2));
  const n2 = Math.max(2, n - n1 - nWinders);

  const L2 = Math.max(0.3, p.run2 ?? L1);
  const soup = new Soup();

  // Helper: extrude a flight profile (same as buildStair).
  const at = (u: number, s: number, latDir: Vec2): Vec2 => [
    p.start[0] + dir[0] * u + latDir[0] * s,
    p.start[1] + dir[1] * u + latDir[1] * s,
  ];

  // Flight 1: straight from start along dir for L1 metres, n1 risers.
  extrudeProfile(
    flightProfile(n1, L1, rh, waist),
    [p.start[0], p.elevation, p.start[1]],
    dir, [dir[1], -dir[0]], w, soup,
  );

  // Winders: triangular wedges fanning out from the inner pivot.
  // The pivot is at the inner corner: (L1, ±w/2) depending on turn direction.
  // sign: +1 for left turn (pivot on left), -1 for right turn.
  const sign = (p.turn ?? "left") === "left" ? 1 : -1;
  const pivot: Vec2 = [p.start[0] + dir[0] * L1 + turnDir[0] * (sign * w / 2),
                       p.start[1] + dir[1] * L1 + turnDir[1] * (sign * w / 2)];
  // Outer corner: opposite the pivot.
  const outer: Vec2 = [p.start[0] + dir[0] * L1 - turnDir[0] * (sign * w / 2),
                       p.start[1] + dir[1] * L1 - turnDir[1] * (sign * w / 2)];

  // The winders span 90 degrees of arc, divided into nWinders slices.
  // Each winder goes from angle a0 to a1 (measured from the pivot).
  // Angle 0 = along the first flight direction (back toward start);
  // Angle 90 = along the second flight direction (forward in turnDir).
  // Each winder's top is at h0 + i * rh; bottom is h0 + (i-1) * rh.
  const h0 = n1 * rh;
  for (let i = 0; i < nWinders; i++) {
    const a0 = (i / nWinders) * (Math.PI / 2);
    const a1 = ((i + 1) / nWinders) * (Math.PI / 2);
    const yTop = p.elevation + h0 + (i + 1) * rh;
    const yBot = p.elevation + h0 + i * rh;

    // The winder polygon has 4 corners: inner-at-a0, outer-at-a0, outer-at-a1, inner-at-a1.
    // Inner radius = 0 (at pivot); outer radius = distance from pivot to outer corner.
    // Actually, for a proper winder, the inner edge has a small radius (the "waist").
    const innerR = 0.02; // 20 mm inner radius to avoid degenerate triangles
    const outerR = Math.hypot(outer[0] - pivot[0], outer[1] - pivot[1]);

    // Compute the 4 corners in world (x, z) plan.
    // Direction from pivot to outer corner:
    const toOuter: Vec2 = [
      (outer[0] - pivot[0]) / (outerR || 1),
      (outer[1] - pivot[1]) / (outerR || 1),
    ];
    // Perpendicular to toOuter (rotate 90 deg in the turn direction):
    const perp: Vec2 = sign > 0 ? [-toOuter[1], toOuter[0]] : [toOuter[1], -toOuter[0]];

    // a0 direction: rotate toOuter by -a0 (toward first flight).
    // a1 direction: rotate toOuter by -a1 (toward second flight).
    const cos0 = Math.cos(-a0 + Math.PI / 2), sin0 = Math.sin(-a0 + Math.PI / 2);
    const cos1 = Math.cos(-a1 + Math.PI / 2), sin1 = Math.sin(-a1 + Math.PI / 2);

    // Rotate toOuter by angle around pivot.
    const dir0: Vec2 = [
      toOuter[0] * cos0 - toOuter[1] * sin0,
      toOuter[0] * sin0 + toOuter[1] * cos0,
    ];
    const dir1: Vec2 = [
      toOuter[0] * cos1 - toOuter[1] * sin1,
      toOuter[0] * sin1 + toOuter[1] * cos1,
    ];

    const inner0: Vec2 = [pivot[0] + dir0[0] * innerR, pivot[1] + dir0[1] * innerR];
    const outer0: Vec2 = [pivot[0] + dir0[0] * outerR, pivot[1] + dir0[1] * outerR];
    const inner1: Vec2 = [pivot[0] + dir1[0] * innerR, pivot[1] + dir1[1] * innerR];
    const outer1: Vec2 = [pivot[0] + dir1[0] * outerR, pivot[1] + dir1[1] * outerR];

    // Build the winder as a prism: 4 corners at top + 4 at bottom.
    const poly: Vec2[] = [inner0, outer0, outer1, inner1];
    prismPlan(poly, yBot, yTop, soup);
  }

  // Flight 2: straight from the end of the winders along turnDir for L2 metres, n2 risers.
  const flight2Start: Vec2 = [
    pivot[0] + turnDir[0] * (w / 2 + L2 * 0) + dir[0] * 0,
    pivot[1] + turnDir[1] * (w / 2 + L2 * 0) + dir[1] * 0,
  ];
  // Actually, the second flight starts at the outer corner of the winder
  // and continues in the turnDir direction.
  const flight2Origin: Vec2 = outer;
  const h2 = h0 + nWinders * rh;
  extrudeProfile(
    flightProfile(n2, L2, rh, waist),
    [flight2Origin[0], p.elevation + h2, flight2Origin[1]],
    turnDir, [turnDir[1], -turnDir[0]], w, soup,
  );

  return {
    parts: [{ positions: soup.p, color: p.color ?? "#b8b2a7", role: "solid", name: "Winder Stair" }],
    info: {
      risers: n, riserHeight: rh, totalRise: p.totalRise,
      flights: 2, winderCount: nWinders,
      treadDepth: L1 / n1, treadDepth2: L2 / n2,
      pitchDeg: (Math.atan2(rh, L1 / n1) * 180) / Math.PI,
      compliant: rh <= 0.19 + 1e-9 && (L1 / n1) >= 0.25 - 1e-9,
      stairShape: "winder",
    },
  };
}

/**
 * Spiral stair: a helical stair that wraps around a central column.
 * The treads fan out from the inner radius to the outer radius,
 * each at a progressively higher elevation. No landings needed —
 * the stair turns continuously.
 *
 * Layout: the stair center is at `p.start`. The total rise is
 * distributed over `spiralTurns` full 360-degree rotations. Each
 * tread spans an angular slice (360 / n degrees) and rises by
 * `totalRise / n` metres.
 *
 * The geometry is a series of wedge prisms, each from angle a0 to a1
 * and from inner radius to outer radius, with top at h0+i*rh and
 * bottom at h0+(i-1)*rh.
 *
 * Compliance: spiral stairs are generally not permitted as primary
 * egress in residential codes but are common for secondary access
 * (attics, lofts). Minimum tread depth at 270 mm from the inner
 * pivot should be >= 190 mm (UK) or >= 7.5 in (US). Not enforced here.
 */
export function buildSpiralStair(p: StairParams): GeoResult {
  if (!(p.width > 0.1)) throw new Error("spiral stair width must be > 0.1 m");
  if (!(p.totalRise > 0.05)) throw new Error("stair rise must be > 0.05 m");

  const innerR = Math.max(0.05, p.innerRadius ?? 0.1);
  const outerR = innerR + p.width;
  const turns = Math.max(0.5, p.spiralTurns ?? 1);
  const maxRiser = p.maxRiser ?? 0.2; // spirals allow slightly taller risers
  const totalAngle = turns * Math.PI * 2;
  // Number of treads: total rise / max riser, at least 6.
  const n = Math.max(6, Math.ceil(p.totalRise / maxRiser - 1e-9));
  const rh = p.totalRise / n;
  const center: Vec2 = p.start;
  const soup = new Soup();

  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * totalAngle;
    const a1 = ((i + 1) / n) * totalAngle;
    const yTop = p.elevation + (i + 1) * rh;
    const yBot = p.elevation + i * rh;

    // 4 corners of the wedge: inner-a0, outer-a0, outer-a1, inner-a1.
    const inner0: Vec2 = [center[0] + innerR * Math.cos(a0), center[1] + innerR * Math.sin(a0)];
    const outer0: Vec2 = [center[0] + outerR * Math.cos(a0), center[1] + outerR * Math.sin(a0)];
    const outer1: Vec2 = [center[0] + outerR * Math.cos(a1), center[1] + outerR * Math.sin(a1)];
    const inner1: Vec2 = [center[0] + innerR * Math.cos(a1), center[1] + innerR * Math.sin(a1)];

    const poly: Vec2[] = [inner0, outer0, outer1, inner1];
    prismPlan(poly, yBot, yTop, soup);
  }

  // Central column: a thin cylinder from elevation to totalRise.
  const colH = p.totalRise;
  const colSegs = 12;
  for (let i = 0; i < colSegs; i++) {
    const a0 = (i / colSegs) * Math.PI * 2;
    const a1 = ((i + 1) / colSegs) * Math.PI * 2;
    const r = innerR * 0.5; // column is half the inner radius
    // Quad from (cos a0, sin a0) to (cos a1, sin a1) at top and bottom.
    const x0 = center[0] + r * Math.cos(a0);
    const z0 = center[1] + r * Math.sin(a0);
    const x1 = center[0] + r * Math.cos(a1);
    const z1 = center[1] + r * Math.sin(a1);
    soup.quad(
      [x0, p.elevation, z0],
      [x1, p.elevation, z1],
      [x1, p.elevation + colH, z1],
      [x0, p.elevation + colH, z0],
    );
  }

  return {
    parts: [{ positions: soup.p, color: p.color ?? "#b8b2a7", role: "solid", name: "Spiral Stair" }],
    info: {
      risers: n, riserHeight: rh, totalRise: p.totalRise,
      innerRadius: innerR, outerRadius: outerR,
      turns, totalAngleDeg: (totalAngle * 180) / Math.PI,
      treadAngle: ((totalAngle / n) * 180) / Math.PI,
      pitchDeg: (Math.atan2(rh, (outerR - innerR)) * 180) / Math.PI,
      compliant: rh <= 0.22 + 1e-9, // spirals allow up to 220 mm risers
      stairShape: "spiral",
    },
  };
}

export function buildStair(p: StairParams): GeoResult {
  const shape = p.shape ?? "straight";
  if (shape === "winder") return buildWinderStair(p);
  if (shape === "spiral") return buildSpiralStair(p);
  const lay = stairLayout(p);
  const waist = Math.max(0, p.waist ?? 0.12);
  const lt = Math.max(0.05, p.landingThickness ?? 0.15);
  const soup = new Soup();
  for (const f of lay.flights) {
    extrudeProfile(flightProfile(f.n, f.run, lay.riserHeight, waist), [f.start[0], p.elevation + f.h0, f.start[1]], f.dir, [f.dir[1], -f.dir[0]], lay.width, soup);
  }
  for (const l of lay.landings) prismPlan(l.poly, p.elevation + l.top - lt, p.elevation + l.top, soup);
  return { parts: [{ positions: soup.p, color: p.color ?? "#b8b2a7", role: "solid", name: "Stair" }], info: lay.info };
}

/* ---------------------------------------------------------------- railings */

export interface RailingParams {
  path: Vec2[]; elevation: number; height?: number; rise?: number; postSpacing?: number; balusterSpacing?: number;
  railSize?: number; postSize?: number; balusters?: boolean; bottomRail?: boolean; color?: string;
}

export function buildRailing(p: RailingParams): GeoResult {
  if (p.path.length < 2) throw new Error("railing needs at least 2 path points");
  const H = p.height ?? 1.0, rise = p.rise ?? 0, rs = p.railSize ?? 0.05, ps = p.postSize ?? 0.05;
  const maxPost = Math.max(0.3, p.postSpacing ?? 1.2), bs = Math.max(0.04, p.balusterSpacing ?? 0.12);
  const seg = [] as Array<{ a: Vec2; b: Vec2; len: number; s0: number }>;
  let total = 0;
  for (let i = 0; i + 1 < p.path.length; i++) {
    const len = Math.hypot(p.path[i + 1][0] - p.path[i][0], p.path[i + 1][1] - p.path[i][1]);
    if (len < 1e-6) continue;
    seg.push({ a: p.path[i], b: p.path[i + 1], len, s0: total });
    total += len;
  }
  if (!seg.length) throw new Error("railing path has zero length");
  const yAt = (s: number) => p.elevation + (total > 0 ? rise * (s / total) : 0);
  const pt = (sg: (typeof seg)[number], t: number, dy: number): V3 => {
    const s = sg.s0 + sg.len * t;
    return [sg.a[0] + (sg.b[0] - sg.a[0]) * t, yAt(s) + dy, sg.a[1] + (sg.b[1] - sg.a[1]) * t];
  };
  const soup = new Soup();
  let posts = 0, bal = 0;
  const post = (v: V3) => { orientedBox(v, [v[0], v[1] + H, v[2]], ps, ps, soup); posts++; };
  for (const sg of seg) {
    orientedBox(pt(sg, 0, H), pt(sg, 1, H), rs * 1.2, rs, soup);                  // top rail
    if (p.bottomRail !== false) orientedBox(pt(sg, 0, 0.12 + rs / 2), pt(sg, 1, 0.12 + rs / 2), rs * 0.8, rs * 0.8, soup);
    const nPosts = Math.max(1, Math.ceil(sg.len / maxPost));
    for (let k = 0; k < nPosts; k++) post(pt(sg, k / nPosts, 0));
    if (p.balusters !== false) {
      const nb = Math.floor(sg.len / bs);
      for (let k = 1; k < nb; k++) {
        const t = k / nb;
        if ((t * nPosts) % 1 < 1e-6 || Math.abs((t * nPosts) % 1 - 1) < 1e-6) continue; // do not overlap a post
        const v = pt(sg, t, 0.12 + rs);
        orientedBox(v, [v[0], v[1] + H - 0.12 - rs, v[2]], 0.012, 0.012, soup);
        bal++;
      }
    }
  }
  post(pt(seg[seg.length - 1], 1, 0));
  return { parts: [{ positions: soup.p, color: p.color ?? "#6b7280", role: "solid", name: "Railing" }], info: { length: total, posts, balusters: bal } };
}

/* ------------------------------------------------------------ curtain walls */

export interface CurtainParams {
  start: Vec2; end: Vec2; elevation: number; height: number; uSpacing?: number; vSpacing?: number;
  mullionWidth?: number; mullionDepth?: number; panelThickness?: number; color?: string;
}

export function buildCurtainWall(p: CurtainParams): GeoResult {
  const dx = p.end[0] - p.start[0], dz = p.end[1] - p.start[1];
  const L = Math.hypot(dx, dz);
  if (L < 0.3) throw new Error("curtain wall is shorter than 0.3 m");
  if (!(p.height > 0.3)) throw new Error("curtain wall height must be > 0.3 m");
  const dir: Vec2 = [dx / L, dz / L];
  const nu = Math.max(1, Math.round(L / Math.max(0.3, p.uSpacing ?? 1.5)));
  const nv = Math.max(1, Math.round(p.height / Math.max(0.3, p.vSpacing ?? 1.2)));
  const mw = p.mullionWidth ?? 0.05, md = p.mullionDepth ?? 0.1, pt = p.panelThickness ?? 0.024;
  const frame = new Soup(), glass = new Soup();
  const P = (u: number, y: number): V3 => [p.start[0] + dir[0] * u, p.elevation + y, p.start[1] + dir[1] * u];
  const normal: V3 = [dir[1], 0, -dir[0]]; // horizontal, perpendicular to the wall
  // mullion cross-section: depth (md) across the wall, width (mw) along it
  for (let i = 0; i <= nu; i++) orientedBox(P((L * i) / nu, 0), P((L * i) / nu, p.height), md, mw, frame, normal);  // vertical mullions
  for (let j = 0; j <= nv; j++) {                                                                                    // horizontal mullions
    const y = (p.height * j) / nv;
    const yy = j === 0 ? mw / 2 : j === nv ? p.height - mw / 2 : y;
    orientedBox(P(0, yy), P(L, yy), md, mw, frame, normal);
  }
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const u0 = (L * i) / nu + mw / 2, u1 = (L * (i + 1)) / nu - mw / 2;
      const y0 = (p.height * j) / nv + mw / 2, y1 = (p.height * (j + 1)) / nv - mw / 2;
      if (u1 - u0 < 0.02 || y1 - y0 < 0.02) continue;
      const cy = (y0 + y1) / 2;
      // thin pane: axis along the wall; cross-section = thickness (across the wall) x pane height (up)
      orientedBox(P(u0, cy), P(u1, cy), pt, y1 - y0, glass, normal);
    }
  }
  return {
    parts: [
      { positions: frame.p, color: p.color ?? "#374151", role: "solid", name: "Mullions" },
      { positions: glass.p, color: "#7dd3fc", role: "glass", name: "Glazing" },
    ],
    info: { columns: nu, rows: nv, panels: nu * nv, length: L },
  };
}

/* -------------------------------------------------------------------- ramps */

export interface RampParams { start: Vec2; end: Vec2; width: number; rise: number; thickness: number; elevation: number; color?: string }
export function buildRamp(p: RampParams): GeoResult {
  const dx = p.end[0] - p.start[0], dz = p.end[1] - p.start[1];
  const L = Math.hypot(dx, dz);
  if (L < 0.3) throw new Error("ramp is shorter than 0.3 m");
  if (!(p.width > 0.2)) throw new Error("ramp width must be > 0.2 m");
  const t = Math.max(0.05, p.thickness);
  const dir: Vec2 = [dx / L, dz / L], lat: Vec2 = [dir[1], -dir[0]];
  const soup = new Soup();
  const prof: Vec2[] = [[0, 0], [L, p.rise], [L, p.rise + t], [0, t]];
  extrudeProfile(prof, [p.start[0], p.elevation, p.start[1]], dir, lat, p.width, soup);
  const slope = L > 0 ? p.rise / L : 0;
  return { parts: [{ positions: soup.p, color: p.color ?? "#a8a29e", role: "solid", name: "Ramp" }], info: { length: L, slopePercent: slope * 100, ratio: slope > 0 ? `1:${(1 / slope).toFixed(1)}` : "flat", compliant: slope <= 1 / 12 + 1e-9 } };
}

/* -------------------------------------------------------------------- roofs */

export interface RoofParams { polygon: Vec2[]; elevation: number; thickness: number; slopeDeg: number; roofType?: "gable" | "shed" | "hip" | "valley"; dirDeg?: number; color?: string }

function clipHalf(poly: Vec2[], f: (p: Vec2) => number): Vec2[] {
  // keep the part where f(p) >= 0 (Sutherland-Hodgman against one half-plane)
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out;
}

/**
 * Signed distance from point q to the line through edge (a -> b).
 * Positive = q is on the left of the edge (interior, for a CCW polygon).
 * Negative = q is on the right (exterior).
 */
function edgeDistance(q: Vec2, a: Vec2, b: Vec2): number {
  // Length of the edge
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  // Perpendicular distance: cross product (b - a) x (q - a) / |b - a|
  // Cross product sign: positive when q is on the left of a -> b
  return ((dx * (q[1] - a[1]) - dz * (q[0] - a[0])) / len);
}

/**
 * Minimum positive distance from q to any edge of the (CCW) polygon.
 * This is the "inward distance" - the perpendicular distance from q to
 * the nearest edge, measured from inside the polygon.
 *
 * Used for hip roofs: the top function at (x, z) is
 *   elevation + slope * minInwardDistance(x, z)
 * so the roof rises uniformly from every edge toward the centre.
 *
 * Returns 0 for points outside the polygon (or on its boundary).
 */
function minInwardDistance(q: Vec2, polygon: Vec2[]): number {
  let minDist = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const d = edgeDistance(q, a, b);
    if (d < minDist) minDist = d;
  }
  return Math.max(0, minDist);
}

/**
 * Build a hip roof - all four (or N) sides slope up from every edge of the
 * footprint polygon to a central ridge. For a rectangular footprint, the
 * ridge is a line segment running along the long axis; for a square or
 * equilateral polygon, the ridge degenerates to a single point (pyramid).
 *
 * Algorithm:
 *   - For each point (x, z) inside the polygon, compute the minimum
 *     perpendicular distance to any polygon edge.
 *   - Top function = elevation + slope * minDist, clamped at the ridge
 *     height (= elevation + slope * halfShortestSide).
 *   - The bottom is flat at elevation - thickness.
 *
 * The resulting surface is a pyramid (square footprint) or a hipped
 * prism (rectangular footprint with a ridge line).
 *
 * Watertightness: prismPlan triangulates the bottom + top using earClip
 * and stitches the sides with quads. The top function is continuous
 * across the polygon, so the resulting soup is closed and outward-wound.
 */
export function buildHipRoof(
  p: RoofParams,
): GeoResult {
  if (p.polygon.length < 3) throw new Error("hip roof needs a footprint polygon");
  const slope = Math.tan((Math.max(1, Math.min(75, p.slopeDeg)) * Math.PI) / 180);
  const t = Math.max(0.03, p.thickness);
  const elevation = p.elevation;

  // Compute the shortest edge (for ridge height) + longest edge (for ridge length).
  // For a rectangle W x L with W < L:
  //   - ridge rise = slope * W/2 (maxRise)
  //   - ridge length = L - W (longestEdge - shortestEdge; 0 for a square)
  let shortestEdge = Infinity;
  let longestEdge = 0;
  for (let i = 0; i < p.polygon.length; i++) {
    const a = p.polygon[i];
    const b = p.polygon[(i + 1) % p.polygon.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < shortestEdge) shortestEdge = len;
    if (len > longestEdge) longestEdge = len;
  }
  const maxRise = slope * (shortestEdge / 2);

  const top = (x: number, z: number): number => {
    const inward = minInwardDistance([x, z], p.polygon);
    const rise = Math.min(inward * slope, maxRise);
    return elevation + rise;
  };

  const soup = new Soup();
  prismPlan(p.polygon, (_x: number, _z: number) => elevation - t, top, soup);

  const ridgeLength = Math.max(0, longestEdge - shortestEdge);

  return {
    parts: [{ positions: soup.p, color: p.color ?? "#9a3412", role: "solid", name: "Hip Roof" }],
    info: {
      ridgeHeight: elevation + maxRise,
      rise: maxRise,
      ridgeLength,
      shortestEdge,
      planArea: Math.abs(area2(p.polygon)),
      surfaceArea: Math.abs(area2(p.polygon)) / Math.cos(Math.atan(slope)),
      roofType: "hip",
    },
  };
}

/**
 * Build a valley roof - intersection of two perpendicular gable roofs.
 * Common at L-shaped or T-shaped plan junctions where two roof sections
 * meet and form a valley (internal gutter line).
 *
 * Algorithm: take the polygon and compute the top function as the maximum
 * of two gable-height functions (each one rises along one of two
 * perpendicular directions). The valley is the set of points where the
 * two functions are equal - that's where the two roof surfaces meet
 * at an internal crease.
 *
 * For simplicity, we use dirDeg as the direction of the first gable, and
 * dirDeg + 90 as the direction of the second. The top function is:
 *   top(x, z) = elevation + min(gable1_rise, gable2_rise)
 * (taking the minimum so the roof surface is the lower of the two at
 * every point - this is how intersecting gable roofs actually drain).
 */
export function buildValleyRoof(
  p: RoofParams,
): GeoResult {
  if (p.polygon.length < 3) throw new Error("valley roof needs a footprint polygon");
  const slope = Math.tan((Math.max(1, Math.min(75, p.slopeDeg)) * Math.PI) / 180);
  const t = Math.max(0.03, p.thickness);
  const elevation = p.elevation;

  // First gable direction
  const a1 = ((p.dirDeg ?? 0) * Math.PI) / 180;
  const s1: Vec2 = [Math.cos(a1), Math.sin(a1)];
  const proj1 = (q: Vec2) => q[0] * s1[0] + q[1] * s1[1];
  const ps1 = p.polygon.map(proj1);
  const min1 = Math.min(...ps1);
  const max1 = Math.max(...ps1);
  const mid1 = (min1 + max1) / 2;
  const half1 = (max1 - min1) / 2;

  // Second gable direction (perpendicular)
  const a2 = a1 + Math.PI / 2;
  const s2: Vec2 = [Math.cos(a2), Math.sin(a2)];
  const proj2 = (q: Vec2) => q[0] * s2[0] + q[1] * s2[1];
  const ps2 = p.polygon.map(proj2);
  const min2 = Math.min(...ps2);
  const max2 = Math.max(...ps2);
  const mid2 = (min2 + max2) / 2;
  const half2 = (max2 - min2) / 2;

  // Top function: minimum of the two gable rises (lower roof wins at each point).
  // This produces the valley line where gable1_rise == gable2_rise.
  const top = (x: number, z: number): number => {
    const d1 = x * s1[0] + z * s1[1];
    const d2 = x * s2[0] + z * s2[1];
    const r1 = slope * (half1 - Math.abs(d1 - mid1));
    const r2 = slope * (half2 - Math.abs(d2 - mid2));
    return elevation + Math.min(r1, r2);
  };

  const soup = new Soup();
  prismPlan(p.polygon, (_x: number, _z: number) => elevation - t, top, soup);

  const rise1 = slope * half1;
  const rise2 = slope * half2;
  const ridgeHeight = elevation + Math.min(rise1, rise2);

  return {
    parts: [{ positions: soup.p, color: p.color ?? "#9a3412", role: "solid", name: "Valley Roof" }],
    info: {
      ridgeHeight,
      rise: Math.min(rise1, rise2),
      rise1,
      rise2,
      gable1HalfWidth: half1,
      gable2HalfWidth: half2,
      planArea: Math.abs(area2(p.polygon)),
      surfaceArea: Math.abs(area2(p.polygon)) / Math.cos(Math.atan(slope)),
      roofType: "valley",
    },
  };
}

export function buildRoof(p: RoofParams): GeoResult {
  if (p.polygon.length < 3) throw new Error("roof needs a footprint polygon");
  const type = p.roofType ?? "gable";
  if (type === "hip") return buildHipRoof(p);
  if (type === "valley") return buildValleyRoof(p);
  const slope = Math.tan((Math.max(1, Math.min(75, p.slopeDeg)) * Math.PI) / 180);
  const t = Math.max(0.03, p.thickness);
  const a = ((p.dirDeg ?? 0) * Math.PI) / 180;
  const s: Vec2 = [Math.cos(a), Math.sin(a)];
  const proj = (q: Vec2) => q[0] * s[0] + q[1] * s[1];
  const ps = p.polygon.map(proj);
  const pmin = Math.min(...ps), pmax = Math.max(...ps), mid = (pmin + pmax) / 2, half = (pmax - pmin) / 2;
  const top = (x: number, z: number): number => {
    const d = x * s[0] + z * s[1];
    return p.elevation + slope * (type === "shed" ? d - pmin : half - Math.abs(d - mid));
  };
  const soup = new Soup();
  const pieces = type === "shed" ? [p.polygon] : [clipHalf(p.polygon, (q) => mid - proj(q)), clipHalf(p.polygon, (q) => proj(q) - mid)];
  for (const piece of pieces) {
    if (piece.length >= 3 && Math.abs(area2(piece)) > 1e-6) prismPlan(piece, (x, z) => top(x, z) - t, top, soup);
  }
  const rise = slope * (type === "shed" ? pmax - pmin : half);
  return { parts: [{ positions: soup.p, color: p.color ?? "#9a3412", role: "solid", name: "Roof" }], info: { ridgeHeight: p.elevation + rise, rise, planArea: Math.abs(area2(p.polygon)), surfaceArea: Math.abs(area2(p.polygon)) / Math.cos(Math.atan(slope)) } };
}

export interface CeilingParams { polygon: Vec2[]; elevation: number; thickness: number; color?: string }
export function buildCeiling(p: CeilingParams): GeoResult {
  if (p.polygon.length < 3) throw new Error("ceiling needs a polygon");
  const t = Math.max(0.005, p.thickness);
  const soup = new Soup();
  prismPlan(p.polygon, p.elevation, p.elevation + t, soup);
  return { parts: [{ positions: soup.p, color: p.color ?? "#e5e7eb", role: "solid", name: "Ceiling" }], info: { area: Math.abs(area2(p.polygon)) } };
}

/* ----------------------------------------------------- authored-element glue */

export const M2_TYPES = ["stairs", "railing", "ramp", "curtain-wall", "roof", "ceiling"] as const;
export type M2Type = (typeof M2_TYPES)[number];
export const isM2Type = (t: string): t is M2Type => (M2_TYPES as readonly string[]).includes(t);

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = <T extends string>(v: unknown, d: T): T => (typeof v === "string" && v ? (v as T) : d);


/** Stair parameters of an authored element (null when the run line is missing). */
export function stairParamsOf(el: GeoElement): StairParams | null {
  const p = el.params, pr = el.properties ?? {};
  if (!p.start || !p.end) return null;
  return {
    start: p.start, end: p.end, width: num(p.width, 1.2), totalRise: num(p.height, 3), elevation: num(p.elevation, 0),
    shape: str(pr.stairShape, "straight"), turn: str(pr.stairTurn, "left"), maxRiser: num(pr.maxRiser, 0.175), waist: num(pr.waist, 0.12),
    landingThickness: num(pr.landingThickness, 0.15), run2: pr.run2 == null ? undefined : num(pr.run2, 0), gap: num(pr.gap, 0.1), color: el.color,
  };
}

/** Geometry for an authored element of an M2 type (null when the type is not M2 or params are incomplete). */

/** Parses a string like "Brick:0.1, Insulation:0.05, Gypsum:0.015" into layer objects */
export function parseWallLayers(layerStr: string, totalThickness: number): Array<{name: string, thickness: number, color: string}> {
  const parts = layerStr.split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length) return [{name: "Core", thickness: totalThickness, color: "#d9d4c7"}];
  
  const colors = ["#d9d4c7", "#a8a29e", "#e5e7eb", "#fcd34d", "#f87171", "#60a5fa"];
  let sum = 0;
  const layers = parts.map((p, i) => {
    const [name, tStr] = p.split(":");
    const t = parseFloat(tStr) || 0;
    sum += t;
    return { name: name || `Layer ${i+1}`, thickness: t, color: colors[i % colors.length] };
  });
  
  if (Math.abs(sum - totalThickness) > 0.01 && sum > 0) {
    const factor = totalThickness / sum;
    layers.forEach(l => l.thickness *= factor);
  }
  return layers;
}

/** Builds a compound wall mesh with multiple side-by-side layers */
export function buildCompoundWall(p: any, layers: Array<{name: string, thickness: number, color: string}>, colorFallback: string): GeoResult | null {
  if (!p.start || !p.end) return null;
  const dx = p.end[0] - p.start[0], dz = p.end[1] - p.start[1];
  const L = Math.hypot(dx, dz);
  if (L < 0.05) return null;
  
  const dir: Vec2 = [dx / L, dz / L];
  const lat: Vec2 = [dir[1], -dir[0]];
  const totalT = num(p.thickness, 0.2);
  const H = num(p.height, 3);
  const E = num(p.elevation, 0);
  
  const parts: Part[] = [];
  let currentOffset = -totalT / 2;
  
  for (const layer of layers) {
    const t = layer.thickness;
    const offsetCenter = currentOffset + t / 2;
    
    const sx = p.start[0] + lat[0] * offsetCenter;
    const sz = p.start[1] + lat[1] * offsetCenter;
    const ex = p.end[0] + lat[0] * offsetCenter;
    const ez = p.end[1] + lat[1] * offsetCenter;
    
    const soup = new Soup();
    const prof: Vec2[] = [[0, 0], [L, 0], [L, H], [0, H]];
    extrudeProfile(prof, [sx, E, sz], dir, lat, t, soup);
    
    parts.push({
      positions: soup.p,
      color: layer.color || colorFallback,
      role: "solid",
      name: layer.name || "Layer"
    });
    currentOffset += t;
  }
  
  return { 
    parts, 
    info: { length: L, height: H, thickness: totalT, isCompound: true, layers: layers.length } 
  };
}
export function buildElementGeo(el: GeoElement): GeoResult | null {
  const p = el.params, pr = el.properties ?? {};
  const color = el.color;
  switch (el.type) {
    case "wall": {
      const layerStr = el.properties?.layers as string | undefined;
      if (layerStr) {
        const totalT = num(p.thickness, 0.2);
        const layers = parseWallLayers(layerStr, totalT);
        return buildCompoundWall(p, layers, color ?? "#d9d4c7");
      }
      return null;
    }
    case "stairs": {
      const sp = stairParamsOf(el);
      return sp ? buildStair(sp) : null;
    }
    case "railing": {
      const path = p.polygon ?? (p.start && p.end ? [p.start, p.end] : null);
      if (!path || path.length < 2) return null;
      return buildRailing({
        path, elevation: num(p.elevation, 0), height: num(p.height, 1), rise: num(pr.rise, 0), postSpacing: num(pr.postSpacing, 1.2),
        balusterSpacing: num(pr.balusterSpacing, 0.12), railSize: num(p.thickness, 0.05), balusters: pr.balusters !== false, color,
      });
    }
    case "ramp":
      if (!p.start || !p.end) return null;
      return buildRamp({ start: p.start, end: p.end, width: num(p.width, 1.5), rise: num(p.height, 0.6), thickness: num(p.thickness, 0.2), elevation: num(p.elevation, 0), color });
    case "curtain-wall":
      if (!p.start || !p.end) return null;
      return buildCurtainWall({
        start: p.start, end: p.end, elevation: num(p.elevation, 0), height: num(p.height, 3.6), uSpacing: num(pr.uSpacing, 1.5), vSpacing: num(pr.vSpacing, 1.2),
        mullionWidth: num(pr.mullionWidth, 0.05), mullionDepth: num(p.thickness, 0.1), color,
      });
    case "roof":
      if (!p.polygon || p.polygon.length < 3) return null;
      return buildRoof({ polygon: p.polygon, elevation: num(p.elevation, 3), thickness: num(p.thickness, 0.2), slopeDeg: num(pr.slope, 30), roofType: str(pr.roofType, "gable"), dirDeg: num(pr.slopeDirection, 0), color });
    case "ceiling":
      if (!p.polygon || p.polygon.length < 3) return null;
      return buildCeiling({ polygon: p.polygon, elevation: num(p.elevation, 2.7), thickness: num(p.thickness, 0.02), color });
    default:
      return null;
  }
}

export interface M2Quantities { length: number; area: number; volume: number; detail: string }

/** Takeoff quantities for the cost / schedule modules (volume = real mesh volume of the solid parts). */
export function m2Quantities(el: GeoElement): M2Quantities | null {
  let g: GeoResult | null;
  try { g = buildElementGeo(el); } catch { return null; }
  if (!g) return null;
  const solid = g.parts.filter((x) => x.role === "solid").reduce((s, x) => s + signedVolume(x.positions), 0);
  const p = el.params;
  const L = p.start && p.end ? Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]) : 0;
  switch (el.type) {
    case "stairs": return { length: L, area: L * num(p.width, 1.2), volume: solid, detail: `${g.info.risers} risers x ${(num(g.info.riserHeight as number, 0) * 1000).toFixed(0)} mm` };
    case "railing": return { length: num(g.info.length as number, 0), area: 0, volume: solid, detail: `${g.info.posts} posts, ${g.info.balusters} balusters` };
    case "ramp": return { length: L, area: L * num(p.width, 1.5), volume: solid, detail: `slope ${(g.info.slopePercent as number).toFixed(1)} %` };
    case "curtain-wall": return { length: L, area: L * num(p.height, 3.6), volume: solid, detail: `${g.info.panels} panels` };
    case "roof": return { length: 0, area: num(g.info.surfaceArea as number, 0), volume: solid, detail: `slope ${num(el.properties?.slope, 30)} deg` };
    case "ceiling": return { length: 0, area: num(g.info.area as number, 0), volume: solid, detail: "ceiling" };
    default: return null;
  }
}
