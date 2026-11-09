/** Helpers shared by the mouse-orbit handlers (MMB+modifier orbit, Shift+LMB orbit). */
import * as THREE from "three";

type Any = Record<string, any>;

/**
 * The orbit maths use THREE.Spherical, which assumes world +Y is up. If camera.up was left tilted by an earlier
 * view change (Top view, saved viewpoint, section view) the orbit rolled the picture instead of turning it.
 * Restore +Y and rebuild camera-controls' orbit basis once at the start of a drag.
 * Returns true when it had to change something.
 */
export function ensureUprightForOrbit(cam: Any | null, controls: Any | null): boolean {
  if (!cam?.up) return false;
  const up = cam.up as THREE.Vector3;
  if (Math.abs(up.x) < 1e-6 && Math.abs(up.y - 1) < 1e-6 && Math.abs(up.z) < 1e-6) return false;
  up.set(0, 1, 0);
  try { controls?.updateCameraUp?.(); } catch { /* */ }
  try { cam.updateMatrixWorld?.(); } catch { /* */ }
  return true;
}

/**
 * Run `apply` at most once per animation frame with the latest arguments. Pointer events can arrive far faster than
 * the screen refreshes (1000 Hz mice); applying the camera for each one made orbiting stutter and hang.
 * `flush()` applies a pending update immediately (call it when the drag ends); `cancel()` drops it.
 */
export function frameCoalesced<A extends unknown[]>(apply: (...args: A) => void): { push: (...args: A) => void; flush: () => void; cancel: () => void } {
  let pending: A | null = null;
  let raf = 0;
  const run = () => {
    raf = 0;
    const a = pending; pending = null;
    if (a) apply(...a);
  };
  return {
    push(...args: A) {
      pending = args;
      if (!raf) raf = (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f: FrameRequestCallback) => setTimeout(() => f(0), 16) as unknown as number)(run);
    },
    flush() {
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      raf = 0; run();
    },
    cancel() {
      if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
      raf = 0; pending = null;
    },
  };
}
