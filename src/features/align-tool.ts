/**
 * Align Tool - BIM-style alignment of authored elements.
 *
 * Aligns selected elements to a target edge / point / ref plane along
 * X, Z (plan) or Y (elevation). Operates on AuthoredElement params
 * (start/end/point) without requiring full geometry rebuild mid-drag.
 */

import { ctx } from "../core/context";
import { notify } from "../core/notify";

type Any = Record<string, any>;

export type AlignAxis = "x" | "y" | "z";
export type AlignMode = "min" | "max" | "center";

interface Alignable {
  id: string;
  getBounds: () => { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null;
  applyDelta: (dx: number, dy: number, dz: number) => void;
}

function getAuthoring(): Any | null {
  return (ctx.features as Any)?.authoring ?? (window as Any).__obsAuthoring ?? null;
}

function getSelectionIds(): string[] {
  const sel = (ctx.features as Any)?.selection;
  if (sel && typeof sel.getSelectedIds === "function") {
    try { return sel.getSelectedIds() ?? []; } catch { /* */ }
  }
  if (sel && typeof sel.ids === "function") {
    try { return [...sel.ids()]; } catch { /* */ }
  }
  return [];
}

function elementBounds(el: Any): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  const p = el.params ?? {};
  const elev = Number(p.elevation ?? 0);
  const h = Number(p.height ?? 0);
  const thick = Number(p.thickness ?? p.width ?? 0.2);

  if (p.start && p.end) {
    const x0 = Math.min(p.start.x, p.end.x);
    const x1 = Math.max(p.start.x, p.end.x);
    const z0 = Math.min(p.start.z ?? p.start.y, p.end.z ?? p.end.y);
    const z1 = Math.max(p.start.z ?? p.start.y, p.end.z ?? p.end.y);
    return {
      min: { x: x0 - thick / 2, y: elev, z: z0 - thick / 2 },
      max: { x: x1 + thick / 2, y: elev + h, z: z1 + thick / 2 },
    };
  }
  if (p.point) {
    const w = Number(p.width ?? thick);
    const d = Number(p.depth ?? thick);
    return {
      min: { x: p.point.x - w / 2, y: elev, z: (p.point.z ?? p.point.y) - d / 2 },
      max: { x: p.point.x + w / 2, y: elev + h, z: (p.point.z ?? p.point.y) + d / 2 },
    };
  }
  if (Array.isArray(p.polygon) && p.polygon.length) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const pt of p.polygon) {
      x0 = Math.min(x0, pt.x);
      x1 = Math.max(x1, pt.x);
      z0 = Math.min(z0, pt.z ?? pt.y);
      z1 = Math.max(z1, pt.z ?? pt.y);
    }
    return {
      min: { x: x0, y: elev, z: z0 },
      max: { x: x1, y: elev + h, z: z1 },
    };
  }
  return null;
}

function applyDeltaToElement(el: Any, dx: number, dy: number, dz: number): void {
  const p = el.params ?? {};
  if (p.start) {
    p.start.x = (p.start.x ?? 0) + dx;
    if ("z" in p.start) p.start.z = (p.start.z ?? 0) + dz;
    else if ("y" in p.start) p.start.y = (p.start.y ?? 0) + dz;
  }
  if (p.end) {
    p.end.x = (p.end.x ?? 0) + dx;
    if ("z" in p.end) p.end.z = (p.end.z ?? 0) + dz;
    else if ("y" in p.end) p.end.y = (p.end.y ?? 0) + dz;
  }
  if (p.point) {
    p.point.x = (p.point.x ?? 0) + dx;
    if ("z" in p.point) p.point.z = (p.point.z ?? 0) + dz;
    else if ("y" in p.point) p.point.y = (p.point.y ?? 0) + dz;
  }
  if (Array.isArray(p.polygon)) {
    for (const pt of p.polygon) {
      pt.x = (pt.x ?? 0) + dx;
      if ("z" in pt) pt.z = (pt.z ?? 0) + dz;
      else if ("y" in pt) pt.y = (pt.y ?? 0) + dz;
    }
  }
  if (dy) {
    p.elevation = (Number(p.elevation) || 0) + dy;
  }
}

function edgeValue(
  b: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  axis: AlignAxis,
  mode: AlignMode,
): number {
  const lo = b.min[axis];
  const hi = b.max[axis];
  if (mode === "min") return lo;
  if (mode === "max") return hi;
  return (lo + hi) / 2;
}

/**
 * Align selected elements to the first selected element (or to a numeric target).
 */
export function alignSelection(
  axis: AlignAxis,
  mode: AlignMode = "min",
  targetValue?: number,
): number {
  const auth = getAuthoring();
  if (!auth) {
    notify("warn", "Authoring not ready");
    return 0;
  }

  const ids = getSelectionIds();
  if (ids.length < 1) {
    notify("info", "Select elements to align");
    return 0;
  }

  const elements: Any[] =
    typeof auth.getElements === "function" ? auth.getElements() ?? [] : auth.elements ?? [];

  const selected = elements.filter((e) => ids.includes(e.id));
  if (!selected.length) return 0;

  // Target = explicit value, else first element's edge
  let target = targetValue;
  if (target == null) {
    const b0 = elementBounds(selected[0]);
    if (!b0) {
      notify("warn", "Cannot compute bounds for target");
      return 0;
    }
    target = edgeValue(b0, axis, mode);
  }

  let moved = 0;
  for (const el of selected) {
    const b = elementBounds(el);
    if (!b) continue;
    const current = edgeValue(b, axis, mode);
    const delta = target - current;
    if (Math.abs(delta) < 1e-9) continue;

    const dx = axis === "x" ? delta : 0;
    const dy = axis === "y" ? delta : 0;
    const dz = axis === "z" ? delta : 0;
    applyDeltaToElement(el, dx, dy, dz);
    moved++;
  }

  if (moved) {
    try {
      if (typeof auth.rebuildAuthored === "function") auth.rebuildAuthored();
      else if (typeof auth.rebuild === "function") auth.rebuild();
      if (typeof auth.markAuthoringDirty === "function") auth.markAuthoringDirty();
    } catch { /* */ }
    notify("success", `Aligned ${moved} element(s) on ${axis.toUpperCase()}`, { timeout: 1600 });
  }

  return moved;
}

/** Distribute selected elements evenly along an axis. */
export function distributeSelection(axis: AlignAxis): number {
  const auth = getAuthoring();
  if (!auth) return 0;
  const ids = getSelectionIds();
  if (ids.length < 3) {
    notify("info", "Select 3+ elements to distribute");
    return 0;
  }

  const elements: Any[] =
    typeof auth.getElements === "function" ? auth.getElements() ?? [] : auth.elements ?? [];
  const selected = elements
    .filter((e) => ids.includes(e.id))
    .map((e) => ({ el: e, b: elementBounds(e) }))
    .filter((x) => x.b) as Array<{ el: Any; b: NonNullable<ReturnType<typeof elementBounds>> }>;

  selected.sort((a, b) => edgeValue(a.b, axis, "center") - edgeValue(b.b, axis, "center"));

  const first = edgeValue(selected[0].b, axis, "center");
  const last = edgeValue(selected[selected.length - 1].b, axis, "center");
  const step = (last - first) / (selected.length - 1);

  let moved = 0;
  for (let i = 1; i < selected.length - 1; i++) {
    const desired = first + step * i;
    const current = edgeValue(selected[i].b, axis, "center");
    const delta = desired - current;
    if (Math.abs(delta) < 1e-9) continue;
    applyDeltaToElement(
      selected[i].el,
      axis === "x" ? delta : 0,
      axis === "y" ? delta : 0,
      axis === "z" ? delta : 0,
    );
    moved++;
  }

  if (moved) {
    try {
      if (typeof auth.rebuildAuthored === "function") auth.rebuildAuthored();
      else if (typeof auth.rebuild === "function") auth.rebuild();
    } catch { /* */ }
    notify("success", `Distributed ${moved} element(s)`, { timeout: 1600 });
  }
  return moved;
}

export function setupAlignTool(): void {
  (ctx.features as any).align = { alignSelection, distributeSelection };
  (window as any).__obsAlign = { alignSelection, distributeSelection };
  console.log("[align-tool] ready");
}
