/**
 * Section cut caps - make a section cut look solid instead of hollow.
 *
 * Closed solids (walls, slabs, columns) show their INSIDE when clipped. Rendering back faces in a flat hatched "poche" colour
 * turns that inside into a cut face. The renderer has no stencil buffer, so the classic stencil cap is not available; this
 * needs no extra geometry and no extra draw calls - only a small fragment-shader change on the model's own materials.
 *
 * Honest scope: it applies to IFC models loaded through the fragments engine and shows the cut face of CLOSED solids. Open or
 * single-sided surfaces show the same colour on their back side. Transparent materials are left alone.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { registerCommand } from "./command-palette";

const PREF_KEY = "obs.sectionCaps";
let pref = true;
try { const v = localStorage.getItem(PREF_KEY); if (v === "0") pref = false; } catch { /* */ }

interface Saved { side: THREE.Side; onBeforeCompile: THREE.Material["onBeforeCompile"]; key: (() => string) | undefined }
const patched = new Map<THREE.Material, Saved>();
let wantActive = false;

const CAP_GLSL = `#include <dithering_fragment>
  if (!gl_FrontFacing) {
    float obsHatch = mod(gl_FragCoord.x + gl_FragCoord.y, 9.0);
    gl_FragColor = vec4(obsHatch < 1.5 ? vec3(0.16, 0.17, 0.20) : vec3(0.80, 0.83, 0.87), 1.0);
  }`;

function patchMaterial(m: THREE.Material): void {
  if (patched.has(m) || m.transparent || m.opacity < 1) return;
  patched.set(m, { side: m.side, onBeforeCompile: m.onBeforeCompile, key: m.customProgramCacheKey });
  const prev = m.onBeforeCompile;
  m.side = THREE.DoubleSide;
  m.onBeforeCompile = function (this: THREE.Material, shader: any, r: any) {
    prev?.call(this, shader, r);
    shader.fragmentShader = shader.fragmentShader.replace("#include <dithering_fragment>", CAP_GLSL);
  } as any;
  m.customProgramCacheKey = () => "obs-section-cap";
  m.needsUpdate = true;
}

function restoreAll(): void {
  for (const [m, s] of patched) {
    m.side = s.side; m.onBeforeCompile = s.onBeforeCompile; m.customProgramCacheKey = s.key as any; m.needsUpdate = true;
  }
  patched.clear();
}

function modelMaterials(): THREE.Material[] {
  const out: THREE.Material[] = [];
  const list = (ctx as any).fragments?.list as Iterable<[unknown, any]> | undefined;
  if (!list) return out;
  for (const [, model] of list) {
    model?.object?.traverse?.((o: any) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) out.push(m);
    });
  }
  return out;
}

/** Called by the Section Box whenever it is on (true) or off (false), and after every box edit. */
export function syncSectionCaps(sectionBoxOn: boolean): void {
  wantActive = sectionBoxOn;
  if (sectionBoxOn && pref) for (const m of modelMaterials()) patchMaterial(m);
  else restoreAll();
}

export function setSectionCapsEnabled(on: boolean): void {
  pref = on;
  try { localStorage.setItem(PREF_KEY, on ? "1" : "0"); } catch { /* */ }
  syncSectionCaps(wantActive);
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind: "info", message: `Section cut caps ${on ? "ON" : "OFF"}` } }));
}

export function isSectionCapsEnabled(): boolean { return pref; }
export function sectionCapsPatchedCount(): number { return patched.size; }

export function setupSectionCaps(): void {
  const f = ((ctx as any).features ??= {});
  f.sectionCaps = { set: setSectionCapsEnabled, isEnabled: isSectionCapsEnabled, patched: sectionCapsPatchedCount };
  registerCommand({
    id: "view.sectionBox.caps",
    label: "View: Section cut caps (solid hatched cut faces on/off)",
    category: "View",
    hint: "Show the inside of clipped solids as a solid hatched cut face instead of leaving the cut hollow",
    run: () => setSectionCapsEnabled(!pref),
  });
}
