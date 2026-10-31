/**
 * Plan view generator.
 *
 * Cut plane at `levelElevation + cutHeight`. Looks down (bird's eye).
 * Fragment geometry: per-element triangle edges, filtered to the cut band,
 * projected to XZ, deduplicated at 1 mm resolution.
 *
 * Authored elements (walls, doors, windows, columns, beams, slabs) generate
 * parametric 2D symbols — real BIM-style plan representations, not
 * bounding boxes.
 *
 * Screen convention inside the plan: `screenX = worldX`, `screenY = -worldZ`.
 * The panel handles the flip when rendering SVG.
 */
import { defaultBendRadius, elbowGeometry } from "../mep/elbow-geometry";
import { mitreEndFaces, type JoinPeer } from "../geometry/linear-join";
import { transitionOutlineSegments, unionOutlineSegments, capOutlineSegments, fittingBranchAngles, openBranchInSegment, fittingArmAngles, fittingArmLength, fittingOutlineSegments } from "../mep/fitting-outline";
import * as THREE from "three";
import { ctx } from "../../core/context";
import { getElementTriangles } from "../clash/geometry";
import {
  getElements,
  getGrids,
  getLevels,
} from "../../features/authoring";
import type { AuthoredElement } from "../projects/types";
import type {
  PlanArc, PlanGenerationOptions, PlanSegment, PlanText, PlanView,
} from "./plan-types";

const EDGE_ROUND = 1000; // 1 mm dedup
const MIN_EDGE_LEN = 0.005; // 5 mm — kill degenerate projections

function key2(x: number, z: number): string {
  return `${Math.round(x * EDGE_ROUND)},${Math.round(z * EDGE_ROUND)}`;
}

function edgeKey(x1: number, z1: number, x2: number, z2: number): string {
  const a = key2(x1, z1);
  const b = key2(x2, z2);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export async function generatePlanView(
  opts: PlanGenerationOptions,
): Promise<PlanView> {
  // BIM-like view range: Top is above the cut plane; Bottom and View Depth
  // control how far below the associated level the plan can see. Legacy cutDepth
  // remains the fallback for callers that only provide the original API.
  const lowDepth = Math.max(
    Math.abs(opts.viewRangeBottom ?? 0),
    Math.abs(opts.viewDepth ?? opts.cutDepth),
  );
  const highDepth = Math.max(opts.cutHeight, Math.abs(opts.viewRangeTop ?? opts.cutHeight));
  const bandLow = opts.levelElevation - lowDepth;
  const bandHigh = opts.levelElevation + highDepth;
  const cutElevation = opts.levelElevation + opts.cutHeight;

  const segments: PlanSegment[] = [];
  const arcs: PlanArc[] = [];
  const texts: PlanText[] = [];
  let truncated = false;
  const edgeSeen = new Set<string>();

  const pushSeg = (s: PlanSegment) => {
    if (segments.length >= opts.maxSegments) {
      truncated = true;
      return;
    }
    const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
    if (len < MIN_EDGE_LEN) return;
    segments.push(s);
  };

  // ── 1. Authored elements (all modeling categories) ───────────────────
  const authored = getElements();
  // Include every authored element; symbol layer chooses cut / overhead / below
  const authoredInBand = authored.filter((el) => {
    const elev = el.params.elevation ?? 0;
    const h = el.params.height ?? 0.1;
    // Always include linear MEP / structure even if slightly outside band
    if (["duct", "pipe", "cable-tray", "conduit", "beam", "brace", "truss", "mline", "strip"].includes(el.type)) {
      return elev <= bandHigh + 3 && elev + h >= bandLow - 1;
    }
    return elev <= bandHigh && elev + h >= bandLow;
  });

  // Build door/window map by host wall
  const hostedByWall = new Map<string, AuthoredElement[]>();
  for (const el of authored) {
    if ((el.type === "door" || el.type === "window") && el.hostId) {
      if (!hostedByWall.has(el.hostId)) hostedByWall.set(el.hostId, []);
      hostedByWall.get(el.hostId)!.push(el);
    }
  }

  for (const el of authoredInBand) {
    if (opts.signal?.cancelled) break;
    emitAuthoredSymbol(el, segments, arcs, texts, pushSeg, hostedByWall, cutElevation, bandLow, bandHigh);
  }

  // ── 2. Fragments (triangle edge extraction) ──────────────────────────
  opts.onProgress?.({ phase: "Reading models", current: 0, total: ctx.fragments.list.size });

  let mi = 0;
  let fragmentElements = 0;
  let fragmentEdgeCount = 0;
  for (const [modelId, model] of ctx.fragments.list) {
    mi++;
    opts.onProgress?.({ phase: `Model: ${modelId}`, current: mi, total: ctx.fragments.list.size });
    if (opts.signal?.cancelled) break;

    let ids: number[] = [];
    let boxes: THREE.Box3[] = [];
    try {
      ids = (await model.getItemsIdsWithGeometry()) ?? [];
      boxes = await model.getBoxes(ids);
    } catch {
      continue;
    }

    try {
      model.object.updateMatrixWorld(true);
    } catch { /* */ }
    const mw: THREE.Matrix4 = model.object.matrixWorld?.clone?.() ?? new THREE.Matrix4();

    for (let i = 0; i < ids.length; i++) {
      if (opts.signal?.cancelled) break;
      if (truncated && segments.length >= opts.maxSegments) break;

      const b = boxes[i];
      if (!b || b.isEmpty()) continue;
      const world = b.clone().applyMatrix4(mw);
      // Quick reject: box outside the cut band
      if (world.max.y < bandLow || world.min.y > bandHigh) continue;

      fragmentElements++;

      let tris: any[] | null = null;
      try {
        tris = getElementTriangles(model.object, ids[i]);
      } catch {
        tris = null;
      }

      if (!tris || !tris.length) {
        // Fallback — footprint of the bounding box
        emitBoxFootprint(world, pushSeg, "cut");
        continue;
      }

      for (const t of tris) {
        const y0 = t[1], y1 = t[4], y2 = t[7];
        const minY = Math.min(y0, y1, y2);
        const maxY = Math.max(y0, y1, y2);
        if (maxY < bandLow || minY > bandHigh) continue;

        const verts = [
          [t[0], t[1], t[2]],
          [t[3], t[4], t[5]],
          [t[6], t[7], t[8]],
        ];
        for (let e = 0; e < 3; e++) {
          const a = verts[e];
          const b2 = verts[(e + 1) % 3];
          const k = edgeKey(a[0], a[2], b2[0], b2[2]);
          if (edgeSeen.has(k)) continue;
          edgeSeen.add(k);
          fragmentEdgeCount++;
          pushSeg({ x1: a[0], z1: a[2], x2: b2[0], z2: b2[2], kind: "cut" });
        }
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }

  // ── 3. Grid lines ────────────────────────────────────────────────────
  for (const gr of getGrids()) {
    // Extend grid to just past the plan bounds (will be clamped later)
    const dx = gr.end[0] - gr.start[0];
    const dz = gr.end[1] - gr.start[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const ux = dx / len, uz = dz / len;
    const pad = 3.0;
    const x1 = gr.start[0] - ux * pad;
    const z1 = gr.start[1] - uz * pad;
    const x2 = gr.end[0] + ux * pad;
    const z2 = gr.end[1] + uz * pad;
    pushSeg({ x1, z1, x2, z2, kind: "grid" });
    // Bubble at end
    texts.push({
      x: x2 + ux * 0.5,
      z: z2 + uz * 0.5,
      text: gr.label,
      kind: "grid",
      anchor: "middle",
      size: 0.6,
    });
  }

  // ── 4. Level text annotation ─────────────────────────────────────────
  texts.push({
    x: 0, z: 0,
    text: `${opts.levelName}  (+${opts.levelElevation.toFixed(2)} m)`,
    kind: "level",
    anchor: "start",
    size: 0.5,
  });

  // ── 5. Compute bounds ────────────────────────────────────────────────
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const consider = (x: number, z: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const s of segments) { consider(s.x1, s.z1); consider(s.x2, s.z2); }
  for (const a of arcs) { consider(a.cx - a.r, a.cz - a.r); consider(a.cx + a.r, a.cz + a.r); }
  if (!Number.isFinite(minX)) { minX = 0; minZ = 0; maxX = 10; maxZ = 10; }

  return {
    level: { name: opts.levelName, elevation: opts.levelElevation },
    cutElevation,
    segments,
    arcs,
    texts,
    bounds: { minX, minZ, maxX, maxZ },
    generatedAt: Date.now(),
    truncated,
    stats: {
      authoredElements: authoredInBand.length,
      fragmentElements,
      segments: segments.length,
      fragmentEdgeCount,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Authored element plan symbols
// ══════════════════════════════════════════════════════════════════════════

/** True when an elbow fitting of the same system has a connection point at (x, z). */
function connectedToFitting(el: AuthoredElement, x: number, z: number): boolean {
  try {
    for (const f of getElements()) {
      if (f.type !== "fitting") continue;
      const fp: any = f.params;
      if (String(fp.parentType ?? "duct") !== el.type || !fp.point) continue;
      const fkind = String(fp.fittingKind ?? "elbow");
      if (fkind === "tee" || fkind === "cross" || fkind === "wye" || fkind === "cap" || fkind === "transition" || fkind === "union") {
        // a run that ends at a junction / cap continues into the fitting outline: no end cap here
        if (Math.hypot(fp.point[0] - x, fp.point[1] - z) < 0.03) return true;
        continue;
      }
      if (fkind !== "elbow") continue;
      const t = fp.thickness ?? 0.3;
      const r = Number(fp.bendRadius) > 0 ? Number(fp.bendRadius) : defaultBendRadius(Math.max(t, 0.05));
      const eg = elbowGeometry([fp.point[0], fp.point[1]], fp.angleIn ?? 0, fp.angleOut ?? Math.PI / 2, r);
      if (!eg) continue;
      if (Math.hypot(eg.T1[0] - x, eg.T1[1] - z) < 0.03 || Math.hypot(eg.T2[0] - x, eg.T2[1] - z) < 0.03) return true;
    }
  } catch { /* */ }
  return false;
}

function emitLinearThick(
  push: (s: PlanSegment) => void,
  el: AuthoredElement,
  kind: "cut" | "overhead" | "below",
  thickness: number,
): void {
  const p = el.params;
  if (!p.start || !p.end) return;
  const [ax, az] = p.start;
  const [bx, bz] = p.end;
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < 0.02) return;
  const ux = dx / L, uz = dz / L;
  const nx = -uz, nz = ux;
  const t2 = Math.max(0.02, thickness / 2);
  const sideA = { x1: ax + nx * t2, z1: az + nz * t2, x2: bx + nx * t2, z2: bz + nz * t2 };
  const sideB = { x1: ax - nx * t2, z1: az - nz * t2, x2: bx - nx * t2, z2: bz - nz * t2 };
  let piecesA = [sideA], piecesB = [sideB];
  const runType = el.type;
  if (runType === "duct" || runType === "pipe" || runType === "cable-tray" || runType === "conduit") {
    // A tee / cross / wye on this run opens its side line where the branch joins (Revit).
    try {
      for (const f of getElements()) {
        if (f.type !== "fitting") continue;
        const fp: any = f.params;
        const fk = String(fp.fittingKind ?? "");
        if ((fk !== "tee" && fk !== "cross" && fk !== "wye") || !fp.point) continue;
        if (String(fp.parentType ?? "duct") !== runType) continue;
        const cx = fp.point[0], cz = fp.point[1];
        const along = (cx - ax) * ux + (cz - az) * uz, across = Math.abs(-(cx - ax) * uz + (cz - az) * ux);
        if (along < -0.02 || along > L + 0.02 || across > 0.02) continue;     // junction not on this run's centreline
        const aIn = fp.angleIn ?? 0;
        const ft0 = fp.thickness ?? thickness;
        const armLen0 = fittingArmLength(ft0, fp.height ?? ft0, Number(fp.bendRadius), runType === "pipe" || runType === "conduit");
        if (Math.abs(Math.sin(aIn - Math.atan2(uz, ux))) > 0.05) {
          // A branch run ending at the junction: drop its sides inside the main run's body.
          if (along < 0.03 || along > L - 0.03) {
            for (const ang of [aIn, aIn + Math.PI]) {
              piecesA = piecesA.flatMap((sg) => openBranchInSegment(sg, cx, cz, ang, armLen0, ft0));
              piecesB = piecesB.flatMap((sg) => openBranchInSegment(sg, cx, cz, ang, armLen0, ft0));
            }
          }
          continue;                                                             // not the main direction
        }
        const ft = fp.thickness ?? thickness;
        const armLen = fittingArmLength(ft, fp.height ?? ft, Number(fp.bendRadius), runType === "pipe" || runType === "conduit");
        for (const ang of fittingBranchAngles(fk as any, aIn, fp.angleOut ?? Math.PI / 2)) {
          piecesA = piecesA.flatMap((sg) => openBranchInSegment(sg, cx, cz, ang, armLen, ft));
          piecesB = piecesB.flatMap((sg) => openBranchInSegment(sg, cx, cz, ang, armLen, ft));
        }
      }
    } catch { /* fittings optional */ }
  }
  for (const sg of [...piecesA, ...piecesB]) push({ ...sg, kind, source: el.id });
  // Runs joined to an elbow continue into the fitting outline: no end cap there (Revit).
  const joinable = el.type === "duct" || el.type === "pipe" || el.type === "cable-tray" || el.type === "conduit";
  if (!(joinable && connectedToFitting(el, ax, az))) {
    push({ x1: ax + nx * t2, z1: az + nz * t2, x2: ax - nx * t2, z2: az - nz * t2, kind, source: el.id });
  }
  if (!(joinable && connectedToFitting(el, bx, bz))) {
    push({ x1: bx + nx * t2, z1: bz + nz * t2, x2: bx - nx * t2, z2: bz - nz * t2, kind, source: el.id });
  }
}

function emitAuthoredSymbol(
  el: AuthoredElement,
  segments: PlanSegment[],
  arcs: PlanArc[],
  texts: PlanText[],
  push: (s: PlanSegment) => void,
  hostedByWall: Map<string, AuthoredElement[]>,
  cutElevation: number,
  bandLow = 0,
  bandHigh = 3,
): void {
  const p = el.params;
  const elev = p.elevation ?? 0;
  const elevKind: "cut" | "overhead" | "below" =
    elev > cutElevation + 0.05 ? "overhead" : elev + (p.height ?? 0) < bandLow ? "below" : "cut";

  switch (el.type) {
    // miter-linear-v4
    // Only wall / beam / brace / strip share the mitered plan footprint.
    // MEP types use flat thickness so the corner is filled by the elbow
    // fitting — matching BIM.
    case "wall":
    case "beam":
    case "brace":
    case "strip": {
      // BIM-style linear join v2 - robust thickness, wider tolerance,
      // perpendicularity preference, wider miter cap. Applies to walls
      // and beams; both miter identically at L-corners.
      if (!p.start || !p.end) return;
      const [ax, az] = p.start;
      const [bx, bz] = p.end;
      const dx = bx - ax, dz = bz - az;
      const L = Math.hypot(dx, dz);
      if (L < 0.05) return;
      const ux = dx / L, uz = dz / L;
      const nx = -uz, nz = ux;
      const rawThick = Number(p.thickness);
      const wallThick = Number.isFinite(rawThick) && rawThick > 0.001 ? rawThick : 0.2;
      const t2 = wallThick / 2;
      const joinStat = String((el as any).properties?.joinStatus ?? "allow");
      const peers: JoinPeer[] = [];
      for (const o of getElements()) {
        if (o.type !== el.type || !o.params.start || !o.params.end) continue;
        const ot = Number(o.params.thickness);
        peers.push({
          id: o.id,
          start: [o.params.start[0], o.params.start[1]],
          end: [o.params.end[0], o.params.end[1]],
          thickness: Number.isFinite(ot) && ot > 0.001 ? ot : 0.2,
          joinStatus: String((o as any).properties?.joinStatus ?? "allow"),
        });
      }
      if (!peers.some((q) => q.id === el.id)) {
        peers.push({ id: el.id, start: [ax, az], end: [bx, bz], thickness: wallThick, joinStatus: joinStat });
      }
      const faceEndsAt = (endX: number, endZ: number, atStart: boolean) => {
        const plainL = { x: endX + nx * t2, z: endZ + nz * t2 };
        const plainR = { x: endX - nx * t2, z: endZ - nz * t2 };
        const m = mitreEndFaces([endX, endZ], [ux, uz], t2, atStart, el.id, peers);
        if (!m) return { left: plainL, right: plainR, joined: false };
        return { left: { x: m.left[0], z: m.left[1] }, right: { x: m.right[0], z: m.right[1] }, joined: m.joined };
      };
      const startFaces = faceEndsAt(ax, az, true);
      const endFaces = faceEndsAt(bx, bz, false);

      const hosts = (hostedByWall.get(el.id) ?? []).filter(
        (h) => h.type === "door" || h.type === "window",
      );
      const openings: { start: number; end: number; el: AuthoredElement }[] = [];
      for (const h of hosts) {
        const w = h.params.width ?? 0.9;
        const off = h.params.offsetAlongHost ?? L / 2;
        openings.push({ start: Math.max(0, off - w / 2), end: Math.min(L, off + w / 2), el: h });
      }
      openings.sort((a, b) => a.start - b.start);

      const merged: { start: number; end: number; el?: AuthoredElement }[] = [];
      for (const o of openings) {
        if (merged.length && o.start <= merged[merged.length - 1].end + 0.01) {
          merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, o.end);
        } else {
          merged.push({ ...o });
        }
      }

      const emitSides = (from: number, to: number) => {
        if (to - from < 0.02) return;
        const t0 = from / L, t1 = to / L;
        const l1x = startFaces.left.x + (endFaces.left.x - startFaces.left.x) * t0;
        const l1z = startFaces.left.z + (endFaces.left.z - startFaces.left.z) * t0;
        const l2x = startFaces.left.x + (endFaces.left.x - startFaces.left.x) * t1;
        const l2z = startFaces.left.z + (endFaces.left.z - startFaces.left.z) * t1;
        const r1x = startFaces.right.x + (endFaces.right.x - startFaces.right.x) * t0;
        const r1z = startFaces.right.z + (endFaces.right.z - startFaces.right.z) * t0;
        const r2x = startFaces.right.x + (endFaces.right.x - startFaces.right.x) * t1;
        const r2z = startFaces.right.z + (endFaces.right.z - startFaces.right.z) * t1;
        push({ x1: l1x, z1: l1z, x2: l2x, z2: l2z, kind: elevKind, source: el.id });
        push({ x1: r1x, z1: r1z, x2: r2x, z2: r2z, kind: elevKind, source: el.id });
      };

      let cursor = 0;
      for (const o of merged) {
        emitSides(cursor, o.start);
        cursor = o.end;
      }
      emitSides(cursor, L);

      if (!startFaces.joined) {
        push({
          x1: startFaces.left.x, z1: startFaces.left.z,
          x2: startFaces.right.x, z2: startFaces.right.z,
          kind: elevKind, source: el.id,
        });
      }
      if (!endFaces.joined) {
        push({
          x1: endFaces.left.x, z1: endFaces.left.z,
          x2: endFaces.right.x, z2: endFaces.right.z,
          kind: elevKind, source: el.id,
        });
      }

      for (const o of merged) {
        const openingEl = openings.find((x) => x.start === o.start)?.el;
        if (openingEl?.type === "door") {
          const hingeX = ax + ux * o.start;
          const hingeZ = az + uz * o.start;
          const w = o.end - o.start;
          arcs.push({
            cx: hingeX, cz: hingeZ, r: w,
            start: Math.atan2(nz, nx),
            end: Math.atan2(uz, ux),
            kind: "door-swing", source: openingEl.id,
          });
          push({
            x1: hingeX, z1: hingeZ,
            x2: hingeX + nx * w, z2: hingeZ + nz * w,
            kind: "cut", source: openingEl.id,
          });
        } else if (openingEl?.type === "window") {
          const l1x = ax + ux * o.start, l1z = az + uz * o.start;
          const l2x = ax + ux * o.end, l2z = az + uz * o.end;
          push({ x1: l1x + nx * t2, z1: l1z + nz * t2, x2: l1x - nx * t2, z2: l1z - nz * t2, kind: "cut" });
          push({ x1: l2x + nx * t2, z1: l2z + nz * t2, x2: l2x - nx * t2, z2: l2z - nz * t2, kind: "cut" });
        }
      }
      break;
    }
    case "column":
    case "equipment":
    case "footing": {
      if (!p.point) return;
      const w = p.thickness;
      const d = p.depth ?? p.thickness;
      const x = p.point[0], z = p.point[1];
      const hw = w / 2, hd = d / 2;
      push({ x1: x - hw, z1: z - hd, x2: x + hw, z2: z - hd, kind: "cut", source: el.id });
      push({ x1: x + hw, z1: z - hd, x2: x + hw, z2: z + hd, kind: "cut", source: el.id });
      push({ x1: x + hw, z1: z + hd, x2: x - hw, z2: z + hd, kind: "cut", source: el.id });
      push({ x1: x - hw, z1: z + hd, x2: x - hw, z2: z - hd, kind: "cut", source: el.id });
      break;
    }

    case "slab": {
      if (!p.polygon || p.polygon.length < 3) return;
      const poly = p.polygon;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        push({ x1: a[0], z1: a[1], x2: b[0], z2: b[1], kind: elevKind, source: el.id });
      }
      break;
    }

    case "truss":
    case "mline":
      emitLinearThick(push, el, elevKind, p.thickness ?? 0.2);
      break;

    // MEP categories — flat thickness, fitting covers the corner
    case "duct":
      emitLinearThick(push, el, elevKind, p.thickness ?? 0.6);
      break;
    case "pipe":
      emitLinearThick(push, el, elevKind, Math.max(0.08, p.thickness ?? 0.1));
      break;
    case "cable-tray":
      emitLinearThick(push, el, elevKind, p.thickness ?? 0.3);
      break;
    case "conduit":
      emitLinearThick(push, el, elevKind, Math.max(0.05, p.thickness ?? 0.05));
      break;
    case "fitting": {
      // MEP elbow v1: render the fitting as two concentric arcs matching
      // the 3D buildFitting geometry. BIM draws duct/pipe elbows as
      // clean quarter (or half) circles in plan — not the tiny box the
      // previous placeholder produced.
      const cxF = p.point?.[0];
      const czF = p.point?.[1];
      if (cxF == null || czF == null) {
        // Legacy line-based fitting fallback: small box.
        if (p.start && p.end) {
          const x = (p.start[0] + p.end[0]) / 2;
          const z = (p.start[1] + p.end[1]) / 2;
          const s = (p.thickness ?? 0.3) / 2;
          push({ x1: x - s, z1: z - s, x2: x + s, z2: z - s, kind: elevKind, source: el.id });
          push({ x1: x + s, z1: z - s, x2: x + s, z2: z + s, kind: elevKind, source: el.id });
          push({ x1: x + s, z1: z + s, x2: x - s, z2: z + s, kind: elevKind, source: el.id });
          push({ x1: x - s, z1: z + s, x2: x - s, z2: z - s, kind: elevKind, source: el.id });
        }
        break;
      }

      const parentType = String((p as any).parentType || "duct");
      const kind = String((p as any).fittingKind || "elbow");
      const aIn = p.angleIn ?? 0;
      const aOut = p.angleOut ?? Math.PI / 2;
      const t = p.thickness ?? 0.3;
      const t2 = Math.max(0.02, t / 2);
      const isRound = parentType === "pipe" || parentType === "conduit";
      // Same construction as the 3D fitting and the duct trimming (shared module).
      const ductWidth = Math.max(t, 0.05);
      const baseR = Number(p.bendRadius);
      const r = Number.isFinite(baseR) && baseR > 0 ? baseR : defaultBendRadius(ductWidth);

      if (kind === "elbow") {
        const eg = elbowGeometry([cxF, czF], aIn, aOut, r);
        if (!eg) break;
        const rOuter = r + t2;
        const rInner = Math.max(0.01, r - t2);
        arcs.push({ cx: eg.O[0], cz: eg.O[1], r: rOuter, start: eg.startAngle, end: eg.startAngle + eg.sweep, kind: "fitting", source: el.id });
        arcs.push({ cx: eg.O[0], cz: eg.O[1], r: rInner, start: eg.startAngle, end: eg.startAngle + eg.sweep, kind: "fitting", source: el.id });
        break;
      }

      // Tee / cross / wye: true plan outline (run continues, branch opens into it)
      if (kind === "tee" || kind === "cross" || kind === "wye") {
        const armLen = fittingArmLength(t, p.height ?? t, Number(p.bendRadius), isRound);
        for (const sg of fittingOutlineSegments(cxF, czF, fittingArmAngles(kind, aIn, aOut), t, armLen)) {
          push({ ...sg, kind: elevKind, source: el.id });
        }
        break;
      }
      if (kind === "cap") {
        for (const sg of capOutlineSegments(cxF, czF, aIn, t, Math.max(0.1, t * 0.4))) {
          push({ ...sg, kind: elevKind, source: el.id });
        }
        break;
      }

      if (kind === "transition" || kind === "union") {
        const rr = Math.max((isRound ? t : Math.max(t, p.height ?? t)) / 2, 0.04);
        const segs = kind === "transition"
          ? transitionOutlineSegments(cxF, czF, aIn, t, rr * 2.8)
          : unionOutlineSegments(cxF, czF, aIn, t, Math.max(0.12, t * 0.35));
        for (const sg of segs) push({ ...sg, kind: elevKind, source: el.id });
        break;
      }

      // Unknown fitting kind: small box fallback
      const s = t / 2;
      push({ x1: cxF - s, z1: czF - s, x2: cxF + s, z2: czF - s, kind: elevKind, source: el.id });
      push({ x1: cxF + s, z1: czF - s, x2: cxF + s, z2: czF + s, kind: elevKind, source: el.id });
      push({ x1: cxF + s, z1: czF + s, x2: cxF - s, z2: czF + s, kind: elevKind, source: el.id });
      push({ x1: cxF - s, z1: czF + s, x2: cxF - s, z2: czF - s, kind: elevKind, source: el.id });
      break;
    }

    case "door":
    case "window":
      // Handled by host wall projection
      break;

    default: {
      // Any other category: linear if start/end, point if point, else skip
      if (p.start && p.end) {
        emitLinearThick(push, el, elevKind, p.thickness ?? 0.2);
      } else if (p.point) {
        const w = p.thickness ?? 0.3;
        const d = p.depth ?? w;
        const x = p.point[0], z = p.point[1];
        const hw = w / 2, hd = d / 2;
        push({ x1: x - hw, z1: z - hd, x2: x + hw, z2: z - hd, kind: elevKind, source: el.id });
        push({ x1: x + hw, z1: z - hd, x2: x + hw, z2: z + hd, kind: elevKind, source: el.id });
        push({ x1: x + hw, z1: z + hd, x2: x - hw, z2: z + hd, kind: elevKind, source: el.id });
        push({ x1: x - hw, z1: z + hd, x2: x - hw, z2: z - hd, kind: elevKind, source: el.id });
      } else if (p.polygon && p.polygon.length >= 2) {
        for (let i = 0; i < p.polygon.length; i++) {
          const a = p.polygon[i];
          const b = p.polygon[(i + 1) % p.polygon.length];
          push({ x1: a[0], z1: a[1], x2: b[0], z2: b[1], kind: elevKind, source: el.id });
        }
      }
      break;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Fallback: box footprint
// ══════════════════════════════════════════════════════════════════════════

function emitBoxFootprint(
  box: THREE.Box3,
  push: (s: PlanSegment) => void,
  kind: "cut" | "overhead" | "below",
): void {
  const minX = box.min.x, minZ = box.min.z, maxX = box.max.x, maxZ = box.max.z;
  push({ x1: minX, z1: minZ, x2: maxX, z2: minZ, kind });
  push({ x1: maxX, z1: minZ, x2: maxX, z2: maxZ, kind });
  push({ x1: maxX, z1: maxZ, x2: minX, z2: maxZ, kind });
  push({ x1: minX, z1: maxZ, x2: minX, z2: minZ, kind });
}

// ══════════════════════════════════════════════════════════════════════════
// Convenience: generate a default plan from the current levels
// ══════════════════════════════════════════════════════════════════════════

export function listAvailableLevels(): { name: string; elevation: number }[] {
  const user = getLevels().map((l) => ({ name: l.name, elevation: l.elevation }));
  if (user.length) return user;
  // Fallback set if no levels defined
  return [
    { name: "Level 0", elevation: 0 },
    { name: "Level 1", elevation: 3 },
    { name: "Level 2", elevation: 6 },
  ];
}