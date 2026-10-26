/**
 * Home view + orientation persistence.
 *
 * Follows the repo's saved-views strategy: localStorage under an `obs.`
 * prefix, keyed per project with a `__global__` fallback. Every read is
 * validated — corrupted, outdated or tampered state degrades to defaults
 * instead of poisoning the camera.
 */
import * as THREE from "three";
import type {
  HomeViewState,
  KeyValueStore,
  OrientationMapping,
} from "./types";
import { DEFAULT_ORIENTATION, isValidMapping } from "./orientation";

const HOME_PREFIX = "obs.navigation.home.";
const ORIENTATION_PREFIX = "obs.navigation.orientation.";

/** Per-project storage key with the same fallback convention as saved-views. */
export function homeStorageKey(projectId: string | null | undefined): string {
  return HOME_PREFIX + (projectId || "__global__");
}

export function orientationStorageKey(projectId: string | null | undefined): string {
  return ORIENTATION_PREFIX + (projectId || "__global__");
}

/* ── Validation ────────────────────────────────────────────────────────── */

type Vec3Tuple = [number, number, number];

function isFiniteTuple(x: unknown): x is Vec3Tuple {
  return (
    Array.isArray(x) && x.length >= 3 &&
    x.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function isProjection(x: unknown): x is HomeViewState["projection"] {
  return x === "perspective" || x === "orthographic";
}

function isNavigationMode(x: unknown): x is HomeViewState["navigationMode"] {
  return isProjection(x) || x === "perspective-ortho-faces";
}

/**
 * Validate + normalize a parsed Home view. Returns null for anything that
 * cannot faithfully reproduce a camera (NaN positions, zero-length
 * pos−target, unknown projection strings, absurd fov values...).
 */
export function validateHome(raw: unknown): HomeViewState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteTuple(r.pos) || !isFiniteTuple(r.target)) return null;
  if (!isProjection(r.projection)) return null;
  if (typeof r.savedAt !== "number" || !Number.isFinite(r.savedAt)) return null;

  const dx = r.pos[0] - r.target[0];
  const dy = r.pos[1] - r.target[1];
  const dz = r.pos[2] - r.target[2];
  if (Math.hypot(dx, dy, dz) < 1e-9) return null; // pos == target is unrestorable

  const out: HomeViewState = {
    pos: [r.pos[0], r.pos[1], r.pos[2]],
    target: [r.target[0], r.target[1], r.target[2]],
    projection: r.projection,
    savedAt: r.savedAt,
  };

  if (r.up !== undefined) {
    if (!isFiniteTuple(r.up)) return null;
    const len = Math.hypot(r.up[0], r.up[1], r.up[2]);
    if (len < 1e-9) return null;
    out.up = [r.up[0] / len, r.up[1] / len, r.up[2] / len];
  }
  if (r.navigationMode !== undefined) {
    if (!isNavigationMode(r.navigationMode)) return null;
    out.navigationMode = r.navigationMode;
  }
  if (r.fov !== undefined) {
    if (typeof r.fov !== "number" || !Number.isFinite(r.fov) || r.fov < 5 || r.fov > 150) return null;
    out.fov = r.fov;
  }
  if (r.orthoHalfHeight !== undefined) {
    if (typeof r.orthoHalfHeight !== "number" || !Number.isFinite(r.orthoHalfHeight) || r.orthoHalfHeight <= 0) return null;
    out.orthoHalfHeight = r.orthoHalfHeight;
  }
  return out;
}

/** Parse + validate a stored JSON string (or an already-parsed object). */
export function parseHome(raw: string | null | unknown): HomeViewState | null {
  if (raw == null) return null;
  if (typeof raw === "object") return validateHome(raw);
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64 * 1024) return null;
  try {
    return validateHome(JSON.parse(raw));
  } catch {
    return null;
  }
}

/* ── Store access ──────────────────────────────────────────────────────── */

export function loadHome(store: KeyValueStore, key: string): HomeViewState | null {
  try {
    return parseHome(store.getItem(key));
  } catch {
    return null;
  }
}

export function saveHome(store: KeyValueStore, key: string, state: HomeViewState): void {
  try {
    const clean = validateHome(state);
    if (clean) store.setItem(key, JSON.stringify(clean));
  } catch {
    /* storage unavailable (private mode etc.) — Home stays in-memory only */
  }
}

export function clearHome(store: KeyValueStore, key: string): void {
  try { store.removeItem(key); } catch { /* */ }
}

/* ── Orientation mapping persistence ───────────────────────────────────── */

function tupleToVec3(x: unknown): THREE.Vector3 | null {
  if (!isFiniteTuple(x)) return null;
  return new THREE.Vector3(x[0], x[1], x[2]);
}

function validateMapping(raw: unknown): OrientationMapping | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const front = r.front, top = r.top;
  if (!front || !top) return null;
  const fDir = tupleToVec3(front.dir), fUp = tupleToVec3(front.up);
  const tDir = tupleToVec3(top.dir), tUp = tupleToVec3(top.up);
  if (!fDir || !fUp || !tDir || !tUp) return null;
  const mapping: OrientationMapping = {
    front: { dir: fDir.normalize(), up: fUp.normalize() },
    top: { dir: tDir.normalize(), up: tUp.normalize() },
  };
  return isValidMapping(mapping) ? mapping : null;
}

export function loadOrientationMapping(store: KeyValueStore, key: string): OrientationMapping | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateMapping(parsed);
  } catch {
    return null;
  }
}

export function saveOrientationMapping(store: KeyValueStore, key: string, m: OrientationMapping): void {
  try {
    const payload = {
      front: { dir: m.front.dir.toArray(), up: m.front.up.toArray() },
      top: { dir: m.top.dir.toArray(), up: m.top.up.toArray() },
    };
    store.setItem(key, JSON.stringify(payload));
  } catch {
    /* */
  }
}

export function defaultOrientation(): OrientationMapping {
  return {
    front: { dir: DEFAULT_ORIENTATION.front.dir.clone(), up: DEFAULT_ORIENTATION.front.up.clone() },
    top: { dir: DEFAULT_ORIENTATION.top.dir.clone(), up: DEFAULT_ORIENTATION.top.up.clone() },
  };
}
