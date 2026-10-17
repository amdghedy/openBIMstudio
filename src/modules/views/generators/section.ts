/**
 * Section view generator — analytic vertical cut.
 *
 *   section-2D X = distance along the cut line
 *   section-2D Z = world Y (elevation)
 */

import { getElements } from "../../../features/authoring";
import type { AuthoredElement } from "../../projects/types";
import type { ViewDef } from "../types";
import type { Scene2D, SceneEntity, StrokeStyle } from "../scene";
import { emptyScene } from "../scene";

const CUT_STYLE: StrokeStyle = { color: "#111827", widthPt: 0.5, dash: null };
const PROJECT_STYLE: StrokeStyle = { color: "#6b7280", widthPt: 0.2, dash: null };

interface CutPlane {
  origin: [number, number];
  dir: [number, number];
  normal: [number, number];
}

function makePlane(cut: NonNullable<ViewDef["section"]>): CutPlane {
  const { x1, z1, x2, z2 } = cut.cutLine;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const L = Math.hypot(dx, dz) || 1;
  const dir: [number, number] = [dx / L, dz / L];
  let normal: [number, number] = [-dir[1], dir[0]];
  if (cut.lookDir === "left") normal = [-normal[0], -normal[1]];
  return { origin: [x1, z1], dir, normal };
}

function alongCut(plane: CutPlane, px: number, pz: number): number {
  return (px - plane.origin[0]) * plane.dir[0] + (pz - plane.origin[1]) * plane.dir[1];
}

function signedDist(plane: CutPlane, px: number, pz: number): number {
  return (px - plane.origin[0]) * plane.normal[0] + (pz - plane.origin[1]) * plane.normal[1];
}

export async function generateSectionScene(def: ViewDef): Promise<Scene2D> {
  const scene = emptyScene();
  if (!def.section) return scene;

  const plane = makePlane(def.section);
  const elements = getElements();
  const allX: number[] = [];
  const allZ: number[] = [];

  for (const el of elements) {
    const slice = cutElement(el, plane);
    if (slice) {
      for (const e of slice) { scene.layers.cut.push(e); updateBoundsFromEntity(e, allX, allZ); }
    }
    const projection = projectElement(el, plane, def.section);
    if (projection) {
      for (const e of projection) { scene.layers.project.push(e); updateBoundsFromEntity(e, allX, allZ); }
    }
  }

  if (allX.length) {
    scene.bounds = {
      minX: Math.min(...allX), minZ: Math.min(...allZ),
      maxX: Math.max(...allX), maxZ: Math.max(...allZ),
    };
  }
  scene.generatedAt = Date.now();
  return scene;
}

function cutElement(el: AuthoredElement, plane: CutPlane): SceneEntity[] | null {
  const p = el.params;

  if (p.start && p.end) {
    const [ax, az] = p.start;
    const [bx, bz] = p.end;
    const dA = signedDist(plane, ax, az);
    const dB = signedDist(plane, bx, bz);
    if (Math.sign(dA) !== Math.sign(dB) || Math.abs(dA) < 1e-6 || Math.abs(dB) < 1e-6) {
      const t = dA / (dA - dB);
      const cx = ax + (bx - ax) * t;
      const cz = az + (bz - az) * t;
      const x = alongCut(plane, cx, cz);
      const y0 = p.elevation;
      const y1 = p.elevation + p.height;
      const w = (p.thickness ?? 0.2) / 2;
      return [{
        kind: "polyline", closed: true,
        points: [[x - w, y0], [x + w, y0], [x + w, y1], [x - w, y1]],
        stroke: CUT_STYLE,
        fill: { color: "#cbd5e1", opacity: 0.6 },
      }];
    }
    return null;
  }

  if (p.point) {
    const [px, pz] = p.point;
    const d = signedDist(plane, px, pz);
    const w = (p.thickness ?? 0.3) / 2;
    if (Math.abs(d) > w) return null;
    const x = alongCut(plane, px, pz);
    const y0 = p.elevation;
    const y1 = p.elevation + p.height;
    const halfW = (p.depth ?? p.thickness ?? 0.3) / 2;
    return [{
      kind: "polyline", closed: true,
      points: [[x - halfW, y0], [x + halfW, y0], [x + halfW, y1], [x - halfW, y1]],
      stroke: CUT_STYLE,
      fill: { color: "#cbd5e1", opacity: 0.6 },
    }];
  }

  if (p.polygon && p.polygon.length >= 3) {
    const crossings: number[] = [];
    for (let i = 0; i < p.polygon.length; i++) {
      const a = p.polygon[i];
      const b = p.polygon[(i + 1) % p.polygon.length];
      const dA = signedDist(plane, a[0], a[1]);
      const dB = signedDist(plane, b[0], b[1]);
      if (Math.sign(dA) !== Math.sign(dB)) {
        const t = dA / (dA - dB);
        const cx = a[0] + (b[0] - a[0]) * t;
        const cz = a[1] + (b[1] - a[1]) * t;
        crossings.push(alongCut(plane, cx, cz));
      }
    }
    if (crossings.length >= 2) {
      const x0 = Math.min(...crossings);
      const x1 = Math.max(...crossings);
      const y0 = p.elevation;
      const y1 = p.elevation + p.height;
      return [{
        kind: "polyline", closed: true,
        points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        stroke: CUT_STYLE,
        fill: { color: "#94a3b8", opacity: 0.6 },
      }];
    }
  }

  return null;
}

function projectElement(
  el: AuthoredElement, plane: CutPlane, cfg: NonNullable<ViewDef["section"]>,
): SceneEntity[] | null {
  const p = el.params;
  const out: SceneEntity[] = [];
  if (p.start && p.end) {
    const [ax, az] = p.start;
    const [bx, bz] = p.end;
    const dA = signedDist(plane, ax, az);
    const dB = signedDist(plane, bx, bz);
    if (dA > 0 && dB > 0 && dA <= cfg.farClip && dB <= cfg.farClip) {
      const x0 = alongCut(plane, ax, az);
      const x1 = alongCut(plane, bx, bz);
      const y0 = p.elevation;
      const y1 = p.elevation + p.height;
      out.push({ kind: "line", x1: x0, z1: y0, x2: x0, z2: y1, stroke: PROJECT_STYLE });
      out.push({ kind: "line", x1: x1, z1: y0, x2: x1, z2: y1, stroke: PROJECT_STYLE });
    }
  }
  return out.length ? out : null;
}

function updateBoundsFromEntity(e: SceneEntity, xs: number[], zs: number[]): void {
  if (e.kind === "line") { xs.push(e.x1, e.x2); zs.push(e.z1, e.z2); }
  else if (e.kind === "polyline") { for (const [x, z] of e.points) { xs.push(x); zs.push(z); } }
  else if (e.kind === "arc") { xs.push(e.cx - e.r, e.cx + e.r); zs.push(e.cz - e.r, e.cz + e.r); }
  else if (e.kind === "circle") { xs.push(e.cx - e.r, e.cx + e.r); zs.push(e.cz - e.r, e.cz + e.r); }
  else if (e.kind === "text" || e.kind === "symbol") { xs.push(e.x); zs.push(e.z); }
}