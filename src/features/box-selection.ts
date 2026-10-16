/**
 * Revit-style 3D rubber-band selection (query only).
 * Gesture + overlay are owned by features/navigation.ts, which calls commit().
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { selection } from "./selection";
import { setSelectedAuthored } from "./authoring";
import { getElementWorldBoxes } from "../modules/geometry/world-box";

export type BoxMode = "window" | "crossing";
export interface BoxRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const _corner = new THREE.Vector3();

function testBox(
  box: THREE.Box3,
  rect: BoxRect,
  mode: BoxMode,
  hostRect: DOMRect,
  cam: THREE.Camera,
): boolean {
  if (!box || box.isEmpty()) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let anyVisible = false;

  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? box.max.x : box.min.x;
    const y = i & 2 ? box.max.y : box.min.y;
    const z = i & 4 ? box.max.z : box.min.z;
    _corner.set(x, y, z).project(cam);

    if (_corner.z < -1 || _corner.z > 1) {
      if (mode === "window") return false;
      continue;
    }

    anyVisible = true;
    const px = (_corner.x * 0.5 + 0.5) * hostRect.width;
    const py = (-_corner.y * 0.5 + 0.5) * hostRect.height;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  if (!anyVisible) return false;

  if (mode === "window") {
    return minX >= rect.x1 && maxX <= rect.x2 && minY >= rect.y1 && maxY <= rect.y2;
  }
  return !(maxX < rect.x1 || minX > rect.x2 || maxY < rect.y1 || minY > rect.y2);
}

async function queryFragments(
  rect: BoxRect,
  mode: BoxMode,
): Promise<Record<string, number[]>> {
  const out: Record<string, number[]> = {};
  const hostRect = ctx.rightHost.getBoundingClientRect();
  const cam = ctx.world.camera.three;

  for (const [modelId, model] of ctx.fragments.list) {
    let ids: number[] = [];
    try {
      ids = ((await (model as any).getItemsIdsWithGeometry()) as number[]) ?? [];
    } catch {
      continue;
    }
    if (!ids.length) continue;

    const hits: number[] = [];
    const CHUNK = 2000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      let boxes: any[] = [];
      try {
        boxes = await getElementWorldBoxes(model, slice, modelId);
      } catch {
        continue;
      }
      for (const wb of boxes) {
        if (testBox(wb.box, rect, mode, hostRect, cam)) hits.push(wb.id);
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    if (hits.length) out[modelId] = hits;
  }
  return out;
}

function queryAuthored(rect: BoxRect, mode: BoxMode): string[] {
  const out: string[] = [];
  const mod: any = (ctx.features as any).authoring;
  if (!mod?.getElements || !mod?.getElementWorldBox) return out;

  const hostRect = ctx.rightHost.getBoundingClientRect();
  const cam = ctx.world.camera.three;
  const elements = mod.getElements();
  for (const el of elements) {
    const box = mod.getElementWorldBox(el);
    if (!box) continue;
    if (testBox(box, rect, mode, hostRect, cam)) out.push(el.id);
  }
  return out;
}

export async function commitBoxSelection(
  rect: BoxRect,
  mode: BoxMode,
  modifier: "replace" | "add" | "remove" = "replace",
): Promise<void> {
  const [fragHits, authHits] = await Promise.all([
    queryFragments(rect, mode),
    Promise.resolve(queryAuthored(rect, mode)),
  ]);

  if (modifier === "replace") {
    const snap: Record<string, Set<number>> = {};
    for (const [mid, ids] of Object.entries(fragHits)) snap[mid] = new Set(ids);
    selection.replace(snap);
    await selection.applyToHighlighter();
    setSelectedAuthored(authHits, "replace");
  } else if (modifier === "add") {
    for (const [mid, ids] of Object.entries(fragHits)) selection.addMany(mid, ids);
    await selection.applyToHighlighter();
    setSelectedAuthored(authHits, "add");
  } else {
    for (const [mid, ids] of Object.entries(fragHits)) selection.removeMany(mid, ids);
    await selection.applyToHighlighter();
    setSelectedAuthored(authHits, "remove");
  }

  const fragTotal = Object.values(fragHits).reduce((a, s) => a + s.length, 0);
  console.log(
    `[box-select] ${mode} · ${modifier} · ` +
      `${fragTotal} fragment + ${authHits.length} authored element(s)`,
  );
}

export function setupBoxSelection(): void {
  (ctx.features as any).boxSelection = {
    commit: commitBoxSelection,
    queryAuthored,
    queryFragments,
  };
  console.log("[box-select] ready (owned by navigation)");
}
