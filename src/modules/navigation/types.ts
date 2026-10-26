/**
 * Navigation module — shared types.
 *
 * This module is DOM-free and unit-testable (same discipline as every other
 * src/modules engine). The DOM layer lives in src/features/viewcube.ts and
 * talks to the real viewer through the CameraAdapter interface defined here.
 */
import type * as THREE from "three";

/* ── Projection ────────────────────────────────────────────────────────── */

/** Core projection of the rendering camera. */
export type CoreProjection = "perspective" | "orthographic";

/**
 * Navigation-level projection mode.
 *
 * "perspective-ortho-faces" orbits freely in perspective, but cube face /
 * edge / corner snaps land as flat orthographic views (Autodesk Viewer
 * "Perspective with Ortho Faces"). Orbiting again returns to perspective.
 */
export type ProjectionMode = CoreProjection | "perspective-ortho-faces";

/* ── ViewCube topology ─────────────────────────────────────────────────── */

export type CubeFace = "front" | "back" | "left" | "right" | "top" | "bottom";

export const CUBE_FACES: readonly CubeFace[] = [
  "front", "back", "left", "right", "top", "bottom",
];

/** Ring order used to derive edges and corners (counter-clockwise from front). */
export const RING_ORDER: readonly CubeFace[] = ["front", "right", "back", "left"];

export type CubeEdge =
  | "front-right" | "back-right" | "front-left" | "back-left"
  | "top-front" | "top-back" | "top-right" | "top-left"
  | "bottom-front" | "bottom-back" | "bottom-right" | "bottom-left";

export const CUBE_EDGES: readonly CubeEdge[] = [
  "front-right", "back-right", "front-left", "back-left",
  "top-front", "top-back", "top-right", "top-left",
  "bottom-front", "bottom-back", "bottom-right", "bottom-left",
];

export type CubeCorner =
  | "top-front-right" | "top-front-left" | "top-back-right" | "top-back-left"
  | "bottom-front-right" | "bottom-front-left" | "bottom-back-right" | "bottom-back-left";

export const CUBE_CORNERS: readonly CubeCorner[] = [
  "top-front-right", "top-front-left", "top-back-right", "top-back-left",
  "bottom-front-right", "bottom-front-left", "bottom-back-right", "bottom-back-left",
];

/** Ring-pair edges (horizontal ring): [a, b] are adjacent ring faces. */
export const RING_EDGE_PAIRS: readonly [CubeFace, CubeFace, CubeEdge][] = [
  ["front", "right", "front-right"],
  ["right", "back", "back-right"],
  ["back", "left", "back-left"],
  ["left", "front", "front-left"],
];

/* ── Orientation ───────────────────────────────────────────────────────── */

/** A view direction plus a stable up vector (both unit, orthogonal). */
export interface ViewSpec {
  /** Direction from the orbit target toward the camera position (unit). */
  dir: THREE.Vector3;
  /** Camera up vector (unit, orthogonal to dir). */
  up: THREE.Vector3;
}

/**
 * User-customizable orientation mapping ("Set current view as Front/Top").
 * All 26 cube targets are derived from these two anchors.
 */
export interface OrientationMapping {
  front: ViewSpec;
  top: ViewSpec;
}

export type OrientationKind = "face" | "edge" | "corner";

export interface OrientationTarget {
  kind: OrientationKind;
  id: string;
}

export interface DerivedOrientation {
  faces: Record<CubeFace, ViewSpec>;
  edges: Record<CubeEdge, ViewSpec>;
  corners: Record<CubeCorner, ViewSpec>;
}

export interface OrientationHit extends OrientationTarget {
  /** Angle (radians) between the current view direction and the target's. */
  angle: number;
  label: string;
}

/* ── Home view ─────────────────────────────────────────────────────────── */

/** Serialized Home view. Positions are world-space arrays for JSON safety. */
export interface HomeViewState {
  pos: [number, number, number];
  target: [number, number, number];
  /** Camera up at save time. Older entries restore with the project default. */
  up?: [number, number, number];
  projection: CoreProjection;
  /** Full navigation mode (perspective-ortho-faces included) when known. */
  navigationMode?: ProjectionMode;
  /** Vertical field of view in degrees (perspective restore). */
  fov?: number;
  /** Visible world half-height (orthographic restore). */
  orthoHalfHeight?: number;
  savedAt: number;
}

/* ── Configuration ─────────────────────────────────────────────────────── */

export interface NavigationConfig {
  /** Camera transition duration (ms). */
  transitionMs: number;
  /** Rotation-arrow step size (degrees). */
  rotateStepDeg: number;
  /** Framing padding multiplier applied to the bounding radius. */
  framingPadding: number;
  /** Hard floor for camera distance after any framing command. */
  minDistance: number;
  /** Continuous-rotation repeat interval while an arrow is held (ms). */
  rotateHoldMs: number;
}

export const DEFAULT_NAVIGATION_CONFIG: Readonly<NavigationConfig> = {
  transitionMs: 550,
  rotateStepDeg: 90,
  framingPadding: 1.15,
  minDistance: 1.0,
  rotateHoldMs: 260,
};

/* ── Camera adapter ────────────────────────────────────────────────────── */

/**
 * The controller's only door to the real viewer. The production adapter
 * wraps ctx.world.camera (ThatOpen OrthoPerspectiveCamera + camera-controls)
 * and the existing camera-tools functions; tests provide a recording mock.
 */
export interface CameraAdapter {
  position(): THREE.Vector3;
  /** Orbit target (camera-controls target, or a look-ahead fallback). */
  target(): THREE.Vector3;
  up(): THREE.Vector3;
  /** Vertical field of view in radians (perspective). */
  fovY(): number;
  /** Frustum aspect ratio (width / height, clamped away from 0). */
  aspect(): number;
  /** Visible world half-height in orthographic mode. */
  orthoHalfHeight(): number;
  setOrthoHalfHeight(h: number): void;
  projection(): CoreProjection;
  /** Switch the core projection. Returns false if the camera API rejected it. */
  setProjection(m: CoreProjection): boolean;
  /**
   * Drive the camera to a position/target/up. Implementations must route
   * through the existing controls (camera-controls setLookAt) so orbit,
   * pan, zoom and clipping stay synchronized.
   */
  lookAt(pos: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3, animate: boolean): void;
  /** Bounds used by Focus commands: selection AABB when present, else scene. */
  focusBounds(): THREE.Box3 | null;
  /** Whole visible scene bounds; null when empty or degenerate. */
  sceneBounds(): THREE.Box3 | null;
  /**
   * Fires when the user starts a manual camera gesture (orbit / pan / zoom),
   * so an active navigation transition can yield. Returns an unsubscribe fn.
   */
  onUserGesture(cb: () => void): () => void;
}

/* ── Storage ───────────────────────────────────────────────────────────── */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
