import * as THREE from "three";
import { ctx } from "./context";
import { axisDistance, targetAhead } from "./view-lock";

/**
 * Make `point` the orbit pivot WITHOUT re-aiming the camera.
 *
 * The camera-controls target is placed straight ahead on the current view
 * axis at the pivot's depth, so position and orientation stay exactly as the
 * user left them (selecting an element must not rotate the view). Rotation
 * modules that orbit around a selection use their own pivot (window.__OBS_ORBIT_PIVOT).
 */
export function setOrbitTargetKeepingView(point: THREE.Vector3): void {
  const wrap: any = (ctx as any).world?.camera;
  const cam: THREE.Camera | undefined = wrap?.three;
  const controls: any = wrap?.controls;
  if (!cam || !controls || !point || !Number.isFinite(point.x)) return;
  const fwd = cam.getWorldDirection(new THREE.Vector3());
  const pos: [number, number, number] = [cam.position.x, cam.position.y, cam.position.z];
  const d = axisDistance(pos, [point.x, point.y, point.z], [fwd.x, fwd.y, fwd.z], 0.5);
  const t = targetAhead(pos, [fwd.x, fwd.y, fwd.z], d);
  try {
    if (typeof controls.setLookAt === "function") {
      controls.setLookAt(pos[0], pos[1], pos[2], t[0], t[1], t[2], false);
    } else if (controls.target?.isVector3) {
      controls.target.set(t[0], t[1], t[2]);
    }
    controls.update?.(0);
  } catch { /* */ }
}
