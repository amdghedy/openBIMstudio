/**
 * CAD underlay snap — stores DXF entity endpoints and exposes them to the
 * snapping system so walls drawn over a DWG underlay snap to the DWG
 * line endpoints, intersections, and circle centers.
 *
 * When a DXF is loaded as an underlay in the 2D plan view, this module
 * parses the entity data (LINE endpoints, LWPOLYLINE vertices, CIRCLE
 * centers) and stores them as snap-able 3D points.
 *
 * The snapping system queries these points via `getUnderlaySnapPoints()`
 * during its snap query loop.
 */

/** A snap-able point from the CAD underlay. */
export interface UnderlaySnapPoint {
  /** World X coordinate (metres). */
  x: number;
  /** World Z coordinate (metres) — Y is the plan's vertical (up) axis. */
  z: number;
  /** Snap type: "endpoint" for line/polyline vertices, "center" for circles. */
  type: "endpoint" | "center" | "midpoint";
}

/** A line segment from the underlay (for midpoint snapping). */
export interface UnderlaySegment {
  x1: number; z1: number;
  x2: number; z2: number;
}

/** Stored underlay entities (points + segments). */
interface UnderlayData {
  points: UnderlaySnapPoint[];
  segments: UnderlaySegment[];
  /** Underlay offset (added to all entity coords). */
  offsetX: number;
  offsetZ: number;
  /** Underlay scale factor. */
  scale: number;
}

let underlayData: UnderlayData | null = null;

/** Whether snap-to-underlay is enabled. */
let snapEnabled = true;

/**
 * Parse DXF text and store entities for snap querying.
 * Extracts LINE endpoints, LWPOLYLINE vertices, and CIRCLE centers.
 *
 * This runs alongside dxfToSvgUnderlay() — the SVG rendering handles
 * display, this module handles snap data.
 */
export function storeUnderlayFromDxf(dxf: string): number {
  const points: UnderlaySnapPoint[] = [];
  const segments: UnderlaySegment[] = [];

  const rows = dxf.split(/\r?\n/);
  let i = 0;
  const num = (): number => {
    i++;
    return parseFloat(rows[i] ?? "0") || 0;
  };
  const str = (): string => {
    i++;
    return (rows[i] ?? "").trim();
  };

  while (i < rows.length) {
    const code = (rows[i] ?? "").trim();

    if (code === "0") {
      const entity = str();

      if (entity === "LINE") {
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        while (i < rows.length - 1) {
          const c = (rows[++i] ?? "").trim();
          if (c === "0") { i--; break; }
          if (c === "10") x1 = num();
          else if (c === "20") y1 = num();
          else if (c === "11") x2 = num();
          else if (c === "21") y2 = num();
          else i++;
        }
        // DXF Y axis = world Z (plan horizontal plane).
        points.push({ x: x1, z: y1, type: "endpoint" });
        points.push({ x: x2, z: y2, type: "endpoint" });
        segments.push({ x1, z1: y1, x2, z2: y2 });
      } else if (entity === "LWPOLYLINE" || entity === "POLYLINE") {
        const pts: Array<[number, number]> = [];
        while (i < rows.length - 1) {
          const c = (rows[++i] ?? "").trim();
          if (c === "0") { i--; break; }
          if (c === "10") {
            const x = num();
            let y = 0;
            if ((rows[i + 1] ?? "").trim() === "20") { i++; y = num(); }
            pts.push([x, y]);
          } else i++;
        }
        // Add each vertex as an endpoint snap.
        for (const [x, y] of pts) {
          points.push({ x, z: y, type: "endpoint" });
        }
        // Add segments for midpoint snapping.
        for (let k = 0; k < pts.length - 1; k++) {
          segments.push({ x1: pts[k][0], z1: pts[k][1], x2: pts[k + 1][0], z2: pts[k + 1][1] });
        }
      } else if (entity === "CIRCLE") {
        let cx = 0, cy = 0, r = 0;
        while (i < rows.length - 1) {
          const c = (rows[++i] ?? "").trim();
          if (c === "0") { i--; break; }
          if (c === "10") cx = num();
          else if (c === "20") cy = num();
          else if (c === "40") r = num();
          else i++;
        }
        // Circle center is a snap-able point.
        points.push({ x: cx, z: cy, type: "center" });
        // Also add 4 quadrant points on the circle.
        points.push({ x: cx + r, z: cy, type: "endpoint" });
        points.push({ x: cx - r, z: cy, type: "endpoint" });
        points.push({ x: cx, z: cy + r, type: "endpoint" });
        points.push({ x: cx, z: cy - r, type: "endpoint" });
      } else if (entity === "ARC") {
        let cx = 0, cy = 0, r = 0;
        while (i < rows.length - 1) {
          const c = (rows[++i] ?? "").trim();
          if (c === "0") { i--; break; }
          if (c === "10") cx = num();
          else if (c === "20") cy = num();
          else if (c === "40") r = num();
          else i++;
        }
        points.push({ x: cx, z: cy, type: "center" });
      }
    }
    i++;
  }

  underlayData = {
    points,
    segments,
    offsetX: 0,
    offsetZ: 0,
    scale: 1,
  };

  console.log(
    `[cad-underlay-snap] stored ${points.length} snap points, ` +
    `${segments.length} segments from DXF underlay`,
  );

  return points.length;
}

/**
 * Get snap-able points from the CAD underlay near a given world position.
 *
 * @param worldX - cursor world X
 * @param worldZ - cursor world Z
 * @param tolerance - snap radius in metres
 * @returns matching snap points within tolerance
 */
export function getUnderlaySnapPoints(
  worldX: number,
  worldZ: number,
  tolerance: number,
): UnderlaySnapPoint[] {
  if (!snapEnabled || !underlayData) return [];

  const results: UnderlaySnapPoint[] = [];
  const ox = underlayData.offsetX;
  const oz = underlayData.offsetZ;
  const s = underlayData.scale;

  // Check endpoint/center points.
  for (const p of underlayData.points) {
    const px = p.x * s + ox;
    const pz = p.z * s + oz;
    const dist = Math.hypot(px - worldX, pz - worldZ);
    if (dist <= tolerance) {
      results.push({ x: px, z: pz, type: p.type });
    }
  }

  // Check segment midpoints.
  for (const seg of underlayData.segments) {
    const mx = ((seg.x1 + seg.x2) / 2) * s + ox;
    const mz = ((seg.z1 + seg.z2) / 2) * s + oz;
    const dist = Math.hypot(mx - worldX, mz - worldZ);
    if (dist <= tolerance) {
      results.push({ x: mx, z: mz, type: "midpoint" });
    }
  }

  return results;
}

/** Check whether any underlay snap data is loaded. */
export function hasUnderlayData(): boolean {
  return underlayData !== null && underlayData.points.length > 0;
}

/** Enable/disable snap-to-underlay. */
export function setUnderlaySnapEnabled(on: boolean): void {
  snapEnabled = on;
}

/** Get current snap-to-underlay state. */
export function isUnderlaySnapEnabled(): boolean {
  return snapEnabled;
}

/** Clear stored underlay data (when underlay is removed). */
export function clearUnderlayData(): void {
  underlayData = null;
}

/** Set underlay positioning offset (for manual positioning). */
export function setUnderlayOffset(offsetX: number, offsetZ: number): void {
  if (underlayData) {
    underlayData.offsetX = offsetX;
    underlayData.offsetZ = offsetZ;
  }
}

/** Set underlay scale (for manual scaling). */
export function setUnderlayScale(scale: number): void {
  if (underlayData) {
    underlayData.scale = scale;
  }
}
