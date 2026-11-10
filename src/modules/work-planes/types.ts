/**
 * Named work planes for 3D sketching and adaptive placement.
 * The serializable definition is plain project data; no THREE runtime objects
 * are stored, so it survives project JSON save/reopen.
 */
export interface WorkPlaneFaceReference {
  elementId?: string;
  meshIndex?: number;
  faceIndex?: number;
  localOrigin?: [number, number, number];
  localNormal?: [number, number, number];
}

export interface WorkPlane {
  id: string;
  name: string;
  /** Plane origin [x, y, z] in world metres. */
  origin: [number, number, number];
  /** Unit normal direction [nx, ny, nz]. */
  normal: [number, number, number];
  /** Rotation around the normal (radians, for sketch orientation). */
  rotation: number;
  /** Whether this plane is the current active work plane. */
  active: boolean;
  /** Optional provenance for a plane picked from a model face. */
  face?: WorkPlaneFaceReference;
}

export interface WorkPlaneSnapshot {
  schemaVersion: 1;
  activeId: string | null;
  planes: Array<Omit<WorkPlane, "active">>;
}

const planes = new Map<string, WorkPlane>();
let activeId: string | null = null;
let idCounter = 0;

function vectorLength(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function normalizeVector(v: [number, number, number], label: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isFinite(n))) {
    throw new Error(label + " must contain three finite values");
  }
  const length = vectorLength(v);
  if (length < 1e-10) throw new Error(label + " cannot be a zero vector");
  return [v[0] / length, v[1] / length, v[2] / length];
}
function validateOrigin(origin: [number, number, number]): [number, number, number] {
  if (!Array.isArray(origin) || origin.length !== 3 || origin.some((n) => !Number.isFinite(n))) {
    throw new Error("Work plane origin must contain three finite coordinates");
  }
  return [...origin] as [number, number, number];
}

export function createWorkPlane(
  name: string,
  origin: [number, number, number],
  normal: [number, number, number] = [0, 1, 0],
  face?: WorkPlaneFaceReference,
): WorkPlane {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("Work plane name is required");
  const plane: WorkPlane = {
    id: "wp-" + (++idCounter),
    name: cleanName,
    origin: validateOrigin(origin),
    normal: normalizeVector(normal, "Work plane normal"),
    rotation: 0,
    active: false,
    ...(face ? { face: JSON.parse(JSON.stringify(face)) as WorkPlaneFaceReference } : {}),
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
  if (Math.abs(plane.normal[1]) > 0.999999) {
    try { (window as any).__obsSnapping?.setWorkPlaneY?.(plane.origin[1]); } catch { /* */ }
  }
  try { window.dispatchEvent(new CustomEvent("obs:work-plane-changed", { detail: { id, plane } })); } catch { /* non-browser test */ }
  return true;
}

export function getActiveWorkPlane(): WorkPlane | null {
  return activeId ? planes.get(activeId) ?? null : null;
}
export function getWorkPlane(id: string): WorkPlane | null {
  return planes.get(id) ?? null;
}
export function listWorkPlanes(): WorkPlane[] {
  return [...planes.values()].map((plane) => ({ ...plane, origin: [...plane.origin], normal: [...plane.normal] }));
}
export function removeWorkPlane(id: string): void {
  if (id === activeId) {
    const plane = planes.get(activeId);
    if (plane) plane.active = false;
    activeId = null;
  }
  planes.delete(id);
  try { window.dispatchEvent(new CustomEvent("obs:work-plane-changed", { detail: { id: activeId, plane: getActiveWorkPlane() } })); } catch { /* */ }
}

/** Return the signed world-space distance from a point to this plane. */
export function distanceToWorkPlane(
  point: [number, number, number],
  plane = getActiveWorkPlane(),
): number | null {
  if (!plane) return null;
  const dx = point[0] - plane.origin[0];
  const dy = point[1] - plane.origin[1];
  const dz = point[2] - plane.origin[2];
  return dx * plane.normal[0] + dy * plane.normal[1] + dz * plane.normal[2];
}

/** Project a world point onto the active work plane. */
export function projectWorldPoint(
  point: [number, number, number],
  plane = getActiveWorkPlane(),
): [number, number, number] {
  if (!plane) return [...point];
  const distance = distanceToWorkPlane(point, plane) ?? 0;
  return [
    point[0] - plane.normal[0] * distance,
    point[1] - plane.normal[1] * distance,
    point[2] - plane.normal[2] * distance,
  ];
}

/** Plane-local 2D coordinates (U,V), useful for planar sketch and dimension tools. */
export function projectOntoWorkPlane(worldX: number, worldY: number, worldZ: number): [number, number] {
  const plane = getActiveWorkPlane();
  if (!plane) return [worldX, worldZ];
  const [nx, ny, nz] = plane.normal;
  const reference: [number, number, number] = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalizeVector([
    reference[1] * nz - reference[2] * ny,
    reference[2] * nx - reference[0] * nz,
    reference[0] * ny - reference[1] * nx,
  ], "Work plane U axis");
  const v = [
    ny * u[2] - nz * u[1],
    nz * u[0] - nx * u[2],
    nx * u[1] - ny * u[0],
  ] as [number, number, number];
  const relative = [worldX - plane.origin[0], worldY - plane.origin[1], worldZ - plane.origin[2]];
  return [
    relative[0] * u[0] + relative[1] * u[1] + relative[2] * u[2],
    relative[0] * v[0] + relative[1] * v[1] + relative[2] * v[2],
  ];
}

export function serializeWorkPlanes(): WorkPlaneSnapshot {
  return {
    schemaVersion: 1,
    activeId,
    planes: listWorkPlanes().map(({ active: _active, ...plane }) => plane),
  };
}

export function restoreWorkPlanes(snapshot: WorkPlaneSnapshot): void {
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.planes)) {
    throw new Error("Unsupported work plane snapshot");
  }
  planes.clear();
  activeId = null;
  for (const entry of snapshot.planes) {
    if (!entry?.id || !entry.name) throw new Error("Invalid saved work plane");
    const restored: WorkPlane = {
      ...entry,
      origin: validateOrigin(entry.origin),
      normal: normalizeVector(entry.normal, "Saved work plane normal"),
      rotation: Number.isFinite(entry.rotation) ? entry.rotation : 0,
      active: false,
    };
    planes.set(restored.id, restored);
    const match = /^wp-(\d+)$/.exec(restored.id);
    if (match) idCounter = Math.max(idCounter, Number(match[1]));
  }
  if (snapshot.activeId) setActiveWorkPlane(snapshot.activeId);
}

let installed = false;
export function setupWorkPlanes() {
  if (installed) return;
  installed = true;
  (window as any).__obsWorkPlanes = {
    create: createWorkPlane,
    setActive: setActiveWorkPlane,
    getActive: getActiveWorkPlane,
    get: getWorkPlane,
    list: listWorkPlanes,
    remove: removeWorkPlane,
    project: projectOntoWorkPlane,
    projectWorld: projectWorldPoint,
    distance: distanceToWorkPlane,
    serialize: serializeWorkPlanes,
    restore: restoreWorkPlanes,
  };
  console.log("[work-planes] ready — arbitrary sketch planes and picked-face references available.");
}
