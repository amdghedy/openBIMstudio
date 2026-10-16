/**
 * Section planes — persistence and viewpoint integration.
 *
 * Reads and writes the clipper state defensively (SDK API varies by version).
 * Section planes are saved into issue viewpoints via the BCF exporter
 * (see modules/issues/bcf.ts) and into projects via appState.sections.
 */
import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { ctx } from "../core/context";
import { isMeasureEnabled, setMeasureEnabled } from "./measure";
import { isDrawingActive } from "./drawing";

export interface SectionPlaneState {
  location: [number, number, number];
  direction: [number, number, number];
}

let enabled = false;
let checkboxEl: any = null;

export function setSectionCheckboxRef(el: any) {
  checkboxEl = el;
}
export function isSectionOn() {
  return enabled;
}

export function setSectionOn(on: boolean) {
  enabled = on;
  const el = checkboxEl ?? ctx.leftHost.querySelector("bim-checkbox[data-section]");
  if (el) el.checked = on;
}

export function toggleSection() {
  const next = !enabled;
  setSectionOn(next);
  if (next) setMeasureEnabled(false);
}

// ═══════════════════════════════════════════════════════════════════════════
// Read current planes
// ═══════════════════════════════════════════════════════════════════════════
export function getSectionPlanes(): SectionPlaneState[] {
  const out: SectionPlaneState[] = [];
  try {
    const list = (ctx.clipper as any)?.list;
    if (!list) return out;
    const iterable: any = list[Symbol.iterator] ? list : null;
    if (!iterable) return out;
    for (const entry of iterable) {
      const item = Array.isArray(entry) ? entry[1] : entry;
      const plane: THREE.Plane = item?.three ?? item?.plane ?? item;
      if (!plane?.normal || typeof plane.constant !== "number") continue;
      const n = plane.normal.clone().normalize();
      const loc = n.clone().multiplyScalar(-plane.constant);
      out.push({
        location: [loc.x, loc.y, loc.z],
        direction: [n.x, n.y, n.z],
      });
    }
  } catch (e) {
    console.warn("[section] getSectionPlanes failed", e);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Restore planes (best-effort against SDK API drift)
// ═══════════════════════════════════════════════════════════════════════════
export function setSectionPlanes(planes: SectionPlaneState[] | undefined | null): void {
  if (!planes || !planes.length) return;
  const clipper: any = ctx.clipper;
  if (!clipper) return;

  try {
    if (typeof clipper.deleteAll === "function") clipper.deleteAll();
  } catch {
    /* */
  }

  // Attempt API 1: createFromNormalAndCoplanarPoint
  const tryCreateFromNormal = (): boolean => {
    if (typeof clipper.createFromNormalAndCoplanarPoint !== "function") return false;
    try {
      for (const p of planes) {
        const n = new THREE.Vector3(p.direction[0], p.direction[1], p.direction[2]);
        const loc = new THREE.Vector3(p.location[0], p.location[1], p.location[2]);
        clipper.createFromNormalAndCoplanarPoint(ctx.world, n, loc);
      }
      return true;
    } catch {
      return false;
    }
  };

  // Attempt API 2: create(world) then adjust item's plane
  const tryCreateInteractive = (): boolean => {
    if (typeof clipper.create !== "function") return false;
    try {
      for (const p of planes) {
        const item: any = clipper.create(ctx.world);
        const plane: THREE.Plane | undefined =
          item?.three?.plane ?? item?.plane ?? item?.three;
        if (plane?.normal) {
          plane.normal.set(p.direction[0], p.direction[1], p.direction[2]);
          plane.constant = -new THREE.Vector3(
            p.location[0],
            p.location[1],
            p.location[2],
          ).dot(plane.normal);
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  if (!tryCreateFromNormal()) {
    if (!tryCreateInteractive()) {
      console.warn(
        "[section] could not restore planes — SDK exposes neither createFromNormalAndCoplanarPoint nor create",
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// resetSection -- clear all planes, disable mode, uncheck the panel toggle
// ═══════════════════════════════════════════════════════════════════════════
export function resetSection(): number {
  let removed = 0;
  try {
    const clipper: any = ctx.clipper;
    if (clipper) {
      removed = getSectionPlanes().length;
      if (typeof clipper.deleteAll === "function") clipper.deleteAll();
      if (clipper.list && typeof clipper.list.clear === "function") clipper.list.clear();
    }
  } catch (e) { console.warn("[section] reset deleteAll failed", e); }

  setSectionOn(false);

  try {
    const hosts: HTMLElement[] = [ctx.leftHost as any, document.body];
    for (const host of hosts) {
      if (!host) continue;
      const labels = Array.from(host.querySelectorAll("label")) as HTMLLabelElement[];
      for (const label of labels) {
        const txt = (label.textContent || "").toLowerCase();
        if (txt.includes("enable section")) {
          const input = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
          if (input) input.checked = false;
        }
      }
      const el = host.querySelector("bim-checkbox[data-section]") as any;
      if (el) el.checked = false;
    }
    if (checkboxEl) checkboxEl.checked = false;
  } catch { /* */ }

  try { (ctx.features as any).sectionCutInteraction?.cancel?.(); } catch { /* */ }
  try { (ctx.features as any).sectionCutInteraction?.disable?.(); } catch { /* */ }
  try { (ctx.features as any).sectionBox?.disable?.(); } catch { /* */ }

  return removed;
}
export function setupSection() {
  ctx.rightHost.addEventListener("dblclick", async (e: MouseEvent) => {
    if (isDrawingActive() || isMeasureEnabled() || !enabled) return;

    const canvas = (ctx.world.renderer.three as THREE.WebGLRenderer).domElement;
    if (e.target !== canvas) return;

    const clipper: any = ctx.clipper;
    let created = false;

    try {
      const caster: any = (ctx.components as any).get(OBC.Raycasters).get(ctx.world);
      const hit: any = await caster.castRay();

      if (hit) {
        const pt = hit.point
          ? new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z)
          : (hit.ray?.origin && hit.distance != null
              ? hit.ray.origin.clone().add(hit.ray.direction.clone().multiplyScalar(hit.distance))
              : null);

        let normal: THREE.Vector3 | null = null;
        const rawN = hit.normal ?? hit.face?.normal ?? null;
        if (rawN) {
          normal = new THREE.Vector3(rawN.x, rawN.y, rawN.z);
          if (hit.object && hit.object.matrixWorld) {
            try {
              const nm = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
              normal.applyMatrix3(nm).normalize();
            } catch { normal.normalize(); }
          } else {
            normal.normalize();
          }
        }

        if (pt && normal) {
          // Flip toward camera so "front" always faces the user
          const camDir = new THREE.Vector3();
          (ctx.world.camera.three as THREE.Camera).getWorldDirection(camDir);
          if (normal.dot(camDir) > 0) normal.negate();

          if (typeof clipper.createFromNormalAndCoplanarPoint === "function") {
            clipper.createFromNormalAndCoplanarPoint(ctx.world, normal, pt);
            created = true;
          } else if (typeof clipper.create === "function") {
            const item: any = clipper.create(ctx.world);
            const plane: THREE.Plane | undefined =
              item?.three?.plane ?? item?.plane ?? item?.three;
            if (plane?.normal) {
              plane.normal.copy(normal);
              plane.constant = -pt.dot(normal);
              created = true;
            }
          }
        }
      }
    } catch (err) {
      console.warn("[section] face-aligned create failed", err);
    }

    if (!created) {
      try { clipper.create(ctx.world); }
      catch (err) { console.warn("[section] fallback create failed", err); }
    }
  });
  ctx.features.section = {
    isEnabled: isSectionOn,
    toggle: toggleSection,
    getPlanes: getSectionPlanes,
    setPlanes: setSectionPlanes,
    reset: resetSection,
    deleteAllPlanes: resetSection,
  };
  (window as any).__obsSection = {
    reset: resetSection,
    getPlanes: getSectionPlanes,
    toggle: toggleSection,
    isEnabled: isSectionOn,
    setOn: setSectionOn,
  };
}
// ============================================================================
// Section visual auto-hide + grid toggle
// ============================================================================
let autoHideSectionVisuals = true;

export function hideSectionVisuals(): number {
  let count = 0;
  try {
    const clipper: any = ctx.clipper;
    if (!clipper) return 0;
    if ("visible" in clipper) {
      try { clipper.visible = false; count++; } catch { /* */ }
    }
    const list: any = clipper.list;
    if (list) {
      const iterable: any = list[Symbol.iterator] ? list : null;
      if (iterable) {
        for (const entry of iterable) {
          const item = Array.isArray(entry) ? entry[1] : entry;
          const three = item?.three;
          if (!three) continue;
          try { three.visible = false; count++; } catch { /* */ }
          try {
            const mat: any = three.material;
            if (mat) {
              mat.opacity = 0;
              mat.transparent = true;
              mat.depthWrite = false;
              mat.needsUpdate = true;
            }
          } catch { /* */ }
        }
      }
    }
  } catch (e) { console.warn("[section] hideSectionVisuals", e); }
  return count;
}

export function showSectionVisuals(): number {
  let count = 0;
  try {
    const clipper: any = ctx.clipper;
    if (!clipper) return 0;
    if ("visible" in clipper) {
      try { clipper.visible = true; count++; } catch { /* */ }
    }
    const list: any = clipper.list;
    if (list) {
      const iterable: any = list[Symbol.iterator] ? list : null;
      if (iterable) {
        for (const entry of iterable) {
          const item = Array.isArray(entry) ? entry[1] : entry;
          const three = item?.three;
          if (!three) continue;
          try { three.visible = true; count++; } catch { /* */ }
          try {
            const mat: any = three.material;
            if (mat) {
              mat.opacity = 0.5;
              mat.transparent = true;
              mat.needsUpdate = true;
            }
          } catch { /* */ }
        }
      }
    }
  } catch (e) { console.warn("[section] showSectionVisuals", e); }
  return count;
}

export function setAutoHideSectionVisuals(on: boolean): void {
  autoHideSectionVisuals = on;
  if (!on) showSectionVisuals();
  else hideSectionVisuals();
}

(function autoHideLoop() {
  setInterval(() => {
    if (!autoHideSectionVisuals) return;
    try {
      const clipper: any = ctx.clipper;
      if (!clipper) return;
      const list: any = clipper.list;
      if (!list) return;
      const iterable: any = list[Symbol.iterator] ? list : null;
      if (!iterable) return;
      let anyVisible = false;
      for (const entry of iterable) {
        const item = Array.isArray(entry) ? entry[1] : entry;
        const three = item?.three;
        if (three && three.visible !== false) { anyVisible = true; break; }
      }
      if (anyVisible) hideSectionVisuals();
    } catch { /* */ }
  }, 500);
})();

let gridVisible = true;

function applyGridVisible(on: boolean): void {
  gridVisible = on;
  try {
    const grid: any = (ctx as any).grid;
    const grids: any = (ctx as any).grids;
    if (grid) {
      const target = grid.three ?? grid.helper ?? grid.object ?? grid;
      if (target && "visible" in target) target.visible = on;
    }
    if (grids && grids.list) {
      const iterable: any = grids.list[Symbol.iterator] ? grids.list : null;
      if (iterable) for (const entry of iterable) {
        const g = Array.isArray(entry) ? entry[1] : entry;
        if (g?.three && "visible" in g.three) g.three.visible = on;
      }
    }
  } catch (e) { console.warn("[section] grid toggle", e); }
  try {
    const btn = document.getElementById("obs-grid-toggle");
    if (btn) {
      btn.textContent = on ? "Grid ON" : "Grid OFF";
      (btn as HTMLElement).style.background = on
        ? "rgba(20,22,30,0.85)" : "rgba(60,20,20,0.85)";
    }
  } catch { /* */ }
}

export function setupGridToggle(): void {
  if ((window as any).__obsGridInstalled) return;
  (window as any).__obsGridInstalled = true;

  (window as any).__obsGrid = {
    show: () => applyGridVisible(true),
    hide: () => applyGridVisible(false),
    toggle: () => applyGridVisible(!gridVisible),
    isVisible: () => gridVisible,
  };

  try {
    const sec: any = (window as any).__obsSection ?? {};
    sec.hideVisuals = hideSectionVisuals;
    sec.showVisuals = showSectionVisuals;
    sec.setAutoHideVisuals = setAutoHideSectionVisuals;
    (window as any).__obsSection = sec;
  } catch { /* */ }

  try {
    const btn = document.createElement("button");
    btn.id = "obs-grid-toggle";
    btn.type = "button";
    btn.title = "Toggle ground grid (G)";
    btn.textContent = "Grid ON";
    btn.style.cssText =
      "position:absolute;bottom:16px;right:16px;z-index:60;" +
      "padding:6px 12px;background:rgba(20,22,30,0.85);color:#e8eaf0;" +
      "border:1px solid #2a2e3a;border-radius:6px;" +
      "font:600 11px system-ui;cursor:pointer;user-select:none";
    btn.addEventListener("click", () => applyGridVisible(!gridVisible));
    ctx.rightHost.appendChild(btn);
  } catch (e) { console.warn("[section] grid button", e); }

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== "g" && e.key !== "G") return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest && t.closest("input,textarea,select,[contenteditable]")) return;
    applyGridVisible(!gridVisible);
    e.preventDefault();
  });

  console.log("[section] grid toggle ready (button bottom-right, key G)");
}

(function bootGridToggle() {
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    const hasGrid = !!(ctx as any).grid || !!(ctx as any).grids;
    if (hasGrid || tries > 120) {
      clearInterval(timer);
      if (hasGrid) setupGridToggle();
    }
  }, 250);
})();