/**
 * View / graphics control layer — Revit-style model display presets.
 *
 * Wireframe · Hidden Line · Shaded · Shaded+Edges · Consistent Colors ·
 * Realistic · Ray Trace (enhanced realistic approximation).
 */
import * as THREE from "three";
import { ctx } from "../core/context";

export type VisualPreset =
  | "wireframe"
  | "hidden-line"
  | "shaded"
  | "shaded-edges"
  | "consistent-colors"
  | "realistic"
  | "ray-trace";

export type BackgroundPreset = "studio" | "paper" | "night";

export const VISUAL_PRESET_LABELS: Record<VisualPreset, string> = {
  wireframe: "Wireframe",
  "hidden-line": "Hidden Line",
  shaded: "Shaded",
  "shaded-edges": "Shaded + Edges",
  "consistent-colors": "Consistent Colors",
  realistic: "Realistic",
  "ray-trace": "Ray Trace",
};

let visualPreset: VisualPreset = "shaded";
let sceneTransparency = 0;
let sunEnabled = true;
let background: BackgroundPreset = "studio";
let thinLines = false;

const original = new WeakMap<
  THREE.Material,
  {
    opacity: number;
    transparent: boolean;
    wireframe?: boolean;
    depthWrite?: boolean;
    color?: THREE.Color;
    emissive?: THREE.Color;
    flatShading?: boolean;
    metalness?: number;
    roughness?: number;
  }
>();

let tracked = false;
let edgeGroup: THREE.Group | null = null;
const EDGE_NAME = "obs-graphic-edges";

function remember(mat: THREE.Material): void {
  if (original.has(mat)) return;
  const m = mat as THREE.Material & {
    wireframe?: boolean;
    depthWrite?: boolean;
    color?: THREE.Color;
    emissive?: THREE.Color;
    flatShading?: boolean;
    metalness?: number;
    roughness?: number;
  };
  original.set(mat, {
    opacity: m.opacity,
    transparent: m.transparent,
    wireframe: m.wireframe,
    depthWrite: m.depthWrite,
    color: m.color?.clone?.(),
    emissive: m.emissive?.clone?.(),
    flatShading: m.flatShading,
    metalness: m.metalness,
    roughness: m.roughness,
  });
}

function isUiHelper(obj: any): boolean {
  for (let o = obj; o; o = o.parent) {
    if (o.name === "obs-gizmo" || o.name === EDGE_NAME || o.userData?.obsHelper) return true;
  }
  return false;
}

function scene(): THREE.Scene | null {
  try {
    return ctx.world?.scene?.three ?? null;
  } catch {
    return null;
  }
}

function eachMaterial(cb: (mat: THREE.Material) => void): void {
  const sc = scene();
  if (!sc) return;
  sc.traverse((obj: any) => {
    if (!obj?.isMesh || !obj.material) return;
    if (isUiHelper(obj)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat) continue;
      remember(mat);
      cb(mat as THREE.Material);
    }
  });
  tracked = true;
}

function clearEdgeOverlay(): void {
  const sc = scene();
  if (!sc || !edgeGroup) return;
  try {
    sc.remove(edgeGroup);
    edgeGroup.traverse((o: any) => {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m: any) => m.dispose?.());
      else o.material?.dispose?.();
    });
  } catch {
    /* */
  }
  edgeGroup = null;
}

/** Black edge lines for Hidden Line / Shaded + Edges. */
function buildEdgeOverlay(): void {
  clearEdgeOverlay();
  const sc = scene();
  if (!sc) return;
  edgeGroup = new THREE.Group();
  edgeGroup.name = EDGE_NAME;
  edgeGroup.userData.obsHelper = true;
  const mat = new THREE.LineBasicMaterial({
    color: 0x111827,
    transparent: true,
    opacity: 0.85,
    depthTest: true,
  });
  let count = 0;
  sc.traverse((obj: any) => {
    if (!obj?.isMesh || !obj.geometry || isUiHelper(obj)) return;
    if (!obj.visible) return;
    try {
      const edges = new THREE.EdgesGeometry(obj.geometry, 25);
      const lines = new THREE.LineSegments(edges, mat.clone());
      lines.userData.obsHelper = true;
      // Match world transform of the mesh
      obj.updateWorldMatrix(true, false);
      lines.matrix.copy(obj.matrixWorld);
      lines.matrixAutoUpdate = false;
      edgeGroup!.add(lines);
      count++;
    } catch {
      /* */
    }
  });
  if (count) sc.add(edgeGroup);
  else clearEdgeOverlay();
}

function applyRendererForPreset(preset: VisualPreset): void {
  try {
    const r = (ctx.world.renderer as any)?.three as THREE.WebGLRenderer | undefined;
    if (!r) return;
    if (preset === "realistic" || preset === "ray-trace") {
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.toneMappingExposure = preset === "ray-trace" ? 1.15 : 1.05;
      r.shadowMap.enabled = true;
      try {
        r.shadowMap.type = THREE.PCFSoftShadowMap;
      } catch {
        /* */
      }
    } else if (preset === "consistent-colors") {
      r.toneMapping = THREE.NoToneMapping;
      r.toneMappingExposure = 1;
    } else {
      r.toneMapping = THREE.NoToneMapping;
      r.toneMappingExposure = 1;
    }
  } catch {
    /* */
  }
  // Directional light shadows for realistic modes
  try {
    const sc = scene();
    sc?.traverse((obj: any) => {
      if (obj?.isDirectionalLight) {
        obj.castShadow = preset === "realistic" || preset === "ray-trace";
      }
      if (obj?.isMesh && !isUiHelper(obj)) {
        obj.castShadow = preset === "realistic" || preset === "ray-trace";
        obj.receiveShadow = preset === "realistic" || preset === "ray-trace";
      }
    });
  } catch {
    /* */
  }
}

export function setVisualPreset(preset: VisualPreset): void {
  visualPreset = preset;
  clearEdgeOverlay();

  eachMaterial((mat) => {
    const m = mat as THREE.Material & {
      wireframe?: boolean;
      depthWrite?: boolean;
      color?: THREE.Color;
      emissive?: THREE.Color;
      flatShading?: boolean;
      metalness?: number;
      roughness?: number;
    };
    const base = original.get(mat);
    if (!base) return;

    // Restore baseline first
    if (typeof m.wireframe === "boolean") m.wireframe = base.wireframe ?? false;
    m.transparent = base.transparent;
    m.opacity = base.opacity;
    m.depthWrite = base.depthWrite ?? true;
    if (m.color && base.color) m.color.copy(base.color);
    if (m.emissive && base.emissive) m.emissive.copy(base.emissive);
    if (typeof m.flatShading === "boolean") m.flatShading = base.flatShading ?? false;
    if (typeof m.metalness === "number" && base.metalness != null) m.metalness = base.metalness;
    if (typeof m.roughness === "number" && base.roughness != null) m.roughness = base.roughness;

    const t = sceneTransparency / 100;

    if (preset === "wireframe") {
      if (typeof m.wireframe === "boolean") m.wireframe = true;
      m.transparent = true;
      m.opacity = Math.max(0.4, 1 - t * 0.5);
    } else if (preset === "hidden-line") {
      // Pale faces + edges drawn separately
      if (typeof m.wireframe === "boolean") m.wireframe = false;
      m.transparent = true;
      m.opacity = Math.max(0.12, 0.35 - t * 0.2);
      m.depthWrite = true;
      if (m.color) m.color.setRGB(0.92, 0.93, 0.95);
    } else if (preset === "consistent-colors") {
      if (typeof m.wireframe === "boolean") m.wireframe = false;
      if (typeof m.flatShading === "boolean") m.flatShading = true;
      if (typeof m.metalness === "number") m.metalness = 0;
      if (typeof m.roughness === "number") m.roughness = 1;
      m.transparent = t > 0;
      m.opacity = t > 0 ? 1 - t : 1;
    } else if (preset === "realistic" || preset === "ray-trace") {
      if (typeof m.wireframe === "boolean") m.wireframe = false;
      if (typeof m.metalness === "number") m.metalness = Math.min(0.35, (base.metalness ?? 0.1) + 0.08);
      if (typeof m.roughness === "number") m.roughness = Math.max(0.25, (base.roughness ?? 0.6) - 0.1);
      m.transparent = t > 0 || base.transparent;
      m.opacity = t > 0 ? 1 - t : base.opacity;
    } else {
      // shaded / shaded-edges
      if (typeof m.wireframe === "boolean") m.wireframe = false;
      m.transparent = t > 0 || base.transparent;
      m.opacity = t > 0 ? 1 - t : base.opacity;
      m.depthWrite = base.depthWrite ?? true;
    }

    m.needsUpdate = true;
  });

  if (preset === "hidden-line" || preset === "shaded-edges") {
    try {
      buildEdgeOverlay();
    } catch (e) {
      console.warn("[view-graphics] edge overlay", e);
    }
  }

  applyRendererForPreset(preset);

  try {
    window.dispatchEvent(new CustomEvent("obs:visual-preset", { detail: { preset } }));
  } catch {
    /* */
  }
  try {
    (ctx.fragments as any)?.core?.update?.(true);
  } catch {
    /* */
  }
}

export function getVisualPreset(): VisualPreset {
  return visualPreset;
}

export function cycleVisualPreset(): VisualPreset {
  const order: VisualPreset[] = [
    "wireframe",
    "hidden-line",
    "shaded",
    "shaded-edges",
    "consistent-colors",
    "realistic",
    "ray-trace",
  ];
  const i = order.indexOf(visualPreset);
  const next = order[(i + 1) % order.length];
  setVisualPreset(next);
  return next;
}

export function setSceneTransparency(value: number): void {
  sceneTransparency = Math.max(0, Math.min(90, Number(value) || 0));
  setVisualPreset(visualPreset);
}

export function getSceneTransparency(): number {
  return sceneTransparency;
}

export function setSunEnabled(on: boolean): void {
  sunEnabled = !!on;
  const sc = scene();
  if (!sc) return;
  sc.traverse((obj: any) => {
    if (obj?.isDirectionalLight) obj.visible = sunEnabled;
  });
}

export function isSunEnabled(): boolean {
  return sunEnabled;
}

export function setSceneBackground(preset: BackgroundPreset): void {
  background = preset;
  const sc = scene();
  if (!sc) return;
  const color = preset === "paper" ? 0xf3f4f6 : preset === "night" ? 0x05070b : 0x0f1117;
  sc.background = new THREE.Color(color);
  try {
    window.dispatchEvent(new CustomEvent("obs:scene-background", { detail: preset }));
  } catch {
    /* */
  }
}

export function getSceneBackground(): BackgroundPreset {
  return background;
}

export function setThinLines(on: boolean): void {
  thinLines = !!on;
  const sc = scene();
  if (!sc) return;
  sc.traverse((o: any) => {
    if (o?.isLine || o?.isLineSegments) {
      if (o.material) {
        try {
          o.material.linewidth = on ? 1 : 2;
          o.material.needsUpdate = true;
        } catch {
          /* */
        }
      }
    }
  });
  (window as any).__obsThinLines = thinLines;
}

export function isThinLines(): boolean {
  return thinLines;
}

/** Open Graphic Display Options dialog (background, sun, transparency, style). */
export function openGraphicDisplayOptions(): void {
  const existing = document.getElementById("obs-gdo-modal");
  if (existing) {
    existing.remove();
  }

  const overlay = document.createElement("div");
  overlay.id = "obs-gdo-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:9800;background:rgba(0,0,0,.45);display:flex;" +
    "align-items:center;justify-content:center";

  const card = document.createElement("div");
  card.style.cssText =
    "width:min(420px,92vw);background:#1b1c26;border:1px solid #34353f;border-radius:10px;" +
    "box-shadow:0 20px 50px rgba(0,0,0,.5);color:#e2e8f0;font:13px system-ui;overflow:hidden";

  card.innerHTML =
    `<div style="padding:12px 14px;border-bottom:1px solid #2a2e3a;font-weight:700;display:flex;align-items:center;gap:8px">` +
    `<span style="color:#38bdf8">✦</span> Graphic Display Options</div>` +
    `<div style="padding:14px;display:grid;gap:12px" id="obs-gdo-body"></div>` +
    `<div style="padding:10px 14px;border-top:1px solid #2a2e3a;display:flex;justify-content:flex-end;gap:8px">` +
    `<button type="button" data-gdo="close" style="padding:6px 14px;border-radius:6px;border:1px solid #3a3f4d;background:#2a2e3a;color:#e8eaf0;cursor:pointer">Close</button>` +
    `</div>`;

  const body = card.querySelector("#obs-gdo-body") as HTMLElement;
  const field = (label: string, control: HTMLElement) => {
    const row = document.createElement("label");
    row.style.cssText = "display:grid;gap:4px;font-size:11px;color:#94a3b8";
    row.append(document.createTextNode(label), control);
    body.appendChild(row);
  };

  const selStyle = document.createElement("select");
  selStyle.style.cssText =
    "width:100%;padding:6px 8px;border-radius:6px;border:1px solid #3a3f4d;background:#12141c;color:#e8eaf0";
  for (const [v, lab] of Object.entries(VISUAL_PRESET_LABELS)) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = lab;
    if (v === visualPreset) o.selected = true;
    selStyle.appendChild(o);
  }
  selStyle.onchange = () => setVisualPreset(selStyle.value as VisualPreset);
  field("Model display style", selStyle);

  const selBg = document.createElement("select");
  selBg.style.cssText = selStyle.style.cssText;
  for (const [v, lab] of [
    ["studio", "Studio (dark)"],
    ["paper", "Paper (light)"],
    ["night", "Night"],
  ] as const) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = lab;
    if (v === background) o.selected = true;
    selBg.appendChild(o);
  }
  selBg.onchange = () => setSceneBackground(selBg.value as BackgroundPreset);
  field("Background", selBg);

  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "90";
  range.value = String(sceneTransparency);
  range.style.cssText = "width:100%";
  const rangeVal = document.createElement("span");
  rangeVal.textContent = `${sceneTransparency}%`;
  range.oninput = () => {
    setSceneTransparency(Number(range.value));
    rangeVal.textContent = `${range.value}%`;
  };
  const rangeWrap = document.createElement("div");
  rangeWrap.append(range, rangeVal);
  field("Transparency", rangeWrap);

  const sun = document.createElement("input");
  sun.type = "checkbox";
  sun.checked = sunEnabled;
  sun.onchange = () => setSunEnabled(sun.checked);
  const sunLab = document.createElement("label");
  sunLab.style.cssText = "display:flex;align-items:center;gap:8px;color:#e2e8f0;font-size:12px";
  sunLab.append(sun, document.createTextNode("Sun / directional light"));
  body.appendChild(sunLab);

  const thin = document.createElement("input");
  thin.type = "checkbox";
  thin.checked = thinLines || !!(window as any).__obsThinLines;
  thin.onchange = () => setThinLines(thin.checked);
  const thinLab = document.createElement("label");
  thinLab.style.cssText = sunLab.style.cssText;
  thinLab.append(thin, document.createTextNode("Thin lines"));
  body.appendChild(thinLab);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  card.querySelector('[data-gdo="close"]')?.addEventListener("click", () => overlay.remove());
}

export function refreshViewGraphics(): void {
  if (!scene()) return;
  setSceneBackground(background);
  setSunEnabled(sunEnabled);
  if (tracked) setVisualPreset(visualPreset);
  else setVisualPreset(visualPreset); // first apply still walks materials
}

export function setupViewGraphics(): void {
  try {
    (ctx.features as any).viewGraphics = {
      setPreset: setVisualPreset,
      getPreset: getVisualPreset,
      cycle: cycleVisualPreset,
      openOptions: openGraphicDisplayOptions,
      setTransparency: setSceneTransparency,
      setBackground: setSceneBackground,
      setSun: setSunEnabled,
      setThinLines,
      labels: VISUAL_PRESET_LABELS,
    };
  } catch {
    /* */
  }
  (window as any).__obsViewGraphics = {
    setPreset: setVisualPreset,
    getPreset: getVisualPreset,
    openOptions: openGraphicDisplayOptions,
  };
  // Re-apply when models finish loading
  try {
    window.addEventListener("obs:models-changed", () => {
      window.setTimeout(() => setVisualPreset(visualPreset), 200);
    });
  } catch {
    /* */
  }
  console.log("[view-graphics] presets: wireframe · hidden-line · shaded · edges · consistent · realistic · ray-trace");
}
