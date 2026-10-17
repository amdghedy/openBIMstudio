import * as THREE from "three";
import { ctx } from "../core/context";

type Any = Record<string, any>;

let installed = false;
let enabled = true;
let timer: number | null = null;

// openbim-fix:lod-always-on -- LOD culling is permanently disabled.
// Every element stays visible regardless of distance or screen size.
// The flag is a constant so no runtime toggle can re-enable culling.
// The reported state stays ON to keep the toolbar button label stable.
const LOD_CULLING_DISABLED = true;

function c(): Any {
  return (ctx as Any) || (window as Any).__OBS_CTX__ || {};
}

function getAuthoringGroup(): Any | null {
  const cont = c();
  const auth = cont.features?.authoring as Any;

  return (
    auth?.getAuthoredGroup?.() ??
    auth?.group ??
    auth?.root ??
    auth?.three ??
    null
  );
}

function restoreAll(): void {
  const group = getAuthoringGroup();

  if (!group || typeof group.traverse !== "function") {
    return;
  }

  group.traverse((obj: Any) => {
    if (obj?.userData?.__obsLodHidden) {
      obj.visible = true;
      delete obj.userData.__obsLodHidden;
    }
  });
}

function applyLod(): void {
  if (!installed) {
    return;
  }

  // openbim-fix:lod-always-on -- never hide geometry.
  if (LOD_CULLING_DISABLED || !enabled) {
    restoreAll();
    return;
  }

  const cont = c();
  const cam = cont.world?.camera?.three as Any;
  const group = getAuthoringGroup();

  if (!cam || !group || typeof group.traverse !== "function") {
    return;
  }

  try {
    group.updateMatrixWorld?.(true);
    cam.updateMatrixWorld?.(true);
  } catch {
    // ignore
  }

  const cameraPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);

  group.traverse((obj: Any) => {
    if (!obj?.isMesh || !obj.geometry) {
      return;
    }

    const geo = obj.geometry;

    if (!geo.boundingSphere) {
      try {
        geo.computeBoundingSphere();
      } catch {
        return;
      }
    }

    const sphere = geo.boundingSphere;

    if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius <= 0) {
      return;
    }

    const center = new THREE.Vector3().copy(sphere.center).applyMatrix4(obj.matrixWorld);
    const radius = sphere.radius * Math.max(
      obj.matrixWorld.elements[0] ?? 1,
      obj.matrixWorld.elements[5] ?? 1,
      obj.matrixWorld.elements[10] ?? 1,
    );

    const dist = cameraPos.distanceTo(center);

    let hide = false;

    if (radius < 0.15 && dist > 30) {
      hide = true;
    } else if (radius < 0.6 && dist > 90) {
      hide = true;
    } else if (radius < 2 && dist > 250) {
      hide = true;
    }

    if (hide) {
      if (obj.visible) {
        obj.visible = false;
        obj.userData.__obsLodHidden = true;
      }
    } else if (obj.userData?.__obsLodHidden) {
      obj.visible = true;
      delete obj.userData.__obsLodHidden;
    }
  });
}

export function setLodEnabled(next: boolean): boolean {
  // openbim-fix:lod-always-on -- the toggle is a no-op. Culling is
  // permanently disabled so every detail stays visible.
  void next;
  enabled = true;
  restoreAll();
  return true;
}

export function isLodEnabled(): boolean {
  // openbim-fix:lod-always-on -- always report ON so the toolbar
  // button label never flips. Culling itself is skipped by
  // LOD_CULLING_DISABLED inside applyLod().
  return true;
}

export function setupLodManager(): void {
  if (installed) {
    return;
  }

  installed = true;

  timer = window.setInterval(applyLod, 250);

  (window as Any).__obsLodManager = {
    setEnabled: setLodEnabled,
    isEnabled: isLodEnabled,
    refresh: applyLod,
    restoreAll,
  };

  console.log("[lod-manager] ready");
}