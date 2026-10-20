/**
 * Work planes — set the active sketch/reference plane for modeling.
 *
 * Revit's "Set Work Plane" lets users pick a face or named plane to
 * draw on. All subsequent sketch operations (extrude, sweep, model
 * lines) are projected onto this plane.
 *
 * The snapping system already has a workPlaneY (horizontal plane at a
 * given height). This module extends it to support named vertical
 * planes (e.g. "Wall 1 Face", "Grid B-Elevation").
 */

export interface WorkPlane {
  id: string;
  name: string;
  /** Plane origin [x, y, z] in world metres. */
  origin: [number, number, number];
  /** Normal direction [nx, ny, nz] (unit vector). */
  normal: [number, number, number];
  /** Rotation around the normal (radians, for sketch orientation). */
  rotation: number;
  /** Whether this plane is the current active work plane. */
  active: boolean;
}

const planes = new Map<string, WorkPlane>();
let activeId: string | null = null;
let idCounter = 0;

export function createWorkPlane(
  name: string,
  origin: [number, number, number],
  normal: [number, number, number] = [0, 1, 0],
): WorkPlane {
  const plane: WorkPlane = {
    id: `wp-${++idCounter}`,
    name,
    origin,
    normal,
    rotation: 0,
    active: false,
  };
  planes.set(plane.id, plane);
  setActiveWorkPlane(plane.id);
  return plane;
}

export function setActiveWorkPlane(id: string): boolean {
  const plane = planes.get(id);
  if (!plane) return false;
  if (activeId) {
    const old = planes.get(activeId);
    if (old) old.active = false;
  }
  plane.active = true;
  activeId = id;

  // Update the snapping system's work plane Y for horizontal planes.
  if (plane.normal[1] > 0.9) {
    try {
      const snap = (window as any).__obsSnapping;
      snap?.setWorkPlaneY?.(plane.origin[1]);
    } catch { /* */ }
  }

  console.log(`[work-planes] active: "${plane.name}"`);
  return true;
}

export function getActiveWorkPlane(): WorkPlane | null {
  return activeId ? planes.get(activeId) ?? null : null;
}

export function listWorkPlanes(): WorkPlane[] { return [...planes.values()]; }
export function removeWorkPlane(id: string): void {
  if (id === activeId) activeId = null;
  planes.delete(id);
}

/** Project a world point onto the active work plane. */
export function projectOntoWorkPlane(worldX: number, worldY: number, worldZ: number): [number, number] {
  const plane = getActiveWorkPlane();
  if (!plane) return [worldX, worldZ];
  const [ox, oy, oz] = plane.origin;
  const [nx, ny, nz] = plane.normal;
  const dx = worldX - ox, dy = worldY - oy, dz = worldZ - oz;
  const dist = dx * nx + dy * ny + dz * nz;
  // Projected point on the plane
  const px = dx - dist * nx;
  const py = dy - dist * ny;
  const pz = dz - dist * nz;
  // Return [u, v] — 2D coordinates on the plane.
  // For horizontal planes (normal = [0,1,0]): u = x, v = z.
  // For vertical planes along X: u = z, v = y.
  if (Math.abs(ny) > 0.9) return [px + ox, pz + oz];
  if (Math.abs(nx) > 0.9) return [pz + oz, py + oy];
  return [px + ox, py + oy];
}

let installed = false;
export function setupWorkPlanes() {
  if (installed) return; installed = true;
  (window as any).__obsWorkPlanes = {
    create: createWorkPlane, setActive: setActiveWorkPlane,
    getActive: getActiveWorkPlane, list: listWorkPlanes,
    remove: removeWorkPlane, project: projectOntoWorkPlane,
  };
  console.log("[work-planes] ready. Set work plane via __obsWorkPlanes.create(name, origin, normal).");
}
