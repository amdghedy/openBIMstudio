/**
 * ViewCube geometry — the cube interaction graph and its projection to
 * widget screen space. Pure math, DOM-free, three.js-free (own quaternion
 * rotation) so Node tests can exercise it directly.
 *
 * The cube lives in world axes: front = +Z, right = +X, top = +Y (the
 * repository's BIM convention, matching gotoExactView and project north).
 */

export interface Vec3 { x: number; y: number; z: number; }

export type VertexKey = string; // "x,y,z" with each coordinate ±1

function key(x: number, y: number, z: number): VertexKey {
  return `${x},${y},${z}`;
}

export function parseVertex(k: VertexKey): Vec3 {
  const [x, y, z] = k.split(",").map(Number);
  return { x, y, z };
}

export const CUBE_VERTEX_KEYS: readonly VertexKey[] = (() => {
  const out: VertexKey[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) out.push(key(x, y, z));
  return out;
})();

/* ── Face / edge / corner graph ────────────────────────────────────────── */

export interface FaceDef {
  normal: Vec3;
  /** CCW seen from outside. */
  vertices: VertexKey[];
}

function faceDef(nx: number, ny: number, nz: number): FaceDef {
  // Vertices on the face plane, enumerated in a fixed plane order; the
  // winding check below guarantees CCW-seen-from-outside.
  const verts: VertexKey[] = [];
  const plane: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  if (nz !== 0) {
    for (const [a, b] of plane) verts.push(key(a, b, nz));
  } else if (ny !== 0) {
    for (const [a, b] of plane) verts.push(key(a, ny, b));
  } else {
    for (const [a, b] of plane) verts.push(key(nx, a, b));
  }
  // Ensure outward CCW: reverse when the winding is inward (cross of diagonals).
  const p = verts.map(parseVertex);
  const d1 = { x: p[2].x - p[0].x, y: p[2].y - p[0].y, z: p[2].z - p[0].z };
  const d2 = { x: p[3].x - p[1].x, y: p[3].y - p[1].y, z: p[3].z - p[1].z };
  const cx = d1.y * d2.z - d1.z * d2.y;
  const cy = d1.z * d2.x - d1.x * d2.z;
  const cz = d1.x * d2.y - d1.y * d2.x;
  const dot = cx * nx + cy * ny + cz * nz;
  if (dot < 0) verts.reverse();
  return { normal: { x: nx, y: ny, z: nz }, vertices: verts };
}

export type FaceId = "front" | "back" | "right" | "left" | "top" | "bottom";
export type EdgeId =
  | "front-right" | "back-right" | "front-left" | "back-left"
  | "top-front" | "top-back" | "top-right" | "top-left"
  | "bottom-front" | "bottom-back" | "bottom-right" | "bottom-left";
export type CornerId =
  | "top-front-right" | "top-front-left" | "top-back-right" | "top-back-left"
  | "bottom-front-right" | "bottom-front-left" | "bottom-back-right" | "bottom-back-left";

export interface CubeGraph {
  faces: Record<FaceId, FaceDef>;
  edges: Record<EdgeId, { a: VertexKey; b: VertexKey; faces: [FaceId, FaceId] }>;
  corners: Record<CornerId, { v: VertexKey; faces: [FaceId, FaceId, FaceId] }>;
}

function buildGraph(): CubeGraph {
  const faces: Record<FaceId, FaceDef> = {
    front: faceDef(0, 0, 1),
    back: faceDef(0, 0, -1),
    right: faceDef(1, 0, 0),
    left: faceDef(-1, 0, 0),
    top: faceDef(0, 1, 0),
    bottom: faceDef(0, -1, 0),
  };

  // Face ids by signed normal axis for adjacency lookups.
  const faceOfNormal = (n: Vec3): FaceId => {
    if (n.z === 1) return "front";
    if (n.z === -1) return "back";
    if (n.x === 1) return "right";
    if (n.x === -1) return "left";
    if (n.y === 1) return "top";
    return "bottom";
  };

  const edges = {} as CubeGraph["edges"];
  const faceIds: FaceId[] = ["front", "back", "right", "left", "top", "bottom"];
  const seen = new Set<string>();

  /**
   * Canonical edge id convention (shared with modules/navigation): pole
   * edges are `<pole>-<ring>` (top-front, bottom-back, ...); ring edges
   * are `<front/back>-<right/left>` (front-right, back-left, ...).
   */
  const canonicalEdgeId = (fa: FaceId, fb: FaceId): EdgeId => {
    const isPole = (f: FaceId) => f === "top" || f === "bottom";
    if (isPole(fa) || isPole(fb)) {
      const pole = isPole(fa) ? fa : fb;
      const ring = isPole(fa) ? fb : fa;
      return `${pole}-${ring}` as EdgeId;
    }
    const priority: Record<FaceId, number> = { front: 0, back: 1, right: 2, left: 3, top: 4, bottom: 5 };
    const [a, b] = priority[fa] <= priority[fb] ? [fa, fb] : [fb, fa];
    return `${a}-${b}` as EdgeId;
  };

  for (const fa of faceIds) {
    for (const fb of faceIds) {
      if (fa >= fb) continue;
      const na = faces[fa].normal, nb = faces[fb].normal;
      if (na.x * nb.x + na.y * nb.y + na.z * nb.z !== 0) continue; // must be adjacent
      const shared = faces[fa].vertices.filter((k) => faces[fb].vertices.includes(k));
      if (shared.length !== 2) continue;
      const [a, b] = shared;
      const edgeId = canonicalEdgeId(fa, fb);
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);
      edges[edgeId] = { a, b, faces: [fa, fb] };
    }
  }

  const corners = {} as CubeGraph["corners"];
  for (const vk of CUBE_VERTEX_KEYS) {
    const p = parseVertex(vk);
    const adjacent = faceIds.filter((f) => {
      const n = faces[f].normal;
      return n.x * p.x + n.y * p.y + n.z * p.z === 1;
    });
    const id = (adjacent.includes("top") ? "top" : "bottom") + "-" +
      (adjacent.includes("front") ? "front" : "back") + "-" +
      (adjacent.includes("right") ? "right" : "left") as CornerId;
    corners[id] = {
      v: vk,
      faces: [adjacent[0], adjacent[1], adjacent[2]] as [FaceId, FaceId, FaceId],
    };
  }

  return { faces, edges, corners };
}

export const CUBE_GRAPH: CubeGraph = buildGraph();

/* ── Quaternion math (self-contained for Node tests) ───────────────────── */

export interface Quat { x: number; y: number; z: number; w: number; }

function qRotate(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2 * q_xyz × (q_xyz × v + w * v)
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const t = {
    x: qy * v.z - qz * v.y + qw * v.x,
    y: qz * v.x - qx * v.z + qw * v.y,
    z: qx * v.y - qy * v.x + qw * v.z,
  };
  return {
    x: v.x + 2 * (qy * t.z - qz * t.y),
    y: v.y + 2 * (qz * t.x - qx * t.z),
    z: v.z + 2 * (qx * t.y - qy * t.x),
  };
}

/* ── Projection ────────────────────────────────────────────────────────── */

export interface ProjectedCube {
  /** View-space vertex positions: x right, y up, z toward the viewer. */
  view: Record<VertexKey, Vec3>;
  /** SVG coordinates (y flipped; widget Y grows downward). */
  screen: Record<VertexKey, [number, number]>;
  /** Face outward normals in view space. */
  faceNormalView: Record<FaceId, Vec3>;
  /** Facing factor 0..1 (1 = straight at the viewer). */
  facing: Record<FaceId, number>;
  visible: Record<FaceId, boolean>;
  edgeVisible: Record<EdgeId, boolean>;
  cornerVisible: Record<CornerId, boolean>;
  /** Depth sort key per face (larger = farther; draw farthest first). */
  depth: Record<FaceId, number>;
}

export interface ProjectionOptions {
  /** Inverse of the live camera world quaternion (camera rotation inverted). */
  qInv: Quat;
  /** Projected cube half-size in px. */
  scale: number;
  /** SVG center coordinates. */
  cx: number;
  cy: number;
}

/** Project the cube graph into widget screen space for one camera rotation. */
export function projectCube(o: ProjectionOptions): ProjectedCube {
  const view = {} as Record<VertexKey, Vec3>;
  const screen = {} as Record<VertexKey, [number, number]>;
  for (const k of CUBE_VERTEX_KEYS) {
    const p = parseVertex(k);
    const r = qRotate(o.qInv, p);
    view[k] = r;
    screen[k] = [o.cx + r.x * o.scale, o.cy - r.y * o.scale];
  }

  const faceNormalView = {} as Record<FaceId, Vec3>;
  const facing = {} as Record<FaceId, number>;
  const visible = {} as Record<FaceId, boolean>;
  const depth = {} as Record<FaceId, number>;

  for (const f of Object.keys(CUBE_GRAPH.faces) as FaceId[]) {
    const n = qRotate(o.qInv, CUBE_GRAPH.faces[f].normal);
    faceNormalView[f] = n;
    facing[f] = Math.max(0, n.z);
    visible[f] = n.z > 0.02;
    // Face center depth (view z; larger = closer to viewer since +z faces it).
    const c = CUBE_GRAPH.faces[f].vertices
      .map((k) => view[k])
      .reduce((acc, p) => ({ x: acc.x + p.x / 4, y: acc.y + p.y / 4, z: acc.z + p.z / 4 }), { x: 0, y: 0, z: 0 });
    depth[f] = -c.z; // larger = farther from the viewer
  }

  const edgeVisible = {} as Record<EdgeId, boolean>;
  for (const e of Object.keys(CUBE_GRAPH.edges) as EdgeId[]) {
    const [fa, fb] = CUBE_GRAPH.edges[e].faces;
    edgeVisible[e] = visible[fa] || visible[fb];
  }

  const cornerVisible = {} as Record<CornerId, boolean>;
  for (const c of Object.keys(CUBE_GRAPH.corners) as CornerId[]) {
    const fs = CUBE_GRAPH.corners[c].faces;
    cornerVisible[c] = visible[fs[0]] || visible[fs[1]] || visible[fs[2]];
  }

  return { view, screen, faceNormalView, facing, visible, edgeVisible, cornerVisible, depth };
}

/* ── Screen-space shapes ───────────────────────────────────────────────── */

/** SVG points string for a face polygon. */
export function facePoints(pc: ProjectedCube, f: FaceId): string {
  return CUBE_GRAPH.faces[f].vertices
    .map((k) => pc.screen[k].map((n) => n.toFixed(2)).join(","))
    .join(" ");
}

/** Thin quad strip along a cube edge (screen space), for hit targets. */
export function edgeStripPoints(pc: ProjectedCube, e: EdgeId, width: number): string {
  const { a, b } = CUBE_GRAPH.edges[e];
  const [x1, y1] = pc.screen[a];
  const [x2, y2] = pc.screen[b];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const px = (-dy / len) * (width / 2);
  const py = (dx / len) * (width / 2);
  const f = (n: number) => n.toFixed(2);
  return `${f(x1 + px)},${f(y1 + py)} ${f(x2 + px)},${f(y2 + py)} ${f(x2 - px)},${f(y2 - py)} ${f(x1 - px)},${f(y1 - py)}`;
}

/**
 * Screen position + visibility of a world-horizontal compass direction
 * (used for the N/E/S/W ring). worldDir must be a unit vector in world axes.
 */
export function compassScreenPos(
  worldDir: Vec3,
  o: Pick<ProjectionOptions, "qInv" | "cx" | "cy">,
  ringRadius: number,
): { x: number; y: number; behind: number } {
  const r = qRotate(o.qInv, worldDir);
  return {
    x: o.cx + r.x * ringRadius,
    y: o.cy - r.y * ringRadius,
    // How much the direction points away from the viewer (0 = at the sides).
    behind: Math.max(0, r.z),
  };
}
