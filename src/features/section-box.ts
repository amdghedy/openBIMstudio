// BIM-style live Section Box with 6-face crop and reset.
import * as THREE from "three";
import { ctx } from "../core/context";
import { getSceneBox } from "./camera-tools";
import { registerCommand } from "./command-palette";

let box: THREE.Box3 | null = null;
let helper: THREE.Box3Helper | null = null;
let enabled = false;

function clipper(): any { return (ctx as any).clipper; }

export function isSectionBoxActive(): boolean { return enabled; }

export function toggleSectionBox(): boolean {
  if (enabled) disableSectionBox(); else enableSectionBox();
  return enabled;
}

export function enableSectionBox(padding = 1.0): void {
  if (enabled) return;
  const scene = getSceneBox();
  if (!scene || scene.isEmpty()) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Load a model first.", kind: "warn" },
    }));
    return;
  }
  box = scene.clone().expandByScalar(padding);
  buildHelper();
  applyClipping();
  enabled = true;
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: "Section Box ON - drag to crop", kind: "success" },
  }));
}

export function disableSectionBox(): void {
  if (!enabled) return;
  try { clipper()?.deleteAll?.(); } catch (e) { /* ignore */ }
  if (helper) {
    ctx.world.scene.three.remove(helper);
    try { helper.geometry?.dispose?.(); } catch (e) { /* ignore */ }
    const mat = helper.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose?.());
    else mat?.dispose?.();
    helper = null;
  }
  box = null;
  enabled = false;
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: "Section Box OFF", kind: "info" },
  }));
}

export function resetSectionBox(): void {
  if (!enabled) return;
  const scene = getSceneBox();
  if (scene && !scene.isEmpty()) box = scene.clone().expandByScalar(1.0);
  if (helper && box) {
    helper.box.copy(box);
    helper.updateMatrixWorld(true);
  }
  applyClipping();
}

function buildHelper(): void {
  if (!box) return;
  helper = new THREE.Box3Helper(box, new THREE.Color(0x22d3ee));
  helper.renderOrder = 999;
  const m = helper.material as THREE.LineBasicMaterial;
  if (m) m.depthTest = false;
  ctx.world.scene.three.add(helper);
}

function applyClipping(): void {
  if (!box) return;
  const c = clipper();
  if (!c) return;
  try {
    c.deleteAll?.();
    const min = box.min;
    const max = box.max;
    const planes = [
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), max.x),
      new THREE.Plane(new THREE.Vector3( 1, 0, 0), -min.x),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), max.y),
      new THREE.Plane(new THREE.Vector3(0,  1, 0), -min.y),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), max.z),
      new THREE.Plane(new THREE.Vector3(0, 0,  1), -min.z),
    ];
    for (const p of planes) c.create?.(p);
  } catch (err) {
    console.warn("[section-box] clipping failed", err);
  }
}

export function setupSectionBox(): void {
  (ctx.features as any).sectionBox = {
    enable: enableSectionBox,
    disable: disableSectionBox,
    toggle: toggleSectionBox,
    reset: resetSectionBox,
    isActive: isSectionBoxActive,
    getBox: () => box ? box.clone() : null,
    setBox: (b: THREE.Box3) => {
      box = b.clone();
      if (helper) helper.box.copy(box);
      applyClipping();
    },
  };

  try {
    registerCommand({
      id: "view.sectionBox",
      label: "View: Section Box (on/off)",
      category: "View",
      run: () => toggleSectionBox(),
    });
    registerCommand({
      id: "view.sectionBox.reset",
      label: "View: Reset Section Box",
      category: "View",
      run: () => resetSectionBox(),
      when: () => isSectionBoxActive(),
    });
  } catch (err) {
    console.warn("[section-box] command registration failed", err);
  }

  console.log("[section-box] ready");
}