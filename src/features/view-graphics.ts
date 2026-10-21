/**
 * View / graphics control layer.
 *
 * Provides persistent presentation presets that act on the current Three.js
 * scene, including loaded Fragments and native authored geometry when their
 * materials expose the standard Three.js graphics properties.
 */
import * as THREE from "three";
import { ctx } from "../core/context";

export type VisualPreset = "shaded" | "shaded-edges" | "wireframe" | "hidden-line";
export type BackgroundPreset = "studio" | "paper" | "night";

let visualPreset: VisualPreset = "shaded";
let sceneTransparency = 0;
let sunEnabled = true;
let background: BackgroundPreset = "studio";

// WeakMap: disposed materials must not be kept alive by this cache.
const original = new WeakMap<THREE.Material, {
  opacity: number;
  transparent: boolean;
  wireframe?: boolean;
  depthWrite?: boolean;
  color?: THREE.Color;
}>();
let tracked = false;

function remember(mat: THREE.Material): void {
  if (original.has(mat)) return;
  const m = mat as THREE.Material & { wireframe?: boolean; depthWrite?: boolean; color?: THREE.Color };
  original.set(mat, {
    opacity: m.opacity,
    transparent: m.transparent,
    wireframe: m.wireframe,
    depthWrite: m.depthWrite,
    color: m.color?.clone?.(),
  });
}

/** True for the transform gizmo and other viewport helpers (not model geometry). */
function isUiHelper(obj: any): boolean {
  for (let o = obj; o; o = o.parent) {
    if (o.name === "obs-gizmo" || o.userData?.obsHelper) return true;
  }
  return false;
}

function eachMaterial(cb: (mat: THREE.Material) => void): void {
  if (!ctx.world?.scene?.three) return;
  ctx.world.scene.three.traverse((obj: any) => {
    if (!obj?.isMesh || !obj.material) return;
    if (isUiHelper(obj)) return; // gizmo/overlays must not turn wireframe/transparent
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat) continue;
      remember(mat);
      cb(mat as THREE.Material);
    }
  });
  tracked = true;
}

export function setVisualPreset(preset: VisualPreset): void {
  visualPreset = preset;
  eachMaterial((mat) => {
    const m = mat as THREE.Material & { wireframe?: boolean; depthWrite?: boolean };
    const base = original.get(mat);
    if (!base) return;
    if (preset === "wireframe") {
      if (typeof m.wireframe === "boolean") m.wireframe = true;
      m.transparent = true;
      m.opacity = Math.max(0.35, 1 - sceneTransparency / 100);
    } else if (preset === "hidden-line") {
      if (typeof m.wireframe === "boolean") m.wireframe = false;
      m.transparent = true;
      m.opacity = Math.max(0.18, 0.78 - sceneTransparency / 120);
      m.depthWrite = false;
    } else {
      if (typeof m.wireframe === "boolean") m.wireframe = false;
      m.transparent = sceneTransparency > 0 || base.transparent;
      m.opacity = sceneTransparency > 0 ? (1 - sceneTransparency / 100) : base.opacity;
      m.depthWrite = base.depthWrite ?? true;
    }
    m.needsUpdate = true;
  });
}

export function getVisualPreset(): VisualPreset { return visualPreset; }

export function setSceneTransparency(value: number): void {
  sceneTransparency = Math.max(0, Math.min(90, Number(value) || 0));
  setVisualPreset(visualPreset);
}

export function getSceneTransparency(): number { return sceneTransparency; }

export function setSunEnabled(on: boolean): void {
  sunEnabled = !!on;
  if (!ctx.world?.scene?.three) return;
  ctx.world.scene.three.traverse((obj: any) => {
    if (obj?.isDirectionalLight) obj.visible = sunEnabled;
  });
}

export function isSunEnabled(): boolean { return sunEnabled; }

export function setSceneBackground(preset: BackgroundPreset): void {
  background = preset;
  if (!ctx.world?.scene?.three) return;
  const color = preset === "paper" ? 0xf3f4f6 : preset === "night" ? 0x05070b : 0x0f1117;
  ctx.world.scene.three.background = new THREE.Color(color);
  try { window.dispatchEvent(new CustomEvent("obs:scene-background", { detail: preset })); } catch { /* */ }
}

export function getSceneBackground(): BackgroundPreset { return background; }

export function refreshViewGraphics(): void {
  if (!ctx.world?.scene?.three) return;
  setSceneBackground(background);
  setSunEnabled(sunEnabled);
  if (tracked) setVisualPreset(visualPreset);
}
