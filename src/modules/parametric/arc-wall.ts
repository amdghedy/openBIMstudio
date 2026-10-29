/**
 * Curved & Arc Wall Modeling Engine
 *
 * Implements:
 * - Center-radius-angle & 3-point arc wall parametrization
 * - Outer, inner, and center baseline radius calculation with justification
 * - High-speed 3D triangulated prism mesh generation (curved inner/outer faces + caps)
 * - 2D plan curve polyline sampling (chord-error adaptive or fixed segment count)
 * - Tangent vector computation & tangent snapping solver for drafting alignment
 *
 * Pure module: headless, safe for Node.js test environments and browser runtime.
 */

export type WallJustification = "center" | "interior" | "exterior";

export interface ArcWallParams {
  id?: string;
  center: [number, number];       // [cx, cy] in meters
  radius: number;                 // baseline radius in meters (r > 0)
  startAngle: number;             // radians [0..2π)
  endAngle: number;               // radians
  counterClockwise?: boolean;     // default true
  thickness: number;              // meters (e.g. 0.20 for 200mm wall)
  height: number;                 // meters (e.g. 3.0m)
  baseOffset?: number;            // meters (default 0)
  justification?: WallJustification; // default "center"
  segments?: number;              // tessellation segment count (default adaptive)
}

export interface ArcWallGeometry {
  center: [number, number];
  baseRadius: number;
  innerRadius: number;
  outerRadius: number;
  startAngle: number;
  endAngle: number;
  sweepAngle: number;
  thickness: number;
  height: number;
  baseOffset: number;
  justification: WallJustification;
  arcLength: number;
  volume: number;
}

export interface ArcWallMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
}

export interface TangentSnapResult {
  snapPoint: [number, number];
  tangentVector: [number, number]; // Normalized unit tangent
  normalVector: [number, number];  // Normalized radial unit normal
  angle: number;
  distance: number;
}

/**
 * Normalizes an angle into [0, 2π).
 */
export function normalizeAngle(rad: number): number {
  let a = rad % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a;
}

/**
 * Calculates counter-clockwise sweep angle between start and end.
 */
export function computeSweepAngle(startAngle: number, endAngle: number, ccw = true): number {
  const s = normalizeAngle(startAngle);
  const e = normalizeAngle(endAngle);
  if (ccw) {
    return e >= s ? e - s : (2 * Math.PI - s + e);
  } else {
    return s >= e ? s - e : (2 * Math.PI - e + s);
  }
}

/**
 * Solves a 3-point circular arc: returns center, radius, start angle, and end angle.
 * P1 = start, P2 = intermediate point on the arc, P3 = end.
 */
export function threePointArc(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
): { center: [number, number]; radius: number; startAngle: number; endAngle: number; ccw: boolean } {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;

  const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) {
    throw new Error("Collinear points cannot define an arc wall");
  }

  const ux =
    ((x1 * x1 + y1 * y1) * (y2 - y3) +
      (x2 * x2 + y2 * y2) * (y3 - y1) +
      (x3 * x3 + y3 * y3) * (y1 - y2)) / d;

  const uy =
    ((x1 * x1 + y1 * y1) * (x3 - x2) +
      (x2 * x2 + y2 * y2) * (x1 - x3) +
      (x3 * x3 + y3 * y3) * (x2 - x1)) / d;

  const center: [number, number] = [ux, uy];
  const radius = Math.hypot(x1 - ux, y1 - uy);

  const startAngle = Math.atan2(y1 - uy, x1 - ux);
  const midAngle = Math.atan2(y2 - uy, x2 - ux);
  const endAngle = Math.atan2(y3 - uy, x3 - ux);

  // Check orientation: cross product of (p2-p1) and (p3-p2)
  const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
  const ccw = cross > 0;

  // Verify that midAngle lies between startAngle and endAngle along ccw sweep
  const sweepToEnd = computeSweepAngle(startAngle, endAngle, ccw);
  const sweepToMid = computeSweepAngle(startAngle, midAngle, ccw);

  // If mid is not on the chosen arc direction, flip ccw
  const isMidOnArc = sweepToMid <= sweepToEnd;
  const finalCcw = isMidOnArc ? ccw : !ccw;

  return {
    center,
    radius,
    startAngle: normalizeAngle(startAngle),
    endAngle: normalizeAngle(endAngle),
    ccw: finalCcw,
  };
}

/**
 * Resolves arc wall geometric dimensions, inner/outer radius, arc length, and volume.
 */
export function resolveArcWallGeometry(params: ArcWallParams): ArcWallGeometry {
  const {
    center,
    radius,
    startAngle,
    endAngle,
    thickness,
    height,
    baseOffset = 0,
    justification = "center",
    counterClockwise = true,
  } = params;

  if (radius <= 0) throw new Error("Arc wall radius must be positive");
  if (thickness <= 0) throw new Error("Arc wall thickness must be positive");
  if (height <= 0) throw new Error("Arc wall height must be positive");

  const halfT = thickness / 2;
  let innerRadius = radius - halfT;
  let outerRadius = radius + halfT;

  if (justification === "interior") {
    innerRadius = radius;
    outerRadius = radius + thickness;
  } else if (justification === "exterior") {
    innerRadius = Math.max(0.001, radius - thickness);
    outerRadius = radius;
  }

  if (innerRadius <= 0) {
    throw new Error("Wall thickness exceeds inner radius curvature limit");
  }

  const sweepAngle = computeSweepAngle(startAngle, endAngle, counterClockwise);
  const arcLength = radius * sweepAngle;
  // Volume of annular cylinder sector: 0.5 * (R_out^2 - R_in^2) * sweep * height
  const area = 0.5 * (outerRadius * outerRadius - innerRadius * innerRadius) * sweepAngle;
  const volume = area * height;

  return {
    center,
    baseRadius: radius,
    innerRadius,
    outerRadius,
    startAngle: normalizeAngle(startAngle),
    endAngle: normalizeAngle(endAngle),
    sweepAngle,
    thickness,
    height,
    baseOffset,
    justification,
    arcLength,
    volume,
  };
}

/**
 * Evaluates a point along the arc wall baseline curve at parameter t in [0, 1].
 */
export function evaluateArcPoint(
  geom: ArcWallGeometry,
  t: number,
  radiusOffset = 0, // e.g. -halfT for inner, +halfT for outer
): [number, number] {
  const angle = geom.startAngle + geom.sweepAngle * Math.max(0, Math.min(1, t));
  const r = geom.baseRadius + radiusOffset;
  return [
    geom.center[0] + r * Math.cos(angle),
    geom.center[1] + r * Math.sin(angle),
  ];
}

/**
 * Computes the tangent unit vector and normal unit vector at a given angle or parameter t.
 */
export function computeArcTangentAt(
  geom: ArcWallGeometry,
  t: number,
): { tangent: [number, number]; normal: [number, number]; angle: number } {
  const angle = geom.startAngle + geom.sweepAngle * Math.max(0, Math.min(1, t));
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  // Tangent vector along increasing sweep
  const tangent: [number, number] = [-sinA, cosA];
  // Outward radial normal
  const normal: [number, number] = [cosA, sinA];

  return { tangent, normal, angle };
}

/**
 * Tangent Snapping Solver:
 * Given a query point (e.g. mouse cursor or start of a connecting linear wall),
 * computes snapping candidates tangent to the curved arc wall.
 */
export function solveArcTangentSnap(
  geom: ArcWallGeometry,
  queryPoint: [number, number],
  tolerance = 0.5, // snap distance in meters
): TangentSnapResult | null {
  const dx = queryPoint[0] - geom.center[0];
  const dy = queryPoint[1] - geom.center[1];
  const d = Math.hypot(dx, dy);

  // 1. Check direct radial projection snap to the arc curve
  const alpha = Math.atan2(dy, dx);
  const normAlpha = normalizeAngle(alpha);
  const sweepFromStart = computeSweepAngle(geom.startAngle, normAlpha, true);

  if (sweepFromStart <= geom.sweepAngle + 1e-4) {
    const radialDist = Math.abs(d - geom.baseRadius);
    if (radialDist <= tolerance) {
      const px = geom.center[0] + geom.baseRadius * Math.cos(alpha);
      const py = geom.center[1] + geom.baseRadius * Math.sin(alpha);
      const t = computeArcTangentAt(geom, sweepFromStart / (geom.sweepAngle || 1));
      return {
        snapPoint: [px, py],
        tangentVector: t.tangent,
        normalVector: t.normal,
        angle: normAlpha,
        distance: radialDist,
      };
    }
  }

  // 2. Check snapping to arc start or end points
  const startPt = evaluateArcPoint(geom, 0);
  const dStart = Math.hypot(queryPoint[0] - startPt[0], queryPoint[1] - startPt[1]);
  if (dStart <= tolerance) {
    const startT = computeArcTangentAt(geom, 0);
    return {
      snapPoint: startPt,
      tangentVector: startT.tangent,
      normalVector: startT.normal,
      angle: startT.angle,
      distance: dStart,
    };
  }

  const endPt = evaluateArcPoint(geom, 1);
  const dEnd = Math.hypot(queryPoint[0] - endPt[0], queryPoint[1] - endPt[1]);
  if (dEnd <= tolerance) {
    const endT = computeArcTangentAt(geom, 1);
    return {
      snapPoint: endPt,
      tangentVector: endT.tangent,
      normalVector: endT.normal,
      angle: endT.angle,
      distance: dEnd,
    };
  }

  // 3. Line-of-sight external tangent contact points
  if (d > geom.baseRadius) {
    const cosBeta = Math.min(1, Math.max(-1, geom.baseRadius / d));
    const beta = Math.acos(cosBeta);
    const candidateAngles = [alpha + beta, alpha - beta];
    let bestResult: TangentSnapResult | null = null;
    let bestDist = Infinity;

    for (const ang of candidateAngles) {
      const normAng = normalizeAngle(ang);
      const sw = computeSweepAngle(geom.startAngle, normAng, true);
      if (sw <= geom.sweepAngle + 1e-4) {
        const px = geom.center[0] + geom.baseRadius * Math.cos(ang);
        const py = geom.center[1] + geom.baseRadius * Math.sin(ang);
        const dist = Math.hypot(queryPoint[0] - px, queryPoint[1] - py);

        if (dist <= tolerance && dist < bestDist) {
          bestDist = dist;
          bestResult = {
            snapPoint: [px, py],
            tangentVector: [-Math.sin(ang), Math.cos(ang)],
            normalVector: [Math.cos(ang), Math.sin(ang)],
            angle: normAng,
            distance: dist,
          };
        }
      }
    }
    if (bestResult) return bestResult;
  }

  return null;
}

/**
 * 2D Plan View Polyline generation for CAD drafting and section representation.
 */
export function generateArcWallPlanPolyline(
  params: ArcWallParams,
  numSegments?: number,
): {
  centerline: Array<[number, number]>;
  innerBoundary: Array<[number, number]>;
  outerBoundary: Array<[number, number]>;
} {
  const geom = resolveArcWallGeometry(params);
  const segs = Math.max(4, numSegments ?? Math.ceil((geom.sweepAngle / (Math.PI / 180)) / 5)); // 1 seg per 5 deg

  const centerline: Array<[number, number]> = [];
  const innerBoundary: Array<[number, number]> = [];
  const outerBoundary: Array<[number, number]> = [];

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = geom.startAngle + geom.sweepAngle * t;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);

    centerline.push([
      geom.center[0] + geom.baseRadius * cosA,
      geom.center[1] + geom.baseRadius * sinA,
    ]);
    innerBoundary.push([
      geom.center[0] + geom.innerRadius * cosA,
      geom.center[1] + geom.innerRadius * sinA,
    ]);
    outerBoundary.push([
      geom.center[0] + geom.outerRadius * cosA,
      geom.center[1] + geom.outerRadius * sinA,
    ]);
  }

  return { centerline, innerBoundary, outerBoundary };
}

/**
 * 3D Triangulated Mesh Generator for Curved / Arc Wall.
 * Generates outer cylinder face, inner cylinder face, top cap, bottom cap, and start/end vertical caps.
 */
export function generateArcWallMesh(params: ArcWallParams): ArcWallMesh {
  const geom = resolveArcWallGeometry(params);
  const segs = Math.max(4, params.segments ?? Math.ceil((geom.sweepAngle / (Math.PI / 180)) / 4));

  const vertices: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];

  const zBottom = geom.baseOffset;
  const zTop = geom.baseOffset + geom.height;

  // We build 4 profiles along the arc:
  // outer-bottom (OB), outer-top (OT), inner-bottom (IB), inner-top (IT)
  const obOffset = 0;
  const otOffset = (segs + 1);
  const ibOffset = (segs + 1) * 2;
  const itOffset = (segs + 1) * 3;

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = geom.startAngle + geom.sweepAngle * t;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);

    // Outer face vertices
    const ox = geom.center[0] + geom.outerRadius * cosA;
    const oy = geom.center[1] + geom.outerRadius * sinA;
    // OB:
    vertices.push(ox, oy, zBottom);
    normals.push(cosA, sinA, 0);

    // Inner face vertices
    const ix = geom.center[0] + geom.innerRadius * cosA;
    const iy = geom.center[1] + geom.innerRadius * sinA;
  }

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = geom.startAngle + geom.sweepAngle * t;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    const ox = geom.center[0] + geom.outerRadius * cosA;
    const oy = geom.center[1] + geom.outerRadius * sinA;
    // OT:
    vertices.push(ox, oy, zTop);
    normals.push(cosA, sinA, 0);
  }

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = geom.startAngle + geom.sweepAngle * t;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    const ix = geom.center[0] + geom.innerRadius * cosA;
    const iy = geom.center[1] + geom.innerRadius * sinA;
    // IB:
    vertices.push(ix, iy, zBottom);
    normals.push(-cosA, -sinA, 0);
  }

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = geom.startAngle + geom.sweepAngle * t;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    const ix = geom.center[0] + geom.innerRadius * cosA;
    const iy = geom.center[1] + geom.innerRadius * sinA;
    // IT:
    vertices.push(ix, iy, zTop);
    normals.push(-cosA, -sinA, 0);
  }

  // 1. Outer curved wall faces (OB, OT)
  for (let i = 0; i < segs; i++) {
    const b0 = obOffset + i;
    const b1 = obOffset + i + 1;
    const t0 = otOffset + i;
    const t1 = otOffset + i + 1;

    indices.push(b0, b1, t0);
    indices.push(t0, b1, t1);
  }

  // 2. Inner curved wall faces (IB, IT - reversed winding for inward face)
  for (let i = 0; i < segs; i++) {
    const b0 = ibOffset + i;
    const b1 = ibOffset + i + 1;
    const t0 = itOffset + i;
    const t1 = itOffset + i + 1;

    indices.push(b0, t0, b1);
    indices.push(t0, t1, b1);
  }

  // 3. Top cap (OT to IT)
  for (let i = 0; i < segs; i++) {
    const ot0 = otOffset + i;
    const ot1 = otOffset + i + 1;
    const it0 = itOffset + i;
    const it1 = itOffset + i + 1;

    indices.push(ot0, it0, ot1);
    indices.push(it0, it1, ot1);
  }

  // 4. Bottom cap (OB to IB)
  for (let i = 0; i < segs; i++) {
    const ob0 = obOffset + i;
    const ob1 = obOffset + i + 1;
    const ib0 = ibOffset + i;
    const ib1 = ibOffset + i + 1;

    indices.push(ob0, ob1, ib0);
    indices.push(ib0, ob1, ib1);
  }

  // 5. Start vertical end cap (i = 0: OB, OT, IB, IT)
  const startOb = obOffset;
  const startOt = otOffset;
  const startIb = ibOffset;
  const startIt = itOffset;
  indices.push(startIb, startOb, startIt);
  indices.push(startOb, startOt, startIt);

  // 6. End vertical end cap (i = segs: OB, OT, IB, IT)
  const endOb = obOffset + segs;
  const endOt = otOffset + segs;
  const endIb = ibOffset + segs;
  const endIt = itOffset + segs;
  indices.push(endOb, endIb, endOt);
  indices.push(endIb, endIt, endOt);

  return {
    positions: new Float32Array(vertices),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
  };
}
