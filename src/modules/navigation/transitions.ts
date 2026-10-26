/**
 * Camera transition engine — quaternion-based, cancellation-safe.
 *
 * Orientation is interpolated with quaternion slerp (shortest arc, no Euler
 * discontinuities, no camera flips between opposite faces). Position is
 * reconstructed each step as target + dir(t) · dist(t), so the orbit pivot
 * and viewing distance animate independently while the up vector rides the
 * interpolated orientation — free roll continuity without gimbal flips.
 *
 * The class is deliberately frame-source agnostic: the widget drives it from
 * requestAnimationFrame, tests call advance() directly.
 */
import * as THREE from "three";
import type { ViewSpec } from "./types";

export interface TransitionEndpoint {
  /** Full camera orientation (basis: right/up/dir with dir = pos − target). */
  q: THREE.Quaternion;
  /** Orbit pivot. */
  target: THREE.Vector3;
  /** Camera distance from the pivot. */
  dist: number;
}

export interface TransitionSample {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  up: THREE.Vector3;
  done: boolean;
}

const DIR_AXIS = new THREE.Vector3(0, 0, 1);
const UP_AXIS = new THREE.Vector3(0, 1, 0);

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Build the full orientation quaternion for a ViewSpec (look-at basis). */
export function quaternionForSpec(spec: ViewSpec): THREE.Quaternion {
  const dir = spec.dir.clone().normalize();
  const right = spec.up.clone().cross(dir).normalize();
  const up = dir.clone().cross(right).normalize();
  const m = new THREE.Matrix4().makeBasis(right, up, dir);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

export class CameraTransition {
  private q0: THREE.Quaternion;
  private q1: THREE.Quaternion;
  private t0: THREE.Vector3;
  private t1: THREE.Vector3;
  private d0: number;
  private d1: number;
  private durationMs: number;
  private elapsed = 0;
  private cancelled = false;
  private finished = false;

  constructor(from: TransitionEndpoint, to: TransitionEndpoint, durationMs: number) {
    this.q0 = from.q.clone();
    this.q1 = to.q.clone();
    this.t0 = from.target.clone();
    this.t1 = to.target.clone();
    this.d0 = Math.max(1e-3, from.dist);
    this.d1 = Math.max(1e-3, to.dist);
    this.durationMs = Math.max(1, durationMs);
  }

  static fromSpec(from: TransitionEndpoint, spec: ViewSpec, target: THREE.Vector3, dist: number, durationMs: number): CameraTransition {
    return new CameraTransition(from, { q: quaternionForSpec(spec), target, dist }, durationMs);
  }

  cancel(): void {
    this.cancelled = true;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  /** Elapsed fraction 0..1 (eased). */
  get progress(): number {
    const t = THREE.MathUtils.clamp(this.elapsed / this.durationMs, 0, 1);
    return easeInOutCubic(t);
  }

  /**
   * Advance by dtMs and produce the camera sample to apply. Returns the
   * sample with done=true on the final frame (or immediately when cancelled).
   */
  advance(dtMs: number): TransitionSample {
    if (this.cancelled) {
      this.finished = true;
      return { pos: new THREE.Vector3(), target: new THREE.Vector3(), up: new THREE.Vector3(), done: true };
    }
    this.elapsed += Math.max(0, dtMs);
    const t = this.progress;
    const q = new THREE.Quaternion().slerpQuaternions(this.q0, this.q1, t);
    const target = new THREE.Vector3().lerpVectors(this.t0, this.t1, t);
    const dist = THREE.MathUtils.lerp(this.d0, this.d1, t);
    const dir = DIR_AXIS.clone().applyQuaternion(q).normalize();
    const up = UP_AXIS.clone().applyQuaternion(q).normalize();
    const pos = target.clone().addScaledVector(dir, dist);
    const done = t >= 1;
    if (done) this.finished = true;
    return { pos, target, up, done };
  }

  isFinished(): boolean {
    return this.finished;
  }

  /** The endpoint this transition converges to (for pre-saving Home states). */
  get endpoint(): TransitionEndpoint {
    return { q: this.q1.clone(), target: this.t1.clone(), dist: this.d1 };
  }
}

/** Extract a TransitionEndpoint from live camera vectors. */
export function endpointFrom(pos: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3): TransitionEndpoint {
  const dir = pos.clone().sub(target);
  const dist = Math.max(dir.length(), 1e-3);
  dir.normalize();
  const u = up.clone();
  // Orthonormalize so a slightly tilted live up can't poison the basis.
  u.addScaledVector(dir, -u.dot(dir));
  if (u.lengthSq() < 1e-10) {
    u.set(0, 1, 0).addScaledVector(dir, -dir.y);
    if (u.lengthSq() < 1e-10) u.set(1, 0, 0);
  }
  u.normalize();
  const q = quaternionForSpec({ dir, up: u });
  return { q, target: target.clone(), dist };
}
