/**
 * Takeoff engine v3.1.
 *
 * Authored elements: exact quantities from parametric definitions.
 *   - Doors, windows, and fittings are billed by the piece (count = 1).
 *   - Linear elements (walls, beams, pipes, ducts) report length + area + volume.
 *   - Slabs and footings report area + volume.
 *
 * IFC elements: reads Qto_*BaseQuantities psets when present (author-provided
 * numbers) and computes geometric values in parallel from triangle soups.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { getElements } from "../../features/authoring";
import { getElementTriangles, type Tri } from "../clash/geometry";
import type { TakeoffRow } from "./types";

let rows: TakeoffRow[] = [];
export function getRows(): TakeoffRow[] {
  return rows;
}

export function shortCat(cat: string) {
  return cat.replace(/^IFC/i, "").replace(/STANDARDCASE$/i, "") || cat;
}

function r3(n: number) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

// ══════════════════════════════════════════════════════════════════════════
// Geometry math
// ══════════════════════════════════════════════════════════════════════════

function signedVolume(tris: Tri[]): number {
  let v = 0;
  for (const t of tris) {
    const ax = t[0], ay = t[1], az = t[2];
    const bx = t[3], by = t[4], bz = t[5];
    const cx = t[6], cy = t[7], cz = t[8];
    const crX = by * cz - bz * cy;
    const crY = bz * cx - bx * cz;
    const crZ = bx * cy - by * cx;
    v += (ax * crX + ay * crY + az * crZ) / 6;
  }
  return Math.abs(v);
}

function surfaceArea(tris: Tri[]): number {
  let s = 0;
  for (const t of tris) {
    const ux = t[3] - t[0];
    const uy = t[4] - t[1];
    const uz = t[5] - t[2];
    const vx = t[6] - t[0];
    const vy = t[7] - t[1];
    const vz = t[8] - t[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    s += 0.5 * Math.hypot(nx, ny, nz);
  }
  return s;
}

function principalLength(tris: Tri[], iterations = 24): number {
  let n = 0;
  let cx = 0, cy = 0, cz = 0;
  for (const t of tris) {
    cx += t[0] + t[3] + t[6];
    cy += t[1] + t[4] + t[7];
    cz += t[2] + t[5] + t[8];
    n += 3;
  }
  if (!n) return 0;
  cx /= n; cy /= n; cz /= n;

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const dx = t[k * 3] - cx;
      const dy = t[k * 3 + 1] - cy;
      const dz = t[k * 3 + 2] - cz;
      xx += dx * dx; xy += dx * dy; xz += dx * dz;
      yy += dy * dy; yz += dy * dz; zz += dz * dz;
    }
  }

  let vx = 1, vy = 1, vz = 1;
  for (let it = 0; it < iterations; it++) {
    const nx = xx * vx + xy * vy + xz * vz;
    const ny = xy * vx + yy * vy + yz * vz;
    const nz = xz * vx + yz * vy + zz * vz;
    const len = Math.hypot(nx, ny, nz) || 1;
    vx = nx / len; vy = ny / len; vz = nz / len;
  }

  let min = Infinity, max = -Infinity;
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const p = t[k * 3] * vx + t[k * 3 + 1] * vy + t[k * 3 + 2] * vz;
      if (p < min) min = p;
      if (p > max) max = p;
    }
  }
  return Math.max(0, max - min);
}

function trustedVolume(tris: Tri[], boxVolume: number): number {
  const v = signedVolume(tris);
  if (!Number.isFinite(v) || v <= 0) return boxVolume;
  if (boxVolume > 0 && v > boxVolume * 1.05) return boxVolume;
  if (boxVolume > 0 && v < boxVolume * 0.02) return Math.min(v, boxVolume * 0.95);
  return v;
}

// ══════════════════════════════════════════════════════════════════════════
// Qto extraction from IFC psets
// ══════════════════════════════════════════════════════════════════════════

interface QtoData {
  length: number;
  area: number;
  volume: number;
  found: boolean;
  sourceSet?: string;
}

function num(v: any): number | null {
  if (v == null) return null;
  const inner = typeof v === "object" && "value" in v ? (v as any).value : v;
  if (typeof inner === "number" && Number.isFinite(inner)) return inner;
  if (typeof inner === "string") {
    const n = parseFloat(inner);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const AREA_KEYS = [
  "NetSideArea", "GrossSideArea", "NetArea", "GrossArea",
  "NetFloorArea", "GrossFloorArea",
  "NetFootprintArea", "GrossFootprintArea",
  "OuterSurfaceArea", "CrossSectionArea", "Area",
];
const VOLUME_KEYS = ["NetVolume", "GrossVolume", "Volume"];
const LENGTH_KEYS = ["Length", "Width", "Span"];

function pick(props: Record<string, any>, keys: string[]): number | null {
  for (const k of keys) {
    const v = num(props[k]);
    if (v != null) return v;
  }
  return null;
}

function extractQtoFromPsets(
  psets: Record<string, Record<string, any>>,
): QtoData | null {
  let length = 0, area = 0, volume = 0, found = false;
  let sourceSet: string | undefined;

  for (const [psName, props] of Object.entries(psets)) {
    if (!/^Qto_/i.test(psName)) continue;
    if (!props || typeof props !== "object") continue;

    const L = pick(props, LENGTH_KEYS);
    const A = pick(props, AREA_KEYS);
    const V = pick(props, VOLUME_KEYS);

    if (L != null) { length += L; found = true; sourceSet = psName; }
    if (A != null) { area += A; found = true; sourceSet = psName; }
    if (V != null) { volume += V; found = true; sourceSet = psName; }
  }

  return found ? { length, area, volume, found, sourceSet } : null;
}

// ══════════════════════════════════════════════════════════════════════════
// Authored elements (exact, parametric)
// ══════════════════════════════════════════════════════════════════════════

function shoelaceArea(poly: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    s += x1 * z2 - x2 * z1;
  }
  return Math.abs(s) / 2;
}

function authoredRows(): TakeoffRow[] {
  const out: TakeoffRow[] = [];
  for (const el of getElements()) {
    const p = el.params;
    let length = 0, area = 0, volume = 0;
    let detailSuffix = "exact";

    if ((el.type === "wall" || el.type === "strip") && p.start && p.end) {
      const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
      length = L;
      area = L * p.height * 2;
      volume = L * p.height * p.thickness;
    } else if (el.type === "slab" && p.polygon && p.polygon.length >= 3) {
      const A = shoelaceArea(p.polygon);
      area = A;
      volume = A * p.height;
    } else if (el.type === "column" && p.point) {
      const w = p.thickness;
      const d = p.depth ?? p.thickness;
      length = p.height;
      area = 2 * (w + d) * p.height;
      volume = w * d * p.height;
    } else if (el.type === "beam" && p.start && p.end) {
      const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
      length = L;
      volume = L * p.height * p.thickness;
      area = 2 * L * (p.height + p.thickness);
    } else if (el.type === "brace" && p.start && p.end) {
      const L = Math.hypot(
        p.end[0] - p.start[0],
        p.end[1] - p.start[1],
        p.height,
      );
      length = L;
      volume = L * p.thickness * p.thickness;
    } else if (el.type === "truss" && p.start && p.end) {
      const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
      const t = p.thickness;
      const panels = Math.max(2, Number(el.properties?.panels ?? 4));
      const topChord = 2 * Math.hypot(L / 2, p.height);
      const posts = (panels - 1) * p.height * 0.6;
      const totalLen = L + topChord + posts;
      length = totalLen;
      volume = totalLen * t * t;
    } else if (el.type === "footing" && p.point) {
      const w = p.thickness;
      const d = p.depth ?? p.thickness;
      volume = w * d * p.height;
      area = 2 * (w * d) + 2 * (w + d) * p.height;
    } else if (el.type === "mline") {
      length =
        p.start && p.end
          ? Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1])
          : 0;
    } else if (el.type === "door" || el.type === "window") {
      // Doors and windows are counted by the piece.
      detailSuffix = `unit (${p.width ?? 0.9} × ${p.height} m)`;
    } else if (el.type === "fitting") {
      // Fittings are counted by the piece — they inherit their parent's
      // profile but the profile itself is not a separately billable
      // length / area / volume in a QS takeoff.
      const parent = (p.parentType as string) || "run";
      const profileLabel =
        parent === "pipe" || parent === "conduit"
          ? `Ø ${(p.thickness * 1000).toFixed(0)} mm`
          : `${(p.thickness * 1000).toFixed(0)} × ${(p.height * 1000).toFixed(0)} mm`;
      detailSuffix = `${parent} fitting (${profileLabel})`;
    }

    out.push({
      key: `authored:${el.id}`,
      source: "authored",
      label: el.name,
      detail: `${el.type} (authored, ${detailSuffix})`,
      count: 1,
      length: r3(length),
      area: r3(area),
      volume: r3(volume),
      primarySource: "authored",
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// IFC aggregation
// ══════════════════════════════════════════════════════════════════════════

const LINEAR_CAT =
  /^(WALL|BEAM|COLUMN|MEMBER|PILE|PIPESEGMENT|PIPEFITTING|DUCTSEGMENT|DUCTFITTING|CABLECARRIERSEGMENT|CABLETRAY|CONDUIT|RAILING|CURTAINWALL|PLATE)/i;

interface Agg {
  count: number;
  qto: { length: number; area: number; volume: number; elements: number };
  geom: { length: number; area: number; volume: number; elements: number };
  bboxOnly: number;
}

async function readQtoBatches(
  model: any,
  ids: number[],
): Promise<Map<number, QtoData>> {
  const out = new Map<number, QtoData>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    try {
      const data = await model.getItemsData(batch, {
        attributesDefault: false,
        psetsDefault: true,
      } as any);
      for (let j = 0; j < batch.length; j++) {
        const d = (data as any[])?.[j];
        const psets = d?.psets;
        if (!psets || typeof psets !== "object") continue;
        const q = extractQtoFromPsets(psets);
        if (q) out.set(batch[j], q);
      }
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

async function ifcRows(): Promise<TakeoffRow[]> {
  const out: TakeoffRow[] = [];

  for (const [modelId, model] of ctx.fragments.list) {
    try {
      const ids: number[] = await model.getItemsIdsWithGeometry();
      if (!ids?.length) continue;

      const boxes = await model.getBoxes(ids);
      let cats: Record<string, number[]> = {};
      try {
        cats = await model.getItemsOfCategories([/.+/]);
      } catch { /* */ }
      const idToCat = new Map<string, string>();
      for (const [cat, list] of Object.entries(cats)) {
        for (const id of (list as number[]) || []) idToCat.set(String(id), cat);
      }

      const qtoMap = await readQtoBatches(model, ids);

      const agg = new Map<string, Agg>();
      const s = new THREE.Vector3();

      for (let i = 0; i < ids.length; i++) {
        const b = boxes[i];
        if (!b || b.isEmpty()) continue;

        const localId = ids[i];
        const rawCat = idToCat.get(String(localId)) ?? "Other";
        const shortName = shortCat(rawCat);
        const key = `ifc:${modelId}:${shortName}`;

        let a = agg.get(key);
        if (!a) {
          a = {
            count: 0,
            qto: { length: 0, area: 0, volume: 0, elements: 0 },
            geom: { length: 0, area: 0, volume: 0, elements: 0 },
            bboxOnly: 0,
          };
          agg.set(key, a);
        }
        a.count++;

        const q = qtoMap.get(localId);
        if (q?.found) {
          a.qto.elements++;
          a.qto.length += q.length;
          a.qto.area += q.area;
          a.qto.volume += q.volume;
        }

        b.getSize(s);
        const boxVol = Math.abs(s.x * s.y * s.z);
        let tris: Tri[] | null = null;
        try {
          tris = getElementTriangles(model.object, localId);
        } catch {
          tris = null;
        }

        if (tris && tris.length) {
          a.geom.elements++;
          a.geom.volume += trustedVolume(tris, boxVol);
          a.geom.area += surfaceArea(tris);
          if (LINEAR_CAT.test(shortName)) {
            a.geom.length += principalLength(tris);
          }
        } else {
          a.bboxOnly++;
          a.geom.elements++;
          a.geom.volume += boxVol;
          a.geom.area += 2 * (s.x * s.y + s.x * s.z + s.y * s.z);
          if (LINEAR_CAT.test(shortName)) {
            a.geom.length += Math.max(s.x, s.y, s.z);
          }
        }
      }

      for (const [key, a] of agg) {
        const parts = key.split(":");
        const cat = parts.slice(2).join(":");

        const qtoShare = a.count > 0 ? a.qto.elements / a.count : 0;
        const primarySource: TakeoffRow["primarySource"] =
          qtoShare >= 0.5 ? "qto" : "geometry";
        const primary = primarySource === "qto" ? a.qto : a.geom;

        const variancePct =
          a.qto.volume > 0 && a.geom.volume > 0
            ? (Math.abs(a.qto.volume - a.geom.volume) / a.geom.volume) * 100
            : undefined;

        const precision =
          a.bboxOnly === 0
            ? "exact geometry"
            : a.bboxOnly === a.geom.elements
              ? "≈ bbox"
              : `≈ mixed (${a.geom.elements - a.bboxOnly} geo · ${a.bboxOnly} bbox)`;

        const detail =
          `${a.count} elements · model "${modelId}" · ${precision}` +
          (a.qto.elements ? ` · Qto ${a.qto.elements}/${a.count}` : "");

        out.push({
          key,
          source: "ifc",
          label: cat,
          detail,
          count: a.count,
          length: r3(primary.length),
          area: r3(primary.area),
          volume: r3(primary.volume),
          qto: a.qto.elements
            ? {
                length: r3(a.qto.length),
                area: r3(a.qto.area),
                volume: r3(a.qto.volume),
                elements: a.qto.elements,
              }
            : undefined,
          geom: a.geom.elements
            ? {
                length: r3(a.geom.length),
                area: r3(a.geom.area),
                volume: r3(a.geom.volume),
                elements: a.geom.elements,
              }
            : undefined,
          primarySource,
          variancePct,
        });
      }
    } catch (e) {
      console.warn("[cost] takeoff failed for model:", modelId, e);
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// Public
// ══════════════════════════════════════════════════════════════════════════

export async function computeTakeoff(): Promise<TakeoffRow[]> {
  const authored = authoredRows();
  const ifc = await ifcRows();
  rows = [...authored, ...ifc];
  return rows;
}

export function r3Compat(n: number) {
  return r3(n);
}