/**
 * Section planes — persistence and viewpoint integration.
 *
 * Reads and writes the clipper state defensively (SDK API varies by version).
 * Section planes are saved into issue viewpoints via the BCF exporter
 * (see modules/issues/bcf.ts) and into projects via appState.sections.
 */
import * as THREE from "three";
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
export function setupSection() {
  ctx.rightHost.addEventListener("dblclick", () => {
    if (isDrawingActive() || isMeasureEnabled() || !enabled) return;
    try {
      ctx.clipper.create(ctx.world);
    } catch (e) {
      console.warn("[section] create failed", e);
    }
  });
  ctx.features.section = {
    isEnabled: isSectionOn,
    toggle: toggleSection,
    getPlanes: getSectionPlanes,
    setPlanes: setSectionPlanes,
  };
}