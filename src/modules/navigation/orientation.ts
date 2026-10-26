/**
 * Orientation mapping — the single source of truth for ViewCube navigation.
 *
 * Every face, edge and corner target is DERIVED from two user-configurable
 * anchors (Front and Top) instead of being a table of unrelated hardcoded
 * camera positions. "Set current view as Front/Top" only rewrites the
 * anchors; the whole cube follows.
 *
 * Conventions (matching features/camera-tools.ts gotoExactView):
 *   front = +Z, up = +Y · right = +X · back = −Z · left = −X
 *   top   = +Y, up = (0,0,−1) · bottom = −Y, up = (0,0,+1)
 * Project North is world +Z (see modules/north/north.ts).
 */
import * as THREE from "three";
import type {
  CubeCorner,
  CubeEdge,
  CubeFace,
  DerivedOrientation,
  OrientationMapping,
  ViewSpec,
} from "./types";
import { CUBE_CORNERS, RING_EDGE_PAIRS } from "./types";

const WORLD_Y = new THREE.Vector3(0, 1, 0);

/** Unit helper. */
function v(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z).normalize();
}

/** Canonical default mapping — identical to gotoExactView's table. */
export const DEFAULT_ORIENTATION: Readonly<OrientationMapping> = {
  front: { dir: v(0, 0, 1), up: v(0, 1, 0) },
  top: { dir: v(0, 1, 0), up: v(0, 0, -1) },
};

/** Clone a spec (dirs/ups are mutable THREE objects — never share them). */
export function cloneSpec(s: ViewSpec): ViewSpec {
  return { dir: s.dir.clone(), up: s.up.clone() };
}

export function cloneMapping(m: OrientationMapping): OrientationMapping {
  return { front: cloneSpec(m.front), top: cloneSpec(m.top) };
}

function finiteUnit(x: THREE.Vector3): boolean {
  return (
    Number.isFinite(x.x) && Number.isFinite(x.y) && Number.isFinite(x.z) &&
    Math.abs(x.length() - 1) < 1e-3
  );
}

/**
 * A mapping is valid when both anchors are unit/orthogonal pairs and the
 * anchors are not parallel to each other (otherwise the cube cannot be
 * derived consistently).
 */
export function isValidMapping(m: OrientationMapping | null | undefined): m is OrientationMapping {
  if (!m || !m.front || !m.top) return false;
  const f = m.front, t = m.top;
  if (!finiteUnit(f.dir) || !finiteUnit(f.up) || !finiteUnit(t.dir) || !finiteUnit(t.up)) return false;
  if (Math.abs(f.dir.dot(f.up)) > 1e-3) return false;
  if (Math.abs(t.dir.dot(t.up)) > 1e-3) return false;
  if (Math.abs(f.dir.dot(t.dir)) > 0.999) return false;
  return true;
}

/** Orthonormalize `up` against `dir`. Returns null when degenerate. */
export function orthogonalizeUp(up: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
  const d = dir.clone().normalize();
  const u = up.clone().addScaledVector(d, -up.dot(d));
  if (u.lengthSq() < 1e-10) return null;
  return u.normalize();
}

/** Build a ViewSpec from dir with a hint up, orthogonalizing the hint. */
export function makeSpec(dir: THREE.Vector3, upHint: THREE.Vector3): ViewSpec | null {
  const d = dir.clone();
  if (d.lengthSq() < 1e-12) return null;
  d.normalize();
  const u = orthogonalizeUp(upHint, d);
  if (!u) return null;
  return { dir: d, up: u };
}

/** Camera-right vector for a view spec: up × dir (THREE lookAt convention). */
export function rightOf(spec: ViewSpec): THREE.Vector3 {
  return spec.up.clone().cross(spec.dir).normalize();
}

/**
 * Derive the six face specs from the anchor mapping.
 * back mirrors front; left/right are derived from front's frame;
 * top/bottom come from the top anchor (bottom up orthogonalizes front.dir).
 */
export function deriveFaces(m: OrientationMapping): Record<CubeFace, ViewSpec> {
  const front = cloneSpec(m.front);
  const back: ViewSpec = { dir: front.dir.clone().negate(), up: front.up.clone() };
  const rightDir = rightOf(front);
  const right: ViewSpec = { dir: rightDir, up: front.up.clone() };
  const left: ViewSpec = { dir: rightDir.clone().negate(), up: front.up.clone() };
  const top = cloneSpec(m.top);
  const bottomDir = top.dir.clone().negate();
  const bottomUp = orthogonalizeUp(front.dir, bottomDir) ?? top.up.clone().negate();
  const bottomUpFixed = orthogonalizeUp(bottomUp, bottomDir) ?? bottomUp;
  const bottom: ViewSpec = { dir: bottomDir, up: bottomUpFixed };
  return { front, back, right, left, top, bottom };
}

/** Orthogonalized up for an edge/corner whose direction is a sum of face dirs. */
function summedSpec(dirs: THREE.Vector3[], upHint: THREE.Vector3): ViewSpec | null {
  const d = new THREE.Vector3();
  for (const x of dirs) d.add(x);
  if (d.lengthSq() < 1e-12) return null;
  d.normalize();
  const u = orthogonalizeUp(upHint, d);
  if (!u) return null;
  return { dir: d, up: u };
}

/**
 * Derive all twelve edge specs. Ring edges keep the ring up (no roll);
 * vertical edges orthogonalize the adjacent ring face's up.
 */
export function deriveEdges(faces: Record<CubeFace, ViewSpec>): Record<CubeEdge, ViewSpec> {
  const out = {} as Record<CubeEdge, ViewSpec>;
  const ringUp = faces.front.up;

  for (const [a, b, id] of RING_EDGE_PAIRS) {
    const s = summedSpec([faces[a].dir, faces[b].dir], ringUp);
    out[id] = s ?? cloneSpec(faces[a]);
  }
  const verticals: Array<[CubeFace, "top" | "bottom", CubeEdge]> = [
    ["front", "top", "top-front"], ["back", "top", "top-back"],
    ["right", "top", "top-right"], ["left", "top", "top-left"],
    ["front", "bottom", "bottom-front"], ["back", "bottom", "bottom-back"],
    ["right", "bottom", "bottom-right"], ["left", "bottom", "bottom-left"],
  ];
  for (const [ring, pole, id] of verticals) {
    const s = summedSpec([faces[ring].dir, faces[pole].dir], faces[ring].up);
    out[id] = s ?? cloneSpec(faces[ring]);
  }
  return out;
}

/** Derive all eight corner specs (three adjacent face dirs, stable up). */
export function deriveCorners(
  faces: Record<CubeFace, ViewSpec>,
): Record<CubeCorner, ViewSpec> {
  const out = {} as Record<CubeCorner, ViewSpec>;
  const defs: Array<[CubeFace, CubeFace, CubeFace, CubeCorner]> = [
    ["front", "right", "top", "top-front-right"],
    ["front", "left", "top", "top-front-left"],
    ["back", "right", "top", "top-back-right"],
    ["back", "left", "top", "top-back-left"],
    ["front", "right", "bottom", "bottom-front-right"],
    ["front", "left", "bottom", "bottom-front-left"],
    ["back", "right", "bottom", "bottom-back-right"],
    ["back", "left", "bottom", "bottom-back-left"],
  ];
  for (const [a, b, pole, id] of defs) {
    const s = summedSpec([faces[a].dir, faces[b].dir, faces[pole].dir], faces[a].up);
    out[id] = s ?? cloneSpec(faces[a]);
  }
  return out;
}

/** Derive the full 26-target orientation from the anchor mapping. */
export function deriveOrientation(m: OrientationMapping): DerivedOrientation {
  const faces = deriveFaces(m);
  return { faces, edges: deriveEdges(faces), corners: deriveCorners(faces) };
}

const FACE_LABEL: Record<CubeFace, string> = {
  front: "Front", back: "Back", left: "Left", right: "Right", top: "Top", bottom: "Bottom",
};

/** Human label for any orientation id (edges/corners hyphenated ids). */
export function orientationLabel(kind: string, id: string): string {
  if (kind === "face") return FACE_LABEL[id as CubeFace] ?? id;
  if (kind === "edge") {
    if (id.startsWith("top-")) return `Top ${id.slice(4)}`;
    if (id.startsWith("bottom-")) return `Bottom ${id.slice(7)}`;
    return id.split("-").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
  }
  // corner: "top-front-right" -> "Top Front Right"
  return id.split("-").map((w) => w[0]?.toUpperCase() + w.slice(1)).join(" ");
}

/** All 26 targets as a flat list of {kind, id, spec}. */
export function allTargets(d: DerivedOrientation): Array<{ kind: string; id: string; spec: ViewSpec }> {
  const out: Array<{ kind: string; id: string; spec: ViewSpec }> = [];
  for (const f of Object.keys(d.faces) as CubeFace[]) out.push({ kind: "face", id: f, spec: d.faces[f] });
  for (const e of Object.keys(d.edges) as CubeEdge[]) out.push({ kind: "edge", id: e, spec: d.edges[e] });
  for (const c of CUBE_CORNERS) out.push({ kind: "corner", id: c, spec: d.corners[c] });
  return out;
}

/**
 * Nearest orientation to an arbitrary view direction — drives the
 * current-orientation indicator (never a fixed, misleading label).
 */
export function nearestOrientation(
  viewDir: THREE.Vector3,
  d: DerivedOrientation,
): { kind: string; id: string; angle: number; label: string } | null {
  if (viewDir.lengthSq() < 1e-12) return null;
  const n = viewDir.clone().normalize();
  let best: { kind: string; id: string; angle: number; label: string } | null = null;
  for (const t of allTargets(d)) {
    const dot = THREE.MathUtils.clamp(n.dot(t.spec.dir), -1, 1);
    const angle = Math.acos(dot);
    if (!best || angle < best.angle) {
      best = { kind: t.kind, id: t.id, angle, label: orientationLabel(t.kind, t.id) };
    }
  }
  return best;
}

/* ── Rotation primitives (Rodrigues) ───────────────────────────────────── */

/** Rodrigues rotation of `x` around unit axis `axis` by `angle` radians. */
export function rotateAroundAxis(x: THREE.Vector3, axis: THREE.Vector3, angle: number): THREE.Vector3 {
  const a = axis.clone().normalize();
  const c = Math.cos(angle), s = Math.sin(angle);
  return x.clone()
    .multiplyScalar(c)
    .add(a.clone().multiplyScalar(x.dot(a) * (1 - c)))
    .add(a.clone().cross(x).multiplyScalar(s));
}

/**
 * Rotate a view spec around the world vertical (screen-level spin used by
 * the left/right/clockwise/counterclockwise arrows). Roll is preserved
 * exactly because up rotates with dir.
 */
export function spinSpec(spec: ViewSpec, angleDeg: number): ViewSpec | null {
  const angle = THREE.MathUtils.degToRad(angleDeg);
  const dir = rotateAroundAxis(spec.dir, WORLD_Y, angle);
  const up = rotateAroundAxis(spec.up, WORLD_Y, angle);
  if (Math.abs(dir.y) > 0.99999) return null; // degenerate pole — refuse
  const u = orthogonalizeUp(up, dir);
  if (!u) return null;
  return { dir: dir.normalize(), up: u };
}

/**
 * Pitch a view spec up/down around the screen-right axis. Positive angles
 * arc the camera UP over the model (world elevation increases). Refused
 * (null) when the step would not increase elevation in the requested
 * direction — at the poles the arrow is a no-op instead of flipping the
 * camera over, which keeps the up vector stable (Autodesk behavior).
 */
export function pitchSpec(spec: ViewSpec, angleDeg: number): ViewSpec | null {
  if (angleDeg === 0) return cloneSpec(spec);
  // Rodrigues around +right by −angle arcs the direction toward +Y.
  const angle = THREE.MathUtils.degToRad(-angleDeg);
  const right = rightOf(spec);
  const dir = rotateAroundAxis(spec.dir, right, angle);
  const up = rotateAroundAxis(spec.up, right, angle);
  if (dir.lengthSq() < 1e-12) return null;
  dir.normalize();
  // Elevation-monotonic guard: "up" must raise the camera, "down" must
  // lower it. Crossing a pole would reverse this — refuse instead.
  if (angleDeg > 0 && dir.y <= spec.dir.y + 1e-9) return null;
  if (angleDeg < 0 && dir.y >= spec.dir.y - 1e-9) return null;
  const u = orthogonalizeUp(up, dir);
  if (!u) return null;
  return { dir, up: u };
}

/** Snap a direction to the nearest cube-target id (used by tests/UI). */
export function specForTarget(d: DerivedOrientation, kind: string, id: string): ViewSpec | null {
  if (kind === "face") return (d.faces as Record<string, ViewSpec>)[id] ?? null;
  if (kind === "edge") return (d.edges as Record<string, ViewSpec>)[id] ?? null;
  if (kind === "corner") return (d.corners as Record<string, ViewSpec>)[id] ?? null;
  return null;
}
